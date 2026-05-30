# Taiga — PMO Control Tower Utilization Report

---

## 1. Identity

| Field | Value |
|-|-|
| Repo name | Taiga (taiga-back + taiga-front) |
| Upstream URLs | https://github.com/kaleidos-ventures/taiga-back + https://github.com/kaleidos-ventures/taiga-front |
| Primary language | Python 3.10 (backend), CoffeeScript + AngularJS 1.5 (frontend) |
| Backend framework | Django 3.2.25 + Django REST Framework (custom fork `taiga.base.api`) |
| Database | PostgreSQL (psycopg2 2.9.11); uses `django.contrib.postgres.fields.ArrayField` and full-text-search `to_tsvector` |
| Task queue | Celery 5.5.3 with Celery Beat for scheduled tasks |
| License | **Back:** Mozilla Public License 2.0 (MPL-2.0) — verified from `taiga-back/LICENSE`; **Front:** AGPL-3.0-or-later — verified from `taiga-front/package.json` and `taiga-front/LICENSE` |
| Latest release (back) | 6.10.1 (single commit `df14a4b`); **Front:** 6.10.3 |
| Activity | Low. Single commit on both repos; no active branch work; last meaningful activity circa 2023–2024. Effectively in maintenance-only or abandoned state upstream. |

Note: the back-end LICENSE is **MPL-2.0**, not AGPL-3.0 as hinted in the brief. The front-end is AGPL-3.0. This distinction matters for reuse (see Section 5).

---

## 2. Architecture

Taiga is a **two-repo monolith**: a Django REST API (taiga-back) and an AngularJS SPA (taiga-front). There is no micro-service split, no module federation, and no shared library.

**Backend structure** (`taiga/`):

- `taiga/projects/` — the central monolith: Project, Membership, all item types (userstories, tasks, issues, epics, milestones), statuses, and all sub-modules (history, notifications, due_dates, wiki, etc.) live here as sub-packages of a single Django app. This is a **fat-app pattern**, not domain-isolated modules.
- `taiga/permissions/` — standalone permission calculation layer (services.py, choices.py).
- `taiga/auth/` — JWT token auth (custom fork of djangorestframework-simplejwt). No OIDC/SAML built in; external SSO providers (GitHub, GitLab) are contrib plugins loaded via settings, not core.
- `taiga/timeline/`, `taiga/stats/`, `taiga/searches/` — separate Django apps for activity feeds, platform stats, and full-text search.
- `taiga/celery.py` — Celery Beat schedules for bulk email dispatch and token flush.

**Data layer:** Django ORM migrations per app under `*/migrations/`. No raw SQL schema files; schema is inferred from models. Postgres-specific features (ArrayField, `to_tsvector`, advisory locks via `django-pglocks`) are used directly.

**Adding a new feature:** requires touching `models.py`, `serializers.py`, `api.py`, `permissions.py`, and `migrations/` inside the relevant sub-package, then wiring URLs in `taiga/urls.py`. No plugin/hook interface — it is a pure monolith.

**Frontend** is AngularJS 1.5 + CoffeeScript, built with Gulp. It is essentially a legacy codebase; no React, no TypeScript, no modern toolchain. Nothing in it is transferable to our Next.js stack.

---

## 3. How It Handles Each Concern

### Data model for projects, departments/teams/groups, and tasks

There is **no department or team grouping concept**. The root entity is `Project` (`taiga/projects/models.py`, line 162). Users are attached to projects via `Membership` (line 48) with a FK to `Role` (`taiga/users/` role model). There is no hierarchical org structure, no department, no portfolio. Tasks (`taiga/projects/tasks/`) belong to UserStories, which belong to Milestones or directly to Projects. Epics (`taiga/projects/epics/`) group UserStories via a `RelatedUserStory` through-table (`taiga/projects/epics/models.py`, line 105).

**PMO relevance:** the flat project→membership model is too shallow for our department-isolation requirement. There is no "department owns a project" concept at all.

### Roles, permissions, and data isolation between teams/groups

Permission enforcement is **application-layer only — no database-level row isolation**.

- `taiga/permissions/services.py` — `calculate_permissions()` computes a set of permission strings from a user's `Membership.role.permissions` (a Postgres ArrayField of strings). This is evaluated in Python, not enforced by DB.
- `taiga/base/filters.py` — `get_filter_expression_can_view_projects()` builds a Django Q expression that filters projects to those where the user has an active Membership with `view_project` permission OR the project is public. This filter must be applied explicitly by each ViewSet; it is not automatic.
- `taiga/searches/api.py` — search gate-checks each category with `user_has_perm()` before querying.
- No row-level security (RLS), no Postgres policies, no database-layer enforcement. A programming error in a ViewSet will leak data. This is the fundamental gap for our isolation requirement.

### Status (RAG or equivalent) and status history

Taiga has a **color-coded status system**, not a named RAG system. Each item type (Epic, UserStory, Task, Issue) has a corresponding `*Status` model (`taiga/projects/models.py`, ~line 565–835) with fields: `name`, `color` (hex string, default `#999999`), `is_closed` (boolean). Statuses are project-configurable; there are no locked "green/amber/red" categories — just a color hex and a closed flag. Status history is captured by the history/diff system described below.

**PMO relevance:** the color+is_closed pattern is a loose analog of RAG. We would need to define a fixed 3-value enum; Taiga's approach can inform that design pattern but is not directly adoptable.

### Approvals or workflow states (draft → pending → approved transitions)

**There are no approvals and no formal workflow state machine in Taiga.** Status transitions are unconstrained — any user with write permission can change an item's status to any other status with no enforced sequence, no sign-off gate, no approval record. The `is_closed` boolean is the closest concept to "done", but it is not an approval. This is a complete absence relative to our requirements.

### Baseline, revisions, and change tracking (snapshots, versioning, deltas)

This is Taiga's **strongest area** and the most valuable reference for us.

- `taiga/projects/history/models.py` — `HistoryEntry` stores: `diff` (JSON field of field-level changes, format `{field: [old, new]}`), `snapshot` (JSON full freeze of the object at that point), `values` (human-readable label cache), `is_snapshot` (boolean marking full snapshots vs partial diffs), `type` (create/change/delete enum), `comment`, and `comment_versions` (edit history of comments).
- `taiga/projects/history/services.py` — `take_snapshot()` (line 368) is called inside `@tx.atomic` with an advisory lock (`django-pglocks`) per object key. It calls `freeze_model_instance()` to snapshot the current state, calls `get_last_snapshot_for_key()` to retrieve the prior state, computes `make_diff()` between them, and writes a new `HistoryEntry`. After `MAX_PARTIAL_DIFFS` (default 60) partial diffs, a full snapshot is written.
- `taiga/projects/history/freeze_impl.py` — per-model "freezer" functions that serialize each model instance to a plain dict. This is the baseline capture mechanism.

**Tamper-resistance:** `HistoryEntry` has no `update` endpoint in the API. Comments can be edited (stored as `comment_versions` with timestamps) and soft-deleted (`delete_comment_date` field) but the original remains. The service uses `HistoryEntry.objects.filter(pk=self.pk).update(...)` for cache writes, bypassing signals — but no DELETE is called. This is append-oriented but **not hard tamper-resistant** (no DB-level immutability constraint, no trigger preventing UPDATEs on the core diff/snapshot columns). A DBA or superuser could mutate rows.

**PMO relevance:** The freeze+diff+snapshot pattern in `history/services.py` is the single most transferable design concept from this codebase. The `take_snapshot` / `make_diff` / `get_last_snapshot_for_key` idiom maps directly to our baseline+revision+delta requirement. We would reimplement in TypeScript/Supabase with Postgres triggers for hard append-only enforcement.

### Audit trail / activity log

`HistoryEntry` doubles as the audit log. `taiga/timeline/` provides a separate, higher-level "activity stream" feed that aggregates events per project or per user (`taiga/timeline/service.py`). Timeline entries are written by Django signals (`taiga/timeline/signals.py`). There is no separate, independently secured audit table — timeline and history share the same database without immutability guarantees.

### Dependencies between items, and any visual dependency map

**There are no task-to-task dependencies.** Epics aggregate UserStories via `RelatedUserStory` (`taiga/projects/epics/models.py`), but this is a grouping, not a dependency (no "blocks/blocked-by" semantics). There is no visual dependency graph in taiga-back or taiga-front. The `blocked_note` field on UserStories/Tasks is a text annotation, not a structural dependency link. **This concern is a complete absence.**

### Dashboards and reporting

- `taiga/stats/services.py` — provides platform-level aggregate stats (user counts per week, project counts, sprint velocity trends) as pure SQL/ORM queries. These are admin-facing, not per-project governance dashboards.
- `taiga/timeline/api.py` — provides project/user activity timelines (event feeds, not KPI dashboards).
- Per-project CSV export is available via token-gated UUID endpoints in `taiga/projects/api.py` (lines 270–326), covering epics, user stories, tasks, and issues. Export is handled by `taiga/export_import/` (top-level, separate from the projects sub-package).
- There is no dashboard of "projects across departments", no KPI rollup, no budget or schedule-performance chart.

### Notifications, scheduled jobs, and escalation logic

- `taiga/projects/notifications/services.py` — `send_notifications()` (line 243) uses `select_for_update()` to create or update a `HistoryChangeNotification` record, batching history entries for an object+user+change-type combo. The `CHANGE_NOTIFICATIONS_MIN_INTERVAL` setting (default 0 seconds, `settings/common.py` line 208) throttles email batching.
- `taiga/projects/notifications/tasks.py` — single Celery task `send_bulk_email()` that calls `services.send_bulk_email()`.
- `taiga/celery.py` — Celery Beat schedules: `send-bulk-emails` fires on the `CHANGE_NOTIFICATIONS_MIN_INTERVAL` schedule; `send-telemetry-once-a-day` fires on a random daily crontab; `auth-flush-expired-tokens` on a configurable period.
- **There is no escalation logic.** No concept of "item is overdue → notify manager → if no action in N hours → escalate to director". No due-date watchers that fire reminders. `DueDateMixin` (`taiga/projects/due_dates/models.py`) stores `due_date` and `due_date_reason` but there is no Celery Beat job that checks for overdue items and fires notifications.

**PMO relevance:** The batching-via-DB-record + `select_for_update()` pattern prevents double-send by design. This is a reusable pattern (we would implement equivalently in Supabase using pg_cron + a notifications queue table). But the escalation engine itself does not exist and must be built from scratch.

### Search (and whether it respects access rules)

`taiga/searches/api.py` — full-text search uses Postgres `to_tsvector`/`to_tsquery` (`taiga/searches/services.py`). Access is enforced explicitly: the search ViewSet calls `user_has_perm(request.user, "view_*", project)` before running each category query, and `_get_project()` uses `get_object_or_error()` which applies `get_filter_expression_can_view_projects`. Search is scoped to one project at a time (project ID is a required query parameter); there is no cross-project or cross-department search. Search respects permissions at the application layer, not at the database layer.

### Authentication and SSO

`taiga/auth/` implements JWT (derived from djangorestframework-simplejwt, MPL-2.0 licensed per the file header). There is no built-in OIDC, SAML, or Microsoft Entra/Active Directory support. GitHub and GitLab OAuth are referenced in `settings/config.py.prod.example` as contrib plugins (`taiga_contrib_github_auth`, `taiga_contrib_gitlab_auth`) — these are separate third-party packages, not part of this repo. **Microsoft SSO is entirely absent.** This is a hard gap for our Microsoft Entra requirement.

---

## 4. Code Quality & Docs

**Readability:** The Python backend is clean and consistently formatted. Docstrings exist on key service functions. The `history/services.py` module is particularly well-documented with an in-module usage example. The `permissions/services.py` is short and readable.

**Modularity:** Mixed. The permissions layer and history layer are well-isolated as independent modules. However, `taiga/projects/` is a single large Django app with 1,445-line `models.py`, numerous sub-packages, and all item types co-located. Lifting the history pattern in isolation is feasible; lifting the project model requires untangling.

**Test coverage:** `tests/` has both `unit/` and `integration/` directories. `grep -c test_` gives ~3,000 test lines. Coverage includes history (`tests/integration/test_history.py`), notifications, milestones, and auth. This is above average for a Django project.

**Documentation:** `docs/` folder exists. API docs are present but not exhaustive. The `CHANGELOG.md` is detailed. No formal architecture diagram.

**The CoffeeScript frontend** is essentially unreadable for reuse purposes — AngularJS 1.5 patterns (controllers, `$scope`, `$http` services) are architecturally incompatible with React and provide zero reference value.

---

## 5. License Implications

**taiga-back (MPL-2.0):** MPL-2.0 is a "weak copyleft" or "file-level copyleft" license. You may use MPL-licensed code in a proprietary product **as long as you do not modify the MPL-licensed files themselves, or if you do modify them, you must release only the modified MPL files under MPL-2.0**. You are NOT required to open-source your larger proprietary application. Practically: if we copy a file (e.g., `history/services.py`) and modify it, we must release that modified file under MPL-2.0. If we *study and reimplement* the concepts cleanly in TypeScript without copying the Python source text, we have **no MPL obligations** — the license covers source files, not ideas or algorithms.

**taiga-front (AGPL-3.0):** AGPL-3.0 is strong copyleft. Any product that incorporates AGPL code and makes it available over a network (SaaS) must release the entire combined work's source under AGPL-3.0. **Incorporating any taiga-front code into our proprietary SaaS product is not permissible.** Given the front-end is AngularJS CoffeeScript with zero stack compatibility, there is no reason to touch it.

**Conclusion for PMO Control Tower:** Read `taiga-back` for patterns and ideas; reimplement in TypeScript. Do not copy Python source files. The front-end is off-limits and irrelevant. The MPL-2.0 back-end is study-safe; the AGPL front-end is irrelevant.

---

## 6. Modifiability Assessment

**Adapting Taiga toward our PMO governance tower is a poor fit overall.** The data model lacks departments, the permission system has no database-layer isolation, there are no approvals or escalation flows, there is no dependency graph, and Microsoft SSO is entirely absent. The history/diff system is genuinely excellent but represents one module of twelve requirements.

### Rubric Scores

| Criterion | Score | Justification |
|-|-|-|
| stackProximity | 2 | Postgres is close; Python/Django vs TypeScript/Next.js is a full-stack mismatch; CoffeeScript front-end is irrelevant |
| modularity | 3 | History layer and permissions layer are cleanly separable; project "monolith" app is entangled |
| governanceCoverage | 2 | History/audit is strong; approvals, escalation, department isolation, baseline, and dependency map are all absent |
| codeClarity | 4 | Python backend is readable with good docstrings and reasonable test coverage |
| licensePosture | 3 | Back-end MPL-2.0 = study-safe, reimplement-safe; front-end AGPL = irrelevant but forbidden |
| maintenance | 2 | Single-commit tip, effectively unmaintained upstream; Django 3.2 (EOL April 2024) |

---

## 7. Top Files/Modules Worth Studying

1. **`taiga/projects/history/services.py`** — The `take_snapshot` / `make_diff` / `get_last_snapshot_for_key` pattern is the most directly applicable reference for our baseline+revision+delta module. The advisory-lock-per-key pattern prevents concurrent snapshot corruption. Study the full flow from freeze → diff → persist.

2. **`taiga/projects/history/models.py`** — `HistoryEntry` schema shows exactly what fields a governance-grade audit record needs: `diff` (JSON), `snapshot` (JSON), `values` (human-readable cache), `is_snapshot` (full vs partial flag), `type` (create/change/delete), user snapshot (JSON, not FK — survives user deletion), and comment versioning. The soft-deletion approach for comments (`delete_comment_date`) is also worth noting.

3. **`taiga/permissions/services.py`** — Clean example of separating permission *calculation* from enforcement. `calculate_permissions()` is a pure function; `get_user_project_permissions()` is the single source of truth. Study this to design our role→permission resolution layer, then replace app-layer enforcement with Supabase RLS policies for actual isolation.

4. **`taiga/base/filters.py` — `get_filter_expression_can_view_projects()`** — Shows the pattern of building a membership-based Q filter for queryset scoping. This is the closest Taiga gets to data isolation, and studying its limitations (no DB enforcement, must be applied explicitly per ViewSet) directly informs why we need RLS instead.

5. **`taiga/projects/notifications/services.py`** — The `send_notifications()` function (lines 243–256) demonstrates the "batch-via-DB-record + `select_for_update()`" deduplication pattern that prevents double-send when multiple events fire in a short window. This is directly applicable to our weekly update reminder and escalation queue design, where we also need idempotent notification dispatch.

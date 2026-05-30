# Plane — PMO Control Tower Utilization Report

**Repo:** makeplane/plane  
**Clone path:** research/vendor/plane  
**Upstream:** https://github.com/makeplane/plane  
**Report date:** 2026-05-30

---

## 1. Identity

| Field | Value |
|-|-|
| Repo name | Plane |
| URL | https://github.com/makeplane/plane |
| Primary language | Python (Django 4.x) backend + TypeScript/React frontend |
| Backend framework | Django REST Framework, Celery, RabbitMQ, Redis |
| Frontend framework | React 18.3 + React Router 7 (Vite, NOT Next.js) + MobX 6 |
| Database | PostgreSQL (primary) + Redis (cache/queues) + MinIO (object storage) |
| License | AGPL-3.0-only (verified: `LICENSE.txt` line 1; `package.json` `"license": "AGPL-3.0"`) |
| Version | 1.3.1 (verified: `package.json` `"version": "1.3.1"`; 121 Django migrations in `apps/api/plane/db/migrations/`) |
| Activity | Active — single-commit clone (`248f5d6`, recent refactor of API rate-limit); 121 migrations indicate a mature, continuously evolving schema |
| Build tooling | pnpm 11 workspaces + Turborepo; Vite for frontend |

**Notable finding on the frontend stack:** The web app (`apps/web/`) uses **Vite + React Router 7**, not Next.js. There are compat shims (`apps/web/app/compat/next/`) that alias `next/link`, `next/navigation`, and `next/script` to React Router equivalents — evidence of a recent migration away from Next.js. `react-router.config.ts` explicitly sets `ssr: false` (client-side SPA only). Our target stack is Next.js 16/App Router; this is a meaningful divergence.

---

## 2. Architecture

Plane is a **pnpm monorepo** (Turborepo) with a hard split between a Django REST API and a React SPA.

```
apps/
  api/          Django backend (plane/ Python package)
  web/          React 18 SPA (Vite + React Router 7)
  admin/        Admin SPA
  space/        Public board embed
  live/         Realtime collaboration service
  proxy/        Nginx proxy
packages/
  ui/           Component library
  types/        Shared TypeScript types
  constants/    Shared constants (plans, feature flags)
  editor/       Tiptap-based rich text editor
  hooks/        Shared React hooks
  services/     API service layer
  tailwind-config/
```

**Backend layout** (`apps/api/plane/`):
- `db/models/` — all Django ORM models, one file per entity domain
- `app/views/` — view classes grouped by domain (issue/, project/, workspace/, search/, etc.)
- `app/permissions/` — permission class hierarchy (base.py, project.py, workspace.py)
- `bgtasks/` — Celery async tasks
- `celery.py` — Celery beat schedule (cron jobs)
- `authentication/` — OAuth adapters (GitHub, Google, GitLab, Gitea)
- `license/` — instance edition model (currently only `PLANE_COMMUNITY`)

**Data layer:** Pure Django ORM over Postgres. No Supabase, no RLS, no pg_cron — all DB access is through Django queries with application-layer permission checks. A `SoftDeletionManager` (`db/mixins.py`) implements logical soft deletes: rows get a `deleted_at` timestamp instead of being removed.

**Adding a new module:** Add a model in `db/models/`, register in `db/models/__init__.py`, run `manage.py makemigrations`, add a viewset in `app/views/`, register URLs in `urls.py`, add a MobX store in `apps/web/core/store/`. There is no plugin or feature-module registration system; it is a classic Django add-feature-in-place approach.

---

## 3. How Plane handles each of our concerns

### Data model for projects, departments/teams/groups, and tasks

Plane's hierarchy is **Workspace → Project → Issue** with no native "department" layer. Workspace (`db/models/workspace.py`: `class Workspace`) is the top-level tenant. `Project` (`db/models/project.py`: `class Project`, line 68) belongs to a workspace via `workspace = models.ForeignKey("db.WorkSpace")`. Issues (`db/models/issue.py`: `class Issue`, line 104) belong to a project. A `Team` model exists (`workspace.py` line 261) but it is only a lightweight grouping within a workspace — no data isolation, no scoping to subsets of projects. There is no equivalent to our "department" as an isolation boundary.

### Roles, permissions, and data isolation between teams/groups

Roles are integer constants: **Admin=20, Member=15, Guest=5** at both workspace and project levels (`workspace.py` line 19 `ROLE_CHOICES`; `app/permissions/base.py` line 13 `class ROLE(Enum)`). `WorkspaceMember` and `ProjectMember` tables join users to their role.

**Isolation is enforced entirely at the application layer** — every queryset in views manually filters by `project__project_projectmember__member=self.request.user` (e.g. `app/views/search/base.py` line 70–79). There is **no DB-level Row Level Security**. A team member who somehow crafts a direct SQL query or hits a buggy view can access any row. For our PMO requirements — "department isolation enforced at the DATABASE layer" — this is a direct miss. Plane has no equivalent mechanism.

The `allow_permission` decorator (`app/permissions/base.py` line 19) provides a concise role-checking shorthand, but it is an application-layer guard, not a database guarantee.

### Status (RAG or equivalent) and status history

Plane has **workflow states** (`db/models/state.py`): `BACKLOG, UNSTARTED, STARTED, COMPLETED, CANCELLED` groups, each with a custom color. These are project-configurable. There is **no Red/Amber/Green semantic** — states are arbitrary text labels with hex colors. Priority is a separate field: `urgent/high/medium/low/none`.

Status history is captured indirectly via `IssueActivity` (`issue.py` line 415): every field change (including `state`) is logged as a row with `field`, `old_value`, `new_value`, `verb`, `actor`, and an `epoch` float timestamp. `IssueVersion` (`issue.py` line 677) additionally snapshots the entire issue state each time a change is made. No RAG-specific logic or automated escalation based on status colour exists.

### Approvals or workflow states (draft → pending → approved transitions)

The **Intake** feature (`db/models/intake.py`) provides the closest approximation: `IntakeIssue.status` cycles through `PENDING(-2) → REJECTED(-1) / SNOOZED(0) / ACCEPTED(1) / DUPLICATE(2)`. This is a lightweight triage/approval for new work item submissions, not a full approval workflow across arbitrary transitions.

The commercial plans page (`apps/web/core/constants/plans.tsx` line 717) lists **"Approvals"** (for workspace, project, and work item type approvals) as a Business/Enterprise feature marked `comingSoon: true` — meaning it is **not yet shipped even in the paid edition**. The open Community codebase has no approval workflow.

### Baseline, revisions, and change tracking (snapshots, versioning, deltas)

Two versioning mechanisms exist in the open code:

1. **`IssueVersion`** (`issue.py` line 677): created by `log_issue_version()` classmethod (line 737). Stores a full snapshot of the issue's fields as a new row each time an issue is saved. Linked back to the triggering `IssueActivity` row. `ChangeTrackerMixin` (`db/mixins.py` line 92) captures `_original_values` on load and computes `changed_fields` before save.

2. **`IssueDescriptionVersion`** (`issue.py` line 782): snapshots the rich text description separately.

There is no "lock baseline" concept, no named baseline, and no delta comparison UI. The version rows are append-style (new row per change) but can be deleted with the issue (CASCADE). The Celery task `delete_issue_description_versions` (`celery.py` line 83) prunes old description version rows — versions are **not guaranteed to be retained indefinitely**.

### Audit trail / activity log, and whether it is tamper-resistant

`IssueActivity` (`issue.py` line 415) is the audit log. Key facts:
- `on_delete=models.DO_NOTHING` on the `issue` FK (line 416) means activity rows survive if the issue is soft-deleted.
- There is **no `delete` endpoint** for activity rows in the public API — `IssueActivityDetailAPIEndpoint` (`api/views/issue.py` line 1706) exposes only `GET`.
- However, rows are **not cryptographically protected** and can be deleted at the database level. No append-only trigger, no pg_audit, no hash chain.
- **"API-enabled Audit Logs"** (plans.tsx line 751) is listed as Business/Enterprise, `comingSoon: true` — not shipped.
- **"Workspace Activity Logs"** (plans.tsx line 740) is also Business/Enterprise only.

Conclusion: the open code has a per-issue activity log that is effectively write-once through the API, but it is not tamper-resistant at the DB level and the workspace-wide audit log is a paid, unreleased feature.

### Dependencies between items, and any visual dependency map

`IssueRelation` (`issue.py` line 296) supports three types: `duplicate`, `relates_to`, `blocked_by` (via `IssueRelationChoices`, line 272). `IssueBlocker` (`issue.py` line 258) is a separate direct-blocker table. These relations are stored relationally and surfaced in the UI per-issue.

There is **no visual dependency graph** in the open Community code — no xyflow/react-flow integration, no network diagram. The Gantt layout referenced in route files (`layout.key === "gantt_chart"`) is cycle/module timeline, not a dependency graph. No `xyflow` or `reactflow` package appears in `pnpm-workspace.yaml`.

### Dashboards and reporting

A `dashboard.store.ts` exists in `apps/web/core/store/`. Analytics (`db/models/analytic.py`) stores saved analytic view configurations per workspace. The `ExporterHistory` model (`db/models/exporter.py` line 24) supports CSV, JSON, XLSX exports of issues.

No executive cross-department dashboard exists. Dashboards are per-workspace, scoped to issues the user can already see.

### Notifications, scheduled jobs, and any escalation logic

Notifications use a **Celery + Django pattern**:
- `notification_task.py` (`bgtasks/`) creates `Notification` rows and queues email sends.
- `email_notification_task.py` stacks and deduplicates emails; `celery.py` line 46–48 fires it every 5 minutes via `crontab(minute="*/5")`.
- Daily cleanup and automation jobs run via Celery beat (`celery.py` lines 55–94).
- `issue_automation_task.archive_and_close_old_issues` (line 60) is the only escalation-style automation — it archives/closes stale issues on a schedule.

There is **no overdue-update reminder, no weekly-cadence reminder, no escalation ladder** (e.g., remind → escalate to director → escalate to executive). The "Trigger And Action" automation (plans.tsx line 769) is a Pro+ paid feature.

### Search (and whether it respects access rules)

`GlobalSearchEndpoint` (`app/views/search/base.py` line 45) performs `icontains` text search across issues, projects, cycles, modules, and pages. Every sub-query joins on `project_projectmember__member=self.request.user` (line 70–79), so search respects project membership at the application layer. No full-text index or vector search — pure `ILIKE` queries. No cross-project isolation beyond project membership.

### Authentication and any SSO / Microsoft / OIDC / SAML integration

Community open code supports: email/password, magic links, GitHub OAuth, Google OAuth, GitLab OAuth, Gitea OAuth (`authentication/provider/oauth/`).

**SAML and OIDC are commercial-only** (plans.tsx lines 1060–1081): SAML is Pro/Business/Enterprise on cloud; OIDC is self-hosted Pro+. Neither is implemented in the open code — no `python-social-auth` OIDC backend, no `djangosaml2` dependency, no Microsoft/Azure Entra adapter exists in `authentication/`. Our requirement of Microsoft Entra ID SSO (OIDC) cannot be borrowed from this codebase.

---

## 4. Code quality & docs

**Readability:** The Django backend is clean, conventionally structured Django. Model files follow a consistent pattern (BaseModel, soft-delete, verbose_name, db_table). The `ChangeTrackerMixin` has inline docstrings explaining its contract. View files are large (issue.py in the API views is 1700+ lines) but logically grouped.

**Modularity:** Backend domain split by model file and view subfolder is reasonable. However, the permission system is app-layer-only and tightly coupled to ORM queries inside each view — not cleanly injectable. The frontend MobX stores (`apps/web/core/store/`) are well-organized by domain but are tightly coupled to Plane's own API service layer.

**Test coverage:** 37 test files under `apps/api/plane/tests/` covering smoke, contract, and unit tests. Presence of `factories.py` suggests factory-based fixtures. Coverage appears moderate for a product this size — no evidence of end-to-end or frontend tests in the clone.

**Documentation:** `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `AGENTS.md` all present. No dedicated API reference docs in the repo (OpenAPI annotations visible in view files suggest auto-generated docs). Architecture docs are sparse — the repo leans on community knowledge.

---

## 5. License implications

License: **AGPL-3.0-only** (confirmed in `LICENSE.txt` and `package.json`).

AGPL-3.0 is a strong copyleft license. Key consequences for a proprietary, internally-hosted product:

- **If you deploy Plane as-is** for internal use with modifications, AGPL requires you to provide source to all users who interact with it over a network — including your internal users. For a strictly internal product with no external access this may be manageable, but it is legally complex.
- **If you copy AGPL code into your own proprietary codebase**, the entire combined work becomes subject to AGPL. You cannot ship PMO Control Tower as a proprietary/resold product containing Plane code.
- **Pattern reuse (ideas, algorithms, approaches) is fine** — copyright does not protect ideas, only expression. You can read Plane's permission model, its `IssueVersion` snapshot approach, or its Celery notification pattern and independently reimplement them in your TypeScript/Supabase stack without any AGPL obligation.

**What is open vs commercial:**
- **Open (Community):** Core issue tracker, states, basic roles, `IssueActivity` log per-issue, Intake triage, GitHub/Google OAuth, Celery notifications, CSV/JSON/XLSX export, per-workspace analytics views.
- **Commercial only (not in this repo):** SAML/OIDC SSO, full workspace audit logs (API-enabled), Approvals workflow (`comingSoon`), Workspace Activity Logs, Admin interface, advanced automations (Trigger/Action), time tracking approvals. These features are listed in `apps/web/core/constants/plans.tsx` behind paid plan gates and have zero implementation code in this clone.

**Bottom line:** AGPL forbids direct code reuse in a proprietary product. The most valuable governance features (approvals, audit logs, SSO) are not in the open code anyway. Read for patterns only.

---

## 6. Modifiability assessment

The honest assessment: Plane is a **moderate fit as a reference** but a **poor fit as a codebase to adapt or extend**. The backend is Python/Django while our stack is TypeScript/Postgres/Supabase. The frontend migrated from Next.js to Vite+React Router (CSR-only), moving in the opposite direction from our App Router SSR target. The governance features we care most about (approvals, audit trail, department isolation, escalation, OIDC) are either absent, commercial-only, or application-layer-only (not DB-enforced). The AGPL license bars code reuse.

**Scores (1–5, 5 = most useful to us):**

| Criterion | Score | Justification |
|-|-|-|
| stackProximity (×3) | 2 | Backend is Django/Python (not TS); frontend is Vite+React Router CSR, not Next.js App Router; Postgres is the only shared piece |
| modularity (×2) | 3 | Domain split by model file and view folder is decent; but permission logic is embedded in querysets, not cleanly isolated |
| governanceCoverage (×2) | 2 | Approvals are paywalled+unreleased; no DB-layer isolation; no escalation ladder; no RAG; no baseline locking; audit trail is incomplete |
| codeClarity (×1) | 4 | Django code is readable, consistent patterns, decent docstrings on mixins; frontend stores well-organized |
| licensePosture (×1) | 1 | AGPL-3.0 is maximally hostile to a proprietary resold/hosted product — direct reuse is off the table |
| maintenance (×1) | 4 | Active development, 121 migrations, recent commits, v1.3.1 released |

---

## 7. Files most worth studying

1. **`apps/api/plane/db/models/issue.py`**  
   Lines 415–450 (`IssueActivity`), 677–780 (`IssueVersion`/`IssueDescriptionVersion`), 258–320 (`IssueBlocker`, `IssueRelation`). The append-style activity log pattern, the full-state snapshot approach in `IssueVersion.log_issue_version()`, and the relation-type enum design are directly applicable patterns for our audit trail and version/delta modules.

2. **`apps/api/plane/db/mixins.py`**  
   Lines 92–175 (`ChangeTrackerMixin`). Compact, well-documented pattern for capturing old field values before save and emitting change records. Directly translatable to a TypeScript Supabase trigger or service-layer hook.

3. **`apps/api/plane/app/permissions/base.py`**  
   The `allow_permission` decorator and `ROLE` enum. Shows a clean way to enforce role checks as a view-level decorator — useful as a reference for designing our own app-layer guard (while we separately implement Supabase RLS for DB-layer isolation).

4. **`apps/api/plane/db/models/intake.py`**  
   The `IntakeIssue` status state machine (`PENDING → ACCEPTED/REJECTED/SNOOZED/DUPLICATE`) is the clearest, most borrowable workflow-state pattern in the open code. It is simple but shows the integer-enum + status transition record structure we can adopt for our own Approvals module.

5. **`apps/api/plane/celery.py`**  
   The Celery beat schedule. Documents the operational pattern for recurring governance jobs (every-5-min email stacking, nightly archiving). We will implement equivalent logic in Supabase pg_cron + Edge Functions, but the job taxonomy and scheduling cadence are a useful reference.

# OpenProject — PMO Control Tower Utilization Report

**Repo:** https://github.com/opf/openproject
**Clone reviewed:** `/Volumes/Passport/PMO/research/vendor/openproject`
**Report date:** 2026-05-30

---

## 1. Identity

| Field | Value |
|-|-|
| Repo name | OpenProject |
| URL | https://github.com/opf/openproject |
| Primary language | Ruby 4.0.2 (see `.ruby-version`), Rails ~8.1.3 (see `Gemfile`) |
| Frontend | TypeScript 5.9.x + Angular 21.x (see `frontend/package.json`) |
| Database | PostgreSQL (required; no MySQL support) |
| License | **GPL-3.0** — confirmed in `LICENSE` and `COPYRIGHT` |
| Latest release | **17.4.0** (from `publiccode.yml`, `releaseDate: 2026-05-13`) |
| Branch/commit | `dev` branch, latest commit: `Merge branch 'release/17.5' into dev` |
| Activity | Actively developed; most recent DB migration dated 2026-05-28 (`20260528120000_add_charset_to_attachments.rb`); 114 migrations tracked |
| Edition split | Community (GPL) + Enterprise (EE, token-gated); key governance features are EE-only (SSO, date alerts, LDAP groups, portfolio management, team planner, baseline comparison banner) |

OpenProject is a mature Rails monolith with an Angular legacy frontend being migrated to Hotwire (Turbo + Stimulus) + ViewComponent. It is **not** written in our stack (TypeScript/React/Next.js) and uses Rails app-layer permission checks rather than Postgres RLS for isolation.

---

## 2. Architecture

OpenProject is a **modular Rails monolith**. The `app/` directory holds core Rails MVC. Optional capabilities live as Rails engines under `modules/` (e.g., `modules/gantt`, `modules/budgets`, `modules/openid_connect`, `modules/reporting`, `modules/xls_export`). Each engine ships its own `app/`, `config/`, `db/` sub-directories and registers itself via a gemspec and `Gemfile.modules`. Adding a new module means creating a new engine under `modules/`, declaring its gem, and hooking into OpenProject's plugin/permission registry (`lib/open_project/access_control/`).

**Backend:** Rails 8 + ActiveRecord + PostgreSQL. Service objects in `app/services/`, contracts in `app/contracts/` (dry-validation style), background jobs via GoodJob (Postgres-backed ActiveJob). No Sidekiq, no Redis required.

**Frontend:** Angular 21 SPA wired into Rails-rendered pages. Migration toward Hotwire/Stimulus with ViewComponents (`lookbook/` for previews). The legacy Angular codebase (`frontend/src/app/`) is large (~1M+ LOC total); new UI is being written as Stimulus controllers and ViewComponents.

**Data layer:** One Postgres database, no sharding. Tables are shared; row-level isolation is enforced by application-layer scopes (`Project.allowed_to`, `WorkPackage.allowed_to`) rather than Postgres RLS policies. A new feature integrates into the existing schema via migrations under `db/migrate/tables/`.

---

## 3. How it handles each concern

### Data model: projects, departments/teams/groups, tasks

Projects are the primary organizational unit (`app/models/project.rb`). OpenProject has **no department concept** — there is no `departments` table. Organizational units are modeled as:

- **Projects** with a `workspace_type` enum: `project | program | portfolio` (lines 46–55, `app/models/project.rb`). Portfolio > Program > Project nesting is allowed per `ALLOWED_PARENT_WORKSPACE_TYPES`.
- **Groups** (`app/models/group.rb`): user groups inheriting from `Principal`, with optional parent group hierarchy. Groups are added as project members but are not the same as a "department" with isolated data.
- **Work packages** (tasks/issues): `db/migrate/tables/work_packages.rb` defines the core row — `project_id`, `status_id`, `type_id`, `assigned_to_id`, `start_date`, `due_date`, `done_ratio`, `parent_id` (hierarchy). Work packages belong to one project; cross-project dependencies exist via the `Relation` model.

There is no first-class "department" table with built-in isolation. Mapping SolServices' nine departments to OpenProject would require either nine top-level projects or nine programs under a portfolio — with access control set per-project membership.

### Roles, permissions, and team/data isolation

**Permission model (`lib/open_project/access_control/permission.rb`, `app/models/role.rb`, `app/models/member.rb`):**

- Permissions are granular named symbols (e.g., `:view_work_packages`, `:edit_work_packages`) registered per module.
- A `Role` carries a set of `RolePermission` rows. Roles include built-in non-member and anonymous roles.
- A `Member` row joins a `Principal` (user or group) to a `Project` with one or more roles via `MemberRole`.
- The `Workflow` model (`app/models/workflow.rb`) governs which status transitions a role can make (old_status → new_status per role + type combination).

**Isolation enforcement:** Application-layer SQL scopes, NOT Postgres RLS. `Project.allowed_to(user, permission)` (`app/models/projects/scopes/allowed_to.rb`) builds a SQL JOIN through `members` → `member_roles` → `role_permissions`. If a user has no membership in a project, that project's work packages are simply excluded from query results. A user in Department A cannot see Department B's work packages **only if** they have no membership in B's project. There is no DB-enforced row filter; a compromised app layer could leak data. The `admin?` guard bypasses all permission checks.

**Verdict for our needs:** The isolation logic is robust at the application layer but **not** enforced at the database layer (no RLS). This is a significant architectural gap versus our requirement for "database-layer isolation."

### Status (RAG or equivalent) and status history

**Work-package level:** `Status` model (`app/models/status.rb`) — named statuses with a `Color` association. Not a native RAG (red/amber/green); it's a custom list. Admins define statuses like "In Progress", "Closed". Status transitions are journalized (every change recorded in `work_package_journals`, joined to `journals` via polymorphic `journable_id/type`).

**Project level (native RAG-equivalent):** `Project` has `status_code` enum: `on_track: 0, at_risk: 1, off_track: 2` (line 201, `app/models/project.rb`) plus `status_explanation` text field. Changes to `status_code` are journalized via `register_journal_formatted_fields "status_code", formatter_key: :project_status_code` (line 151). This is the closest analog to RAG. History is readable through the journals system.

### Approvals or workflow states

There is **no dedicated approval module**. OpenProject does not have a draft → pending → approved pattern with an approver role. What exists:

- Status transitions gated by role via the `Workflow` model: only users with the right role can move a work package from status X to status Y.
- Custom actions (`modules/` area) can automate status transitions.
- The backlogs module has sprint review concepts, but these are not formal approvals.

For our PMO's director-approval-of-updates requirement, OpenProject provides no direct analog — it would need to be built on top of its workflow/status system.

### Baseline, revisions, and change tracking (snapshots, versioning, deltas)

**This is OpenProject's strongest governance feature.** The journaling system creates a full snapshot history:

- `journals` table (`db/migrate/tables/journals.rb`): polymorphic `journable_id/type`, `version` integer, `validity_period` tstzrange, `cause` JSONB. An exclusion constraint `non_overlapping_journals_validity_periods` ensures validity periods do not overlap — this is a sophisticated temporal design.
- `work_package_journals` (`db/migrate/tables/work_package_journals.rb`): stores a full copy of all WP fields at each journal version. Diffs are computable field-by-field.
- **Baseline comparison feature** (`frontend/src/app/features/work-packages/components/wp-baseline/`): allows comparing the current state of a work package list against a past timestamp. Implemented via `Journable::WithHistoricAttributes` (`app/models/journable/with_historic_attributes.rb`) — wraps any `Journable` to expose `.attributes_by_timestamp[ts]` for any past point. The baseline UI component imports `BannersService` (enterprise banner) indicating baseline comparison may be partially EE-gated for certain displays, but the underlying `WithHistoricAttributes` API is in community code.

This pattern — immutable journal rows with tstzrange validity periods — is the single most valuable architectural pattern to study for our audit trail + baseline module.

### Audit trail / activity log, tamper-resistance

**Architecture:** The `acts_as_journalized` plugin (`lib_static/plugins/acts_as_journalized/`) hooks into ActiveRecord callbacks to write new `Journal` rows on every save. The journals controller (`app/controllers/journals_controller.rb`) exposes only `index` (Atom feed) and `diff` actions — there is **no `update` or `destroy` action** on journals, meaning the HTTP API cannot edit or delete journal entries. However:

- Journal notes (comments) can be edited by users with `edit_own_work_package_comments` permission (referenced in `app/models/journal.rb` `acts_as_attachable` block).
- There is no DB-level constraint preventing admin deletion of journal rows via SQL.
- The `journals` table has no `NOT DELETABLE` trigger or cryptographic chaining.

**Verdict:** Practically append-only by convention and API surface, but not cryptographically tamper-resistant. A DBA or admin can delete journal rows. For our PMO's tamper-resistant requirement, the pattern is instructive but insufficient as-is — we would need to add Postgres triggers or hash-chaining on top.

### Dependencies between items, and visual dependency map

`Relation` model (`app/models/relation.rb`) stores directed edges between work packages: `TYPE_PRECEDES / FOLLOWS`, `TYPE_BLOCKS / BLOCKED`, `TYPE_INCLUDES / PARTOF`, `TYPE_DUPLICATES`, `TYPE_RELATES`, `TYPE_REQUIRES`. The Gantt chart (`modules/gantt/`) renders these as a timeline with dependency arrows. There is no standalone interactive node-graph (no xyflow-style visualization); dependencies are shown only in the Gantt bar chart view. The Gantt frontend is Angular-based, not React/xyflow.

### Dashboards and reporting

- **My Page / Grids** (`modules/grids/`): configurable widget dashboard. Available widgets include project status, member list, news, description (`modules/grids/app/components/grids/widgets/`).
- **Reporting module** (`modules/reporting/`): cost/time reporting with its own controller, models, and views.
- **XLS export** (`modules/xls_export/`): spreadsheet export of work package queries.
- Dashboards are per-user "My Page" grids, not executive cross-department portfolio views. There is no built-in executive dashboard showing all departments' RAG statuses in one view.

### Notifications, scheduled jobs, escalation logic

**Job queue:** GoodJob (Postgres-backed, gem `good_job ~> 4.18.2`) runs all background jobs. No Redis/Sidekiq.

**Cron pattern:** `app/workers/cron/quarter_hour_schedule_job.rb` defines `Cron::QuarterHourScheduleJob` — a concern that uses `GoodJob::ActiveJobExtensions::Concurrency` with `enqueue_limit: 1, perform_limit: 1` to prevent duplicate runs. Jobs track predecessor `cron_at` to handle gaps during downtime without double-sending. This is the anti-double-send pattern we need for our weekly update reminders.

**Date alerts** (`app/workers/notifications/schedule_date_alerts_notifications_job.rb`): fires every 15 minutes, checks which users' local time is 1:00 AM, and enqueues per-user alert jobs. **EE-gated:** `return unless EnterpriseToken.allows_to?(:date_alerts)`.

**Reminders** (`app/models/reminder.rb`, `app/workers/reminders/schedule_reminder_job.rb`): personal work-package reminders. Community edition feature.

**There is no escalation engine** — no built-in logic to detect "update is late" and escalate to a manager. That concept does not exist in OpenProject.

### Search

`SearchController` (`app/controllers/search_controller.rb`) uses `load_and_authorize_in_optional_project` as a `before_action` — this resolves the optional scoped project and calls `User.current.allowed_based_on_permission_context?` before searching. Search queries call `klass.search(tokens, projects_to_search, ...)` where `projects_to_search` is filtered to only projects the current user can access. Search results respect project-level permissions. Full-text search uses Postgres GIN trigram indexes (the `journals` table defines `using: "gin", opclass: :gin_trgm_ops` on `notes`).

### Authentication and SSO / Microsoft OIDC

**Modules present:** `modules/openid_connect/` (OIDC), `modules/auth_saml/` (SAML). Both are in the GPL codebase but **EE-gated at runtime**: creating/managing OIDC or SAML providers redirects to `index` unless `EnterpriseToken.allows_to?(:sso_auth_providers)` (confirmed in `modules/openid_connect/app/controllers/openid_connect/providers_controller.rb:138` and `modules/auth_saml/app/controllers/saml/providers_controller.rb:136`).

There is **no Microsoft Entra ID / Azure AD integration** specifically — the OIDC module is generic and could theoretically connect to Entra but is not documented or tested for it. No Microsoft Graph API integration exists in this codebase.

---

## 4. Code quality and docs

**Quality:** Rails code follows standard conventions. Service objects and contracts are clearly separated. The journaling library (`lib_static/plugins/acts_as_journalized/`) is well-structured with clear modules. RSpec test suite contains 2,825+ spec files — coverage is extensive.

**Documentation:** `CLAUDE.md` (agent instructions), `CONTRIBUTING.md`, `docs/` directory with API docs and user guides. API is documented in OpenAPI/YAML format under `docs/api/apiv3/`. The codebase is very large (~840 MB, ~1M+ LOC) — no single developer can hold it in their head.

**Readability:** Individual files are clean and well-commented. But the system is complex enough that understanding a flow requires tracing through controllers → contracts → service objects → models → concerns. Module interdependencies are not always obvious.

**Modularity:** The `modules/` engine pattern means individual features (budgets, gantt, reporting) are somewhat separable as gems. However, most share the core `app/` models and permission registry, so true isolation is limited.

---

## 5. License implications

**License: GPL-3.0** (confirmed in `LICENSE` and `COPYRIGHT`).

GPL-3.0 is a strong copyleft license. Key implications:

- **You MAY NOT** include GPL-3.0 code in a proprietary, closed-source, or commercially-resold/hosted product without releasing all combined code under GPL-3.0.
- **You MAY** study the code, understand patterns, and independently reimplement concepts (ideas and algorithms are not copyrightable). You can build a proprietary product inspired by OpenProject's architecture without copying source code.
- **EE features** (OIDC/SAML SSO, date alerts, baseline comparison UI, portfolio management, LDAP groups, team planner): these are in the GPL codebase but require a paid OpenProject Enterprise Token to activate. Studying them is fine; copying them is still GPL-encumbered.
- **`lib_static/plugins/acts_as_journalized/`**: This library itself contains MIT-licensed code from Steve Richert (declared in the file header) but is bundled inside a GPL project. Direct reuse requires verifying the MIT segments are clearly separable — practically, you should reimplement the journaling pattern independently.

**Summary for PMO Control Tower:** Read the code freely for patterns. Do NOT copy any Ruby/Angular source into your TypeScript/Next.js product. The journaling schema design (tstzrange validity periods, polymorphic journable, snapshot tables) can be reimplemented independently in Postgres/Supabase without license risk.

---

## 6. Modifiability assessment

OpenProject is a **poor candidate for direct adoption or forking** for our PMO Control Tower. The stack mismatch (Rails/Angular vs. Next.js/React/TypeScript), GPL license, lack of Postgres RLS, no native department isolation, no approval workflow, EE-gated SSO and date alerts, and the ~1M LOC complexity make adaptation prohibitively expensive. The value is entirely in studying patterns to reimplement.

| Criterion | Score | Justification |
|-|-|-|
| stackProximity | 1 | Rails + Angular; our stack is Next.js + React + TypeScript + Supabase. Nearly zero overlap. |
| modularity | 2 | Rails engine modules are somewhat separable but all depend on shared Rails core models/permissions; cannot lift a single concern cleanly. |
| governanceCoverage | 3 | Journals/baseline and project-level RAG (on_track/at_risk/off_track) are directly relevant; no approval workflow, no escalation engine, no department isolation at DB layer. |
| codeClarity | 3 | Clean Rails conventions, good test coverage, but very large and complex; audit trail and permission patterns are readable once located. |
| licensePosture | 1 | GPL-3.0 prohibits code reuse in a proprietary hosted product; code can only be studied for patterns. |
| maintenance | 5 | Actively maintained; 17.4.0 released 2026-05-13, migrations as recent as 2026-05-28, stable development status. |

**Weighted score (informational):** stackProximity×3 + modularity×2 + governance×2 + clarity×1 + license×1 + maintenance×1 = 3+4+6+3+1+5 = 22 / 50.

---

## 7. Top files / modules most worth studying

1. **`db/migrate/tables/journals.rb`** — The journals table definition with `tstzrange validity_period`, exclusion constraint for non-overlapping periods, and GIN trigram index on notes. This is the cleanest example of a temporal audit log with period-based versioning in pure Postgres DDL. Directly reimplement this pattern in Supabase for our audit trail.

2. **`app/models/journable/with_historic_attributes.rb`** — Documents (with extensive inline comments) how to wrap any model to expose its historical attribute state at any timestamp. The `baseline_attributes` / `attributes_by_timestamp` pattern is the reference design for our Baseline / Revisions / Delta module.

3. **`app/workers/cron/quarter_hour_schedule_job.rb`** — The GoodJob concurrency + predecessor-cron_at tracking pattern to prevent double-send and handle gaps during downtime. Directly maps to our weekly update reminder and escalation scheduling logic (reimplement with pg_cron + pg_net or Supabase Edge Functions + cron).

4. **`app/models/projects/scopes/allowed_to.rb`** — Shows how to build SQL-level project access filtering (JOIN through members → member_roles → role_permissions) at the ORM scope level. Study this to inform how we structure our Supabase RLS policies and PostgREST queries — but implement it as actual Postgres RLS, not app-layer scopes.

5. **`app/models/project.rb` (lines 46–55, 201–204)** — The `workspace_type` enum (project/program/portfolio) and `status_code` enum (on_track/at_risk/off_track) with journaling hooks. This is the data model reference for our Projects & Departments + RAG Status modules.

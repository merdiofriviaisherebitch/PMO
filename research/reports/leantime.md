# Leantime — PMO Control Tower Utilization Report

---

## 1. Identity

| Field | Value |
|-|-|
| Repo | Leantime |
| URL | https://github.com/Leantime/leantime |
| Primary language | PHP 8.2+ |
| Framework | Laravel 11 (custom bootstrap, extended core) |
| Database | MySQL 8.0+ or MariaDB 10.6+ (PostgreSQL and MS SQL also supported via Laravel Schema Builder) |
| Frontend | jQuery 3.7.1 + Bootstrap 2.x + HTMX (migration in progress); Tailwind 3.4 with `tw-` prefix; Laravel Mix/Webpack 5 build |
| License | **AGPL-3.0-only** — confirmed in `composer.json` and `LICENSE` |
| Latest version | **3.8.0** (verified in `app/Core/Configuration/AppSettings.php`, DB schema version 3.5.1) |
| Activity | Active — latest commit on main branch is a recent PR merge; CHANGELOG shows ongoing development with v3.8.0 completing the Blade migration and adding mobile API surface |

---

## 2. Architecture

Leantime is a **PHP monolith** on Laravel 11, with a domain-driven directory layout that provides moderate modularity at the file-system level.

**Directory skeleton:**
- `app/Core/` — framework glue: Application, middleware stack, auth guards, DB abstraction, event dispatcher, template engine.
- `app/Domain/` — **56 domain modules** (Tickets, Projects, Users, Reports, Notifications, Audit, Queue, Cron, Goalcanvas, Strategy, Entityrelations, etc.). Each module contains `Controllers/`, `Hxcontrollers/`, `Services/`, `Repositories/`, `Models/`, `Templates/`, `Listeners/`, `register.php`.
- `app/Plugins/` — a git submodule pointing to a private commercial-plugin repo; empty in the OSS clone.
- `database/` — migrations directory is missing from this clone; schema is instead created by `app/Domain/Install/Services/SchemaBuilder.php` via Laravel Schema Builder.
- `public/`, `storage/`, `config/` — standard web-root, cache, and dotenv config.

**Backend/frontend split:** There is no separate frontend app. Templates are Laravel Blade (91 files, ~30% of views) alongside legacy `.tpl.php` (being removed in v3.8). HTMX handles partial updates; jQuery handles interactivity. The JSON-RPC endpoint (`app/Domain/Api/Controllers/Jsonrpc.php`) exposes every public `@api`-annotated service method.

**Adding a new module:** Create a new folder under `app/Domain/<Feature>/` following the Controller/Service/Repository/Model pattern, add a `register.php` for event listeners and scheduled jobs, and optionally add `routes.php` for Laravel-style routing (the legacy Frontcontroller still handles most routes via URL convention).

**Data layer:** Repositories use Laravel Query Builder (or raw SQL in older code) against a MySQL/Postgres database. Table prefix is `zp_`. There is no ORM; models are plain PHP objects with public properties. A `dbcall()` wrapper dispatches events around SQL execution.

---

## 3. How It Handles Each Concern

### Data model for projects, departments/teams/groups, and tasks

The hierarchy is: **Client** (`zp_clients`) → **Project** (`zp_projects`) → **Milestone/Ticket** (`zp_tickets`). There is no explicit "department" entity. The `zp_user` table has a `department` varchar column and a `clientId` FK, but departments are not first-class objects with enforced boundaries. Users are associated to projects via `zp_relationuserproject` (join table with `userId`, `projectId`, `projectRole`). Project access visibility is controlled by the `psettings` column on `zp_projects` (values: `assigned`, `clients`, `all`).

Paths: `app/Domain/Install/Services/SchemaBuilder.php` (createProjectsTable, createUserTable, createRelationUserProjectTable), `app/Domain/Projects/Repositories/Projects.php` (getUserProjects).

### Roles, permissions, and data isolation between teams/groups

Six hard-coded roles in `app/Domain/Auth/Models/Roles.php`: `readonly` (5), `commenter` (10), `editor` (20), `manager` (30), `admin` (40), `owner` (50). Enforcement is **application-layer only** — static methods `Auth::userIsAtLeast()`, `Auth::userHasRole()`, and `Auth::authOrRedirect()` compare the session-stored role integer. There is **no database-layer row-level isolation** (no RLS, no views, no row filters in the DB). Controllers and repositories manually include/exclude data based on session state. An admin (role ≥ 40) bypasses project `psettings` checks. Cross-department isolation does not exist as a formal concept: "department" is a freeform string field on `zp_user` with no enforcement.

Paths: `app/Domain/Auth/Services/Auth.php` (userIsAtLeast, authOrRedirect), `app/Domain/Projects/Repositories/Projects.php` (getUserProjects, lines 305–325), `app/Domain/Auth/Models/Roles.php`.

### Status (RAG or equivalent) and status history

Tickets have a numeric `status` field. Each project can define custom status labels stored as serialized PHP in `zp_settings` (key: `projectsettings.<id>.ticketlabels`). Labels have a `statusType` (e.g., `NEW`, `IN_PROGRESS`, `DONE`) and optional `kanbanCol` flag. **There is no RAG (Red/Amber/Green) concept**; colour is used on milestones only (a `tags` column on milestone tickets holds a CSS color variable). Change history is tracked in `zp_tickethistory` — rows of `{userId, ticketId, changeType, changeValue, dateModified}` are batch-inserted when a ticket is updated.

Paths: `app/Domain/Tickets/Services/Tickets.php` (getStateLabels, saveStatusLabels), `app/Domain/Install/Services/SchemaBuilder.php` (createTicketHistoryTable), `app/Domain/Tickets/Repositories/Tickets.php` (lines 1680–1710).

### Approvals or workflow states

A `zp_approvals` table exists (`module`, `entityId`, `requestorId`, `approverId`, `approvalStatus`, `requestedOn`, `lastStatusChange`) but there is **no active domain module using it** in the OSS codebase. No `Approvals` folder exists under `app/Domain/`. The table schema is defined in `SchemaBuilder.php` and the legacy SQL migration in `app/Domain/Install/Repositories/Install.php`, but no service or controller reads or writes to it. This is a stub or a commercial-plugin feature.

Paths: `app/Domain/Install/Services/SchemaBuilder.php` (createApprovalsTable, lines 210–222).

### Baseline, revisions, and change tracking

**No baseline/revision/delta concept exists.** Ticket field changes are logged as individual rows in `zp_tickethistory`, which provides a change log but not snapshots or baseline comparison. There is no concept of "locking the plan," tracking revisions against a baseline, or computing schedule variance. Goalcanvas tracks current vs. target values numerically but does not version them.

Paths: `app/Domain/Install/Services/SchemaBuilder.php` (createTicketHistoryTable), `app/Domain/Tickets/Repositories/Tickets.php` (storeHistory method ~line 1680).

### Audit trail and tamper-resistance

`zp_audit` stores `{id, userId, projectId, action, entity, entityId, values (JSON text), date}`. The `Audit\Repositories\Audit::storeEvent()` inserts rows; there is no UPDATE or DELETE method in the repository except `pruneEvents()` which deletes rows older than N days (`app/Domain/Audit/Repositories/Audit.php`, line 98). **The audit trail is therefore NOT tamper-resistant** — rows can be aged out, and the DB table has no immutability constraint. Usage is sparse: only `app/Domain/Wiki/Services/Wiki.php` (5 `storeEvent` calls) and `app/Domain/Cron/Services/Cron.php` (constructor injection only) use the audit repository. Ticket changes go to `zp_tickethistory` (not `zp_audit`).

Paths: `app/Domain/Audit/Repositories/Audit.php`, `app/Domain/Wiki/Services/Wiki.php`.

### Dependencies between items and visual dependency map

The `zp_entity_relationship` table (`entityA`, `entityAType`, `entityB`, `entityBType`, `relationship`, `createdOn`, `createdBy`, `meta`) is the polymorphic dependency store. The `zp_tickets` table also has a `dependingTicketId` FK for simple ticket-to-ticket blocking. However, there is **no visual dependency graph** in the OSS code. The `app/Domain/Entityrelations/` module contains only settings helpers (`getSetting`, `saveSetting`) — no service that queries actual relationships. No Gantt/network diagram for dependencies was found; the Gantt chart (Frappe Gantt fork) is timeline-only.

Paths: `app/Domain/Install/Services/SchemaBuilder.php` (createEntityRelationshipTable, lines 710–727), `app/Domain/Entityrelations/Repositories/Entityrelations.php`.

### Dashboards and reporting

The Dashboard domain (`app/Domain/Dashboard/`) is primarily a comment+reaction aggregator for a project homepage. Widget-based dashboards exist via `app/Domain/Widgets/` — widgets are registered components loaded lazily via HTMX (`hx-trigger="revealed"`). Reports (`app/Domain/Reports/`) provide sprint burndown charts and velocity data using Chart.js, plus a Gantt timeline. There is no executive cross-project dashboard. All reporting is scoped to the currently active project in session.

Paths: `app/Domain/Dashboard/Services/Dashboard.php`, `app/Domain/Widgets/Services/Widgets.php`, `app/Domain/Reports/Services/Reports.php`.

### Notifications, scheduled jobs, and escalation logic

Notifications are persisted in `zp_notifications` and also sent as emails. The `zp_queue` table (`msghash` PK prevents duplicates, `channel`, `userId`, `subject`, `message`, `thedate`, `projectId`) is a simple message queue processed by a Laravel Scheduler job every minute (EmailWorker) and every 5 minutes (HttpRequestWorker). The `msghash` primary key on `zp_queue` is the de-duplication mechanism — attempting to insert the same hash a second time is silently ignored.

Scheduling runs via a "poor man's cron": a PHP cron endpoint or a post-response shutdown hook calls `php bin/leantime schedule:run`, which invokes `app/Domain/Cron/Services/Cron.php::runScheduledTasks()`. Scheduled tasks are registered in domain `register.php` files listening to the `leantime.core.console.consolekernel.schedule.cron` event. Current registered jobs: email queue (1 min), HTTP-request queue (5 min), default queue (5 min), telemetry (daily), daily data ingestion (daily), marketplace plugin license validation (daily via Plugins).

**There is no escalation engine.** No scheduled job checks for overdue tickets, missing status updates, or stale dependencies and fires reminders/escalations.

Paths: `app/Domain/Queue/register.php`, `app/Domain/Cron/Services/Cron.php`, `app/Domain/Queue/Services/Queue.php`, `app/Domain/Notifications/Services/Notifications.php`.

### Search

Ticket search uses SQL `LIKE '%term%'` against `headline`, `description`, and `id` (`app/Domain/Tickets/Repositories/Tickets.php`, lines 552–560). Search is **scoped by the current project in session** — cross-project search is not offered in the OSS version. There is no full-text index, Elasticsearch, or vector search. Access rules are respected only because search always filters by `projectId` (the session-current project), not because of any explicit permission check during search.

Paths: `app/Domain/Tickets/Repositories/Tickets.php` (getAllBySearchCriteria, lines ~550–560).

### Authentication and SSO

Three auth guards: `leantime` (session), `sanctum` (Bearer token, requires AdvancedAuth commercial plugin), `jsonRpc` (API key). Native LDAP and OIDC (custom, `app/Domain/Oidc/`) are baked in. Laravel Socialite is installed with providers for **Microsoft, Microsoft Azure, SAML2, Authentik, Auth0, Okta, Keycloak, GitHub, GitLab, Google, Gitea, PropelAuth, EduID** — all listed in `composer.json`. Microsoft Entra ID (OIDC/OAuth2) is therefore supported but requires configuration. There is no Microsoft Graph API (Teams/Outlook) integration in the OSS code.

Paths: `app/Domain/Oidc/Services/Oidc.php`, `app/Domain/Auth/Services/Auth.php`, `composer.json` (socialiteproviders/* entries).

---

## 4. Code Quality and Docs

**Readability:** Mixed. Recent code (Notifications, Dashboard, Audit, Queue) is clean PHP 8.2 with typed properties, constructor DI, and phpdoc. Older repositories (Projects, Tickets) are verbose, mixing session reads inside repositories, and using raw `$_POST` in some controllers. The `zp_tickets` table has 30+ columns, many nullable with no constraints — typical of organic growth.

**Modularity:** Each domain is self-contained enough to be read in isolation, but cross-domain service calls are common and documented warnings about circular references exist (CLAUDE.md). Repositories are not formally separated from domain logic in the older modules.

**Test coverage:** Codeception acceptance tests exist for Login, Install, Tickets, Timesheets, Wiki, Goals, Blueprints, and User creation (`tests/Acceptance/`). Unit tests exist under `tests/Unit/` (Domain and Core sub-trees). PHPStan is run at **level 0** (minimal), suggesting limited static-type guarantees across the codebase.

**Documentation:** The repo includes a detailed `CLAUDE.md` (developer guide), phpdoc on most service methods, and inline architecture notes. Public docs exist at docs.leantime.io. The `@api` annotation system is documentation-only and not enforced at runtime.

---

## 5. License Implications

Leantime is **AGPL-3.0-only** (`composer.json` `license` field, confirmed by `LICENSE` file — GNU Affero General Public License v3).

**What AGPL-3.0 permits:** Running the unmodified software, reading the source for ideas, studying the architecture, reimplementing the same concepts independently.

**What AGPL-3.0 forbids for a proprietary hosted product:** Any derivative work (modified version) run as a network service **must** disclose the complete corresponding source to every user of that service. For a private internal tool (SolServices employees only, not public), legal risk is lower but not zero — AGPL's network-use clause applies to any user interacting over a network, including internal corporate users.

**CRITICAL:** Do **not** copy any PHP class, SQL migration, or template from this repository into the PMO Control Tower codebase. Doing so would create a derivative work obligating full AGPL source disclosure of the entire proprietary product. Even partial "inspiration" copies (e.g., copying a migration file verbatim) create legal exposure.

**Pattern reading is safe.** Understanding how Leantime structures its schema, schedules jobs, or dispatches events, and then reimplementing those ideas from scratch in TypeScript/Postgres is not a license violation — ideas and algorithms are not copyrightable.

**Commercial features:** The `app/Plugins/` submodule points to a private commercial-plugin repo. The approvals feature (zp_approvals table exists but no domain code) is likely behind a commercial plugin. Advanced Auth (Sanctum tokens) is commercial-plugin only.

---

## 6. Modifiability Assessment

Leantime is a PHP/MySQL/Laravel monolith. The PMO Control Tower will be built in TypeScript/Next.js/Supabase-Postgres. There is essentially zero direct code portability. The value is architectural pattern study only.

**Scores:**

| Criterion | Score | Justification |
|-|-|-|
| stackProximity | 1 | PHP + MySQL + jQuery — maximally distant from TypeScript, React, Postgres+RLS, Supabase |
| modularity | 3 | 56 domain folders with clear Service/Repo/Model layers; individual concerns are readable in isolation, but cross-domain coupling and session-threading limit clean extraction |
| governanceCoverage | 2 | Has projects, tickets, ticket-history, basic notifications, and custom status labels. Lacks approvals (stub only), baseline/revision discipline, escalation engine, department isolation, and RAG status — all core to PMO Control Tower governance |
| codeClarity | 3 | Recent modules are clean PHP 8.2; legacy modules use procedural patterns, raw `$_POST`, and session reads inside repositories. PHPStan level 0 means types are unverified |
| licensePosture | 1 | AGPL-3.0 — the most restrictive copyleft for a hosted product; no code can be reused in a proprietary build |
| maintenance | 4 | Active development; v3.8.0 just released with major Blade migration complete; recent commits; mobile API work under way |

**Weighted score (for reference):** stackProximity×3 + modularity×2 + governanceCoverage×2 + codeClarity×1 + licensePosture×1 + maintenance×1 = (1×3) + (3×2) + (2×2) + (3×1) + (1×1) + (4×1) = 3+6+4+3+1+4 = **21 / 50**

**Plain assessment:** Leantime is well-maintained, increasingly clean PHP, but it is the wrong language, wrong stack, wrong isolation model (app-layer vs. DB-layer), and encumbered by AGPL. Its patterns for scheduling (event-listener cron registration), de-duplication (msghash PK on queue), and project-to-user join tables are worth understanding but trivially reimplementable in TypeScript. Nothing here justifies the legal risk of closer adoption.

---

## 7. Top Files to Study

| Path | Why |
|-|-|
| `app/Domain/Install/Services/SchemaBuilder.php` | Complete schema for all 27 tables in one file; shows the full data model including projects, tickets, audit, queue, notifications, entity relationships, approvals stub — the fastest way to understand what Leantime stores and how it structures data. |
| `app/Domain/Projects/Repositories/Projects.php` | The `getUserProjects()` method (lines 264–360) is the canonical example of app-layer access control — shows exactly what psettings+role checks look like in SQL JOIN conditions, and why it is not DB-level isolation. Useful as a "what not to do" reference when designing Supabase RLS policies. |
| `app/Domain/Auth/Services/Auth.php` | `userIsAtLeast()` and `authOrRedirect()` show Leantime's entire permission model in ~80 lines: numeric role comparison from session, no policy objects, no DB enforcement. Useful contrast against Supabase RLS approach. |
| `app/Domain/Queue/register.php` + `app/Domain/Queue/Services/Queue.php` | Together they show the full notification-sending pipeline: Laravel Scheduler registration via event listener, `msghash` PK as idempotency key, worker dispatch. The idempotency pattern (hash-based dedup on a queue table) is directly reimplementable in Postgres. |
| `app/Domain/Audit/Repositories/Audit.php` | 107 lines showing what Leantime's audit trail actually is: insert-only storeEvent, join-enriched getEventsForEntity, and a `pruneEvents` that deletes old rows. The prune method makes clear the trail is NOT tamper-resistant — useful as a negative example when designing the PMO Control Tower's append-only audit requirement. |

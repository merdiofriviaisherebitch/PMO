# OpenPPM Utilization Report

**Prepared for:** PMO Control Tower project  
**Repo studied:** OpenPPM / https://github.com/OpenPPM/OpenPPM  
**Local clone:** `research/vendor/openppm`

---

## 1. Identity

| Field | Value |
|-|-|
| Repo | OpenPPM |
| URL | https://github.com/OpenPPM/OpenPPM |
| Primary language | Java 1.7 |
| Frameworks | Maven multi-module; Hibernate ORM; Quartz Scheduler; Jersey 2.19 (JAX-RS REST API); JAAS (PlainLoginModule); XStream (XML serialization for audit snapshots); JasperReports 4.7.1 |
| Frontend | JSP/JSTL server-side rendering (249 JSP files under `front/src/main/webapp/jsp/`); no modern JS framework |
| Database | MySQL 5.6 (single-tenant schema; `schemas/CreateDB.sql`). No Postgres. No RLS. |
| License | **GNU General Public License v3 (GPL-3.0)** — declared in every file header and in `pom.xml` copyright block. No separate LICENSE file exists at repo root; the pom.xml header is authoritative. |
| Latest release / version | `4.0-SNAPSHOT` (`pom.xml`). Only one commit in the shallow clone: `48b28f2` dated **2017-02-09** ("Update README.md"). |
| Activity level | **Dead.** Single commit visible, last touched February 2017, version still SNAPSHOT after 8+ years. No CI, no releases, no changelogs, no issue tracker activity visible from the repo. |

---

## 2. Architecture

OpenPPM is a **Maven multi-module monolith** deployed as a single WAR to a Java EE application server (Tomcat/JBoss). The modules are:

- `core/` — all business logic, DAOs (Hibernate Criteria API), model POJOs, audit, security logic, and notification logic. ~700 Java files.
- `front/` — JSP pages, Servlet controllers, Quartz scheduler jobs, REST endpoints (Jersey), LDAP auth utility. ~290 Java files + 249 JSP pages.
- `plugins/` — four optional plugins (`plugin-project-change`, `plugin-project-charter`, `plugin-project-close`, `plugin-project-synchronize`) each with their own Maven artifact.
- `clients/` — API client module.
- `integration/` — pom.xml only, empty module.
- `utils/` — shared utilities.
- `schemas/` — single SQL DDL file (`CreateDB.sql`), 3267 lines, MySQL 5.6 dump with ~75 tables.

There is **no separation of concerns** at the service boundary. Logic lives in `*Logic.java` classes inside `core/`, servlets in `front/` call logic classes directly, and HTML is rendered server-side via JSPs. There is no REST-first or API-first design except for the thin Jersey REST layer introduced in `front/src/main/java/es/sm2/openppm/api/rest/`. Adding a new module requires: adding a DAO + model + logic class in `core/`, a servlet or resource in `front/`, and JSP templates. No dependency injection framework (Spring/CDI) is used — objects are instantiated directly with `new`.

---

## 3. How it handles each of our concerns

### Data model for projects, departments/teams, and tasks

The hierarchy is: `company` → `performingorg` (performing organization = department analogue) → `program` → `project` → `wbsnode` (WBS tree, self-referential `Parent` FK) → `projectactivity` (leaf tasks). All scoped by `idCompany` and `idPerfOrg` FKs. `schemas/CreateDB.sql` lines 577 (`company`), 1789 (`performingorg`), 1992 (`program`), 2028 (`project`), 3163 (`wbsnode`), 2146 (`projectactivity`). The `project` table carries 60+ columns including `rag char(1)`, `risk char(1)`, `status varchar(11)`, `investmentStatus`, baseline dates (`plannedInitDate`, `plannedFinishDate`), and actual dates (`startDate`, `finishDate`).

### Roles, permissions, and data isolation

Roles are an enum in `Resourceprofiles.java` (`core/src/main/java/es/sm2/openppm/core/model/impl/Resourceprofiles.java`): RESOURCE(1), PROJECT_MANAGER(2), INVESTMENT_MANAGER(3), FUNCTIONAL_MANAGER(4), PROGRAM_MANAGER(5), RESOURCE_MANAGER(6), **PMO(7)**, SPONSOR(8), PORTFOLIO_MANAGER(9), **ADMIN(10)**, STAKEHOLDER(11), LOGISTIC(12). This is 12 numeric role IDs.

**Isolation mechanism: application-layer only.** The `security` table (`schemas/CreateDB.sql` line 2776) stores `AutorizationLevel char(1)` per login. Checks are performed in `SecurityUtil.java` (`front/src/main/java/es/sm2/openppm/front/utils/SecurityUtil.java`) via `isUserInRole(request, Profile...)` which reads `rolPrincipal` from the HTTP session. The `SecurityAction` interface (`core/src/main/java/es/sm2/openppm/core/logic/security/SecurityAction.java`) provides `hasPermission(int role)`. There is **no database-layer row filtering** (no RLS, no row-level WHERE clauses per user). Data isolation between performing orgs is enforced purely by application-layer WHERE conditions in DAO queries. A compromised or miscoded query exposes cross-org data.

### Status (RAG or equivalent) and status history

The `project` table has `rag char(1)` (Red/Amber/Green) and `status varchar(11)`. Status transitions are logged in `logprojectstatus` (`schemas/CreateDB.sql` line 1488): `idProject`, `idEmployee`, `projectStatus`, `investmentStatus`, `logDate datetime` — an append-only log row per transition. The `projectfollowup` table (`line 2393`) captures point-in-time flags per follow-up date: `GeneralFlag`, `RiskFlag`, `CostFlag`, `ScheduleFlag` (all `char(1)`), plus EV/PV/AC values.

### Approvals or workflow states

There is no formal approval workflow table. Project lifecycle states (`status` column on `project`) serve as the state machine — values like INITIATING, PLANNING, EXECUTING, etc. (PMBOK phases). The `stagegate` table (`line 2924`) allows company-defined stage gates per project. The `changecontrol` table (`line 322`) has a `Resolution bit(1)` + `ResolutionDate` + `resolutionName` for change request approval/rejection, but it is a simple flag, not a multi-step workflow. No draft → pending → approved transition table exists.

### Baseline, revisions, and change tracking

The `project` table carries dual date sets: `plannedInitDate`/`plannedFinishDate` (baseline) vs. `startDate`/`finishDate` (actual). Similarly, `activityseller` (`line 27`) has `baselineStart`/`baselineFinish` vs. `startDate`/`finishDate`. The `changecontrol` table (`line 322`) records change requests with `EstimatedEffort` and `EstimatedCost` impact. There is **no snapshot/versioning mechanism** — no separate baseline snapshot table, no delta calculation, no revision history for budget or scope. The approach is "store the two dates side-by-side on the same row." This is a minimal PMBOK baseline concept, not a proper baseline locking system.

### Audit trail / activity log, and tamper-resistance

The `Audit` model (`core/src/main/java/es/sm2/openppm/core/model/impl/Audit.java`) stores: `creationDate`, `location` (enum), `idEmployee`, `idContact`, `idCompany`, `idProject`, `projectStatus`, `username`, and `dataObject byte[]` (an XStream-serialized XML snapshot of the changed object). The `XStreamAuditUtil` (`core/src/main/java/es/sm2/openppm/core/audit/XStreamAuditUtil.java`) creates these snapshots for ~15 entity types (Project, WbsNode, Milestone, Risk, Followup, etc.). The `AuditDAO` (`core/src/main/java/es/sm2/openppm/core/dao/AuditDAO.java`) only provides `find()` with a max of 500 results — **no DELETE or UPDATE methods are visible**, which suggests append-only intent. However, tamper-resistance is only by convention; there are no DB-level triggers, INSERT-only grants, or hash chains. The audit record is a plain MySQL row that an admin with DB access can delete.

### Dependencies between items and visual dependency map

`projectassociation` (`schemas/CreateDB.sql` line 2186`) is a simple junction table: `lead int(11)`, `dependent int(11)`, `updateDates bit(1)`. This represents project-to-project dependencies. The `wbsnode` table has a self-referential `Parent` FK for task hierarchy. There is **no visual dependency map** — no graph rendering or dependency visualization in the codebase. The `front/` module contains JSP pages and chart utilities (`core/src/main/java/es/sm2/openppm/core/charts/`) using JFreeChart/FusionCharts-style XML for bar/area charts and Gantt charts (`ChartGantt.java`), but no network/dependency graph.

### Dashboards and reporting

`executivereport` table (`line 1034`) stores free-text `internal`/`external` status blocks per project per date. Dashboard rendering is JSP-based with chart XML generation in `core/src/main/java/es/sm2/openppm/core/charts/`. The `FollowProjectsServlet` (`front/src/main/java/es/sm2/openppm/front/servlets/FollowProjectsServlet.java`) provides the portfolio-level follow-up view. Reports use JasperReports 4.7.1 for PDF/Excel output (referenced in `pom.xml` and `ReportConstants.java`). The `historickpi` table (`line 1246`) tracks KPI values over time per project.

### Notifications, scheduled jobs, and escalation logic

Quartz Scheduler is used. Jobs in `front/src/main/java/es/sm2/openppm/front/threads/scheduler/`: `NotificationJob.java` calls `NotificationLogic.sendNotifications()` on a schedule; `MilestoneNotify.java` fires milestone-specific alerts; `NotificationExpirationJob.java` handles expiry; `TriggerActionListener.java` is a Quartz trigger listener. The `notification` table (`line 1703`) holds outbound messages with `status`, `type`, `modeNotification`, `creationDate`, `changeStatusDate`. There is **no explicit escalation engine** — no "if update is N days late, escalate to manager" logic was found. Notification logic is triggered by scheduled jobs, not event-driven. No deduplication/idempotency mechanism is visible in the code.

### Search

No full-text search engine (Lucene, Elasticsearch, pg_tsvector) is present. Search is implemented as Hibernate Criteria queries with `Restrictions.ilike()` filters in DAO classes. There is no search endpoint that enforces access scoping — search filtering by company/perforg is applied at the DAO query level per method call, not as a universal interceptor.

### Authentication and SSO / Microsoft / OIDC / SAML integration

JAAS is used (`front/src/main/java/es/sm2/openppm/auth/PlainLoginModule.java`, `PlainRolePrincipal.java`, `PlainUserPrincipal.java`). LDAP integration exists in `front/src/main/java/es/sm2/openppm/front/utils/ConnectLDAP.java` using `javax.naming` JNDI — this supports Active Directory via LDAP bind, not OIDC or SAML. **No OIDC, SAML, OAuth2, or Microsoft Entra ID integration exists.** Passwords are stored as MD5 hashes (visible in seed data: `21232f297a57a5a743894a0e4a801fc3` = MD5 of "admin"). The REST API offers a token-based authenticate endpoint (`front/src/main/java/es/sm2/openppm/api/rest/AuthenticateResource.java`) but this is a custom proprietary token, not JWT or OAuth.

---

## 4. Code quality and docs

**Readability:** Moderate. Java is verbose but class naming is consistent (DAO / Logic / Model tiers). Every file carries the GPL header (25 lines of boilerplate) which obscures actual content. Method names are descriptive (`consInitiatingProject`, `findByFilters`).

**Modularity:** Weak. The `core` module is a large flat package with ~700 Java files. Logic classes are not interfaces — they are concrete classes instantiated with `new` throughout the codebase. There is no IoC container, making unit testing hard and cross-cutting concerns (e.g., audit) duplicated per method.

**Test coverage:** Negligible. Only 5 test files found across the entire codebase (2 converter tests, 1 comparator test, 1 Hibernate mapping test, 1 HQL test). No integration tests, no end-to-end tests.

**Documentation:** README is 30 lines of marketing copy. No API docs, no architecture diagram, no developer guide. The installation guide is a PDF in Spanish/English. No inline Javadoc beyond auto-generated stubs.

---

## 5. License implications

OpenPPM is **GPL v3**. GPL v3 is a strong copyleft license. Key implications for a proprietary, resold, or hosted product:

- **Cannot reuse GPL code** in a proprietary closed-source product without releasing the entire combined work under GPL v3. This applies to both on-premise and SaaS distribution (GPL does not trigger on mere internal use, but any distribution to users — including SaaS customers — of a GPL-linked work requires source disclosure under standard GPL interpretation; AGPL would make this explicit, GPL alone is debated but carries legal risk).
- **Cannot borrow code patterns by copy-paste** from GPL files into a proprietary codebase — that creates a derivative work.
- **What IS permitted:** reading the code to understand concepts, then independently re-implementing the same ideas in a clean room (no copy-paste, no structural derivation from specific GPL expressions). Ideas, algorithms, and data model concepts are not copyrightable.
- **No commercial-only tier:** OpenPPM is fully open; there is no Enterprise Edition with additional features behind a paywall. The GPL applies uniformly to everything in the repo.

**Verdict:** The GPL v3 license means **zero lines of OpenPPM code can enter the PMO Control Tower codebase.** All value must come from reading the data model design as inspiration and re-implementing independently.

---

## 6. Modifiability assessment

The stack (Java 7 / JSP / MySQL / Hibernate / Quartz) has essentially zero overlap with the target stack (TypeScript / Next.js / React / Supabase Postgres / RLS / Edge Functions). The architecture is a 2017-era Java EE monolith with no REST-first design, no modern auth, no RLS concept, and no event-driven scheduling. Borrowing toward the governance tower means reading the data model only — no code is reusable.

### Rubric scores

| Criterion | Score | Justification |
|-|-|-|
| stackProximity | 1 | Java 7 / JSP / MySQL / Hibernate. Nothing in common with TS/React/Postgres/Supabase. |
| modularity | 2 | DAOs are individually readable but everything lives in one flat `core/` package with direct instantiation; no clean concern boundaries. |
| governanceCoverage | 3 | PMBOK PMO hierarchy (portfolio→program→performingorg→project), RAG field, status log, change control, XStream audit snapshot, and Quartz notifications are all present — but approvals are rudimentary, escalation is absent, and baseline is a dual-date hack. |
| codeClarity | 2 | Verbose Java with 25-line GPL boilerplate on every file, no IoC, negligible tests, near-zero Javadoc. |
| licensePosture | 1 | GPL v3. Prohibits any code reuse in a proprietary product. Lowest possible score. |
| maintenance | 1 | Single commit dated 2017-02-09, version still 4.0-SNAPSHOT, demo URL likely dead. Effectively abandoned. |

---

## 7. Top files worth studying

| Path | Why |
|-|-|
| `schemas/CreateDB.sql` | The most valuable artifact in the repo. A complete PMBOK-aligned relational schema: company→performingorg→program→project→wbsnode→activity hierarchy, RAG on project, logprojectstatus for status history, projectfollowup for periodic snapshots, changecontrol for change tracking, projectassociation for project-to-project dependencies, notification queue table. Study as a data model reference for our own Postgres schema. |
| `core/src/main/java/es/sm2/openppm/core/model/impl/Resourceprofiles.java` | Defines the 12-role enum (RESOURCE, PM, INVESTMENT_MANAGER, FUNCTIONAL_MANAGER, PROGRAM_MANAGER, RESOURCE_MANAGER, PMO, SPONSOR, PORTFOLIO_MANAGER, ADMIN, STAKEHOLDER, LOGISTIC). Useful reference for mapping PMBOK roles to our simpler 4-role model (Executive, Director, Member, Viewer). |
| `core/src/main/java/es/sm2/openppm/core/model/impl/Audit.java` + `core/src/main/java/es/sm2/openppm/core/audit/XStreamAuditUtil.java` | Shows the pattern: capture a before/after XML blob per event, store actor + project + location + timestamp. The `dataObject byte[]` serialized snapshot concept is directly adaptable as a `jsonb` column in Postgres. |
| `core/src/main/java/es/sm2/openppm/core/logic/security/SecurityAction.java` + `core/src/main/java/es/sm2/openppm/core/logic/security/actions/` | Illustrates the action-per-tab permission check pattern. Each tab/action is an enum implementing `hasPermission(int role)`. Useful conceptually for designing our Supabase RLS policy names and Edge Function authorization guards. |
| `front/src/main/java/es/sm2/openppm/front/threads/scheduler/NotificationJob.java` + `MilestoneNotify.java` + `NotificationExpirationJob.java` | Shows the notification queue + Quartz job pattern. Translates to our pg_cron + pg_net Edge Function trigger model: a `notification` queue table drained by a scheduled job is the right separation of concerns, and OpenPPM confirms this architecture. |

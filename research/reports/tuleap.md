# Tuleap — PMO Control Tower Utilization Report

> **Study scope:** Two repositories examined read-only.
> - `research/vendor/tuleap` — source mirror tagged **v5.3.99.4 (2012)**. Structurally representative of the tracker engine but massively stale. All code citations are from this snapshot; treat them as illustrating enduring design patterns, not current implementation.
> - `research/vendor/tuleap-documentation-en` — current Enalean official docs, updated through **Tuleap 17.5 (March 2026)**. Used as the authoritative source for current feature state.

---

## 1. Identity

| Field | Value |
|-|-|
| Repo name | Tuleap |
| Upstream URL | https://github.com/Enalean/tuleap (live); rhertzog/tuleap mirror (2012, studied) + Enalean/tuleap-documentation-en (current docs) |
| Primary language | PHP (backend); Vue.js + TypeScript (current frontend, per dev.rst); 2012 snapshot uses plain JS |
| Frameworks | PHP with homegrown MVC (`src/common/mvc/`); no major PHP framework; current frontend is Vue + TypeScript components |
| Database | MySQL (v5.x in 2012 snapshot; MySQL 8.4 in v17.x per `languages/en/deployment-guide/17.x.rst`) |
| License | GNU GPL v2 (`src/COPYING`). The *documentation* repo is GPL v2 (`tuleap-documentation-en/LICENSE`). Enterprise plugins (Baselines, Cross-tracker search, OAuth2 provider, Full-text search/Meilisearch) are **not open source** — they are commercial-only in the Tuleap Enterprise distribution. |
| Latest release | **17.5 — March 2026** (per `languages/en/deployment-guide/17.x.rst`; v17.6 under development) |
| Activity | **High** on the live product (monthly releases since at least v7.x, through v17.x). The *studied source snapshot* is from 2012 — 13 years stale. This split is critical for all scores. |

---

## 2. Architecture

Tuleap is a **PHP monolith with a plugin layer**. The core lives in `src/` and provides project/group management, user authentication, permissions, references, and shared infrastructure. Features are added as plugins under `plugins/` — each plugin directory contains its own `include/` (business logic), `db/` (install.sql schema migrations), `www/` (PHP controllers/views), and `site-content/` (i18n).

**Data layer:** MySQL, no ORM. Plugins ship their own `install.sql` and update scripts under `db/mysql/updates/`. The core schema (`src/db/mysql/database_structure.sql`) defines foundational tables: `groups` (projects), `user_group`, `ugroup`, `ugroup_user`, and `permissions`. Plugins extend via their own tables keyed on `group_id` or `tracker_id`.

**Backend/frontend split (2012):** server-rendered PHP/Smarty templates with sprinkles of jQuery. Per the current `dev.rst`, the live product now uses Vue + TypeScript components compiled and served via the plugin asset pipeline, but the architectural boundary is still server-driven PHP.

**Adding a new module:** create a new directory under `plugins/`, implement a plugin descriptor, register hooks on the event bus (`EventManager`), ship your own DB schema, and declare permissions using the `permissions` table. There is no scaffolding CLI. This is a fully hand-assembled plugin contract.

**Isolation model:** Project isolation is app-layer enforced, not database RLS. Every query carries a `group_id` and every permission check flows through `permission_db_authorized_ugroups()` called from PHP. There is **no Row-Level Security in MySQL** — isolation depends entirely on PHP code calling the permissions tables correctly.

---

## 3. How It Handles Each Concern

### Data model — projects, departments/teams, tasks

Core tables: `groups` (= projects, `src/db/mysql/database_structure.sql` line 983), `user_group` (project membership, line 2035), `ugroup`/`ugroup_user` (named user groups within a project, lines 2927–2943). Trackers (`plugins/tracker/db/install.sql` line 80) are scoped to a `group_id`. Artifacts (`tracker_artifact`, line 433) belong to a tracker. There is no native "department" entity — departments would be modeled as projects or user groups. Tasks are simply artifacts in a tracker configured for that purpose.

### Roles, permissions, data isolation

Permissions are stored in a generic `permissions` table (`database_structure.sql` line 2949) keyed by `(permission_type, object_id, ugroup_id)`. Tracker-level access uses types `PLUGIN_TRACKER_ACCESS_FULL`, `PLUGIN_TRACKER_ACCESS_SUBMITTER`, `PLUGIN_TRACKER_ACCESS_ASSIGNEE`, checked in `Tracker_Artifact.class.php` (lines 111–175) via `isMemberOfUGroup()`. Field-level access is defined per-field and enforced in PHP before rendering or accepting input.

**Critical gap for PMO:** isolation is app-layer only. There is no database-level row filter (no Postgres RLS). A bug in PHP code or a direct DB query bypasses all isolation. For a governance product that must enforce department isolation at the database layer, this architecture is the wrong model.

Tracker-level permissions are documented in `languages/en/user-guide/trackers/administration/configuration/permissions-management.rst`. Field-level permissions assign read/write/hidden per ugroup.

### Status (RAG or equivalent) and status history

Tuleap uses **Semantics** (`plugins/tracker/db/install.sql` line 547, `tracker_semantic_status` table) to designate which select-box field is "status" and which values are "open." Individual list values can be given colors (decorators), documented in `languages/en/user-guide/trackers/administration/configuration/field-usage-management.rst`. This maps loosely to RAG if you configure three color-coded values, but it is not a first-class RAG concept — there is no system understanding of Red/Amber/Green as distinct states.

Status **history** is implicit in the changeset model: every field change, including status transitions, is stored as a new `tracker_changeset` + `tracker_changeset_value` row, giving a full field-level audit trail. Docs: `languages/en/user-guide/trackers/administration/configuration/semantics.rst`.

### Approvals / workflow states

Tuleap has a **Workflow** engine (`plugins/tracker/db/install.sql` lines 3–55, `tracker_workflow` + `tracker_workflow_transition` tables). A workflow is defined on a single list field; allowed transitions are configured as a matrix. Each transition can carry **pre-conditions** (authorized ugroups) and **post-actions** (auto-set other fields). Documented in `languages/en/user-guide/trackers/administration/configuration/workflow.rst`.

This models draft→pending→approved cycles but is single-field, single-tracker. Cross-tracker approval choreography requires **Triggers** (`languages/en/user-guide/trackers/administration/configuration/triggers.rst`), which propagate value changes across parent/child tracker hierarchies. There is no dedicated "approval record" or sign-off entity — approval is just a status transition with a pre-condition on who can perform it.

### Baseline, revisions, and change tracking

**Baselines plugin** (Tuleap Enterprise only): snapshots the content of a Backlog milestone at a point in time; two baselines can be compared. Documented in `languages/en/user-guide/baseline.rst`. It is marked "early delivery / not feature complete." It captures title, description, status, and linked child artifacts per snapshot.

**Important:** the Baselines plugin is commercial-only (Tuleap Enterprise). The open-source tracker changeset model implicitly provides per-field versioning (every change creates a new changeset row), but there is no concept of a "locked plan baseline" or delta report built in to the CE edition.

### Audit trail / activity log

The **changeset model** is the audit trail. `tracker_changeset` records who changed what and when (submitted_by + submitted_on timestamps). `tracker_changeset_value_*` tables store the new value for every changed field. This is effectively append-only in normal use.

However, it is **not tamper-resistant by design**: `Tracker_Artifact_Changeset.class.php` lines 254–260 show `userCanDelete()` returns true for superusers, and lines 298–304 confirm a hard delete of changeset + comment + value rows is possible. Comments can be edited (line 285). The code even has a comment at line 212: "We can't delete a snapshot since there is too many repercussion on subsequent changesets" — yet the delete path exists for admin users. For a governance product requiring a tamper-resistant append-only log, this falls short without additional controls.

### Dependencies between items / visual dependency map

Dependencies are modeled via the **ArtifactLink field** (`tracker_changeset_value_artifactlink`, `install.sql` line 287), which cross-references artifacts by `artifact_id` + `keyword` + `group_id`. The reference manager (`src/common/reference/ReferenceManager.class.php`) extracts `art #123`-style cross-references from text fields across the whole system.

Tracker hierarchy (`languages/en/user-guide/trackers/administration/configuration/hierarchy.rst`) defines parent/child structural relationships between trackers. The **Roadmap** widget (Tuleap Enterprise) provides a visual timeline. There is no dedicated dependency graph/network view comparable to xyflow in the CE edition.

### Dashboards and reporting

Each project has a configurable dashboard (widget-based). Tracker reports (`plugins/tracker/include/Tracker/Report/`) define saved queries and table renderers. The `graphontrackersv5` plugin provides charts (burndown etc.) bound to tracker data. **Cross-Tracker Search** (`languages/en/user-guide/trackers/cross-tracker-search.rst`) is Enterprise-only and aggregates data across projects using Tuleap Query Language (TQL). No built-in executive roll-up dashboard for multi-department governance exists in CE.

### Notifications, scheduled jobs, escalation

Email notifications fire on every changeset via `Tracker_GlobalNotification` and per-role watcher rules (`tracker_watcher`, `tracker_notification_role` in install.sql). The **tracker_date_reminder** plugin (`plugins/tracker_date_reminder/`) implements date-field-triggered reminders fired by an OS cron job (a PHP script invoked from crontab). It tracks `notification_sent` state in a DB column to avoid re-sending (line 425 of `ArtifactDateReminderFactory.class.php`). This plugin targets tracker v3 only (per README.txt).

There is no escalation engine in the modern tracker v5: no "auto-escalate if status is Red for N days," no week-level chase logic, no cross-department dependency alert. Automation via **Triggers** and **Tuleap Functions for Tracker** (Enterprise, webhook-like) exists but must be custom-configured per use case, not built-in governance escalation.

### Search

The CE edition has per-tracker report search (saved TQL queries). Full-text search (`languages/en/administration-guide/application-management/plugins/full-text-search.rst`) is Enterprise-only, backed by either MySQL FULLTEXT or Meilisearch. Search results respect the tracker-level permission checks (per docs: "The full-text search makes possible to find an item based on its content across all the items **you can access**").

### Authentication and SSO / Microsoft / OIDC

The 2012 source includes an **LDAP plugin** (`plugins/ldap/README.txt`) for authentication against Active Directory / LDAP. Current Tuleap Enterprise adds an **OAuth2 + OpenIDConnect provider** plugin (`languages/en/user-guide/oauth2.rst`) — but this makes Tuleap an OIDC *server*, not an OIDC *client*. There is no SAML IDP integration documented. No Microsoft Entra ID / Azure AD OIDC sign-in support is described in any docs file; LDAP/AD is the nearest option. This is a significant gap relative to the PMO requirement for Microsoft Entra SSO.

---

## 4. Code Quality & Docs

**2012 source:** Procedural PHP, global state, `$GLOBALS`, no type hints, god-object classes (`Tracker_Artifact.class.php` is 1,000+ lines). Class names use `Tracker_Artifact_Changeset_Comment` naming conventions. No interfaces enforced at call sites. Test coverage exists under `plugins/tracker/tests/` but is minimal for the studied snapshot. Readability is poor by modern standards — heavy use of raw SQL strings, mixed HTML generation in domain classes, `require_once` chains.

**Current product:** The developer guide references Vue + TypeScript components and a more structured frontend build pipeline. The PHP backend has presumably been refactored but the source is not in the studied clone.

**Documentation:** The `tuleap-documentation-en` docs repo is well-structured reStructuredText, clearly organized, actively maintained through v17.x. Feature boundaries between CE and Enterprise are consistently flagged. This is genuinely useful as a concept reference.

---

## 5. License Implications

The source code is **GPL v2**. This is a strong copyleft license.

**What it allows:** reading and studying the code; reimplementing the *concepts* (changeset audit trail, workflow state machine, permission table patterns) in a new codebase with no license obligation, as long as you write the new code from scratch.

**What it forbids for a proprietary/hosted product:**
- You cannot copy GPL v2 PHP source into a proprietary product. Distributing or deploying a product that incorporates GPL v2 code requires releasing your entire combined work under GPL v2. This is non-negotiable for a privately hosted, commercially operated SaaS.
- Even reading the code and closely paraphrasing its logic into another language is legally risky without cleanroom separation.

**Enterprise features:** Baselines, Cross-Tracker Search, Full-text search (Meilisearch), OAuth2 provider, Roadmap, Tuleap Functions — these are **not GPL, not open source**. They are commercial plugins distributed only to paying Tuleap Enterprise customers. The concepts can be studied from the docs; no source is available to read.

**Bottom line:** Tuleap is GPL v2. You can read it to understand patterns. You cannot copy a line of code. For our PMO Control Tower, the only safe path is concept extraction + clean reimplementation. The useful governance concepts (changeset audit pattern, workflow transition matrix, permission-type + ugroup model) are well-established computer science and not IP — implementing them independently is straightforward.

---

## 6. Modifiability Assessment

Adapting Tuleap directly to our stack is not viable: it is PHP, we are TypeScript/Next.js. The value is purely conceptual. Scores reflect usefulness of the *patterns* for our reimplementation, not the code itself.

| Criterion | Score | Justification |
|-|-|-|
| stackProximity | 1 | PHP + MySQL vs TypeScript + React + Postgres — maximally distant. Zero code reuse possible. |
| modularity | 2 | Plugin system provides some isolation, but business logic is entangled in monolith internals; lifting a single concern requires understanding the entire permission + event infrastructure. |
| governanceCoverage | 3 | Strong on changeset audit trail, workflow transitions, and permission model. Weak on escalation, no native RAG, no dept-level isolation at DB layer. Baseline is CE-only and incomplete. |
| codeClarity | 2 | 2012 snapshot is procedural PHP with global state, mixed concerns, and poor readability. Docs (current) are excellent and partially compensate. |
| licensePosture | 1 | GPL v2 is the worst possible posture for a proprietary hosted product. No code can be copied. Best features (Baselines, search) are commercial-only and inaccessible. |
| maintenance | 3 | The live product (v17.5, March 2026) is actively maintained. The studied source is 13 years stale. Score reflects the split: patterns are alive, source is useless. |

---

## 7. Files / Modules Most Worth Studying

1. **`plugins/tracker/db/install.sql`** — The changeset + artifact link data model is the single most instructive artifact. Tables `tracker_changeset`, `tracker_changeset_value`, `tracker_semantic_status`, and `tracker_workflow_transition` directly map to our Audit Trail, RAG Status, and Approvals modules. Study this schema to design the equivalent Postgres schema with append-only constraints and RLS.

2. **`plugins/tracker/include/Tracker/Artifact/Tracker_Artifact_Changeset.class.php`** — Reveals the deliberate decision to NOT delete changesets (lines 211–225) and where that principle was compromised (superuser hard-delete path, lines 298–304). The contrast is instructive: our implementation should use Postgres policies or triggers to make deletion physically impossible, not rely on application-layer restraint.

3. **`plugins/tracker/include/Tracker/Artifact/Tracker_Artifact.class.php`** (lines 111–175) — The permission check cascade (FULL access → submitter group → assignee group → artifact-level permissions) models a multi-tier access pattern. Our Postgres RLS policies should encode equivalent logic declaratively so no app-layer bypass is possible.

4. **`languages/en/user-guide/trackers/administration/configuration/workflow.rst`** + **`triggers.rst`** — The workflow simple/advanced mode distinction and the cross-tracker trigger mechanism are the clearest description of how Tuleap operationalizes state-machine approvals and cross-item automation. Directly applicable to designing our Approvals & Escalation Engine, even though we will reimplement in TypeScript + pg_cron.

5. **`languages/en/user-guide/baseline.rst`** — Even though the Baselines plugin is Tuleap Enterprise-only and self-described as "early delivery," the doc defines the exact semantics we need: named snapshots of a milestone's artifact tree, point-in-time capture, and diff comparison between two snapshots. Our Baseline module should implement this model as a first-class, open feature.

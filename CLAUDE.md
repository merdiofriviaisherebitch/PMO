# PMO Control Tower — Master Build Context

> **This file is the single source of truth for a fresh Claude Code session.**
> A session that reads only this file must be able to build the full product with no other context.
> Last updated: 2026-05-30 (rev 3).
> Repository: https://github.com/merdiofriviaisherebitch/PMO.git
>
> **Changelog — 2026-05-30 (rev 3): architecture deepening pass (via `improve-codebase-architecture`) + engineering-skill suite.** Centralized the audit write path into one `audit_capture()` trigger + `resolve_scope()` resolver so scope denormalization has one home (§9, §14); factored escalation rule evaluation into a pure `due_escalations(now)` module with an injected clock and put notifications behind a `Notifier` **port** with Resend/Teams/in-memory adapters (§11, §12, §14); made baseline **delta** a single module consumed everywhere (§5, §9); added a `belongs_to_my_department()` RLS helper and a "Scope" glossary term (§3, §10); recorded the full review in §20. Documented the mattpocock engineering skills (`tdd`, `diagnose`, `to-issues`, `to-prd`, `improve-codebase-architecture`) with milestone usage in §19, and ran `setup-matt-pocock-skills` to scaffold `docs/agents/` (issue tracker, triage labels, domain docs), recorded in §19.6.
>
> **Changelog — 2026-05-30 (rev 2): security-hardening pass, all items reflected before Phase 1.** Specified JWT claim issuance via a Supabase Custom Access Token (Auth) Hook + claim lockdown/staleness (§4, §7, §10, §17, §18); scoped Realtime and Storage explicitly because table RLS does not cover them (§7, §8, §10, §15, §17); required manual department scoping on every service-role path (§4, §10, §14, §15, §17); denormalized `department_id`/`project_id` onto the audit + polymorphic history tables to resolve a §9↔§10 contradiction (§9, §10); fixed the escalation `dedup_key` to include the ladder `step` + a per-rule period bucket (§6, §8, §9, §11); softened the audit-immutability claim to "immutable to the application/app role" (§3, §6); added RLS performance helpers and an exhaustive CI isolation regression (§10, §15); corrected the Leantime `msghash` citation (§16); defined the rejected-update transition and review-rigor tiers (§5, §19).

---

## 1. Project Overview & Purpose

The **PMO Control Tower** is a private web application for executive project governance and accountability. It is NOT a task tracker, BI dashboard, or shared spreadsheet. It enforces *rules*: who logs progress, who approves it, what the locked plan is, who is accountable for delays, and what happens automatically when someone falls behind.

The system serves one company (SolServices). The CEO and executives get one live view of every project across every department. Each department sees only its own data. The system chases people automatically when updates are late, escalates to leadership when red items linger, and keeps a permanent tamper-resistant record of every change.

This is a governance and accountability product. Every architectural decision must serve that goal.

---

## 2. Client & Domain Context

**Client:** SolServices — an energy and infrastructure developer (geothermal and related projects).

**Users:** ~50 users across 9 departments.

**The 9 departments:**
1. Accounting
2. Legal
3. Finance
4. Geothermal
5. Back Office
6. IT
7. Technical
8. Lumentrade
9. Project Development

**Infrastructure:** Microsoft 365 company-wide. Limited Azure/cloud experience. Users sign in with their existing company M365 accounts.

**Hosting target:** Vercel + Supabase, EU region by default. The data-residency question (managed EU cloud vs. inside their own Azure tenant) must be confirmed with the client before launch.

---

## 3. Glossary

| Term | Definition |
|-|-|
| RAG status | Red / Amber / Green — a three-value health indicator on tasks and projects. Red = off-track or blocked. Amber = at risk. Green = on track. Every status change is recorded in a history log. |
| Baseline | A locked snapshot of a project plan (scope, dates, budget) at a specific point in time. Once locked, it cannot be changed — only a new revision can be created. |
| Delta | The computed difference between the current state and the locked baseline. Shows schedule variance, scope drift, and budget variance. |
| Escalation | An automatic action triggered by a time-based rule: e.g., an update not submitted by Friday EOD triggers a reminder to the department member; if still missing after N hours, it escalates to the director; if still unresolved, it escalates to the executive. |
| Dependency block | A cross-department link where one department's task cannot start or complete until another department's task is resolved. A blocked dependency can trigger automatic escalation. |
| Audit trail | An append-only log of every change to every entity: who changed what, from what value, to what value, and when. Immutable to the application and the application's Postgres role (UPDATE/DELETE revoked; writes only via SECURITY DEFINER triggers). A Postgres superuser/DB admin can still delete rows on self-hosted Postgres — true write-once against a DB admin requires shipping records to an external append-only store (optional hardening, see §6). |
| Department workspace | The intersection of a project and a department — the scoped area where a department enters and manages its portion of a project. |
| Update cycle | A recurring weekly window during which each department must submit a progress update. Typically opens Monday and closes Friday EOD. Missed deadlines trigger automatic chasers. |
| Scope | The unit a row/policy/report/escalation is bounded to: `department`, `project`, the `department_workspace` (project×department), or `global`. Represented consistently as `department_id` + `project_id` (both nullable; the pair encodes the scope). This is the single vocabulary for all isolation and targeting — avoid inventing `target_scope`/`scope_type` variants. |
| Deep module / seam | Architecture vocabulary (used in §20): a *deep* module hides a lot of behaviour behind a small interface; a *seam* is where that interface lives (where behaviour can be swapped, e.g. a test adapter). We prefer a few deep modules over many shallow ones — it concentrates change, bugs, and tests in one place. |
| The 9 departments | Accounting, Legal, Finance, Geothermal, Back Office, IT, Technical, Lumentrade, Project Development. |

---

## 4. Roles & Permission Model

| Role | Scope | Key Capabilities |
|-|-|-|
| Executive | All departments, all projects | Read/write across everything; see all dashboards; receive escalation notifications; approve or override anything |
| Director | Their department only | Approve their department's weekly updates; see all of their department's data; receive first-level escalation; cannot see other departments |
| Member | Their department only | Enter and edit their own department's tasks and updates; submit updates for director approval; cannot see other departments |
| Viewer | Their department only (or specific projects) | Read-only; no edits; scoped to their assignment |

**The cardinal rule:** A department member — including a Director — must be physically unable to read another department's data. This isolation is enforced in the DATABASE via Row Level Security policies keyed on the user's department and role. It is not enforced by UI hiding or application-layer filters alone. The executive role carries an explicit override policy that grants cross-department read access.

**How `role` and `department_id` reach the policies (and why they can be trusted).** These claims are injected into the JWT by a **Supabase Custom Access Token (Auth) Hook** that reads `role` and `department_id` from the `users`/profile table at token issuance. Policies must never trust a value the user can set directly — so the `users` table itself carries RLS that **forbids a user from updating their own `role` or `department_id`**; only the service role or an executive may change those fields. See §10 for the hook and the lockdown policy.

**Claim staleness.** With the default access-token TTL, a moved or demoted user keeps old access until the token refreshes. On any change to a user's `role` or `department_id`, the app must **force re-authentication** (revoke that user's sessions) or rely on a deliberately short access-token TTL. Default approach: revoke sessions on role/department change; confirm the acceptable TTL with the client (§18).

**Service-role paths re-apply scoping in code.** Service-role operations (escalation engine, scheduled jobs, Edge Functions, report generator) use the Supabase service role, which **bypasses RLS entirely** — RLS will not protect them. Every service-role code path must re-apply department/project scoping in code. Service-role access must never be exposed to the client side. See §10 and §14.

---

## 5. The 14 Modules

1. **Projects & Departments** — Projects contain department workspaces (one per department involved). Each workspace contains that department's tasks for that project. A project spans one or more departments; each department only sees its own workspace.

2. **Weekly Update Cycle** — A recurring cadence (e.g., opens Monday, closes Friday EOD) during which each department submits a progress update. System opens the cycle automatically via pg_cron, tracks submission status per department, and triggers chasers when deadlines are missed. This is core product IP — no open-source precedent exists anywhere.

3. **RAG Status** — Red/Amber/Green on individual tasks and on projects as a whole. Status changes are recorded in an append-only status history table. Projects aggregate department-level RAG to produce an executive-visible roll-up.

4. **Approvals & Sign-off** — A department member drafts an update; it enters a `pending` state; the Director reviews and either approves or rejects it. State machine: `draft → pending → approved`, or `pending → rejected → draft` — a rejected update returns to `draft` for the member to revise and resubmit; it does not dead-end. Transitions are role-gated in both RLS policies and application logic. An approved update becomes part of the permanent record.

5. **Baseline Lock, Revisions, Deltas** — When a project plan is ready, it is locked as a named baseline (scope, schedule, budget). Subsequent changes are recorded as revisions. The delta between current state and the locked baseline is computed by a **single `delta(project, at?)` module** (the only place that diffs current-vs-snapshot); the dashboard, reports, and the delta view all consume it — never recompute the diff per view (§20).

6. **Audit Trail** — Append-only, tamper-resistant log of every change to every entity. Implemented as a Postgres table with UPDATE and DELETE revoked at the role level, written exclusively by SECURITY DEFINER triggers. App-layer discipline is insufficient; DB-level enforcement is required.

7. **Dependency Tracking + Visual Map** — Cross-department task dependencies with typed relations (blocks / blocked-by / precedes / follows). A visual interactive node-graph built on @xyflow/react shows the full dependency map. Blocked dependencies trigger automatic escalation.

8. **Escalation Engine** — Time-based rules fire reminders, then escalate to directors, then to executives when updates are late, red items linger, or blocked dependencies go unresolved. Built fresh on pg_cron + pg_net → Edge Function → Resend. Idempotent: never double-sends, never silently fails. Core product IP — no open-source precedent exists anywhere.

9. **Budget & Cost Governance** — Budget vs. actual tracking with variance flags. Budget figures are director-approved. Variance thresholds trigger amber/red status on the budget line.

10. **Dashboards** — Live executive dashboard showing all projects across all departments with RAG roll-up, budget summary, and dependency overview. Scoped department dashboards for Directors and Members. Powered by Recharts + Supabase Realtime.

11. **Reports & Export** — Auto-generated weekly and monthly governance reports. Exportable as PDF and Excel. Includes status summary, variance vs. baseline, unresolved blockers, and escalation history.

12. **Notifications** — Email notifications now (via Resend). Microsoft Teams and Outlook calendar integration later (via Graph API). All notifications flow through a `notification_outbox` table with a deduplication key.

13. **Access Control** — Department isolation enforced by Postgres RLS policies. Executive override via a separate policy. Membership JOIN logic informed by OpenProject and Taiga patterns but implemented as real RLS, not application-layer scopes.

14. **Search** — Full-text search across projects, tasks, and updates. Search runs through RLS automatically — results are department-scoped without any extra application-layer filtering.

---

## 6. Non-Negotiables

These three constraints are absolute. Nothing is built on top of them until they are proven.

**1. Department isolation at the database layer.**
Every department's data must be inaccessible to other departments at the Postgres row level via RLS policies. Application-layer filters are insufficient and are prohibited as the sole isolation mechanism. The isolation gate (Phase 1) must pass a pen-test before any other module is built.

**2. Append-only audit trail.**
The `audit_log` table has UPDATE and DELETE revoked for the application role. Writes happen exclusively via `SECURITY DEFINER` triggers or Edge Functions using the service role. No application code path can modify or delete an audit row — the log is immutable to the application and the application's Postgres role. This is tested by attempting mutations directly against the DB as the application role and confirming they are rejected. (Caveat: a Postgres superuser/DB admin can still delete rows. True write-once against a DB admin would require streaming audit records to an external append-only store — an optional hardening item to decide with the client, see §18.)

**3. Reliable, non-double-sending escalation engine.**
The escalation engine fires exactly once per **rule + step + target + period** combination — the dedup key includes the ladder `step` level, so a rule's reminder, director, and executive sends never collapse into one. It uses a `notification_outbox` table with a UNIQUE deduplication key, `pg_cron` for scheduling, `SELECT ... FOR UPDATE SKIP LOCKED` for safe concurrent dispatch, and marks items `sent` before delivery to prevent retries from double-sending. Silent failures are not acceptable — failed sends must be logged and retried with backoff.

---

## 7. Tech Stack

| Layer | Technology | Version | Reason |
|-|-|-|-|
| Framework | Next.js | 16.x | App Router, RSC, server + client in one; type-safe API routes |
| UI library | React | 19.2 | Required by Next.js 16; concurrent rendering |
| Language | TypeScript | latest | End-to-end type safety; compile-time correctness |
| Styling | Tailwind CSS | v4 | Utility-first; fast to build; pairs with shadcn |
| Components | shadcn/ui | latest | Copy-in components we own; accessible; Radix primitives |
| Database | Supabase / PostgreSQL | 15+ (new projects may default to 17 — confirm the version at creation) | Relational integrity for governance data; RLS is the isolation mechanism |
| Auth | Supabase Auth | latest | Sessions + JWT; custom claims (department_id, role) injected by a Custom Access Token (Auth) Hook — see §10 |
| Row-level security | Supabase RLS | — | THE department isolation mechanism; not negotiable |
| Realtime | Supabase Realtime | — | Live dashboard updates over **private channels with Realtime Authorization** (RLS on `realtime.messages`). Never public broadcast or unscoped `postgres_changes` for department data — see §10 |
| Storage | Supabase Storage | — | Report files/attachments in **non-public** buckets; RLS on `storage.objects` mirrors the department model; signed URLs minted only after a server-side scope check — see §10 |
| Scheduled jobs | pg_cron + pg_net | — | Escalation engine and update-cycle openers/closers run inside Postgres |
| Server logic | Supabase Edge Functions | — | Trusted server-side ops, webhooks, Graph API calls; service role |
| Email | Resend | latest | Transactional email for reminders and escalations |
| Dependency map | @xyflow/react | v12 | Interactive node-graph for visual dependency map |
| Charts | Recharts | latest | Dashboard KPI charts |
| Data grids | TanStack Table | latest | Large tabular data with sorting, filtering, pagination |
| Hosting | Vercel | — | Next.js-native deployment; EU region |
| Supabase hosting | Supabase Cloud | — | EU region by default; possibly Azure-tenant if client requires |
| SSO | Microsoft Entra ID | — | Company's existing M365; users sign in with work accounts via OIDC |
| Microsoft integration | Microsoft Graph API | — | Teams notifications, Outlook calendar invites (Phase 8) |

---

## 8. Architecture

### Layers

```
Browser (React / RSC)
  ↓ server component fetch / route handler
Next.js App Router (server components + API routes)
  ↓ Supabase JS client (anon key + user JWT)
Supabase PostgREST / RLS
  ↓ enforces policies keyed on JWT claims (department_id, role)
PostgreSQL 15+
  ↑ SECURITY DEFINER triggers write audit_log
  ↑ pg_cron fires escalation dispatcher
  ↑ pg_net calls Edge Functions for email delivery
```

### Typical action flow (e.g., department member submits a weekly update)

1. Member fills the update form in the browser (React client component).
2. Form posts to a Next.js route handler (server-side; never exposes service role to browser).
3. Route handler calls Supabase with the user's JWT. RLS policies enforce that the user can only write to their own department's workspace.
4. Postgres trigger fires, writing an `audit_log` row via SECURITY DEFINER function.
5. Update state transitions to `pending`. Director is notified via the `notification_outbox` → pg_net → Edge Function → Resend.
6. If Director does not act within N hours, the escalation engine (pg_cron job) fires a reminder.

### Scheduled jobs (pg_cron)

| Job | Schedule | What it does |
|-|-|-|
| `open_update_cycle` | Monday 00:01 | Creates a new `update_cycle` row; sets all `department_update` rows to `draft` |
| `close_update_cycle` | Friday EOD | Marks cycle closed; flags departments that did not submit |
| `escalation_dispatcher` | Every 15 min | Selects due escalation rules FOR UPDATE SKIP LOCKED; writes to `notification_outbox`; calls pg_net |
| `outbox_sender` | Every 5 min | Drains `notification_outbox` rows with status `queued`; calls Edge Function → Resend |

### Microsoft bridge (Edge Functions)

- **Auth:** Entra ID OIDC token is exchanged at sign-in; stored in Supabase Auth session.
- **Light tier:** Email reminders sent via Resend; .ics calendar invites attached.
- **Full tier (Phase 8):** Edge Function calls Graph API with delegated or application permissions to create Teams meetings, post Teams channel notifications, sync Outlook calendar events.

### Realtime & Storage are scoped too (table RLS does not cover them)

- **Realtime:** department dashboards subscribe over **private channels** gated by **Realtime Authorization** (RLS on `realtime.messages`). A table RLS policy does not by itself secure a Realtime subscription. Never use public broadcast or unscoped `postgres_changes` for department-scoped data.
- **Storage:** report files live in **non-public** buckets with RLS on `storage.objects` mirroring the department model; the object path encodes scope. Signed URLs are generated only after a server-side scope check.
- **Service role:** `pg_cron` jobs, Edge Functions, and the report generator run as the service role and **bypass RLS** — they re-apply department/project scoping in code (see §10, §14).

---

## 9. Data Model

### Core entities and relationships

```
departments
  id, name, created_at

users
  id (= Supabase auth.uid), department_id → departments, role (executive|director|member|viewer),
  email, display_name, entra_oid, created_at

projects
  id, name, description, status (rag_enum), owner_id → users, created_at

department_workspaces
  id, project_id → projects, department_id → departments, rag_status (rag_enum),
  created_at
  UNIQUE(project_id, department_id)

tasks
  id, workspace_id → department_workspaces, title, description, assignee_id → users,
  rag_status, due_date, start_date, baseline_due_date, baseline_start_date,
  created_at, created_by → users

update_cycles
  id, opens_at, closes_at, status (open|closed)

department_updates
  id, cycle_id → update_cycles, workspace_id → department_workspaces,
  submitted_by → users, content (jsonb), status (draft|pending|approved|rejected),
  submitted_at, approved_by → users, approved_at, created_at

rag_status_history
  id, entity_type (task|workspace|project), entity_id, old_status, new_status,
  department_id → departments, project_id → projects,  -- denormalized at write time, for RLS scoping (§10)
  changed_by → users, changed_at
  -- append-only; no UPDATE/DELETE on application role

approvals
  id, entity_type, entity_id, from_status, to_status, actor_id → users,
  department_id → departments, project_id → projects,  -- denormalized at write time, for RLS scoping (§10)
  actioned_at, notes

baselines
  id, project_id → projects, name, locked_at, locked_by → users,
  snapshot (jsonb)  -- full serialized state at lock time

revisions
  id, baseline_id → baselines, created_at, created_by → users,
  delta (jsonb)  -- computed by the single delta(project, at?) module (§5, §20); never diffed ad hoc per consumer

audit_log
  id (bigserial), entity_type, entity_id, action (create|update|delete|approve|etc.),
  actor_id, actor_snapshot (jsonb),  -- denormalized; survives user deletion
  department_id → departments, project_id → projects,  -- denormalized BY THE TRIGGER at write time, for RLS scoping
  old_values (jsonb), new_values (jsonb), occurred_at
  -- UPDATE and DELETE revoked for app role; written by SECURITY DEFINER trigger only
  -- ONE generic trigger function audit_capture() is attached to every audited table; it calls
  -- resolve_scope(entity_type, entity_id) -> (department_id, project_id) so scope denormalization
  -- lives in exactly ONE place (see §20). The same resolver feeds rag_status_history/approvals/escalation_events,
  -- so directors can be granted own-department SELECT (§10) without per-table bespoke logic.

dependencies
  id, source_task_id → tasks, target_task_id → tasks,
  relation_type (blocks|precedes|relates), created_by → users, created_at

escalation_rules
  id, rule_type (late_update|red_lingering|blocked_dependency),
  target_scope (department|project|global), target_id,
  period_bucket (escalation_period),  -- re-send cadence for THIS rule (iso_week reminder vs. daily red re-nag)
  active

escalation_steps                       -- the per-rule ladder; replaces a single threshold_hours
  id, rule_id → escalation_rules, level (int: 1=member reminder, 2=director, 3=executive),
  threshold_hours,                      -- hours after the previous step before this step fires
  recipient_scope (recipient_scope)
  UNIQUE(rule_id, level)

escalation_events
  id, rule_id → escalation_rules, level (int),  -- which ladder step fired
  target_entity_id, department_id → departments, project_id → projects,  -- denormalized, for RLS scoping (§10)
  triggered_at, resolved_at

notification_outbox
  id, rule_id, level (int),  -- the ladder step this send belongs to
  recipient_id → users, subject, body, channel (email|teams),
  dedup_key (TEXT UNIQUE),  -- format: "rule:<id>:step:<level>:target:<id>:period:<bucket>"
                            -- <bucket> granularity comes from escalation_rules.period_bucket (NOT hard-coded iso-week)
  status (queued|sent|failed), created_at, sent_at

budgets
  id, workspace_id → department_workspaces, budget_amount, approved_by → users,
  approved_at

budget_actuals
  id, budget_id → budgets, amount, description, recorded_by → users, recorded_at

reports
  id, report_type (weekly|monthly), generated_at, generated_by → users,
  file_path (Supabase Storage key), scope_type, scope_id
```

### Enumerations

```sql
CREATE TYPE rag_enum AS ENUM ('green', 'amber', 'red');
CREATE TYPE update_status AS ENUM ('draft', 'pending', 'approved', 'rejected');
CREATE TYPE approval_action AS ENUM ('approve', 'reject');
CREATE TYPE notification_channel AS ENUM ('email', 'teams');
CREATE TYPE notification_status AS ENUM ('queued', 'sent', 'failed');
CREATE TYPE relation_type AS ENUM ('blocks', 'precedes', 'relates');
CREATE TYPE escalation_period AS ENUM ('iso_week', 'day');   -- per-rule re-send cadence
CREATE TYPE recipient_scope AS ENUM ('member', 'director', 'executive');
```

---

## 10. Access-Control Design

### Claim issuance and lockdown (build this in Phase 1, before any policy is trusted)

`role` and `department_id` are NOT set by the client. A **Supabase Custom Access Token (Auth) Hook** reads them from the `users` table at token issuance and stamps them into the JWT. Therefore:

- The `users` table has RLS that lets a user read their own row but **never update their own `role` or `department_id`** (a column-restricted UPDATE policy, plus a trigger that rejects self-changes to those columns). Only the service role or an executive may change them.
- On any change to a user's `role` or `department_id`, the app **revokes that user's sessions** (or a short access-token TTL is used) so stale claims cannot grant old access. Confirm the TTL / forced-re-login policy with the client (§18).

### Helper functions (every policy uses these — no policy re-implements the predicate)

```sql
-- Defined once, in a NON-managed schema (public — never the Supabase-managed `auth` schema).
-- STABLE so the planner caches them per statement.
CREATE FUNCTION public.current_department() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT ((SELECT auth.jwt()) ->> 'department_id')::uuid
$$;
CREATE FUNCTION public.is_executive() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT ((SELECT auth.jwt()) ->> 'role') = 'executive'
$$;
-- Deepen the repeated "join through workspace to a department" predicate into ONE helper
-- so no workspace-child policy (tasks, budgets, department_updates, …) re-implements the join (§20):
CREATE FUNCTION public.belongs_to_my_department(p_workspace_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM department_workspaces w
    WHERE w.id = p_workspace_id AND w.department_id = public.current_department()
  )
$$;
```

Wrapping `auth.jwt()` as `(SELECT auth.jwt())` makes Postgres evaluate it **once per query**, not once per row — a required RLS performance pattern at our row counts.

### RLS policy structure

Every table holding department-scoped data carries policies built from the helpers above:

```sql
-- department_workspaces read policy
CREATE POLICY "members see own department workspaces"
  ON department_workspaces FOR SELECT
  USING ( department_id = public.current_department() OR public.is_executive() );

-- tasks read policy (join through workspace)
CREATE POLICY "members see tasks in own department"
  ON tasks FOR SELECT
  USING (
    public.belongs_to_my_department(workspace_id) OR public.is_executive()
  );

-- audit_log / rag_status_history / approvals / escalation_events are polymorphic
-- (entity_type/entity_id) and carry a DENORMALIZED department_id (§9), so a director
-- can be granted own-department SELECT on them:
CREATE POLICY "directors read own-department audit"
  ON audit_log FOR SELECT
  USING ( department_id = public.current_department() OR public.is_executive() );
-- INSERT on audit_log happens only via the SECURITY DEFINER trigger; UPDATE/DELETE revoked at the role level.
```

If denormalizing `department_id` onto any of those four tables is undesirable, make that table **executive-only SELECT** instead — never leave a director policy referencing a column the table does not have. **§9 and this section must agree.**

### Isolation guarantee

- A Member or Director can only read/write rows where `department_id` matches their claim; the executive override is an explicit `OR public.is_executive()` on every policy, not a policy bypass.
- `audit_log`, `rag_status_history`, `approvals`, `escalation_events` are SELECT-scoped via their denormalized `department_id`; INSERT is trigger/service-role only; UPDATE/DELETE revoked at the role level.

### Realtime is scoped separately

Table RLS does NOT secure Realtime. Department dashboards subscribe over **private channels** authorized by **RLS policies on `realtime.messages`** (Realtime Authorization). Never use public broadcast or unscoped `postgres_changes` for department data. (Pen-test in §15.)

### Storage is scoped separately

Report files live in **non-public** buckets. RLS on `storage.objects` mirrors the department model and the object path encodes scope (e.g. `reports/<department_id>/...`). Signed URLs are generated **only after a server-side scope check**, never minted blindly. (Pen-test in §15.)

### Service-role paths bypass RLS — re-scope in code

The report generator, escalation dispatcher, and every Edge Function run as the service role and see all rows. They MUST re-apply the department/project filter in code. A service-role query must never place cross-department data into a department-scoped artifact (report, export, notification). (Test in §15; rule in §17.)

### Membership JOIN reference

OpenProject `app/models/projects/scopes/allowed_to.rb` and Taiga `taiga/base/filters.py` show how to build membership-JOIN access filters. We study the join logic (user → membership → project → permission), then implement equivalent logic as real Postgres RLS policies. We do not copy their source.

---

## 11. Escalation Engine Design

### Architecture

```
pg_cron (every 15 min)
  → find due (rule, step) pairs: JOIN escalation_rules → escalation_steps
     WHERE the step's threshold_hours has elapsed and the step has not fired this period
     FOR UPDATE SKIP LOCKED
  → INSERT INTO notification_outbox
       (level, dedup_key = 'rule:<id>:step:<level>:target:<id>:period:<bucket>')
     -- <bucket> derives from escalation_rules.period_bucket (iso_week, day, ...), NOT hard-coded
     ON CONFLICT ON CONSTRAINT notification_outbox_dedup_key_key DO NOTHING
  → pg_net: POST to Edge Function URL
  → Edge Function: validate payload, call Resend API
  → UPDATE notification_outbox SET status = 'sent', sent_at = now() WHERE id = $1
```

### Escalation ladder (modeled explicitly as `escalation_steps`)

Each rule has ordered steps in `escalation_steps` (level + `threshold_hours` + `recipient_scope`):

1. **Level 1 — Reminder:** the deadline passes without a submission → email to department Member(s).
2. **Level 2 — Director escalation:** `threshold_hours` after level 1, still unresolved → email to Director.
3. **Level 3 — Executive escalation:** `threshold_hours` after level 2, still unresolved → email to Executive.

Each fired step writes a distinct `escalation_events` row (carrying its `level`) and a distinct `notification_outbox` row whose `dedup_key` includes `step:<level>` — so the three steps never collapse into a single key. Thresholds and recipients are configured per step in `escalation_steps`; the re-send cadence (`period_bucket`) is configured per rule in `escalation_rules` — `iso_week` for the update-cycle reminder, `day` for a red-item-lingering re-nag. Do not hard-code iso-week for all rules.

### Idempotency guarantee

The `dedup_key` UNIQUE constraint on `notification_outbox` ensures a second INSERT for the same **rule + step + target + period** is silently dropped — each ladder step sends exactly once per period, and the steps are independent. The `SELECT ... FOR UPDATE SKIP LOCKED` pattern ensures concurrent cron instances do not double-process. A failed send sets `status = 'failed'` and is retried by the outbox sender job with exponential backoff, not by creating a new row.

### Deepening: separate "what is due" from "how it sends" (see §20)

- **Rule evaluation is a pure module.** `due_escalations(now) -> [{rule, step, target, recipient, department_id, project_id}]` computes which (rule, step, target) tuples are due — each `rule_type` (`late_update` / `red_lingering` / `blocked_dependency`) computes its own anchor time behind the one interface. The **clock is injected**, so the whole engine is unit-tested with a fake clock through this single interface — no real time, no real sends. The dispatcher just consumes the list and writes outbox rows.
- **Delivery is behind a `Notifier` port.** The engine depends on a `Notifier` interface (`send(recipient, message, channel)`), not on Resend directly. Adapters: a **Resend adapter** (email, now), a **Teams/Graph adapter** (Phase 8), and an **in-memory adapter** (tests). Two real adapters (email today, Teams later — §12) justify the seam, and tests assert what was sent without touching Resend.

### Anti-patterns avoided (negative lessons from the study)

- Taiga `select_for_update()` batch: the correct anti-double-send pattern — adopt.
- OpenProject GoodJob `cron_at` predecessor tracking: prevents gap-fill double-send on restart — adopt.
- Leantime `msghash` PK on queue: hash-based dedup — adopt as `dedup_key`.
- Leantime `pruneEvents` delete: **do not implement** — audit rows must never be pruned.

---

## 12. Microsoft Integration Approach

### Entra ID SSO (required from Phase 1)

SolServices uses Microsoft 365. Users sign in with their work account via Microsoft Entra ID (formerly Azure AD) using OIDC/OAuth2.

**App registration required:** An app registration in the company's Entra tenant with:
- Redirect URI pointing to Supabase Auth callback.
- Delegated permissions: `openid`, `profile`, `email`, `offline_access`.
- (Full tier only) `Calendars.ReadWrite`, `OnlineMeetings.ReadWrite`, `ChannelMessage.Send`.

**Who administers:** Confirm with client whether their IT department or Entra admin handles app registration, or if we do it under their tenant.

**Supabase side:** Configure Entra as a custom OIDC provider in Supabase Auth. The Entra `oid` claim is stored on the `users` table as `entra_oid` for stable cross-system identity.

### Light tier (Phase 1 scope)

- Login with M365 account via OIDC.
- Email reminders and escalations via Resend.
- `.ics` calendar invites attached to email for update cycle deadlines.

### Full tier (Phase 8 — confirm with client whether in scope for v1)

- Auto-created Teams meetings for governance review sessions (Graph: `OnlineMeetings.Create`).
- Outlook calendar sync for update deadlines and milestones (Graph: `Calendars.ReadWrite`).
- Teams channel notifications for escalations (Graph: `ChannelMessage.Send` or `chatMessage.send`).

All Graph calls happen inside Supabase Edge Functions using application-level permissions (client credentials flow) or delegated tokens stored securely. Never call Graph from the browser.

The Teams/Outlook channel is a **`Notifier` adapter** behind the same port the email (Resend) notifications use (§11, §20). Adding Teams at Phase 8 is a new adapter, not a rewrite of the escalation engine — the engine only ever calls `Notifier.send(...)`.

---

## 13. Build Phases & Test Gates

Each phase ends with a gate that must pass before the next phase begins.

| Phase | Name | Gate |
|-|-|-|
| 0 | Foundations | Next.js + Supabase project created; Tailwind + shadcn configured; CI passes; EU region confirmed |
| **1** | **Identity & Access (CRITICAL)** | **Entra ID SSO works end-to-end; RLS policies deployed; pen-test proves a Member in Department A cannot read Department B data at the DB layer; service role restricted to server only** |
| 2 | Core governance data | Departments, users, projects, workspaces, tasks created and scoped correctly; CRUD respects RLS |
| 3 | Workflow + baseline + audit | Approval state machine works; baseline lock creates immutable snapshot; audit log written by trigger; UPDATE/DELETE on audit_log rejected at DB level |
| 4 | Weekly cycle + dashboards + budget | pg_cron opens/closes cycles on schedule; department dashboard shows correct scoped data; executive dashboard shows all; budget entries created and variance calculated |
| 5 | Escalation engine + notifications | pg_cron dispatcher fires; notification_outbox dedup key prevents double-send; Resend delivers email; escalation ladder advances correctly; no silent failures |
| 6 | Dependencies + visual map | Dependency records created; xyflow graph renders; blocked status triggers escalation |
| 7 | Reports + export | Weekly/monthly report generated automatically; PDF and Excel export correct and scoped |
| 8 | Teams/Outlook integration | Graph API calls succeed from Edge Functions; Teams notifications delivered; calendar sync works |
| 9 | Hardening + user testing + go-live | Performance testing with 50 users; security review; client UAT sign-off; go-live |

**Phase 1 is the most critical gate.** Nothing else is trustworthy until isolation is proven airtight.

**Every phase also runs the standard review gate before it counts as done — see §19.2:** built-in `/code-review` plus the complementary `requesting-code-review` against that phase's diff, then a `thermo-nuclear-code-quality-review` structural-cleanup pass once the functional test gate passes. Tag phase boundaries in git (e.g. `phase-N-start` / `phase-N-end`) so the reviewers get exact diffs.

---

## 14. Coding Conventions & Project Structure

### Directory layout

```
app/                            # Next.js App Router
  (auth)/                       # Auth routes (sign-in, callback)
  (executive)/                  # Executive-only layouts + pages
  (department)/                 # Department-scoped layouts + pages
  api/                          # Route handlers (never expose service role to client)
  layout.tsx
components/
  ui/                           # shadcn/ui copies (owned, not imported)
  governance/                   # Domain-specific components
  charts/                       # Recharts wrappers
lib/
  supabase/
    client.ts                   # Browser client (anon key)
    server.ts                   # Server client (anon key + cookie session)
    service.ts                  # Service role client — server-only, never imported by client
  types/                        # Generated Supabase types (supabase gen types)
  utils/
supabase/
  migrations/                   # All DDL migrations; numbered sequentially
    0001_departments.sql
    0002_users.sql
    ...
    0010_rls_policies.sql       # RLS policies in their own migration file
  functions/                    # Edge Functions
    escalation-sender/          # Receives pg_net call; sends via Resend
    graph-bridge/               # Microsoft Graph API calls
    report-generator/
  seed.sql
docs/
  agents/                       # mattpocock-suite config: issue tracker, triage labels, domain (§19.6)
  adr/                          # Architecture Decision Records — created lazily as decisions crystallize
research/                       # Study output (gitignored vendor clones)
  reports/                      # The 8 report files + RANKING.md + UTILIZATION_REPORT.md
  vendor/                       # Cloned repos — NEVER import from here into app code
.env.local                      # NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY
                                # SUPABASE_SERVICE_ROLE_KEY — server only, never NEXT_PUBLIC_
```

### Key conventions

- Never use `NEXT_PUBLIC_` prefix on secrets. The service role key must never reach the browser.
- All RLS migrations are in `supabase/migrations/`. Never apply RLS via the Supabase dashboard UI alone — it must be in version control.
- Generate TypeScript types from the schema: `supabase gen types typescript --local > lib/types/database.ts`. Re-run after every migration.
- Server components fetch via `createServerClient` with the user's cookie session. RLS enforces scoping automatically.
- Route handlers use `createServerClient` for user-scoped operations, `createServiceClient` only when bypassing RLS is intentional and documented.
- Edge Functions use `SUPABASE_SERVICE_ROLE_KEY`. They must validate the incoming request (shared secret or JWT) before acting.
- Service-role code (Edge Functions, pg_cron jobs, report generator) bypasses RLS — it MUST re-apply the department/project filter in code (see §10). Never assume RLS protects a service-role query.
- The JWT `role`/`department_id` claims come from the Custom Access Token (Auth) Hook (§10). Never read role/department from a client-supplied value; the `users` table forbids self-update of those columns.
- Audit log writes must go through triggers, not application code. Never insert into `audit_log` from a route handler. Use ONE generic `audit_capture()` trigger function on every audited table, backed by a single `resolve_scope()` resolver — do not hand-write per-table audit logic (§20).
- Put external services behind a port. The escalation/notification engine depends on a `Notifier` interface (Resend adapter now, Teams/Graph adapter at Phase 8, in-memory adapter for tests); rule evaluation is the pure `due_escalations(now)` module with an injected clock (§11, §20). Keep transport out of the domain logic.
- Compute baseline delta in the one `delta()` module; never diff current-vs-baseline ad hoc in a view, report, or route handler (§5, §20).
- Enumerations in Postgres (not as varchar) for all finite-value fields: `rag_enum`, `update_status`, etc.

---

## 15. Testing Strategy

### Per-phase gates

Each phase gate includes:
- Unit tests for new service functions (vitest).
- Integration tests for RLS policies (Supabase CLI local instance).
- Manual smoke test of the happy path for that phase.

### Phase 1 isolation pen-test (mandatory before any other phase)

The following must all be confirmed to FAIL or be blocked:

1. Sign in as a Member of Department A. Attempt a direct SQL query (via Supabase JS client) to `SELECT * FROM tasks`. Confirm only Department A tasks are returned.
2. Sign in as a Member of Department A. Attempt to POST a route handler that reads Department B's `department_workspaces`. Confirm a 403 or empty result.
3. Sign in as a Director of Department A. Attempt to approve a Department B update. Confirm rejection.
4. Sign in as an Executive. Confirm that ALL departments' data is visible.
5. As the application Postgres role (not service role), attempt `DELETE FROM audit_log WHERE id = 1`. Confirm permission denied.
6. As the application Postgres role, attempt `UPDATE audit_log SET actor_id = null WHERE id = 1`. Confirm permission denied.
7. **Realtime:** Sign in as a Member of Department A and subscribe to the department dashboard channel. Confirm they receive Department A change events and **never** receive Department B change events (Realtime Authorization on `realtime.messages`, not just table RLS).
8. **Storage:** As a Member of Department A, attempt to fetch Department B's report both by object path and by a signed URL. Confirm both are denied.
9. **Service role:** Run the report generator (service role) scoped to Department A. Confirm the output contains only Department A data — never all departments — proving the in-code scoping holds even though RLS is bypassed.

### Exhaustive isolation regression (runs in CI on every migration)

Do not test isolation once at Phase 1 and forget it. A test enumerates **every** department-scoped table programmatically (from the catalog), asserts RLS is **enabled** on each, and asserts that a cross-department read as a Member returns zero rows. It runs in CI on every migration, so a new table or a dropped policy fails the build immediately.

### Escalation engine tests

- Deploy a rule with a 1-minute threshold. Confirm the outbox row is created exactly once.
- Trigger the dispatcher twice concurrently. Confirm exactly one email is sent per step (the `dedup_key` includes `step:<level>`, so the second insert is dropped).
- Advance time through all three ladder steps of one rule. Confirm three distinct sends occur (reminder, director, executive) — i.e. the steps do NOT collapse into a single dedup key.
- Simulate a failed send (Resend returns 500). Confirm the outbox row is marked `failed` and retried, not duplicated.

### RAG status tests

- Change a task to Red. Confirm `rag_status_history` has a new row.
- Attempt to delete the history row as application role. Confirm denied.

---

## 16. Borrowed Patterns & Licensing

### What we borrow (patterns, not code)

| Pattern | Source repo | Specific file(s) | What we take |
|-|-|-|-|
| Snapshot + diff + advisory lock | Taiga (MPL-2.0 back-end) | `taiga/projects/history/services.py`, `taiga/projects/history/models.py` | `take_snapshot`/`make_diff`/`get_last_snapshot_for_key` idiom; `HistoryEntry` field structure (diff JSON + full snapshot + user snapshot + `is_snapshot` flag) |
| Temporal audit log DDL | OpenProject (GPL-3.0) | `db/migrate/tables/journals.rb` | `tstzrange validity_period` with exclusion constraint + GIN index; point-in-time reconstruction pattern |
| Point-in-time attribute reads | OpenProject (GPL-3.0) | `app/models/journable/with_historic_attributes.rb` | `attributes_by_timestamp` pattern for baseline comparison |
| Approvals state machine | Tuleap (GPL-2.0) | `plugins/tracker/db/install.sql` (workflow tables); `languages/en/user-guide/trackers/administration/configuration/workflow.rst` | Per-transition group preconditions; transition matrix structure |
| PMBOK hierarchy + RAG | OpenPPM (GPL-3.0) | `schemas/CreateDB.sql` | `performingorg → project` hierarchy; `rag char(1)` on project; `logprojectstatus` append-log shape; `changecontrol` |
| Escalation job anti-double-send | Taiga (MPL-2.0) | `taiga/projects/notifications/services.py` | `select_for_update()` batch pattern |
| Cron predecessor tracking | OpenProject (GPL-3.0) | `app/workers/cron/quarter_hour_schedule_job.rb` | `cron_at` predecessor tracking to prevent gap-fill double-send |
| Queue dedup key | Leantime (AGPL-3.0) | `app/Domain/Queue/Repositories/Queue.php` (msghash dedup on `zp_queue`); column defined in `app/Domain/Install/Services/SchemaBuilder.php` | Hash-based deduplication → implemented as `dedup_key UNIQUE` on `notification_outbox` |
| Membership JOIN logic | OpenProject (GPL-3.0) | `app/models/projects/scopes/allowed_to.rb` | Join structure: user → membership → project → role → permission |
| Membership filter pattern | Taiga (MPL-2.0) | `taiga/base/filters.py` | `get_filter_expression_can_view_projects()` as reference for translating to RLS |
| Relation types (dependency) | OpenProject (GPL-3.0) | `app/models/relation.rb` | `precedes/blocks/relates` taxonomy |
| Intake state machine | Plane (AGPL-3.0) | `apps/api/plane/db/models/intake.py` | `PENDING → ACCEPTED/REJECTED` integer enum structure |
| FTS approach | Taiga (MPL-2.0) | `taiga/searches/services.py` | `to_tsvector` / `to_tsquery` pattern for Postgres FTS |

### Negative examples (what NOT to do)

| Anti-pattern | Source | File |
|-|-|-|
| Audit rows that can be deleted | Leantime | `app/Domain/Audit/Repositories/Audit.php` (`pruneEvents` method) |
| App-layer-only audit with superuser bypass | Tuleap | `plugins/tracker/include/Tracker/Artifact/Tracker_Artifact_Changeset.class.php` (lines 298–304) |
| App-layer-only isolation | All six repos | Universal lesson: Django querysets, Rails scopes, PHP session checks are all bypassable |
| AGPL version rows pruned by scheduled task | Plane | `apps/api/plane/celery.py` (`delete_issue_description_versions`) |

### Licensing rule (mandatory)

**GPL-3.0 (OpenProject, OpenPPM), GPL-2.0 (Tuleap), AGPL-3.0 (Plane, Leantime, Taiga-front): NO code from these repos may enter the PMO Control Tower codebase.** Reading to understand patterns is permitted. Copying, adapting, or structurally deriving from their source is not.

**Taiga-back is MPL-2.0.** File-level reuse is legally possible (modified files must be released under MPL-2.0; surrounding proprietary code is not affected). In practice, Taiga-back is Python and we are TypeScript — a port is a rewrite. Treat it as a close reference and reimplement cleanly. Verify the `LICENSE` and `DCOLICENSE` files in the repo before any direct reuse.

The cloned repos live in `research/vendor/` (gitignored). They must never be imported into app code.

---

## 17. Do / Do-Not List

### Do

- Enforce isolation in Postgres RLS — never rely on application-layer filters alone.
- Write audit rows only from `SECURITY DEFINER` triggers or service-role Edge Functions.
- Revoke UPDATE and DELETE on `audit_log` for the application Postgres role.
- Use `dedup_key UNIQUE` on `notification_outbox` for all escalation/notification sends.
- Use `SELECT ... FOR UPDATE SKIP LOCKED` in the escalation dispatcher.
- Store the service role key server-side only. Never prefix it with `NEXT_PUBLIC_`.
- Run migrations from `supabase/migrations/` — never apply schema changes manually without recording them.
- Regenerate `lib/types/database.ts` after every migration.
- Prove Phase 1 isolation before building anything on top of it.
- Scope every search query through RLS — do not bolt on permission filters in application code.
- Denormalize `actor_snapshot (jsonb)` in `audit_log` so records survive user deletion. Also denormalize `department_id`/`project_id` onto `audit_log`, `rag_status_history`, `approvals`, and `escalation_events` (via the trigger) so directors can be granted own-department SELECT (§10).
- Issue `role`/`department_id` claims only via the Custom Access Token (Auth) Hook reading the `users` table; forbid users from updating their own `role`/`department_id` (service role or executive only).
- Use `(SELECT auth.jwt())` and the `public.current_department()` / `public.is_executive()` helpers in every RLS policy — never inline the predicate per policy.
- Re-apply department/project scoping in every service-role code path (report generator, escalation dispatcher, Edge Functions); RLS does not protect the service role.
- Scope Realtime via private channels + Realtime Authorization; scope Storage via `storage.objects` RLS + non-public buckets + server-side-checked signed URLs.
- Revoke a user's sessions (or use a short access-token TTL) when their `role` or `department_id` changes, so stale claims cannot grant old access.
- Design for ~50 users and 9 departments. Do not over-engineer for multi-tenancy.

### Do Not

- Do not copy any line of GPL-3.0, GPL-2.0, or AGPL-3.0 source into the codebase.
- Do not import anything from `research/vendor/`.
- Do not use `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` or any similar exposure of the service key.
- Do not enforce department isolation only in UI components or API route handlers — a single bug would be a data breach.
- Do not implement a `pruneEvents` or `DELETE FROM audit_log` path anywhere, for any reason.
- Do not trust the browser for role claims — always re-read role from the DB or JWT, never from a client-side variable. Never let a user set or update their own `role` or `department_id`.
- Do not stream department-scoped data over public or unauthorized Realtime channels — use private channels with Realtime Authorization (RLS on `realtime.messages`).
- Do not store reports in a public Storage bucket, and do not hand out a signed URL without a server-side scope check.
- Do not let a service-role query place cross-department data into a department-scoped artifact (report, export, notification) — re-scope in code.
- Do not build the escalation engine as a polling loop in a route handler or cron webhook without the outbox dedup pattern — this will double-send.
- Do not add any enterprise-edition features from studied repos (OpenProject EE, Tuleap Enterprise, Plane Pro) — they are commercial-only and have no open source code to reference.
- Do not deploy without running the Phase 1 isolation pen-test.
- Do not skip the `supabase gen types` step after a migration — stale types cause silent runtime errors.

---

## 18. Open Questions for Client

Confirm all of the following before or at the start of Phase 1.

| # | Question | Why it matters |
|-|-|-|
| 1 | **Data residency:** Managed Supabase/Vercel in EU region, or must data stay inside SolServices' own Azure tenant? | Determines hosting topology; Azure tenant requires Supabase self-host or Azure PostgreSQL + custom deployment |
| 2 | **Weekly update cut-off:** Day + time still to confirm (default: Friday 17:00). Timezone **confirmed: `Europe/Budapest`** (Budapest, Hungary) — set as `APP_TIMEZONE`; pg_cron schedules use it. | pg_cron jobs scheduled in `Europe/Budapest`; client's fiscal week must align |
| 3 | **Budget source of truth:** Does financial data (actuals, forecasts) originate in the PMO Control Tower, or is it pulled from an external system (ERP, finance platform)? | Determines whether we build a budget entry UI or a data integration layer |
| 4 | **Teams/Outlook (full tier):** Is the full Microsoft Graph integration (Teams meetings, calendar sync, Teams notifications) in scope for v1, or is light tier (login + email) sufficient for launch? | Phase 8 scope and timeline |
| 5 | **Audit retention period:** How long must audit records be retained? Indefinitely, or a defined period (e.g., 7 years for regulatory compliance)? | Affects storage sizing and whether we need a cold-archive path (no prune path in hot DB) |
| 6 | **Entra app registration:** Who will create and administer the app registration in the SolServices Entra tenant — their IT team or us? | Must be resolved before Phase 1 SSO work begins |
| 7 | **Escalation thresholds:** What are the default N-hour thresholds for each escalation step (reminder → director escalation → executive escalation)? | Required to configure `escalation_rules` seed data |
| 8 | **Who is Executive?** Exact list of users who receive the all-departments executive view. | Role assignment and notification routing |
| 9 | **Baseline locking authority:** Who can lock a baseline — only the PMO/executive, or also project directors? | Determines the role gate on the baseline lock action |
| 10 | **Phase 8 priority:** Should Teams/Outlook integration be built in parallel with Phase 7 reporting, or strictly after? | Resource and timeline planning |
| 11 | **Token TTL / forced re-login on role change:** What access-token TTL is acceptable, and is forced re-authentication (session revoke) on a `role`/`department_id` change acceptable to users? | Determines how fast a moved/demoted user loses old access; trades security against re-login friction |

---

## 19. Agent Skills & Review Workflow

This project relies on a fixed set of installed agent **skills**. They are not optional niceties — the review skills are part of every phase gate (§13), and the stack skills encode the conventions this codebase must follow. This section defines **what is installed, how each is invoked, and at which milestones**.

### 19.1 Installed skills inventory

| Skill | Source / type | What it does | How to invoke |
|-|-|-|-|
| `code-review` | Built-in | Reviews the current git diff for correctness bugs + reuse/simplification/efficiency cleanups. Effort levels: low/medium (few, high-confidence) → high/max (broader) → `ultra` (deep multi-agent cloud review). Flags: `--comment` (post inline PR comments), `--fix` (apply fixes). | `/code-review`, `/code-review high`, `/code-review ultra`, `/code-review --fix` |
| `requesting-code-review` | Installed (obra/superpowers) | Dispatches a **fresh-context** code-reviewer subagent that sees only a crafted brief + the diff between two SHAs — never your session history. Independent second opinion; preserves your context. Ships a `code-reviewer.md` template. | Auto-eligible, or explicitly: invoke the skill, give it `{BASE_SHA}`/`{HEAD_SHA}` + a short description of what was built |
| `thermo-nuclear-code-quality-review` | Installed (cursor/plugins) | Extremely strict maintainability audit: abstraction quality, files crossing ~1000 lines, spaghetti-conditional growth, and ambitious "code-judo" restructures that delete complexity. **Manual-invoke only** (`disable-model-invocation: true`) — it will not auto-trigger. | Explicitly only: `/thermo-nuclear-code-quality-review` (or Skill tool by name) |
| `simplify` | Built-in | Quality-only pass (reuse/simplification/efficiency/altitude) that applies fixes. Does **not** hunt for bugs — use `/code-review` for that. | `/simplify` |
| `security-review` | Built-in | Security review of pending changes on the current branch. | `/security-review` |
| `supabase` | Installed (global) | Authority for ALL Supabase work: Postgres, Auth, RLS, Edge Functions, Realtime, Storage, Cron/pg_cron, supabase-js / `@supabase/ssr`, sessions/JWT/cookies, migrations, security audits, extensions. | Auto-triggers on Supabase work; or invoke `supabase` |
| `supabase-postgres-best-practices` | Installed (global) | Postgres performance + schema best practices: index design, RLS-policy performance, query tuning. | Auto-triggers on query/schema work; or invoke by name |
| `vercel-react-best-practices` | Installed (global) | React/Next.js performance: RSC vs client, data fetching, bundle optimization, render patterns. | Auto-triggers on React/Next.js work; or invoke by name |
| `anthropic-skills:pdf` | Anthropic plugin | Create/fill/merge/split/extract/OCR PDFs. | Auto-triggers on PDF tasks; or `/pdf` |
| `anthropic-skills:docx` | Anthropic plugin | Create/edit Word documents. | Auto-triggers; or `/docx` |
| `anthropic-skills:xlsx` | Anthropic plugin | Create/edit Excel workbooks. | Auto-triggers; or `/xlsx` |
| `tdd` | Installed (mattpocock) | Red→green→refactor as **vertical slices** (one test → one impl; never "all tests first"). Tests assert behaviour through the public interface so they survive refactors. Bundles `deep-modules.md`, `interface-design.md`, `mocking.md`. | When building a feature or fixing a bug test-first; and to **run each phase's tests in their appropriate scope** at the gate (§15, §19.2) |
| `diagnose` | Installed (mattpocock) | Disciplined debugging loop for hard bugs / perf regressions: reproduce → minimise → hypothesise → instrument → fix → regression-test. | When something is broken/throwing/failing or a perf regression appears mid-phase — "diagnose this" |
| `to-prd` | Installed (mattpocock) | Turns the current conversation/scope into a PRD published to the project issue tracker. | At a phase kickoff, to turn agreed scope into a written PRD before breaking it down |
| `to-issues` | Installed (mattpocock) | Breaks a plan/spec/PRD into independently-grabbable issues using tracer-bullet vertical slices. | After `to-prd`, to turn a phase's PRD into implementation tickets on the tracker |
| `improve-codebase-architecture` | Installed (mattpocock) | Finds **deepening** opportunities (shallow→deep modules), informed by the domain glossary + ADRs; outputs an HTML report of candidates, then grills the chosen one. Vocabulary: module/interface/seam/leverage/locality + the deletion test. | At the **end of a phase** (alongside `thermo-nuclear`) and whenever a module feels tangled or is hard to test through its interface. Used to produce §20. |

> All skills run with full agent permissions. Review their output before applying. `requesting-code-review` requires git SHAs, so this project must be a git repo from Phase 0 and every phase boundary must be tagged.
> **The mattpocock skills are a suite.** `to-issues`, `to-prd`, `diagnose`, `tdd`, and `improve-codebase-architecture` read the project's domain glossary + ADRs and publish to an issue tracker. Run **`setup-matt-pocock-skills`** once (it writes an `## Agent skills` block + a `docs/agents/` layout recording the tracker = this GitHub repo, the triage labels, and the domain-doc location) before relying on `to-issues`/`to-prd`. Until a dedicated `CONTEXT.md` / `docs/adr/` exists, these skills treat **this CLAUDE.md** as the domain glossary and decision record.

### 19.2 The standard per-phase review gate (run on EVERY phase)

Run this sequence at the close of **every** phase 0–9. The order matters: prove it works first, then review behavior, then clean up structure.

1. **Build the phase.** Do NOT run `thermo-nuclear-code-quality-review` mid-build — it will try to refactor things that aren't finished yet and fight you.
2. **Pass the functional test gate** for that phase (§13). Build features test-first with the **`tdd`** skill (one test → one impl), and run **that phase's tests in their appropriate scope** — the RLS integration suite for Phase 1, the escalation tests for Phase 5, the export tests for Phase 7, etc. (the test groups in §15) — plus the isolation pen-test where relevant. `tdd` runs the scoped suite for the milestone being closed, not unrelated suites.
3. **Run the built-in `/code-review`** against the phase diff. Scale effort to risk: `medium` for routine phases (2, 6, 7); `high` or `ultra` for the high-stakes phases (**1 identity/RLS, 3 audit/baseline, 5 escalation, 9 hardening**). Use `--fix` to apply, or `--comment` if working through a PR.
4. **Run the complementary `requesting-code-review`** against the same diff (`BASE_SHA = phase-N-start`, `HEAD_SHA = phase-N-end`). This gives an independent, fresh-context review that catches what a diff-only pass misses (missing requirements, wrong abstractions, untested paths). Both reviews run after each phase by default — see the rigor tiers note below for the lighter option on low-risk phases.
5. **Once the gate passes and the feature actually works, run `thermo-nuclear-code-quality-review`** as a structural-cleanup pass before moving to the next milestone (see §19.3).
6. **Apply the fixes, re-run the gate, then proceed** to the next phase.

### 19.3 thermo-nuclear-code-quality-review — when and how to use it on this project

- **Not during the initial build of a phase.** It would fight you and try to refactor things that aren't finished yet.
- **At the end of each phase, after that phase's test gate passes and the feature actually works,** run it as a structural cleanup pass before moving to the next milestone. That stops slop from compounding across nine phases.
- **Especially before Phase 9 (hardening and go-live),** and any time a file is ballooning (it flags files crossing ~1000 lines by default) or a module feels tangled.
- **Invoke it explicitly** — it is manual-only and will not auto-trigger. Expect it to be harsh and to propose ambitious restructures; that is the point. On this codebase, point it especially at the RLS policy files, the audit/baseline trigger logic, and the escalation dispatcher, where tangled conditionals are most dangerous.

### 19.4 Which skill at which milestone

| Phase | Primary stack skills | Review skills at gate |
|-|-|-|
| 0 Foundations | `supabase` (project init, EU region), `vercel-react-best-practices` | `/code-review` + `requesting-code-review`; thermo-nuclear (light) |
| 1 Identity & Access | `supabase` (Auth, Entra OIDC, RLS), `supabase-postgres-best-practices` (RLS policy performance) | `/code-review ultra` + `requesting-code-review` + `/security-review`; thermo-nuclear on RLS files |
| 2 Core governance data | `supabase`, `supabase-postgres-best-practices`, `vercel-react-best-practices` | `/code-review` + `requesting-code-review`; thermo-nuclear |
| 3 Workflow + baseline + audit | `supabase-postgres-best-practices` (triggers, temporal tables), `supabase` | `/code-review high` + `requesting-code-review`; thermo-nuclear on audit/baseline logic |
| 4 Weekly cycle + dashboards + budget | `supabase` (pg_cron), `vercel-react-best-practices` (dashboards) | `/code-review` + `requesting-code-review`; thermo-nuclear |
| 5 Escalation engine + notifications | `supabase` (pg_cron + pg_net + Edge Functions), `supabase-postgres-best-practices` | `/code-review high` + `requesting-code-review`; thermo-nuclear on dispatcher |
| 6 Dependencies + visual map | `vercel-react-best-practices` (xyflow rendering perf) | `/code-review` + `requesting-code-review`; thermo-nuclear |
| 7 Reports + export | `anthropic-skills:pdf`, `anthropic-skills:xlsx`, `anthropic-skills:docx` | `/code-review` + `requesting-code-review`; thermo-nuclear |
| 8 Teams/Outlook | `supabase` (Edge Functions for Graph calls) | `/code-review high` + `requesting-code-review` + `/security-review`; thermo-nuclear |
| 9 Hardening + go-live | all of the above as needed | `/code-review ultra` + `requesting-code-review` + `/security-review`; **full thermo-nuclear sweep across the codebase** |

### 19.5 Reinstalling / verifying skills

Installed globally (symlinked into every agent, including Claude Code). To verify or reinstall:

```
npx skills list --global
npx skills add https://github.com/obra/superpowers --skill requesting-code-review --full-depth --global --yes
npx skills add https://github.com/cursor/plugins --skill thermo-nuclear-code-quality-review --full-depth --global --yes
npx skills add https://github.com/vercel-labs/agent-skills --skill vercel-react-best-practices --global --yes
npx skills add https://github.com/supabase/agent-skills --skill supabase --global --yes
npx skills add https://github.com/supabase/agent-skills --skill supabase-postgres-best-practices --global --yes
# mattpocock engineering suite (ONE --skill per call; --full-depth because they live in subdirs):
npx skills add https://github.com/mattpocock/skills --skill tdd --full-depth --global --yes
npx skills add https://github.com/mattpocock/skills --skill diagnose --full-depth --global --yes
npx skills add https://github.com/mattpocock/skills --skill to-issues --full-depth --global --yes
npx skills add https://github.com/mattpocock/skills --skill to-prd --full-depth --global --yes
npx skills add https://github.com/mattpocock/skills --skill improve-codebase-architecture --full-depth --global --yes
# recommended companion — sets up the suite's tracker / triage labels / domain-doc context:
npx skills add https://github.com/mattpocock/skills --skill setup-matt-pocock-skills --full-depth --global --yes
```

The Anthropic `pdf` / `docx` / `xlsx` skills are provided by the `anthropic-skills` plugin and are already available; install standalone copies from `https://github.com/anthropics/skills` only if that plugin is ever unavailable. The `code-review`, `simplify`, and `security-review` skills are built into Claude Code — nothing to install.

### 19.6 Suite configuration (issue tracker, triage labels, domain docs)

The mattpocock engineering skills read per-repo config from `docs/agents/` (scaffolded by `setup-matt-pocock-skills`, 2026-05-30):

- **Issue tracker — GitHub.** Issues/PRDs live in `merdiofriviaisherebitch/PMO` via the `gh` CLI. Live: the repo is pushed, GitHub Issues is enabled, and `to-issues`/`to-prd` can publish directly. See `docs/agents/issue-tracker.md`.
- **Triage labels — canonical five.** `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` — created on the remote with colors + descriptions. See `docs/agents/triage-labels.md`.
- **Domain docs — single-context.** Until a dedicated `CONTEXT.md` / `docs/adr/` exist, **this CLAUDE.md is the domain glossary (§3) and the decision record (§6 non-negotiables, §20 deepening decisions)** — the suite uses that vocabulary and flags conflicts against those instead of ADRs. See `docs/agents/domain.md`.

---

## 20. Architecture Review — Deepening Pass (2026-05-30)

Run with the `improve-codebase-architecture` lens (deep vs shallow modules, **seams**, **leverage**, **locality**, the **deletion test**) against the **documented** architecture — no code exists yet, so this is a pre-build design review. A full visual report (Tailwind cards + before/after) is written to the OS temp dir per run and is not committed. Decisions marked **Applied** are already baked into the sections above; **Open** items are for the build session to grill before the phase that touches them.

| # | Candidate | Strength | Status | Where |
|-|-|-|-|-|
| C1 | **One `audit_capture()` trigger + `resolve_scope()` resolver** instead of per-table audit triggers. Scope denormalization gets one home (locality); one place to correctly derive `department_id`/`project_id` for `audit_log` + `rag_status_history` + `approvals` + `escalation_events`. Deletion test: a bespoke per-table trigger just re-spreads identical logic across N tables — and one table getting it wrong silently breaks director visibility of audit rows. | Strong | Applied | §9, §14 |
| C2 | **`due_escalations(now)` pure evaluator** behind one interface, clock injected. The engine's "what is due" logic (per `rule_type`) is unit-tested through one seam with a fake clock — no real time, no real sends. Hardens non-negotiable #3. | Strong | Applied | §11, §14 |
| C3 | **`Notifier` port** with Resend + Teams + in-memory adapters. Escalation depends on the port, not Resend; "Teams later" becomes a new adapter, not a rewrite. Two real adapters (email now, Teams at Phase 8) justify the seam. | Strong | Applied | §11, §12, §14 |
| C4 | **Single `delta(project, at?)` module.** Current-vs-baseline diff lives in one deep module consumed by dashboard / reports / delta view; never recomputed per consumer. | Strong | Applied | §5, §9 |
| C5 | **`belongs_to_my_department(workspace_id)` RLS helper.** Deepens the repeated "join through workspace to a department" predicate so no workspace-child policy re-implements the join. | Worth exploring | Applied | §10 |
| C6 | **Name "Scope" as one domain term** (department / project / workspace / global) with a single `department_id`+`project_id` representation — stops `target_scope` / `scope_type` / denormalized columns from drifting into three vocabularies. | Worth exploring | Applied (glossary); finish during build | §3 |
| C7 | **Reports/export as a deep module over the same `delta()` + Scope**, not a parallel query path. Defer until Phase 7 when the report shapes are known. | Speculative | Open — grill at Phase 7 | — |

**Verdict: solid for Phase 1.** The three non-negotiables now each sit behind a single deep seam — RLS behind `current_department()`/`is_executive()`/`belongs_to_my_department()`; audit behind `audit_capture()`+`resolve_scope()`; escalation behind `due_escalations()`+`Notifier`. That is precisely what makes them testable through one interface and hard to get subtly wrong in N places. No change contradicts an earlier section; the §9↔§10 and §9↔§11 invariants from rev 2 still hold.

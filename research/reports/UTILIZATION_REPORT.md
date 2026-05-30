# UTILIZATION REPORT — what we borrow, reimplement, or build fresh

This maps our 14 modules onto the six studied repos and gives one decision per module: **Reuse code** (only where license *and* stack permit), **Reimplement pattern** (read to understand, write our own clean implementation), or **Build fresh** (no usable precedent). Companion documents: per-repo reports in this folder and `RANKING.md`.

## 1. Reference matrix (module × repo)

Strength = how useful that repo is *as a reference* for that module. `strong` = study it directly; `weak` = partial/illustrative; `—` = nothing useful.

| Our module | OpenProject | Plane | Leantime | Tuleap | OpenPPM | Taiga |
|-|-|-|-|-|-|-|
| 1. Projects & Departments | weak | weak | weak | weak | **strong** | weak |
| 2. Weekly Update Cycle | — | — | — | — | — | — |
| 3. RAG Status | **strong** | — | — | weak | **strong** | weak |
| 4. Approvals & Sign-off | — | — | — | **strong** | weak | — |
| 5. Baseline / Revisions / Delta | **strong** | weak | — | weak | weak | **strong** |
| 6. Audit Trail | **strong** | weak | weak | **strong** | weak | **strong** |
| 7. Dependencies & Visual Map | weak | weak | weak | weak | weak | — |
| 8. Escalation Engine | — | — | — | — | — | — |
| 9. Budget & Cost Governance | weak | — | weak | — | weak | — |
| 10. Dashboards | weak | weak | weak | weak | weak | weak |
| 11. Reports & Export | weak | weak | weak | weak | weak | weak |
| 12. Notifications | weak | weak | weak | weak | weak | weak |
| 13. Access Control (isolation + override) | weak | — | — | weak | weak | weak |
| 14. Search | weak | weak | weak | weak | — | weak |

Two columns of note: **Module 2 (Weekly Update Cycle) and Module 8 (Escalation Engine) are empty across the board**, and **Module 13 (DB-level isolation) is `weak` at best everywhere** — no repo enforces isolation below the application layer.

## 2. Per-module recommendation

**1. Projects & Departments — Reimplement pattern.** Borrow OpenPPM's PMBOK hierarchy shape (company → performing-org → program → project → WBS) as a domain checklist, then build our own `projects → department_workspaces → tasks` model with a real `department` entity (the studied tools only have flat projects or freeform department strings). *Best ref:* OpenPPM `schemas/CreateDB.sql`; secondary OpenProject `app/models/project.rb` (`workspace_type` enum).

**2. Weekly Update Cycle — Build fresh.** No precedent in any tool. Design our own `update_cycle` / `department_update` entities with due dates, draft→submitted states, and a `pg_cron` opener/closer. This is core product IP.

**3. RAG Status — Reimplement pattern.** Borrow OpenProject's `status_code` enum (on_track/at_risk/off_track) journalized for history, and OpenPPM's `logprojectstatus` history-log shape. Build a first-class `rag_status` enum on tasks/projects with an append-only status-history table. *Best ref:* OpenProject `app/models/project.rb`; OpenPPM `logprojectstatus`.

**4. Approvals & Sign-off — Reimplement pattern.** Tuleap's workflow transition matrix (per-transition group preconditions) is the right mental model for director sign-off gates; Plane's `IntakeIssue` PENDING/ACCEPTED/REJECTED is the minimal state-machine version. Build draft → pending → approved with role-gated transitions enforced in RLS + a transitions table. *Best ref:* Tuleap `languages/en/user-guide/.../workflow.rst`; Plane `apps/api/plane/db/models/intake.py`.

**5. Baseline / Revisions / Delta — Reimplement pattern (possible Taiga code reuse).** This is the best-supported governance module. Taiga `history/services.py` (`take_snapshot`/`make_diff`, advisory-locked) is the cleanest snapshot+diff engine and is **MPL-2.0 — the one place file-level code reuse is legally plausible** (verify the LICENSE and MPL obligations first). OpenProject `Journable::WithHistoricAttributes` shows point-in-time reconstruction. Build a `baseline` (locked snapshot) + `revision` + computed `delta` on top of the audit log. *Best ref:* Taiga `taiga/projects/history/{services,models}.py`; OpenProject `app/models/journable/with_historic_attributes.rb`.

**6. Audit Trail — Reimplement pattern, enforce in DB.** Combine OpenProject's `journals` Postgres DDL (`tstzrange validity_period` + exclusion constraint + GIN) with Taiga's `HistoryEntry` (diff JSON + full snapshot + user snapshot surviving deletion). **Critical:** every studied "append-only" log is actually deletable (Tuleap superuser delete; Leantime `pruneEvents`) — we must revoke UPDATE/DELETE at the Postgres role level and write via triggers/SECURITY DEFINER only. *Best ref:* OpenProject `db/migrate/tables/journals.rb`; Taiga `taiga/projects/history/models.py`. *Negative ref:* Leantime `app/Domain/Audit/Repositories/Audit.php`.

**7. Dependencies & Visual Map — Build fresh (borrow data types only).** No tool has an interactive node-graph; Gantt bars are the ceiling. Borrow only the relation taxonomy (precedes/blocks/relates) from OpenProject `Relation` / Plane `IssueRelation`; build the cross-department dependency graph fresh on `@xyflow/react`. *Best ref:* OpenProject relation model; Plane `issue.py` `IssueRelation`.

**8. Escalation Engine — Build fresh.** No precedent anywhere — our key differentiator. Build time-based rules (late update, lingering red, blocked dependency) on `pg_cron` + `pg_net` → Edge Function → Resend, with an outbox/sent-ledger for exactly-once. Borrow *only* the anti-double-send mechanics: Taiga `select_for_update()`, OpenProject GoodJob `cron_at` predecessor tracking, Leantime `msghash` dedup. *Best refs (mechanics):* Taiga `notifications/services.py`; OpenProject `app/workers/cron/quarter_hour_schedule_job.rb`.

**9. Budget & Cost Governance — Reimplement pattern / mostly build fresh.** Borrow OpenPPM's cost table shapes (`projectcosts`, `expenses`, `workingcosts`) and OpenProject's `budgets` module structure as a checklist; build budget-vs-actual with variance flags fresh (none has an approval-gated budget). *Best ref:* OpenPPM `schemas/CreateDB.sql`.

**10. Dashboards — Build fresh.** All references are stack-incompatible (Rails/JSP/Angular widgets) and none has a cross-department executive roll-up. Build with Recharts + RLS-scoped queries; executive view via an explicit exec-override policy. No code to borrow.

**11. Reports & Export — Build fresh.** Borrow only the *concept* of templated weekly/monthly reports (OpenPPM JasperReports, OpenProject reporting). Implement PDF/Excel export in our own stack. No code to borrow.

**12. Notifications — Reimplement pattern.** Idempotent dispatch is the transferable asset: Taiga `select_for_update()` batch, Leantime `msghash` PK dedup, OpenProject debounce. Build on Resend + a Postgres outbox; route email now, Teams/Outlook later via Graph. *Best ref:* Taiga `taiga/projects/notifications/services.py`.

**13. Access Control (department isolation + executive override) — Build fresh with RLS (NON-NEGOTIABLE).** Every studied tool enforces access in the app layer only (Django querysets, Rails `allowed_to` scopes, PHP session role compares) and several bypass it for admins. Read OpenProject `allowed_to.rb` and Taiga `base/filters.py` to understand the membership-JOIN logic, then implement it as **actual Postgres RLS policies** keyed on the user's department + role, with an explicit executive-override policy. The studied code is a *spec for the JOIN logic and a catalogue of what not to rely on*, not a source. *Best ref (logic + cautionary):* OpenProject `app/models/projects/scopes/allowed_to.rb`; Taiga `taiga/base/filters.py`.

**14. Search — Reimplement pattern.** Borrow Taiga's Postgres `to_tsvector` FTS and OpenProject's GIN trigram index approach; build search that runs **through** RLS so results are department-scoped automatically (the studied tools bolt permission filters on top in the app layer — we get it for free from RLS). *Best ref:* Taiga search (`to_tsvector`); OpenProject GIN index.

## 3. The licensing reality

**Code we could legally reuse:** essentially only **Taiga-back (MPL-2.0)** — a file-level (weak) copyleft. We may reuse individual Taiga backend files if we keep modifications to *those files* open-source; our own new files remain proprietary. This is plausible for the `history` engine **but** (a) it is Python/Django and we are TypeScript/Supabase, so a port is a rewrite anyway, and (b) the exact `LICENSE`/`DCOLICENSE` must be confirmed before any copy. Treat even this as "reimplement, with the original open as a close reference."

**Code we may only learn from, never copy:**
- OpenProject — **GPL-3.0**
- Plane — **AGPL-3.0-only** (viral over the network — the worst case for a hosted SaaS)
- Leantime — **AGPL-3.0-only**
- Tuleap — **GPL-2.0**
- OpenPPM — **GPL-3.0**
- Taiga-**front** — **AGPL-3.0-or-later**

For a **proprietary, resold, hosted** product, GPL and especially AGPL are disqualifying for code reuse. **Reading these repos to understand an approach and then writing our own clean implementation is fine and is the intended use of this study. Copying or adapting their source into our product is not.** Keep the clone tree in `research/vendor/` (gitignored), never import from it, and document any pattern we adopt as independently reimplemented.

## 4. Overall verdict — **BUILD CUSTOM on the chosen stack, borrowing patterns (not code).**

Adopt-and-extend and hybrid-fork are both off the table, for three independent reasons:

1. **The governance core is absent from the field.** These are issue/task trackers. The things that make the Control Tower a *governance and accountability* system — the weekly update cadence, the escalation engine, multi-step approval chains, baseline-lock-with-delta, and above all database-level department isolation — are either missing entirely (modules 2 and 8 score `none` everywhere) or exist only as app-layer half-measures. There is no product here to extend into ours.
2. **Licenses forbid it.** Five of six are GPL/AGPL; the sixth (Taiga) is half-AGPL. None can be forked into a proprietary resold product.
3. **Stacks are far.** Rails+Angular, Django+AngularJS, PHP, and Java are all distant from Next.js + Supabase; even Plane's modern frontend is Vite/MobX, not App Router.

**So: build custom, and borrow these specific patterns —**
- **Audit Trail + Baseline/Delta:** Taiga `history` (snapshot + diff + advisory lock) and OpenProject `journals` (`tstzrange` temporal DDL, point-in-time reads). *These two are the highest-value takeaways of the entire study.*
- **Approvals state machine:** Tuleap workflow transition matrix.
- **Projects/RAG data model:** OpenPPM PMBOK hierarchy + `logprojectstatus`; OpenProject `status_code`.
- **Idempotent scheduled dispatch (for our fresh escalation engine):** Taiga `select_for_update`, OpenProject GoodJob `cron_at`, Leantime `msghash`.
- **Access control:** read OpenProject/Taiga membership-JOIN logic, then implement as real Supabase RLS — and heed the universal lesson that app-layer-only isolation is not isolation.

Everything else (weekly cycle, escalation rules, dependency map, dashboards, reports, Microsoft/Entra integration) is fresh build with no meaningful precedent in the studied set.

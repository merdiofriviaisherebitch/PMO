# RANKING — Open-source PM/PMO tools vs. the PMO Control Tower

**Method.** Each repo was studied read-only by a dedicated investigator (reports in this folder). Each rubric criterion is scored 1–5, then weighted: Stack proximity ×3, Modularity ×2, Governance coverage ×2, Code clarity ×1, License posture ×1, Maintenance ×1 (max **50**). Scoring is deliberately **critical** — 5 means *genuinely useful to building the Control Tower on Next.js + Supabase*, not "good software in general." A tool can be excellent and still score low here if its stack, license, or feature focus is wrong for us.

## Score breakdown

| Criterion (weight) | OpenProject | Plane | Leantime | Tuleap | OpenPPM | Taiga |
|-|-|-|-|-|-|-|
| Stack proximity (×3) | 1 | 2 | 1 | 1 | 1 | 2 |
| Modularity (×2) | 2 | 3 | 3 | 2 | 2 | 3 |
| Governance coverage (×2) | 3 | 2 | 2 | 3 | 3 | 2 |
| Code clarity (×1) | 3 | 4 | 3 | 2 | 2 | 4 |
| License posture (×1) | 1 | 1 | 1 | 1 | 1 | 3 |
| Maintenance (×1) | 5 | 4 | 4 | 3 | 1 | 2 |
| **Weighted total /50** | **22** | **25** | **21** | **19** | **17** | **25** |

## Ranked, most → least useful to us

Plane and Taiga tie numerically at 25. **Taiga is ranked #1** on the tiebreak that matters most for a proprietary, resold product: it is the only repo in the set whose backend carries a **non-viral license (MPL-2.0)**, and it holds the single best-in-class artifact of the whole study — the `history` snapshot/diff engine that maps directly onto our two hardest core modules (Audit Trail and Baseline/Delta).

### 1. Taiga — 25/50. Best patterns, only reusable license, but stale and structurally thin.
The `taiga-back/taiga/projects/history` app (`services.py` `take_snapshot`/`make_diff` + `models.py` `HistoryEntry`) is the cleanest audit-plus-baseline-plus-change-tracking design we found anywhere: it stores a JSON diff *and* a full snapshot *and* a denormalised user snapshot that survives account deletion, guarded by a per-key advisory lock against concurrent corruption. Its notification dispatcher (`select_for_update()` batch) is a textbook idempotent-send pattern for our escalation engine. **Blunt caveats:** the project model is flat (no department/org hierarchy), it has *zero* approvals, escalation, dependencies, or DB-level isolation, the frontend is dead AngularJS/CoffeeScript, the backend pins EOL Django 3.2, and both repos are effectively single-commit/maintenance-only. We learn from it; we do not adopt it. Confirm the exact `LICENSE` (MPL-2.0) before reusing any file.

### 2. Plane — 25/50. Closest to our stack and actively maintained, but AGPL and its governance is paywalled vapor.
The only repo with a real, modern TypeScript/React frontend and continuous development. Backend patterns worth reading: `ChangeTrackerMixin` (captures old field values pre-save), `IssueVersion` snapshots, `IntakeIssue` PENDING/ACCEPTED/REJECTED state machine (our nearest approvals analog), and the Celery-beat job taxonomy. **Blunt caveats:** it is **AGPL-3.0-only** — viral over the network, so no code reuse in a hosted proprietary product; the frontend is Vite + React Router + MobX, *not* Next.js App Router, so even ignoring license the architecture differs; and — exactly as the brief warned — approvals, workspace audit logs, and SAML/OIDC SSO are **commercial-edition / "coming soon," absent from the open code.** Useful as a stack-shaped reference, not a source.

### 3. OpenProject — 22/50. The most sophisticated Postgres data patterns; wrong stack and license.
Held back by Rails+Angular (stack 1) and GPL-3.0 (license 1), but it owns the **most directly reimplementable database artifact in the entire study**: the `journals` table (`db/migrate/tables/journals.rb`) using a `tstzrange` `validity_period` with an exclusion constraint and GIN index, plus `Journable::WithHistoricAttributes` for point-in-time reads. That is precisely the shape of an append-only audit log + queryable baseline in native Postgres — gold for us to reimplement in Supabase. Also strong: `status_code` RAG enum and the GoodJob `cron_at` predecessor-tracking that prevents double-send across restarts. No approvals, no escalation, isolation is app-layer scopes only, and date-alerts/SSO are Enterprise-gated.

### 4. Leantime — 21/50. Good schema clarity; almost nothing of our governance core, and a cautionary audit anti-pattern.
Domain-driven PHP/Laravel monolith on MySQL (AGPL-3.0). The single-file 27-table schema (`SchemaBuilder.php`) is a fast read, and the `zp_queue` `msghash` primary-key dedup is a reusable notification-idempotency idea. But it is the wrong stack, has no DB isolation (role is a numeric session compare), an `zp_approvals` table that no code uses, no baseline/escalation, and — importantly — its audit repository exposes a `pruneEvents` **delete** method. That is the textbook **negative example** proving our audit trail must be append-only *enforced in Postgres*, not by app-layer good intentions.

### 5. Tuleap — 19/50. Conceptually the richest on audit/approvals; practically the hardest to study.
The tracker `changeset` model (one row per change = built-in field-level history) and the **workflow transition matrix with per-transition group preconditions** are the best approval-gate and audit *concepts* in the set, and the docs describe a Baselines plugin that matches our baseline module almost exactly. **But:** the only studyable source is a **13-year-old snapshot (v5.3.99.4, 2012)** because Tuleap's current source left GitHub; it is GPL-2.0 (no reuse); the stack (homegrown PHP MVC + MySQL) is maximally distant; isolation is app-layer with a superuser bypass; and the most relevant features (Baselines, full-text/cross-tracker search, OAuth2 provider) are **commercial-only**. Mine it for concepts (workflow state machine, changeset audit), nothing else.

### 6. OpenPPM — 17/50. The best PMBOK/PMO data model; otherwise dead.
Last commit **2017**, Java 7 / Hibernate / MySQL, GPL-3.0 — abandoned and unusable as code. Its one genuine gift is `schemas/CreateDB.sql`: a complete PMBOK-aligned hierarchy (company → performing-org → program → project → WBS → activity) with a first-class `rag` column, a `logprojectstatus` history table, `changecontrol`, XStream audit snapshots, and a notification queue drained by Quartz. As a *schema-shaped checklist* for a governance/PMO domain — including a built-in PMO role and executive-report concept — it is worth one read, then close it.

## Cross-cutting findings (the part that actually decides the build)

- **Two of our modules have zero precedent in any tool: the Weekly Update Cycle and the Escalation Engine.** Not one of the six implements a scheduled status-collection cadence with chasing/escalation. This is the heart of an *accountability* product and it is genuinely ours to build. We borrow only the plumbing for not-double-sending (Taiga `select_for_update`, OpenProject GoodJob `cron_at`, Leantime `msghash`).
- **Department isolation at the database layer does not exist anywhere.** All six enforce access in the application layer (Django querysets, Rails scopes, PHP session checks) and several have explicit superuser/admin bypasses. This *confirms* — rather than threatens — our non-negotiable: Supabase **Row Level Security is the build**, and the studied repos serve as the membership-JOIN logic to translate into RLS policies (and as cautionary tales of what app-layer-only gets you).
- **"Append-only" audit is claimed but never enforced.** Tuleap allows superuser changeset deletion; Leantime ships `pruneEvents`. Our audit must revoke UPDATE/DELETE at the Postgres role level and use triggers — app discipline is insufficient.
- **A visual dependency map exists nowhere** (Gantt bars at most). Our `@xyflow/react` map is a fresh build; we borrow only relation *types* (precedes/blocks) from OpenProject/Plane.
- **Audit + baseline patterns are the only truly transferable governance assets**, concentrated in Taiga (`history`) and OpenProject (`journals`). Everything else is either task-tracker filler or stack/license-blocked.

**Bottom line:** the field is a source of *patterns for our hardest sub-problems* (temporal audit, baseline diffing, idempotent dispatch, PMBOK hierarchy, workflow state machines) and a source of *clear negative lessons* (app-layer isolation, deletable audit). It is not a source of a product to adopt. See `UTILIZATION_REPORT.md` for the module-by-module build/borrow decision.

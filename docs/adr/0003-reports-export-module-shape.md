# ADR 0003 — Reports & Export as a Node "deep module" over `delta()` + Scope

**Status:** Accepted (2026-05-31, Phase 7)
**Relates to:** CLAUDE.md §5 module 11, §5 module 5 (`delta`), §8, §10 (Storage), §11, §14, §20 C4/C7; migration `0029_reports.sql`.

## Context

Phase 7 adds auto-generated weekly/monthly governance reports, exportable as **PDF**
and **Excel**, scoped per department. A report's content (§11) is: a RAG status
summary, **variance vs. the locked baseline**, unresolved blockers, and escalation
history.

Two CLAUDE.md statements pull on the implementation shape:

- **§14** sketches a `supabase/functions/report-generator/` Edge Function (Deno),
  consistent with §8 where trusted server ops run as Edge Functions.
- **§20 C7** (explicitly flagged *"grill at Phase 7"*) says reports/export should be a
  **deep module over the same `delta()` + Scope, not a parallel query path** — i.e.
  it must *reuse* the one `computeDelta()` module (§5 C4) and the existing RLS-scoped
  aggregation layer, never re-derive them.

The aggregation layer that already produces every report section lives in **`lib/`
(Node/TypeScript)**: `computeDelta()` (`lib/data/delta.ts`), `getRagRollup()` /
`getBudgetSummary()` (`lib/data/dashboard.ts`), `getOpenEscalations()`
(`lib/data/escalations.ts`), `listDependencyGraph()` (`lib/data/dependencies.ts`),
`listBaselines()` (`lib/data/governance.ts`). A Deno Edge Function cannot import these
Node modules; choosing Deno would force re-implementing the data layer in Deno —
**precisely the "parallel query path" C7 forbids** — and would split the code away
from the vitest harness that already unit-tests `computeDelta()`.

## Decision

**Build Reports & Export as a deep Node module in `lib/reports/`, consumed by a
Next.js route handler — not a Deno Edge Function.** C7 wins over the §14 sketch.

1. **Pure domain, fully unit-testable, no I/O:**
   - `lib/reports/model.ts` — `buildReportModel(input: ScopedReportData): ReportModel`
     assembles the four §11 sections; baseline variance comes from `computeDelta()`,
     never re-diffed (§5, §20 C4).
   - `lib/reports/pdf.ts` — `renderReportPdf(model): Uint8Array` (`pdf-lib`).
   - `lib/reports/xlsx.ts` — `renderReportXlsx(model): Uint8Array` (`exceljs`).
   These three are the §15 "export tests" target: vitest parses the bytes back and
   asserts content, with zero DB/Storage.

2. **Data gathering reuses the RLS-scoped layer** (`lib/data/reports.ts`):
   `gatherReportData(scope)` calls the existing `lib/data/*` functions — no new
   ad-hoc queries. On-demand generation runs under the user's RLS session; the
   automatic (cron) path runs service-role and **re-applies the department/project
   filter in code** (§10, §14) before handing already-scoped data to the pure model.

3. **Generation entrypoint** is a Next.js route handler (`app/api/reports/generate`)
   authenticated by a **constant-time shared secret** — the same trust model as the
   escalation sender (`verify_jwt=false` + Vault secret). **Automatic** generation is
   a `pg_cron` job (weekly + monthly) calling it via `net.http_post` with the secret
   and URL read from Vault — mirroring `outbox_send_batch` (§8, migration `0025`).
   An exec/director may also trigger on-demand generation via a Server Action.

4. **Storage stays scoped (§10):** a **non-public** `reports` bucket; `storage.objects`
   RLS mirrors the department model with the object path encoding scope
   (`reports/<department_id>/...`, `reports/global/...` for executive roll-ups);
   signed URLs are minted **only after a server-side scope check**, never blindly.

5. **Libraries:** `pdf-lib` (PDF) and `exceljs` (XLSX) — both pure-JS, no native
   binaries, so the identical renderer code runs in a Node route handler and under
   vitest.

## Consequences

- Reports consume the **one** `computeDelta()` + the existing RLS-scoped aggregations
  — there is **no parallel query path** and no second copy of the diff logic (§20 C7,
  C4 satisfied).
- The renderers are **pure and deterministic**, so export correctness is proven by
  fast vitest unit tests rather than by generating files in CI.
- **Deviation from §14's `supabase/functions/report-generator/` sketch**, recorded
  here. The trade is deliberate: testability + data-layer reuse over locating the job
  in Deno. The service-role re-scoping rule (§10) is unchanged — it now lives in the
  route handler instead of an Edge Function. CLAUDE.md §14's directory note should be
  read as "a report generator," not "a Deno function," after this ADR.
- `pg_cron` now `net.http_post`s a Vercel route URL (Vault-stored) instead of an Edge
  Function URL — same shared-secret trust model, one more secret in Vault.
- Storage isolation gains a dedicated pen-test (the deferred §15 item 8 / issue #24):
  a member of department A cannot read department B's report by object path or signed
  URL; an executive can read all.

## Alternatives considered

- **Deno Edge Function (`supabase/functions/report-generator/`)** — rejected: cannot
  import `lib/data/*`/`computeDelta()`, so it would re-derive the aggregations in Deno
  (the C7 anti-pattern) and fall outside the vitest export-test harness.
- **Vercel Cron instead of pg_cron** — rejected for the trigger: pg_cron runs in the
  local Supabase stack (where every prior phase is verified, CI being billing-locked),
  keeping the automatic path testable locally and consistent with §8.

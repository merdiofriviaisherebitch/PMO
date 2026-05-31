/**
 * lib/reports/generate.ts — Pure orchestration layer for report generation.
 *
 * PURE module: no database, no "server-only", no direct I/O. All side effects go
 * through the injected ReportStore port (§20 C3 Notifier pattern applied to storage).
 * This makes the module unit-testable with a fake store without touching Supabase
 * or the filesystem.
 *
 * ADR 0003: the generator calls buildReportModel + the two renderers, then delegates
 * storage via the port. The caller (route handler / cron job) wires in the real
 * Supabase storage adapter.
 */

import { buildReportModel } from "./model"
import { renderReportPdf } from "./pdf"
import { renderReportXlsx } from "./xlsx"
import type { ReportInput, ReportModel } from "./types"

// ─── Port ─────────────────────────────────────────────────────────────────────

export type ReportMeta = {
  period: "weekly" | "monthly"
  departmentId: string | null
  projectId: string | null
  periodStart: string
  periodEnd: string
  pdfPath: string
  xlsxPath: string
  generatedBy: string | null
}

export type ReportStore = {
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>
  insertMeta(meta: ReportMeta): Promise<void>
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export type GenerateReportResult = {
  pdfPath: string
  xlsxPath: string
  model: ReportModel
}

/**
 * Generate a report from already-gathered, already-scoped ReportInput.
 *
 * Path layout (§10 Storage: path encodes scope so storage RLS can gate on it):
 *   reports/<department_id | "global">/<period>/<periodStart>.pdf
 *   reports/<department_id | "global">/<period>/<periodStart>.xlsx
 *
 * Side effects flow ONLY through the injected `store`.
 */
export async function generateReport(opts: {
  input: ReportInput
  store: ReportStore
  generatedBy: string | null
}): Promise<GenerateReportResult> {
  const { input, store, generatedBy } = opts
  const { period, periodStart, periodEnd, scope } = input

  // Path base encodes scope — the Storage RLS policy keys on the first segment
  // being the department UUID (or the literal "global" for executive roll-ups).
  const scopeSegment = scope.departmentId ?? "global"
  const storagePathBase = `${scopeSegment}/${period}/${periodStart}`
  const pdfPath = `${storagePathBase}.pdf`
  const xlsxPath = `${storagePathBase}.xlsx`

  // Build model (pure, synchronous)
  const model = buildReportModel(input)

  // Render both formats in parallel
  const [pdfBytes, xlsxBytes] = await Promise.all([
    renderReportPdf(model),
    renderReportXlsx(model),
  ])

  // Upload both in parallel, then record metadata
  await Promise.all([
    store.upload(pdfPath, pdfBytes, "application/pdf"),
    store.upload(
      xlsxPath,
      xlsxBytes,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
  ])

  await store.insertMeta({
    period,
    departmentId: scope.departmentId,
    projectId: null,
    periodStart,
    periodEnd,
    pdfPath,
    xlsxPath,
    generatedBy,
  })

  return { pdfPath, xlsxPath, model }
}

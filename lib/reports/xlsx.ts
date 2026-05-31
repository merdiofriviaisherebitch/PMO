/**
 * lib/reports/xlsx.ts — Excel renderer using ExcelJS.
 *
 * PURE module: no database, no I/O, no "server-only". Accepts a ReportModel
 * and returns the XLSX bytes as a Uint8Array.
 *
 * Sheets:
 *   "Summary"     — RAG project/task counts + budget totals; A1 = model.title
 *   "Variance"    — header row + one row per variance entry
 *   "Blockers"    — header + rows
 *   "Escalations" — header + rows
 */

import ExcelJS from "exceljs"
import type { ReportModel } from "./types"

export async function renderReportXlsx(model: ReportModel): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  wb.creator = "PMO Control Tower"
  wb.created = new Date()

  // ── Summary sheet ─────────────────────────────────────────────────────────
  const summary = wb.addWorksheet("Summary")

  // A1 = title (assertion hook for tests)
  summary.getCell("A1").value = model.title
  summary.getCell("A1").font = { bold: true, size: 14 }
  summary.getCell("A2").value = model.subtitle

  summary.addRow([]) // blank spacer

  // RAG heading
  summary.addRow(["RAG Summary"]).getCell(1).font = { bold: true }
  summary.addRow(["", "Green", "Amber", "Red", "Total"])
  summary.addRow(["Projects", model.rag.projects.green, model.rag.projects.amber, model.rag.projects.red, model.rag.projects.total])
  summary.addRow(["Tasks", model.rag.tasks.green, model.rag.tasks.amber, model.rag.tasks.red, model.rag.tasks.total])

  summary.addRow([]) // blank spacer

  // Budget heading
  summary.addRow(["Budget Summary"]).getCell(1).font = { bold: true }
  summary.addRow(["Total Budget", "Total Actual", "Remaining", "Red Lines", "Amber Lines", "Green Lines"])
  summary.addRow([
    model.budget.totalBudget,
    model.budget.totalActual,
    model.budget.remaining,
    model.budget.red,
    model.budget.amber,
    model.budget.green,
  ])

  // ── Variance sheet ────────────────────────────────────────────────────────
  const varianceSheet = wb.addWorksheet("Variance")
  varianceSheet.addRow(["Project", "Added", "Removed", "Schedule Changes", "RAG Changes"])
  varianceSheet.getRow(1).font = { bold: true }

  for (const row of model.variance) {
    varianceSheet.addRow([
      row.projectName,
      row.addedCount,
      row.removedCount,
      row.scheduleChangedCount,
      row.ragChangedCount,
    ])
  }

  // ── Blockers sheet ────────────────────────────────────────────────────────
  const blockersSheet = wb.addWorksheet("Blockers")
  blockersSheet.addRow(["Blocker", "Blocked"])
  blockersSheet.getRow(1).font = { bold: true }

  for (const row of model.blockers) {
    blockersSheet.addRow([row.blockerLabel, row.blockedLabel])
  }

  // ── Escalations sheet ─────────────────────────────────────────────────────
  const escalationsSheet = wb.addWorksheet("Escalations")
  escalationsSheet.addRow(["Level", "Kind", "Department", "Triggered At"])
  escalationsSheet.getRow(1).font = { bold: true }

  for (const row of model.escalations) {
    escalationsSheet.addRow([row.level, row.kind, row.department, row.triggeredAt])
  }

  const buffer = await wb.xlsx.writeBuffer()
  return new Uint8Array(buffer as ArrayBuffer)
}

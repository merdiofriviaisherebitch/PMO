// @vitest-environment node
/**
 * lib/reports/xlsx.test.ts — Behavior tests for renderReportXlsx.
 *
 * Parses the rendered bytes back into a fresh ExcelJS workbook to assert
 * content — never tests internal state.
 */

import { describe, it, expect } from "vitest"
import ExcelJS from "exceljs"
import { buildReportModel } from "./model"
import { renderReportXlsx } from "./xlsx"
import type { ReportInput } from "./types"

const INPUT: ReportInput = {
  period: "monthly",
  periodStart: "2026-05-01",
  periodEnd: "2026-05-31",
  generatedAt: "2026-05-31T10:00:00Z",
  scope: { label: "Legal", departmentId: "dept-2" },
  rag: {
    projects: { green: 1, amber: 2, red: 3, total: 6 },
    tasks: { green: 4, amber: 3, red: 2, total: 9 },
  },
  budget: {
    totalBudget: 200_000,
    totalActual: 150_000,
    remaining: 50_000,
    red: 2,
    amber: 1,
    green: 3,
    lines: [],
  },
  dependencyGraph: {
    nodes: [
      { id: "t1", title: "Contract Review", ragStatus: "red", departmentId: "dept-2" },
      { id: "t2", title: "Permit Filing", ragStatus: "amber", departmentId: "dept-2" },
    ],
    edges: [
      { id: "e1", source: "t1", target: "t2", relationType: "blocks", sourceDeptId: "dept-2", targetDeptId: "dept-2" },
    ],
    departments: { "dept-2": "Legal" },
  },
  escalations: [
    { id: "esc-1", level: 2, kind: "late_update", departmentName: "Legal", triggeredAt: "2026-05-28T09:00:00Z" },
    { id: "esc-2", level: 3, kind: "red_item", departmentName: null, triggeredAt: "2026-05-29T12:00:00Z" },
  ],
  deltas: [
    {
      projectId: "p1",
      projectName: "Geothermal Phase 2",
      delta: {
        hasChanges: true,
        addedTasks: [{ task_id: "t3", title: "New Legal Review", rag_status: "amber", start_date: null, due_date: null }],
        removedTasks: [],
        scheduleVariances: [
          { task_id: "t1", title: "Contract Review", startDateVarianceDays: 5, dueDateVarianceDays: 3, startDateChange: null, dueDateChange: null },
        ],
        ragChanges: [],
        budgetVariances: [],
      },
    },
    {
      projectId: "p2",
      projectName: "No Change Project",
      delta: { hasChanges: false, addedTasks: [], removedTasks: [], scheduleVariances: [], ragChanges: [], budgetVariances: [] },
    },
  ],
}

async function loadWorkbook(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(bytes.buffer as ArrayBuffer)
  return wb
}

describe("renderReportXlsx", () => {
  it("returns a Uint8Array with non-trivial size", async () => {
    const model = buildReportModel(INPUT)
    const bytes = await renderReportXlsx(model)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBeGreaterThan(500)
  })

  it("produces a valid XLSX (loadable by ExcelJS)", async () => {
    const model = buildReportModel(INPUT)
    const bytes = await renderReportXlsx(model)
    // If this throws, the file is corrupt
    const wb = await loadWorkbook(bytes)
    expect(wb.worksheets.length).toBeGreaterThan(0)
  })

  it("Summary A1 equals model.title", async () => {
    const model = buildReportModel(INPUT)
    const bytes = await renderReportXlsx(model)
    const wb = await loadWorkbook(bytes)
    const summary = wb.getWorksheet("Summary")
    expect(summary).toBeDefined()
    expect(summary!.getCell("A1").value).toBe(model.title)
  })

  it("Summary sheet contains the expected RAG project counts", async () => {
    const model = buildReportModel(INPUT)
    const bytes = await renderReportXlsx(model)
    const wb = await loadWorkbook(bytes)
    const summary = wb.getWorksheet("Summary")!
    // Find the row containing the projects RAG — search all rows for the "Projects" label
    let foundGreen = false
    summary.eachRow((row) => {
      const firstCell = row.getCell(1).value
      if (firstCell === "Projects") {
        expect(row.getCell(2).value).toBe(model.rag.projects.green)   // Green = 1
        expect(row.getCell(4).value).toBe(model.rag.projects.red)     // Red = 3
        foundGreen = true
      }
    })
    expect(foundGreen).toBe(true)
  })

  it("Blockers sheet has the correct number of data rows (excluding header)", async () => {
    const model = buildReportModel(INPUT)
    const bytes = await renderReportXlsx(model)
    const wb = await loadWorkbook(bytes)
    const blockersSheet = wb.getWorksheet("Blockers")
    expect(blockersSheet).toBeDefined()
    // Subtract 1 for the header row
    const dataRows = blockersSheet!.rowCount - 1
    expect(dataRows).toBe(model.blockers.length)
  })

  it("Escalations sheet has the correct number of data rows (excluding header)", async () => {
    const model = buildReportModel(INPUT)
    const bytes = await renderReportXlsx(model)
    const wb = await loadWorkbook(bytes)
    const escSheet = wb.getWorksheet("Escalations")
    expect(escSheet).toBeDefined()
    const dataRows = escSheet!.rowCount - 1
    expect(dataRows).toBe(model.escalations.length)
  })

  it("Variance sheet has one data row for the hasChanges project only", async () => {
    const model = buildReportModel(INPUT)
    const bytes = await renderReportXlsx(model)
    const wb = await loadWorkbook(bytes)
    const varianceSheet = wb.getWorksheet("Variance")!
    const dataRows = varianceSheet.rowCount - 1
    // Only "Geothermal Phase 2" has hasChanges; "No Change Project" must be excluded
    expect(dataRows).toBe(1)
    // Verify the project name in the data row
    expect(varianceSheet.getRow(2).getCell(1).value).toBe("Geothermal Phase 2")
  })

  it("Blockers sheet data rows contain correct blocker/blocked labels", async () => {
    const model = buildReportModel(INPUT)
    const bytes = await renderReportXlsx(model)
    const wb = await loadWorkbook(bytes)
    const sheet = wb.getWorksheet("Blockers")!
    // Row 2 is first data row (row 1 is header)
    const dataRow = sheet.getRow(2)
    expect(dataRow.getCell(1).value).toBe(model.blockers[0].blockerLabel)
    expect(dataRow.getCell(2).value).toBe(model.blockers[0].blockedLabel)
  })

  it("handles empty blockers gracefully (Blockers sheet has header only)", async () => {
    const emptyInput: ReportInput = {
      ...INPUT,
      dependencyGraph: { nodes: [], edges: [], departments: {} },
    }
    const model = buildReportModel(emptyInput)
    expect(model.blockers).toHaveLength(0)
    const bytes = await renderReportXlsx(model)
    const wb = await loadWorkbook(bytes)
    const sheet = wb.getWorksheet("Blockers")!
    // rowCount includes the header
    expect(sheet.rowCount).toBe(1)
  })
})

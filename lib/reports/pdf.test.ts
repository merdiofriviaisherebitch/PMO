// @vitest-environment node
/**
 * lib/reports/pdf.test.ts — Behavior tests for renderReportPdf.
 *
 * Parses the rendered bytes back (via pdf-lib PDFDocument.load) to assert
 * content — never tests internal state.
 */

import { describe, it, expect } from "vitest"
import { PDFDocument } from "pdf-lib"
import { buildReportModel } from "./model"
import { renderReportPdf, toWinAnsiSafe } from "./pdf"
import type { ReportInput } from "./types"

const INPUT: ReportInput = {
  period: "weekly",
  periodStart: "2026-05-26",
  periodEnd: "2026-06-01",
  generatedAt: "2026-06-01T08:00:00Z",
  scope: { label: "Accounting", departmentId: "dept-1" },
  rag: {
    projects: { green: 2, amber: 0, red: 1, total: 3 },
    tasks: { green: 5, amber: 2, red: 1, total: 8 },
  },
  budget: {
    totalBudget: 50_000,
    totalActual: 25_000,
    remaining: 25_000,
    red: 0,
    amber: 1,
    green: 2,
    lines: [],
  },
  dependencyGraph: {
    nodes: [
      { id: "t1", title: "Blocker Task", ragStatus: "red", departmentId: "dept-1" },
      { id: "t2", title: "Blocked Task", ragStatus: "green", departmentId: "dept-1" },
    ],
    edges: [
      { id: "e1", source: "t1", target: "t2", relationType: "blocks", sourceDeptId: "dept-1", targetDeptId: "dept-1" },
    ],
    departments: { "dept-1": "Accounting" },
  },
  escalations: [
    { id: "esc-1", level: 1, kind: "late_update", departmentName: "Accounting", triggeredAt: "2026-05-30T10:00:00Z" },
  ],
  deltas: [
    {
      projectId: "p1",
      projectName: "Alpha",
      delta: {
        hasChanges: true,
        addedTasks: [],
        removedTasks: [],
        scheduleVariances: [{ task_id: "t1", title: "Task 1", startDateVarianceDays: 2, dueDateVarianceDays: null, startDateChange: null, dueDateChange: null }],
        ragChanges: [],
      },
    },
  ],
}

describe("renderReportPdf", () => {
  it("returns bytes starting with the PDF header %PDF-", async () => {
    const model = buildReportModel(INPUT)
    const bytes = await renderReportPdf(model)
    const header = String.fromCharCode(...bytes.slice(0, 5))
    expect(header).toBe("%PDF-")
  })

  it("embeds the title in document metadata", async () => {
    const model = buildReportModel(INPUT)
    const bytes = await renderReportPdf(model)
    const loaded = await PDFDocument.load(bytes)
    expect(loaded.getTitle()).toBe(model.title)
  })

  it("embeds the scopeLabel as document subject", async () => {
    const model = buildReportModel(INPUT)
    const bytes = await renderReportPdf(model)
    const loaded = await PDFDocument.load(bytes)
    expect(loaded.getSubject()).toBe(model.scopeLabel)
  })

  it("produces at least one page", async () => {
    const model = buildReportModel(INPUT)
    const bytes = await renderReportPdf(model)
    const loaded = await PDFDocument.load(bytes)
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1)
  })

  it("produces a Uint8Array", async () => {
    const model = buildReportModel(INPUT)
    const bytes = await renderReportPdf(model)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBeGreaterThan(100)
  })

  it("renders additional pages when content is large (many escalations)", async () => {
    // Flood the escalations to force pagination
    const manyEscalations = Array.from({ length: 60 }, (_, i) => ({
      id: `esc-${i}`,
      level: 1 + (i % 3),
      kind: "late_update" as const,
      departmentName: `Dept ${i}`,
      triggeredAt: "2026-05-30T10:00:00Z",
    }))
    const bigInput: ReportInput = { ...INPUT, escalations: manyEscalations }
    const model = buildReportModel(bigInput)
    const bytes = await renderReportPdf(model)
    const loaded = await PDFDocument.load(bytes)
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(2)
  })
})

describe("toWinAnsiSafe (drawn-text encoding)", () => {
  // Regression: the title "… Report — All Departments" was rendering the em-dash as
  // '?' in the DRAWN text (the PDF metadata title was fine, so the other tests missed
  // it; only extracting drawn text via poppler caught it). Em/en dashes must map to '-'.
  it("maps the em-dash to a hyphen (not '?')", () => {
    expect(toWinAnsiSafe("Weekly Governance Report — All Departments")).toBe(
      "Weekly Governance Report - All Departments",
    )
  })
  it("maps the en-dash to a hyphen", () => {
    expect(toWinAnsiSafe("2026 – 2027")).toBe("2026 - 2027")
  })
  it("maps the arrow to '->'", () => {
    expect(toWinAnsiSafe("2026-05-25 → 2026-05-31")).toBe("2026-05-25 -> 2026-05-31")
  })
  it("preserves the middle dot (valid WinAnsi 0xB7)", () => {
    expect(toWinAnsiSafe("a · b")).toBe("a · b")
  })
  it("replaces a genuinely-unsupported glyph with '?'", () => {
    expect(toWinAnsiSafe("star ★ here")).toBe("star ? here")
  })
})

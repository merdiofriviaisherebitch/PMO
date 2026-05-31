/**
 * lib/reports/generate.test.ts — Behavior tests for generateReport.
 *
 * Uses a FAKE ReportStore to verify:
 *   - Path encoding (department UUID vs "global")
 *   - Both uploads happen with the correct content types
 *   - insertMeta receives correct scope, paths, period, generatedBy
 *   - The returned model is a real ReportModel (has the expected title)
 */

import { describe, it, expect, beforeEach } from "vitest"
import { generateReport } from "./generate"
import type { ReportStore, ReportMeta } from "./generate"
import type { ReportInput } from "./types"

// ─── Fake store ───────────────────────────────────────────────────────────────

type UploadCall = { path: string; bytes: Uint8Array; contentType: string }

function makeFakeStore(): ReportStore & {
  uploads: UploadCall[]
  metas: ReportMeta[]
} {
  const uploads: UploadCall[] = []
  const metas: ReportMeta[] = []
  return {
    uploads,
    metas,
    async upload(path, bytes, contentType) {
      uploads.push({ path, bytes, contentType })
    },
    async insertMeta(meta) {
      metas.push(meta)
    },
  }
}

// ─── Fixture ──────────────────────────────────────────────────────────────────

const DEPT_ID = "a1b2c3d4-0000-0000-0000-000000000001"

const BASE_INPUT: ReportInput = {
  period: "weekly",
  periodStart: "2026-05-26",
  periodEnd: "2026-06-01",
  generatedAt: "2026-06-01T08:00:00Z",
  scope: { label: "Accounting", departmentId: DEPT_ID },
  rag: {
    projects: { green: 2, amber: 1, red: 0, total: 3 },
    tasks: { green: 5, amber: 2, red: 1, total: 8 },
  },
  budget: {
    totalBudget: 50_000,
    totalActual: 30_000,
    remaining: 20_000,
    red: 0,
    amber: 1,
    green: 2,
    lines: [],
  },
  dependencyGraph: { nodes: [], edges: [], departments: {} },
  escalations: [],
  deltas: [],
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("generateReport", () => {
  let store: ReturnType<typeof makeFakeStore>

  beforeEach(() => {
    store = makeFakeStore()
  })

  it("encodes department UUID in storage paths", async () => {
    const result = await generateReport({ input: BASE_INPUT, store, generatedBy: "user-1" })

    expect(result.pdfPath).toBe(`${DEPT_ID}/weekly/2026-05-26.pdf`)
    expect(result.xlsxPath).toBe(`${DEPT_ID}/weekly/2026-05-26.xlsx`)
  })

  it("uses 'global' as path segment for null departmentId (exec roll-up)", async () => {
    const input: ReportInput = {
      ...BASE_INPUT,
      scope: { label: "Global", departmentId: null },
    }
    const result = await generateReport({ input, store, generatedBy: null })

    expect(result.pdfPath).toBe("global/weekly/2026-05-26.pdf")
    expect(result.xlsxPath).toBe("global/weekly/2026-05-26.xlsx")
  })

  it("uploads PDF with the correct content type", async () => {
    await generateReport({ input: BASE_INPUT, store, generatedBy: "user-1" })

    const pdfUpload = store.uploads.find((u) => u.path.endsWith(".pdf"))
    expect(pdfUpload).toBeDefined()
    expect(pdfUpload!.contentType).toBe("application/pdf")
    expect(pdfUpload!.bytes.length).toBeGreaterThan(0)
  })

  it("uploads XLSX with the correct content type", async () => {
    await generateReport({ input: BASE_INPUT, store, generatedBy: "user-1" })

    const xlsxUpload = store.uploads.find((u) => u.path.endsWith(".xlsx"))
    expect(xlsxUpload).toBeDefined()
    expect(xlsxUpload!.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    expect(xlsxUpload!.bytes.length).toBeGreaterThan(0)
  })

  it("calls insertMeta exactly once with correct scope and paths", async () => {
    await generateReport({ input: BASE_INPUT, store, generatedBy: "user-42" })

    expect(store.metas).toHaveLength(1)
    const meta = store.metas[0]
    expect(meta.departmentId).toBe(DEPT_ID)
    expect(meta.projectId).toBeNull()
    expect(meta.period).toBe("weekly")
    expect(meta.periodStart).toBe("2026-05-26")
    expect(meta.periodEnd).toBe("2026-06-01")
    expect(meta.pdfPath).toBe(`${DEPT_ID}/weekly/2026-05-26.pdf`)
    expect(meta.xlsxPath).toBe(`${DEPT_ID}/weekly/2026-05-26.xlsx`)
    expect(meta.generatedBy).toBe("user-42")
  })

  it("passes null generatedBy (system/cron invocation)", async () => {
    await generateReport({ input: BASE_INPUT, store, generatedBy: null })

    expect(store.metas[0].generatedBy).toBeNull()
  })

  it("returns a model with the expected title", async () => {
    const result = await generateReport({ input: BASE_INPUT, store, generatedBy: null })

    expect(result.model.title).toContain("Weekly")
    expect(result.model.title).toContain("Accounting")
  })

  it("returns the same pdfPath/xlsxPath as uploaded to the store", async () => {
    const result = await generateReport({ input: BASE_INPUT, store, generatedBy: null })

    const paths = store.uploads.map((u) => u.path)
    expect(paths).toContain(result.pdfPath)
    expect(paths).toContain(result.xlsxPath)
  })

  it("encodes period and date correctly for monthly reports", async () => {
    const input: ReportInput = {
      ...BASE_INPUT,
      period: "monthly",
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
    }
    const result = await generateReport({ input, store, generatedBy: null })

    expect(result.pdfPath).toBe(`${DEPT_ID}/monthly/2026-05-01.pdf`)
    expect(result.xlsxPath).toBe(`${DEPT_ID}/monthly/2026-05-01.xlsx`)
  })
})

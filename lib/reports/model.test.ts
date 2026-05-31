/**
 * lib/reports/model.test.ts — Behavior tests for buildReportModel.
 *
 * Tests assert through the PUBLIC interface (ReportInput → ReportModel) and
 * explicitly assert exclusions so a future regression breaks a test.
 */

import { describe, it, expect } from "vitest"
import { buildReportModel } from "./model"
import type { ReportInput } from "./types"

// ─── Fixture ──────────────────────────────────────────────────────────────────

const BASE_INPUT: ReportInput = {
  period: "weekly",
  periodStart: "2026-05-26",
  periodEnd: "2026-06-01",
  generatedAt: "2026-06-01T08:00:00Z",
  scope: { label: "Global", departmentId: null },
  rag: {
    projects: { green: 3, amber: 1, red: 1, total: 5 },
    tasks: { green: 10, amber: 4, red: 2, total: 16 },
  },
  budget: {
    totalBudget: 100_000,
    totalActual: 60_000,
    remaining: 40_000,
    red: 1,
    amber: 2,
    green: 4,
    lines: [],
  },
  dependencyGraph: {
    nodes: [
      { id: "task-a", title: "Task A", ragStatus: "red", departmentId: "dept-1" },
      { id: "task-b", title: "Task B", ragStatus: "green", departmentId: "dept-1" },
      { id: "task-c", title: "Task C", ragStatus: "amber", departmentId: "dept-2" },
      { id: "task-d", title: "Task D", ragStatus: "red", departmentId: "dept-2" },
    ],
    edges: [
      // INCLUDE: relation=blocks, source task-a is red → should appear
      { id: "e1", source: "task-a", target: "task-c", relationType: "blocks", sourceDeptId: "dept-1", targetDeptId: "dept-2" },
      // EXCLUDE: relation=blocks but source task-b is green → NOT a red blocker
      { id: "e2", source: "task-b", target: "task-c", relationType: "blocks", sourceDeptId: "dept-1", targetDeptId: "dept-2" },
      // EXCLUDE: relation=precedes (wrong type, irrelevant even if source is red)
      { id: "e3", source: "task-d", target: "task-c", relationType: "precedes", sourceDeptId: "dept-2", targetDeptId: "dept-2" },
      // EXCLUDE: relation=relates (wrong type)
      { id: "e4", source: "task-d", target: "task-b", relationType: "relates", sourceDeptId: "dept-2", targetDeptId: "dept-1" },
    ],
    departments: { "dept-1": "Accounting", "dept-2": "Legal" },
  },
  escalations: [
    { id: "esc-1", level: 2, kind: "late_update", departmentName: "Geothermal", triggeredAt: "2026-05-29T09:00:00Z" },
    // Null departmentName → should fall back to "—"
    { id: "esc-2", level: 3, kind: "blocked_dependency", departmentName: null, triggeredAt: "2026-05-30T10:00:00Z" },
  ],
  deltas: [
    {
      projectId: "proj-1",
      projectName: "Alpha",
      delta: {
        hasChanges: true,
        addedTasks: [{ task_id: "t1", title: "New task", rag_status: "green", start_date: null, due_date: null }],
        removedTasks: [],
        scheduleVariances: [{ task_id: "t2", title: "Old task", startDateVarianceDays: 3, dueDateVarianceDays: null, startDateChange: null, dueDateChange: null }],
        ragChanges: [{ task_id: "t3", title: "RAG task", from: "green", to: "red" }],
      },
    },
    {
      // EXCLUDE: hasChanges=false → should NOT appear in variance
      projectId: "proj-2",
      projectName: "Beta",
      delta: {
        hasChanges: false,
        addedTasks: [],
        removedTasks: [],
        scheduleVariances: [],
        ragChanges: [],
      },
    },
  ],
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildReportModel", () => {
  it("generates the correct title for weekly period", () => {
    const model = buildReportModel(BASE_INPUT)
    expect(model.title).toBe("Weekly Governance Report — Global")
  })

  it("generates the correct title for monthly period", () => {
    const model = buildReportModel({ ...BASE_INPUT, period: "monthly" })
    expect(model.title).toBe("Monthly Governance Report — Global")
  })

  it("builds the subtitle from period + generatedAt", () => {
    const model = buildReportModel(BASE_INPUT)
    expect(model.subtitle).toBe("2026-05-26 → 2026-06-01 · generated 2026-06-01T08:00:00Z")
  })

  it("passes through rag counts unchanged", () => {
    const model = buildReportModel(BASE_INPUT)
    expect(model.rag.projects).toEqual({ green: 3, amber: 1, red: 1, total: 5 })
    expect(model.rag.tasks).toEqual({ green: 10, amber: 4, red: 2, total: 16 })
  })

  describe("blockers", () => {
    it("includes only the red-source 'blocks' edge", () => {
      const model = buildReportModel(BASE_INPUT)
      expect(model.blockers).toHaveLength(1)
      expect(model.blockers[0]).toEqual({ blockerLabel: "Task A", blockedLabel: "Task C" })
    })

    it("excludes non-red 'blocks' edges (green source)", () => {
      const model = buildReportModel(BASE_INPUT)
      const labels = model.blockers.map((b) => b.blockerLabel)
      expect(labels).not.toContain("Task B")
    })

    it("excludes 'precedes' edges even if source is red", () => {
      const model = buildReportModel(BASE_INPUT)
      // task-d is red and is source of a 'precedes' edge — must be excluded
      const labels = model.blockers.map((b) => b.blockerLabel)
      expect(labels).not.toContain("Task D")
    })

    it("excludes 'relates' edges", () => {
      const model = buildReportModel(BASE_INPUT)
      // e4 is relates, should never appear
      expect(model.blockers).toHaveLength(1) // only e1
    })

    it("falls back to dept-name·hidden for boundary nodes not in the nodes list", () => {
      const input: ReportInput = {
        ...BASE_INPUT,
        dependencyGraph: {
          ...BASE_INPUT.dependencyGraph,
          nodes: [{ id: "task-a", title: "Task A", ragStatus: "red", departmentId: "dept-1" }],
          edges: [
            { id: "ex", source: "task-a", target: "unknown-id", relationType: "blocks", sourceDeptId: "dept-1", targetDeptId: "dept-2" },
          ],
        },
      }
      const model = buildReportModel(input)
      expect(model.blockers).toHaveLength(1)
      expect(model.blockers[0].blockedLabel).toBe("Legal · hidden")
    })

    it("falls back to 'hidden' when dept id is also missing", () => {
      const input: ReportInput = {
        ...BASE_INPUT,
        dependencyGraph: {
          ...BASE_INPUT.dependencyGraph,
          nodes: [{ id: "task-a", title: "Task A", ragStatus: "red", departmentId: "dept-1" }],
          edges: [
            { id: "ex", source: "task-a", target: "unknown-id", relationType: "blocks", sourceDeptId: "dept-1", targetDeptId: null },
          ],
        },
      }
      const model = buildReportModel(input)
      expect(model.blockers[0].blockedLabel).toBe("hidden")
    })
  })

  describe("variance", () => {
    it("includes only the project where hasChanges is true", () => {
      const model = buildReportModel(BASE_INPUT)
      expect(model.variance).toHaveLength(1)
      expect(model.variance[0].projectName).toBe("Alpha")
    })

    it("excludes the project where hasChanges is false", () => {
      const model = buildReportModel(BASE_INPUT)
      const names = model.variance.map((v) => v.projectName)
      expect(names).not.toContain("Beta")
    })

    it("computes counts correctly from delta arrays", () => {
      const model = buildReportModel(BASE_INPUT)
      const row = model.variance[0]
      expect(row.addedCount).toBe(1)
      expect(row.removedCount).toBe(0)
      expect(row.scheduleChangedCount).toBe(1)
      expect(row.ragChangedCount).toBe(1)
    })
  })

  describe("escalations", () => {
    it("maps all escalations", () => {
      const model = buildReportModel(BASE_INPUT)
      expect(model.escalations).toHaveLength(2)
    })

    it("maps departmentName to department, falling back to '—' when null", () => {
      const model = buildReportModel(BASE_INPUT)
      expect(model.escalations[0].department).toBe("Geothermal")
      expect(model.escalations[1].department).toBe("—")
    })

    it("preserves level, kind, and triggeredAt", () => {
      const model = buildReportModel(BASE_INPUT)
      expect(model.escalations[0].level).toBe(2)
      expect(model.escalations[0].kind).toBe("late_update")
      expect(model.escalations[0].triggeredAt).toBe("2026-05-29T09:00:00Z")
    })
  })

  it("returns empty arrays for all sections when input has no data", () => {
    const empty: ReportInput = {
      ...BASE_INPUT,
      dependencyGraph: { nodes: [], edges: [], departments: {} },
      escalations: [],
      deltas: [],
    }
    const model = buildReportModel(empty)
    expect(model.blockers).toEqual([])
    expect(model.variance).toEqual([])
    expect(model.escalations).toEqual([])
  })
})

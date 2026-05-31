import { describe, expect, it } from "vitest"

import { computeDelta, type BaselineSnapshot, type CurrentState } from "@/lib/data/delta"

/**
 * The single delta() module (CLAUDE.md §5, §20 C4) — tests assert behaviour
 * through the public interface (computeDelta) so the impl can be refactored
 * freely. A baseline snapshot is the shape lock_baseline() serializes; current
 * state is the same shape read live. delta reports schedule variance, scope
 * drift (added/removed tasks), and RAG changes.
 */

function snapshot(tasks: BaselineSnapshot["workspaces"][number]["tasks"]): BaselineSnapshot {
  return {
    project_id: "p1",
    captured_at: "2026-01-01T00:00:00Z",
    workspaces: [
      { workspace_id: "w1", department_id: "d1", rag_status: "green", tasks },
    ],
  }
}
function current(tasks: CurrentState["workspaces"][number]["tasks"]): CurrentState {
  return {
    workspaces: [
      { workspace_id: "w1", department_id: "d1", rag_status: "green", tasks },
    ],
  }
}

describe("computeDelta", () => {
  it("reports no changes when current matches the baseline", () => {
    const base = snapshot([
      { task_id: "t1", title: "A", rag_status: "green", start_date: "2026-01-01", due_date: "2026-02-01" },
    ])
    const cur = current([
      { task_id: "t1", title: "A", rag_status: "green", start_date: "2026-01-01", due_date: "2026-02-01" },
    ])
    const d = computeDelta(base, cur)
    expect(d.hasChanges).toBe(false)
    expect(d.addedTasks).toHaveLength(0)
    expect(d.removedTasks).toHaveLength(0)
    expect(d.scheduleVariances).toHaveLength(0)
    expect(d.ragChanges).toHaveLength(0)
  })

  it("detects an added task (scope drift)", () => {
    const base = snapshot([
      { task_id: "t1", title: "A", rag_status: "green", start_date: null, due_date: null },
    ])
    const cur = current([
      { task_id: "t1", title: "A", rag_status: "green", start_date: null, due_date: null },
      { task_id: "t2", title: "B", rag_status: "amber", start_date: null, due_date: null },
    ])
    const d = computeDelta(base, cur)
    expect(d.hasChanges).toBe(true)
    expect(d.addedTasks.map((t) => t.task_id)).toEqual(["t2"])
    expect(d.removedTasks).toHaveLength(0)
  })

  it("detects a removed task (scope drift)", () => {
    const base = snapshot([
      { task_id: "t1", title: "A", rag_status: "green", start_date: null, due_date: null },
      { task_id: "t2", title: "B", rag_status: "green", start_date: null, due_date: null },
    ])
    const cur = current([
      { task_id: "t1", title: "A", rag_status: "green", start_date: null, due_date: null },
    ])
    const d = computeDelta(base, cur)
    expect(d.removedTasks.map((t) => t.task_id)).toEqual(["t2"])
  })

  it("computes schedule variance in days when a due date slips", () => {
    const base = snapshot([
      { task_id: "t1", title: "A", rag_status: "green", start_date: "2026-01-01", due_date: "2026-02-01" },
    ])
    const cur = current([
      { task_id: "t1", title: "A", rag_status: "green", start_date: "2026-01-01", due_date: "2026-02-08" },
    ])
    const d = computeDelta(base, cur)
    expect(d.scheduleVariances).toHaveLength(1)
    expect(d.scheduleVariances[0]).toMatchObject({
      task_id: "t1",
      dueDateVarianceDays: 7, // slipped 7 days later
    })
  })

  it("flags a due date that was added after baseline (not a day-count)", () => {
    const base = snapshot([
      { task_id: "t1", title: "A", rag_status: "green", start_date: null, due_date: null },
    ])
    const cur = current([
      { task_id: "t1", title: "A", rag_status: "green", start_date: null, due_date: "2026-03-01" },
    ])
    const d = computeDelta(base, cur)
    expect(d.scheduleVariances).toHaveLength(1)
    expect(d.scheduleVariances[0]).toMatchObject({
      task_id: "t1",
      dueDateChange: "added",
      dueDateVarianceDays: null,
    })
  })

  it("flags a start date that was removed after baseline", () => {
    const base = snapshot([
      { task_id: "t1", title: "A", rag_status: "green", start_date: "2026-01-01", due_date: null },
    ])
    const cur = current([
      { task_id: "t1", title: "A", rag_status: "green", start_date: null, due_date: null },
    ])
    const d = computeDelta(base, cur)
    expect(d.scheduleVariances).toHaveLength(1)
    expect(d.scheduleVariances[0]).toMatchObject({
      task_id: "t1",
      startDateChange: "removed",
    })
  })

  it("detects a RAG change on an existing task", () => {
    const base = snapshot([
      { task_id: "t1", title: "A", rag_status: "green", start_date: null, due_date: null },
    ])
    const cur = current([
      { task_id: "t1", title: "A", rag_status: "red", start_date: null, due_date: null },
    ])
    const d = computeDelta(base, cur)
    expect(d.ragChanges).toHaveLength(1)
    expect(d.ragChanges[0]).toMatchObject({ task_id: "t1", from: "green", to: "red" })
  })

  it("counts a workspace appearing only in current as added scope, not a crash", () => {
    const base = snapshot([])
    const cur: CurrentState = {
      workspaces: [
        { workspace_id: "w1", department_id: "d1", rag_status: "green", tasks: [] },
        {
          workspace_id: "w2",
          department_id: "d2",
          rag_status: "amber",
          tasks: [
            { task_id: "t9", title: "New dept task", rag_status: "amber", start_date: null, due_date: null },
          ],
        },
      ],
    }
    const d = computeDelta(base, cur)
    expect(d.addedTasks.map((t) => t.task_id)).toEqual(["t9"])
    expect(d.hasChanges).toBe(true)
  })
})

import type { Database } from "@/lib/types/database"

type Rag = Database["public"]["Enums"]["rag_status"]

/**
 * The single current-vs-baseline diff module (CLAUDE.md §5, §20 C4).
 *
 * This is the ONLY place the project plan is diffed against a locked baseline.
 * The dashboard, reports, and the delta view all consume `computeDelta` — none
 * recompute the diff themselves. Keeping it pure (no DB, no I/O) means it is
 * trivially unit-tested and identical across every consumer.
 *
 * `BaselineSnapshot` is exactly the shape `lock_baseline()` serializes into
 * `baselines.snapshot` (§9 migration 0018); `CurrentState` is the same shape
 * read live. Compare them to surface schedule variance, scope drift
 * (added/removed tasks), and RAG changes.
 */

export type SnapshotTask = {
  task_id: string
  title: string
  rag_status: Rag
  start_date: string | null
  due_date: string | null
}

export type SnapshotWorkspace = {
  workspace_id: string
  department_id: string
  rag_status: Rag
  tasks: SnapshotTask[]
}

export type BaselineSnapshot = {
  project_id: string
  captured_at: string
  workspaces: SnapshotWorkspace[]
}

/** Current state is the snapshot shape minus the lock metadata. */
export type CurrentState = {
  workspaces: SnapshotWorkspace[]
}

export type ScheduleVariance = {
  task_id: string
  title: string
  startDateVarianceDays: number | null
  dueDateVarianceDays: number | null
}

export type RagChange = {
  task_id: string
  title: string
  from: Rag
  to: Rag
}

export type ProjectDelta = {
  hasChanges: boolean
  addedTasks: SnapshotTask[]
  removedTasks: SnapshotTask[]
  scheduleVariances: ScheduleVariance[]
  ragChanges: RagChange[]
}

/** Flatten every task across all workspaces into one id→task map. */
function indexTasks(workspaces: SnapshotWorkspace[]): Map<string, SnapshotTask> {
  const map = new Map<string, SnapshotTask>()
  for (const w of workspaces) {
    for (const t of w.tasks) map.set(t.task_id, t)
  }
  return map
}

/** Whole-day difference (current − baseline). Positive = later than baseline. */
function dayVariance(baseline: string | null, current: string | null): number | null {
  if (!baseline || !current) return null
  const MS_PER_DAY = 86_400_000
  const b = Date.parse(baseline)
  const c = Date.parse(current)
  if (Number.isNaN(b) || Number.isNaN(c)) return null
  return Math.round((c - b) / MS_PER_DAY)
}

export function computeDelta(
  baseline: BaselineSnapshot,
  current: CurrentState,
): ProjectDelta {
  const baseTasks = indexTasks(baseline.workspaces)
  const curTasks = indexTasks(current.workspaces)

  const addedTasks: SnapshotTask[] = []
  const removedTasks: SnapshotTask[] = []
  const scheduleVariances: ScheduleVariance[] = []
  const ragChanges: RagChange[] = []

  // Added: in current, not in baseline.
  for (const [id, t] of curTasks) {
    if (!baseTasks.has(id)) addedTasks.push(t)
  }

  // Removed + per-task comparisons for tasks present in baseline.
  for (const [id, base] of baseTasks) {
    const cur = curTasks.get(id)
    if (!cur) {
      removedTasks.push(base)
      continue
    }

    const startVar = dayVariance(base.start_date, cur.start_date)
    const dueVar = dayVariance(base.due_date, cur.due_date)
    if ((startVar ?? 0) !== 0 || (dueVar ?? 0) !== 0) {
      scheduleVariances.push({
        task_id: id,
        title: cur.title,
        startDateVarianceDays: startVar,
        dueDateVarianceDays: dueVar,
      })
    }

    if (base.rag_status !== cur.rag_status) {
      ragChanges.push({
        task_id: id,
        title: cur.title,
        from: base.rag_status,
        to: cur.rag_status,
      })
    }
  }

  const hasChanges =
    addedTasks.length > 0 ||
    removedTasks.length > 0 ||
    scheduleVariances.length > 0 ||
    ragChanges.length > 0

  return { hasChanges, addedTasks, removedTasks, scheduleVariances, ragChanges }
}

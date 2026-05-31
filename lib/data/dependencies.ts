import "server-only"

import { createClient } from "@/lib/supabase/server"
import type { Database } from "@/lib/types/database"

/**
 * Read-side data for the dependency map (CLAUDE.md §5 module 7, §7).
 *
 * Everything runs through the user-scoped server client, so RLS scopes it: a
 * member sees only edges TOUCHING their department (migration 0026's symmetric
 * "either endpoint dept" SELECT), and the foreign endpoint task stays hidden by
 * tasks-RLS. There is deliberately NO manual department filter here (§6, §17).
 *
 * The map therefore renders two kinds of node:
 *   * a KNOWN node — a task the caller may see (full title + RAG), returned in
 *     `nodes`; and
 *   * a BOUNDARY node — the far end of a cross-department edge the caller may NOT
 *     see. The client derives these from any edge endpoint missing from `nodes`,
 *     and labels them by department using the edge's denormalized dept id +
 *     `departments` (department names are globally readable, 0010). The foreign
 *     task's title/assignee/dates are never sent.
 */

type Rag = Database["public"]["Enums"]["rag_status"]
type RelationType = Database["public"]["Enums"]["relation_type"]

export type DependencyNode = {
  id: string
  title: string
  ragStatus: Rag
  departmentId: string | null
}

export type DependencyEdge = {
  id: string
  source: string
  target: string
  relationType: RelationType
  // Nullable to match the DB columns (trigger-populated; null only in the
  // never-expected fail-safe case). Downstream labels fall back gracefully.
  sourceDeptId: string | null
  targetDeptId: string | null
}

export type DependencyGraph = {
  nodes: DependencyNode[]
  edges: DependencyEdge[]
  /** id → name, for labeling cross-department boundary nodes (no task contents). */
  departments: Record<string, string>
}

/**
 * The dependency graph the caller may see: every visible edge, the visible tasks
 * that are an endpoint of one, and a department-name lookup for boundary nodes.
 */
export async function listDependencyGraph(): Promise<DependencyGraph> {
  const supabase = await createClient()

  // 1) Edges (RLS-scoped to those touching the caller's department, or all if exec).
  const { data: edgeRows, error: edgeErr } = await supabase
    .from("dependencies")
    .select(
      "id, source_task_id, target_task_id, relation_type, source_department_id, target_department_id",
    )
    .order("created_at", { ascending: true })
  if (edgeErr) throw new Error(`listDependencyGraph edges: ${edgeErr.message}`)

  const edges: DependencyEdge[] = (edgeRows ?? []).map((e) => ({
    id: e.id,
    source: e.source_task_id,
    target: e.target_task_id,
    relationType: e.relation_type,
    sourceDeptId: e.source_department_id,
    targetDeptId: e.target_department_id,
  }))

  // 2) The visible tasks that are an endpoint of some edge → the KNOWN nodes.
  //    (We only need endpoints, not every task — keeps the graph focused + bounded.)
  const endpointIds = [...new Set(edges.flatMap((e) => [e.source, e.target]))]
  let nodes: DependencyNode[] = []
  if (endpointIds.length > 0) {
    const { data: taskRows, error: taskErr } = await supabase
      .from("tasks")
      .select("id, title, rag_status, department_workspaces(department_id)")
      .in("id", endpointIds)
    if (taskErr) throw new Error(`listDependencyGraph tasks: ${taskErr.message}`)
    nodes = (taskRows ?? []).map((t) => ({
      id: t.id,
      title: t.title,
      ragStatus: t.rag_status,
      departmentId:
        (t.department_workspaces as { department_id: string } | null)?.department_id ?? null,
    }))
  }

  // 3) Department names for every department referenced by an edge (for labels).
  const deptIds = [
    ...new Set(
      edges
        .flatMap((e) => [e.sourceDeptId, e.targetDeptId])
        .filter((d): d is string => d !== null),
    ),
  ]
  const departments: Record<string, string> = {}
  if (deptIds.length > 0) {
    const { data: deptRows, error: deptErr } = await supabase
      .from("departments")
      .select("id, name")
      .in("id", deptIds)
    if (deptErr) throw new Error(`listDependencyGraph departments: ${deptErr.message}`)
    for (const d of deptRows ?? []) departments[d.id] = d.name
  }

  return { nodes, edges, departments }
}

export type DependencyTaskOption = {
  id: string
  label: string
  departmentId: string | null
}

/**
 * Tasks the caller may pick as a dependency endpoint (RLS-scoped). A member only
 * sees their department's tasks, so they can only build intra-department edges;
 * an executive sees all and can build cross-department edges (ADR 0002).
 */
export async function listTasksForDependencyForm(): Promise<DependencyTaskOption[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("tasks")
    .select("id, title, department_workspaces(department_id, departments(name), projects(name))")
    .order("created_at", { ascending: false })
  if (error) throw new Error(`listTasksForDependencyForm: ${error.message}`)

  return (data ?? []).map((t) => {
    const ws = t.department_workspaces as unknown as {
      department_id: string
      departments: { name: string } | null
      projects: { name: string } | null
    } | null
    const dept = ws?.departments?.name ?? "—"
    const proj = ws?.projects?.name ?? "—"
    return { id: t.id, label: `${proj} · ${dept} · ${t.title}`, departmentId: ws?.department_id ?? null }
  })
}

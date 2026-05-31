import "server-only"

import { createClient } from "@/lib/supabase/server"
import type { Database } from "@/lib/types/database"

/**
 * Read-side data access for the governance hierarchy.
 *
 * Every query runs through the user-scoped server client, so RLS scopes results
 * automatically: a member sees only their department's rows, an executive sees
 * all (CLAUDE.md §13, §14). There is deliberately NO manual `.eq('department_id',
 * ...)` filtering here — adding one would duplicate (and could contradict) the
 * policy, and the whole point of Phase 1 is that the database is the boundary.
 */

type Rag = Database["public"]["Enums"]["rag_status"]
type UpdateStatus = Database["public"]["Enums"]["update_status"]

export type ProjectRow = {
  id: string
  name: string
  description: string | null
  status: Rag
  created_at: string
}

export async function listProjects(): Promise<ProjectRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, description, status, created_at")
    .order("created_at", { ascending: false })

  if (error) throw new Error(`listProjects: ${error.message}`)
  return data ?? []
}

export async function getProject(id: string): Promise<ProjectRow | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, description, status, created_at")
    .eq("id", id)
    .maybeSingle()

  if (error) throw new Error(`getProject: ${error.message}`)
  return data
}

export type WorkspaceRow = {
  id: string
  project_id: string
  department_id: string
  rag_status: Rag
  departments: { name: string } | null
}

/** Workspaces visible to the caller for a project (RLS: own dept, or all if exec). */
export async function listWorkspacesForProject(
  projectId: string,
): Promise<WorkspaceRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("department_workspaces")
    .select("id, project_id, department_id, rag_status, departments(name)")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true })

  if (error) throw new Error(`listWorkspacesForProject: ${error.message}`)
  return data ?? []
}

export type TaskRow = {
  id: string
  workspace_id: string
  title: string
  description: string | null
  rag_status: Rag
  start_date: string | null
  due_date: string | null
}

/** Tasks the caller may see (RLS-scoped). Optionally narrow to one workspace. */
export async function listTasks(workspaceId?: string): Promise<TaskRow[]> {
  const supabase = await createClient()
  let query = supabase
    .from("tasks")
    .select("id, workspace_id, title, description, rag_status, start_date, due_date")
    .order("created_at", { ascending: false })

  if (workspaceId) query = query.eq("workspace_id", workspaceId)

  const { data, error } = await query
  if (error) throw new Error(`listTasks: ${error.message}`)
  return data ?? []
}

export type DepartmentRow = { id: string; name: string }

export async function listDepartments(): Promise<DepartmentRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("departments")
    .select("id, name")
    .order("name", { ascending: true })

  if (error) throw new Error(`listDepartments: ${error.message}`)
  return data ?? []
}

/**
 * Workspaces the caller can WRITE tasks into — i.e. their own department's (or,
 * for an executive, every workspace). Used to populate the "new task" form.
 * RLS already guarantees the rows returned are writable by this user.
 */
export async function listWritableWorkspaces(): Promise<
  Array<{ id: string; label: string }>
> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("department_workspaces")
    .select("id, departments(name), projects(name)")
    .order("created_at", { ascending: true })

  if (error) throw new Error(`listWritableWorkspaces: ${error.message}`)
  return (data ?? []).map((w) => {
    const dept = (w.departments as { name: string } | null)?.name ?? "—"
    const proj = (w.projects as { name: string } | null)?.name ?? "—"
    return { id: w.id, label: `${proj} · ${dept}` }
  })
}

// ── Phase 3: weekly update cycle + approvals ─────────────────────────────────

export type UpdateCycle = {
  id: string
  opens_at: string
  closes_at: string
  status: string
}

/** The most recent open update cycle, or null if none is open. */
export async function getOpenCycle(): Promise<UpdateCycle | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("update_cycles")
    .select("id, opens_at, closes_at, status")
    .eq("status", "open")
    .order("opens_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`getOpenCycle: ${error.message}`)
  return data
}

export type DepartmentUpdateRow = {
  id: string
  cycle_id: string
  workspace_id: string
  status: UpdateStatus
  content: { summary?: string } | null
  submitted_at: string | null
  approved_at: string | null
  department_workspaces: {
    department_id: string
    departments: { name: string } | null
    projects: { name: string } | null
  } | null
}

/**
 * Weekly updates visible to the caller (RLS-scoped) for a cycle. A member sees
 * only their department's; a director the same; an executive sees all.
 */
export async function listUpdatesForCycle(
  cycleId: string,
): Promise<DepartmentUpdateRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("department_updates")
    .select(
      "id, cycle_id, workspace_id, status, content, submitted_at, approved_at, department_workspaces(department_id, departments(name), projects(name))",
    )
    .eq("cycle_id", cycleId)
    .order("created_at", { ascending: true })

  if (error) throw new Error(`listUpdatesForCycle: ${error.message}`)
  return (data ?? []) as unknown as DepartmentUpdateRow[]
}

// ── Phase 3: baselines + delta ───────────────────────────────────────────────

export type BaselineRow = {
  id: string
  project_id: string
  name: string
  snapshot: unknown
  locked_at: string
}

/** Baselines for a project the caller can see, newest first. */
export async function listBaselines(projectId: string): Promise<BaselineRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("baselines")
    .select("id, project_id, name, snapshot, locked_at")
    .eq("project_id", projectId)
    .order("locked_at", { ascending: false })

  if (error) throw new Error(`listBaselines: ${error.message}`)
  return data ?? []
}

/** The most recent baseline for a project, or null if none locked yet. */
export async function getLatestBaseline(
  projectId: string,
): Promise<BaselineRow | null> {
  const rows = await listBaselines(projectId)
  return rows[0] ?? null
}

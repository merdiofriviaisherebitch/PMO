import "server-only"

/**
 * lib/data/reports.ts — Data access for the reports module (CLAUDE.md §5 module 11, §10).
 *
 * SECURITY-CRITICAL (§10, §17):
 *   gatherReportInput() uses the SERVICE-ROLE client (createServiceClient) which BYPASSES RLS
 *   entirely. Every query MUST apply an explicit department filter when scope.departmentId is
 *   not null. The filter is what makes this correct — never rely on RLS here.
 *
 *   listReports() and getReportSignedUrl() use the RLS server client (createClient).
 *   getReportSignedUrl() intentionally uses the RLS read as the server-side scope check
 *   before minting a signed URL — if RLS returns nothing, no URL is minted (§10 Storage).
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"
import { createClient } from "@/lib/supabase/server"
import { computeDelta } from "@/lib/data/delta"
import type { BaselineSnapshot, CurrentState, SnapshotTask } from "@/lib/data/delta"
import type { ReportInput } from "@/lib/reports/types"
import type { RagCounts, BudgetSummary } from "@/lib/data/dashboard"
import type { DependencyGraph, DependencyNode, DependencyEdge } from "@/lib/data/dependencies"
import type { OpenEscalation, EscalationKind } from "@/lib/data/escalations"

type Rag = Database["public"]["Enums"]["rag_status"]
type RelationType = Database["public"]["Enums"]["relation_type"]

// ─── Internal helpers ─────────────────────────────────────────────────────────

function tallyRag(items: Array<{ rag_status?: Rag; status?: Rag }>, key: "rag_status" | "status"): RagCounts {
  const c: RagCounts = { green: 0, amber: 0, red: 0, total: items.length }
  for (const r of items) {
    const v = r[key]
    if (v === "green") c.green++
    else if (v === "amber") c.amber++
    else if (v === "red") c.red++
  }
  return c
}

function kindOf(targetEntityType: string): EscalationKind {
  if (targetEntityType === "department_update") return "late_update"
  if (targetEntityType === "task") return "red_item"
  if (targetEntityType === "dependency") return "blocked_dependency"
  return "other"
}

// ─── Build 2a: gatherReportInput ─────────────────────────────────────────────

/**
 * Gather all data needed to render a report for the given scope and window.
 *
 * CRITICAL (§10): uses the SERVICE-ROLE client. RLS is NOT active. Every section
 * that touches department-scoped data MUST apply .eq("department_id", departmentId)
 * (or an equivalent join-filter) when scope.departmentId is not null.
 *
 * CALLER CONTRACT: a null departmentId = the global, all-departments executive
 * roll-up — under the service role it deliberately fetches EVERY department's rows.
 * Because this function cannot see the JWT, callers MUST gate the null scope on an
 * executive/system actor. The only two callers do: app/api/reports/generate is the
 * pg_cron/system path, and lib/actions/reports derives the scope from VERIFIED
 * executive claims (exec → null, director → own department). Do not introduce a
 * caller that passes null for a non-executive.
 */
export async function gatherReportInput(
  client: SupabaseClient<Database>,
  scope: { departmentId: string | null; label: string },
  period: "weekly" | "monthly",
  window: { start: string; end: string },
): Promise<ReportInput> {
  const deptId = scope.departmentId

  // Defense-in-depth (Phase 7 security review): scope.departmentId is always a trusted
  // UUID today (a JWT claim or a departments-table lookup), but it is interpolated into a
  // PostgREST .or() filter below — validate it is a UUID so a future caller can never turn
  // it into a filter-injection vector.
  if (deptId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deptId)) {
    throw new Error("gatherReportInput: scope.departmentId must be a UUID")
  }

  // ── RAG: projects + tasks ──────────────────────────────────────────────────
  // Projects are scoped via their department_workspaces when a dept is specified.
  // We count distinct project ids reachable through that dept's workspaces.
  // FILTER: workspace.department_id = deptId when scoped.
  let projectRag: RagCounts
  let taskRag: RagCounts

  if (deptId !== null) {
    // Scoped: find workspace ids for this department, then count project statuses
    // and task rag_status through those workspaces.
    const { data: wsRows, error: wsErr } = await client
      .from("department_workspaces")
      .select("id, projects(id, status)")
      .eq("department_id", deptId)   // §10 EXPLICIT dept filter
    if (wsErr) throw new Error(`gatherReportInput workspaces: ${wsErr.message}`)

    const wsIds = (wsRows ?? []).map((w) => w.id)

    // Project RAG: distinct projects visible through this department's workspaces.
    const projectMap = new Map<string, Rag>()
    for (const w of wsRows ?? []) {
      const proj = w.projects as { id: string; status: Rag } | null
      if (proj) projectMap.set(proj.id, proj.status)
    }
    const projectItems = [...projectMap.values()].map((s) => ({ status: s }))
    projectRag = tallyRag(projectItems, "status")

    // Task RAG: tasks in this department's workspaces.
    if (wsIds.length > 0) {
      const { data: taskRows, error: taskErr } = await client
        .from("tasks")
        .select("rag_status")
        .in("workspace_id", wsIds)   // §10 EXPLICIT dept filter via workspace membership
      if (taskErr) throw new Error(`gatherReportInput tasks: ${taskErr.message}`)
      taskRag = tallyRag(taskRows ?? [], "rag_status")
    } else {
      taskRag = { green: 0, amber: 0, red: 0, total: 0 }
    }
  } else {
    // Global roll-up: no department filter.
    const [projResult, taskResult] = await Promise.all([
      client.from("projects").select("status"),
      client.from("tasks").select("rag_status"),
    ])
    if (projResult.error) throw new Error(`gatherReportInput projects: ${projResult.error.message}`)
    if (taskResult.error) throw new Error(`gatherReportInput tasks: ${taskResult.error.message}`)
    projectRag = tallyRag(projResult.data ?? [], "status")
    taskRag = tallyRag(taskResult.data ?? [], "rag_status")
  }

  // ── Budget ─────────────────────────────────────────────────────────────────
  // §20 C4 SINGLE SOURCE: budget RAG comes ONLY from the canonical budget_variance()
  // function (0021/0023 — zero-budget spend = RED, per-row amber_pct/red_pct). It is
  // never recomputed here (the old inline 85/100 + zero-budget-green copy was C3, a
  // governance-credibility bug: the report showed GREEN where the dashboard showed RED).
  // budget_variance() is SECURITY INVOKER; the service client bypasses RLS, so for a
  // department report we re-apply the §10 scope filter in code by workspace id.
  let budget: BudgetSummary
  {
    const { data: varianceRows, error: vErr } = await client.rpc("budget_variance")
    if (vErr) throw new Error(`gatherReportInput budget_variance: ${vErr.message}`)
    const rows = varianceRows ?? []

    if (deptId !== null) {
      const { data: wsIds2, error: wsErr2 } = await client
        .from("department_workspaces")
        .select("id")
        .eq("department_id", deptId)   // §10 EXPLICIT dept filter
      if (wsErr2) throw new Error(`gatherReportInput budget workspaces: ${wsErr2.message}`)
      const wanted = new Set((wsIds2 ?? []).map((w) => w.id))
      budget = summarizeVariance(rows.filter((r) => wanted.has(r.workspace_id)))
    } else {
      budget = summarizeVariance(rows)
    }
  }

  // ── Dependency graph ───────────────────────────────────────────────────────
  // The dependency graph uses denormalized dept columns on the edge.
  // FILTER: (source_department_id = deptId OR target_department_id = deptId) when scoped.
  let dependencyGraph: DependencyGraph

  {
    let edgeQuery = client
      .from("dependencies")
      .select(
        "id, source_task_id, target_task_id, relation_type, source_department_id, target_department_id",
      )
      .order("created_at", { ascending: true })

    if (deptId !== null) {
      // §10 EXPLICIT dept filter: edges that touch this department (either endpoint).
      // PostgREST OR filter: use .or()
      edgeQuery = edgeQuery.or(
        `source_department_id.eq.${deptId},target_department_id.eq.${deptId}`,
      )
    }
    // Global: no filter — all edges.

    const { data: edgeRows, error: edgeErr } = await edgeQuery
    if (edgeErr) throw new Error(`gatherReportInput dependencies: ${edgeErr.message}`)

    const edges: DependencyEdge[] = (edgeRows ?? []).map((e) => ({
      id: e.id,
      source: e.source_task_id,
      target: e.target_task_id,
      relationType: e.relation_type as RelationType,
      sourceDeptId: e.source_department_id,
      targetDeptId: e.target_department_id,
    }))

    // Department names (a global-readable lookup, 0010) — built FIRST so a foreign
    // endpoint can be labelled by department without exposing the foreign task.
    const deptIds = [
      ...new Set(
        edges
          .flatMap((e) => [e.sourceDeptId, e.targetDeptId])
          .filter((d): d is string => d !== null),
      ),
    ]
    const departments: Record<string, string> = {}
    if (deptIds.length > 0) {
      const { data: deptRows, error: dErr } = await client
        .from("departments")
        .select("id, name")
        .in("id", deptIds)
      if (dErr) throw new Error(`gatherReportInput dep departments: ${dErr.message}`)
      for (const d of deptRows ?? []) departments[d.id] = d.name
    }

    // Endpoint nodes. CRITICAL (§6, §10, ADR 0002): under the service role RLS is OFF, so
    // a foreign endpoint (a task whose department != the scoped department) MUST render as a
    // department-labelled BOUNDARY ("Legal · hidden"), never its title — exactly like the
    // dependency map. We keep its rag_status (the minimum the cross-department block needs,
    // mirroring the 0027 escalation) but suppress the title. A global exec roll-up (deptId
    // null) has no foreign endpoints — the executive may see every title.
    const endpointIds = [...new Set(edges.flatMap((e) => [e.source, e.target]))]
    let nodes: DependencyNode[] = []
    if (endpointIds.length > 0) {
      const { data: taskRows, error: taskErr } = await client
        .from("tasks")
        .select("id, title, rag_status, department_workspaces(department_id)")
        .in("id", endpointIds)
      if (taskErr) throw new Error(`gatherReportInput dep tasks: ${taskErr.message}`)
      nodes = (taskRows ?? []).map((t) => {
        const taskDept =
          (t.department_workspaces as { department_id: string } | null)?.department_id ?? null
        const foreign = deptId !== null && taskDept !== deptId
        return {
          id: t.id,
          title: foreign
            ? `${(taskDept && departments[taskDept]) || "Another department"} · hidden`
            : t.title,
          ragStatus: t.rag_status as Rag,
          departmentId: taskDept,
        }
      })
    }

    dependencyGraph = { nodes, edges, departments }
  }

  // ── Open escalations ───────────────────────────────────────────────────────
  // escalation_events carries denormalized department_id (§9).
  // FILTER: department_id = deptId when scoped.
  let escalations: OpenEscalation[]

  {
    let escQuery = client
      .from("escalation_events")
      .select("id, level, target_entity_type, department_id, triggered_at")
      .is("resolved_at", null)
      .order("triggered_at", { ascending: false })

    if (deptId !== null) {
      escQuery = escQuery.eq("department_id", deptId)  // §10 EXPLICIT dept filter
    }
    // Global: no filter.

    const { data: escRows, error: escErr } = await escQuery
    if (escErr) throw new Error(`gatherReportInput escalations: ${escErr.message}`)

    // Resolve department names for the rows.
    const escDeptIds = [...new Set((escRows ?? []).map((r) => r.department_id).filter(Boolean))] as string[]
    const deptNames = new Map<string, string>()
    if (escDeptIds.length > 0) {
      const { data: depts, error: dErr } = await client
        .from("departments")
        .select("id, name")
        .in("id", escDeptIds)
      if (dErr) throw new Error(`gatherReportInput esc departments: ${dErr.message}`)
      for (const d of depts ?? []) deptNames.set(d.id, d.name)
    }

    escalations = (escRows ?? []).map((r): OpenEscalation => ({
      id: r.id,
      level: r.level,
      kind: kindOf(r.target_entity_type),
      departmentName: r.department_id ? deptNames.get(r.department_id) ?? null : null,
      triggeredAt: r.triggered_at,
    }))
  }

  // ── Baseline deltas ────────────────────────────────────────────────────────
  // Projects in scope → latest baseline → current tasks → computeDelta (§20 C4).
  // FILTER: workspaces.department_id = deptId (join) when scoped.
  const deltaEntries: ReportInput["deltas"] = []

  {
    // Find projects in scope.
    let projectQuery = client.from("projects").select("id, name")

    if (deptId !== null) {
      // Only projects that have a workspace for this department.
      const { data: wsForDept, error: wdErr } = await client
        .from("department_workspaces")
        .select("project_id")
        .eq("department_id", deptId)  // §10 EXPLICIT dept filter
      if (wdErr) throw new Error(`gatherReportInput delta workspaces: ${wdErr.message}`)
      const projIds = [...new Set((wsForDept ?? []).map((w) => w.project_id))]
      if (projIds.length === 0) {
        // No projects → no deltas.
      } else {
        projectQuery = projectQuery.in("id", projIds)
        const { data: projects, error: pErr } = await projectQuery
        if (pErr) throw new Error(`gatherReportInput delta projects: ${pErr.message}`)

        for (const proj of projects ?? []) {
          const delta = await computeProjectDelta(client, proj.id, deptId)
          if (delta !== null) {
            deltaEntries.push({ projectId: proj.id, projectName: proj.name, delta: delta.delta })
          }
        }
      }
    } else {
      // Global: all projects.
      const { data: projects, error: pErr } = await projectQuery
      if (pErr) throw new Error(`gatherReportInput delta projects global: ${pErr.message}`)
      for (const proj of projects ?? []) {
        const delta = await computeProjectDelta(client, proj.id, null)
        if (delta !== null) {
          deltaEntries.push({ projectId: proj.id, projectName: proj.name, delta: delta.delta })
        }
      }
    }
  }

  return {
    period,
    periodStart: window.start,
    periodEnd: window.end,
    generatedAt: new Date().toISOString(),
    scope,
    rag: { projects: projectRag, tasks: taskRag },
    budget,
    dependencyGraph,
    escalations,
    deltas: deltaEntries,
  }
}

/**
 * Compute the delta for one project against its latest baseline.
 * Returns null if the project has no baseline yet.
 * Uses the service-role client already in scope via the caller.
 */
async function computeProjectDelta(
  client: SupabaseClient<Database>,
  projectId: string,
  deptId: string | null,
): Promise<{ delta: ReturnType<typeof computeDelta> } | null> {
  const { data: baseline, error: bErr } = await client
    .from("baselines")
    .select("snapshot")
    .eq("project_id", projectId)
    .order("locked_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (bErr) throw new Error(`computeProjectDelta baseline: ${bErr.message}`)
  if (!baseline) return null

  const rawSnap = baseline.snapshot as BaselineSnapshot
  // CRITICAL (§6, §10): the baseline snapshot is the WHOLE project (every department).
  // A scoped report compares like-for-like — filter the snapshot to this department's
  // workspaces too, or cross-department baseline tasks surface as "removed" (a correctness
  // bug AND a foreign-task-title leak under the service role).
  const snap: BaselineSnapshot =
    deptId === null
      ? rawSnap
      : { ...rawSnap, workspaces: rawSnap.workspaces.filter((w) => w.department_id === deptId) }

  // Current state: tasks in in-scope workspaces.
  let wsQuery = client
    .from("department_workspaces")
    .select("id, department_id, rag_status, budgets(budget_amount), tasks(id, title, rag_status, start_date, due_date)")
    .eq("project_id", projectId)

  if (deptId !== null) {
    wsQuery = wsQuery.eq("department_id", deptId)  // §10 EXPLICIT dept filter
  }

  const { data: wsRows, error: wsErr } = await wsQuery
  if (wsErr) throw new Error(`computeProjectDelta workspaces: ${wsErr.message}`)

  const current: CurrentState = {
    workspaces: (wsRows ?? []).map((w) => ({
      workspace_id: w.id,
      department_id: w.department_id,
      rag_status: w.rag_status as Rag,
      budget_amount:
        (w.budgets as unknown as Array<{ budget_amount: number | null }> | null)?.[0]
          ?.budget_amount ?? null,
      tasks: ((w.tasks as unknown as Array<{
        id: string
        title: string
        rag_status: Rag
        start_date: string | null
        due_date: string | null
      }>) ?? []).map(
        (t): SnapshotTask => ({
          task_id: t.id,
          title: t.title,
          rag_status: t.rag_status,
          start_date: t.start_date,
          due_date: t.due_date,
        }),
      ),
    })),
  }

  return { delta: computeDelta(snap, current) }
}

// ─── Budget helpers ───────────────────────────────────────────────────────────

/** One canonical budget_variance() row (RAG already computed by the DB, §20 C4). */
type VarianceRow = Database["public"]["Functions"]["budget_variance"]["Returns"][number]

/** Tally canonical budget_variance() rows into the report's BudgetSummary. The RAG
 * comes straight from the function (zero-budget spend = RED, per-row thresholds) —
 * this NEVER re-derives it (§20 C4 single source). */
function summarizeVariance(rows: VarianceRow[]): BudgetSummary {
  const summary = emptyBudgetSummary()
  for (const r of rows) {
    const budget = Number(r.budget_amount ?? 0)
    const actual = Number(r.actual_total ?? 0)
    summary.totalBudget += budget
    summary.totalActual += actual
    if (r.rag === "red") summary.red++
    else if (r.rag === "amber") summary.amber++
    else summary.green++

    summary.lines.push({
      budget_id: r.budget_id,
      workspace_id: r.workspace_id,
      budget_amount: budget,
      actual_total: actual,
      pct_used: Number(r.pct_used ?? 0),
      rag: r.rag,
    })
  }
  summary.remaining = summary.totalBudget - summary.totalActual
  return summary
}

function emptyBudgetSummary(): BudgetSummary {
  return { totalBudget: 0, totalActual: 0, remaining: 0, red: 0, amber: 0, green: 0, lines: [] }
}

// ─── Build 2b: listReports ────────────────────────────────────────────────────

/**
 * List reports visible to the caller (RLS-scoped via createClient).
 * Ordered newest first.
 */
export async function listReports(): Promise<
  Array<{
    id: string
    period: string
    departmentId: string | null
    periodStart: string
    periodEnd: string
    generatedAt: string
  }>
> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("reports")
    .select("id, period, department_id, period_start, period_end, generated_at")
    .order("generated_at", { ascending: false })

  if (error) throw new Error(`listReports: ${error.message}`)
  return (data ?? []).map((r) => ({
    id: r.id,
    period: r.period,
    departmentId: r.department_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    generatedAt: r.generated_at,
  }))
}

// ─── Build 2c: getReportSignedUrl ─────────────────────────────────────────────

/**
 * Mint a short-lived signed URL for a report file.
 *
 * §10 Storage doctrine: the RLS client read IS the server-side scope check.
 * If the caller cannot see the reports row (RLS returns nothing), we return null
 * and never mint a URL — the storage RLS policy is a second gate.
 */
export async function getReportSignedUrl(
  reportId: string,
  format: "pdf" | "xlsx",
): Promise<string | null> {
  // A malformed id can never name a real report — treat it as not-found rather than letting
  // the uuid cast throw a 500 (also avoids a 500-vs-404 oracle on the download route).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reportId)) {
    return null
  }

  const supabase = await createClient()

  // Server-side scope check via RLS — if the caller cannot see this row, returns null.
  const { data: row, error: rowErr } = await supabase
    .from("reports")
    .select("pdf_path, xlsx_path")
    .eq("id", reportId)
    .maybeSingle()

  if (rowErr) throw new Error(`getReportSignedUrl row: ${rowErr.message}`)
  if (!row) return null  // RLS denied or row doesn't exist — no URL minted.

  const path = format === "pdf" ? row.pdf_path : row.xlsx_path

  const { data: signed, error: signErr } = await supabase.storage
    .from("reports")
    .createSignedUrl(path, 60)  // 60-second TTL

  if (signErr) throw new Error(`getReportSignedUrl sign: ${signErr.message}`)
  return signed?.signedUrl ?? null
}

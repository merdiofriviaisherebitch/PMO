import "server-only"

import { createClient } from "@/lib/supabase/server"
import type { Database } from "@/lib/types/database"

/**
 * Dashboard aggregations (CLAUDE.md §5 module 10). Everything is RLS-scoped, so
 * the SAME functions power the executive roll-up (all departments) and a
 * department view (own only) — the policies decide what each user sees.
 *
 * Per the Vercel guidance, callers fetch these with Promise.all() so the
 * independent aggregations run in parallel (no request waterfall).
 */

type Rag = Database["public"]["Enums"]["rag_status"]

export type RagCounts = { green: number; amber: number; red: number; total: number }

function tally(rows: Array<{ rag_status?: Rag; status?: Rag }>, key: "rag_status" | "status"): RagCounts {
  const c: RagCounts = { green: 0, amber: 0, red: 0, total: rows.length }
  for (const r of rows) {
    const v = r[key]
    if (v === "green") c.green++
    else if (v === "amber") c.amber++
    else if (v === "red") c.red++
  }
  return c
}

/** RAG roll-up across projects + tasks the caller can see. */
export async function getRagRollup(): Promise<{ projects: RagCounts; tasks: RagCounts }> {
  const supabase = await createClient()
  const [projects, tasks] = await Promise.all([
    supabase.from("projects").select("status"),
    supabase.from("tasks").select("rag_status"),
  ])
  if (projects.error) throw new Error(`getRagRollup projects: ${projects.error.message}`)
  if (tasks.error) throw new Error(`getRagRollup tasks: ${tasks.error.message}`)
  return {
    projects: tally(projects.data ?? [], "status"),
    tasks: tally(tasks.data ?? [], "rag_status"),
  }
}

export type BudgetSummary = {
  totalBudget: number
  totalActual: number
  remaining: number
  red: number
  amber: number
  green: number
  lines: Array<{
    budget_id: string
    workspace_id: string
    budget_amount: number
    actual_total: number
    pct_used: number
    rag: Rag
  }>
}

/** Budget variance summary via the single budget_variance() fn (RLS-scoped). */
export async function getBudgetSummary(): Promise<BudgetSummary> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("budget_variance")
  if (error) throw new Error(`getBudgetSummary: ${error.message}`)

  const rows = data ?? []
  const summary: BudgetSummary = {
    totalBudget: 0,
    totalActual: 0,
    remaining: 0,
    red: 0,
    amber: 0,
    green: 0,
    lines: [],
  }
  for (const r of rows) {
    summary.totalBudget += Number(r.budget_amount)
    summary.totalActual += Number(r.actual_total)
    if (r.rag === "red") summary.red++
    else if (r.rag === "amber") summary.amber++
    else summary.green++
    summary.lines.push({
      budget_id: r.budget_id,
      workspace_id: r.workspace_id,
      budget_amount: Number(r.budget_amount),
      actual_total: Number(r.actual_total),
      pct_used: Number(r.pct_used),
      rag: r.rag,
    })
  }
  summary.remaining = summary.totalBudget - summary.totalActual
  return summary
}

/** Budget variance rows for one project's visible workspaces (RLS-scoped). */
export async function getProjectBudgets(
  workspaceIds: string[],
): Promise<BudgetSummary["lines"]> {
  if (workspaceIds.length === 0) return []
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("budget_variance")
  if (error) throw new Error(`getProjectBudgets: ${error.message}`)
  const wanted = new Set(workspaceIds)
  return (data ?? [])
    .filter((r) => wanted.has(r.workspace_id))
    .map((r) => ({
      budget_id: r.budget_id,
      workspace_id: r.workspace_id,
      budget_amount: Number(r.budget_amount),
      actual_total: Number(r.actual_total),
      pct_used: Number(r.pct_used),
      rag: r.rag,
    }))
}

export type CycleStatus = {
  cycleId: string | null
  closesAt: string | null
  submitted: number
  pending: number
  outstanding: number
  total: number
}

/**
 * Submission status for the open cycle (CLAUDE.md §5 module 2). "submitted" =
 * approved; "pending" = awaiting director; "outstanding" = draft/rejected. All
 * RLS-scoped, so a director sees their department, an exec sees all.
 */
export async function getCycleStatus(): Promise<CycleStatus> {
  const supabase = await createClient()
  const { data: cycle, error: cErr } = await supabase
    .from("update_cycles")
    .select("id, closes_at")
    .eq("status", "open")
    .order("opens_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (cErr) throw new Error(`getCycleStatus cycle: ${cErr.message}`)
  if (!cycle) {
    return { cycleId: null, closesAt: null, submitted: 0, pending: 0, outstanding: 0, total: 0 }
  }

  const { data: updates, error: uErr } = await supabase
    .from("department_updates")
    .select("status")
    .eq("cycle_id", cycle.id)
  if (uErr) throw new Error(`getCycleStatus updates: ${uErr.message}`)

  const rows = updates ?? []
  let submitted = 0
  let pending = 0
  let outstanding = 0
  for (const u of rows) {
    if (u.status === "approved") submitted++
    else if (u.status === "pending") pending++
    else outstanding++ // draft | rejected
  }
  return {
    cycleId: cycle.id,
    closesAt: cycle.closes_at,
    submitted,
    pending,
    outstanding,
    total: rows.length,
  }
}

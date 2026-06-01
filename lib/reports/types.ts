/**
 * lib/reports/types.ts — Input + model types for the report domain module.
 *
 * PURE module: no database, no I/O, no "server-only". Consumed by both route
 * handlers (server) and vitest (test) — see ADR 0003.
 *
 * Type-only imports from data modules are safe: `import type` does NOT execute
 * the module, so the `server-only` runtime guard never fires.
 */

import type { BudgetSummary, RagCounts } from "@/lib/data/dashboard"
import type { DependencyGraph } from "@/lib/data/dependencies"
import type { ProjectDelta } from "@/lib/data/delta"
import type { OpenEscalation } from "@/lib/data/escalations"

// ─── Input ────────────────────────────────────────────────────────────────────

export type ReportInput = {
  period: "weekly" | "monthly"
  /** ISO date strings for the covered window. */
  periodStart: string
  periodEnd: string
  /** ISO timestamp for when this report was generated. */
  generatedAt: string
  /** null departmentId = global executive roll-up. */
  scope: { label: string; departmentId: string | null }
  rag: { projects: RagCounts; tasks: RagCounts }
  budget: BudgetSummary
  dependencyGraph: DependencyGraph
  escalations: OpenEscalation[]
  deltas: Array<{ projectId: string; projectName: string; delta: ProjectDelta }>
}

// ─── Derived rows (intermediate) ─────────────────────────────────────────────

export type BlockerRow = {
  blockerLabel: string
  blockedLabel: string
}

export type VarianceRow = {
  projectName: string
  addedCount: number
  removedCount: number
  scheduleChangedCount: number
  ragChangedCount: number
  /** Workspaces whose budget drifted from the locked baseline (C2; §3/§5). */
  budgetChangedCount: number
  scheduleVariances: ProjectDelta["scheduleVariances"]
}

export type EscalationRow = {
  level: number
  kind: string
  department: string
  triggeredAt: string
}

// ─── Model (render-ready) ─────────────────────────────────────────────────────

export type ReportModel = {
  title: string
  /** "${periodStart} → ${periodEnd} · generated ${generatedAt}" */
  subtitle: string
  scopeLabel: string
  period: "weekly" | "monthly"
  rag: { projects: RagCounts; tasks: RagCounts }
  budget: BudgetSummary
  /** Red-source "blocks" edges only. */
  blockers: BlockerRow[]
  /** Projects where delta.hasChanges === true only. */
  variance: VarianceRow[]
  escalations: EscalationRow[]
}

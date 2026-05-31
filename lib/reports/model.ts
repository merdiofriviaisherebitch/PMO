/**
 * lib/reports/model.ts — Pure derivation of ReportModel from ReportInput.
 *
 * PURE module: no database, no I/O, no "server-only". Clock-independent (inputs
 * carry the ISO strings). Testable through its single exported function.
 *
 * §20 C4: this is the one place governance data is shaped for output — reports,
 * PDFs, and spreadsheets all consume `buildReportModel` and never re-derive.
 */

import type { ReportInput, ReportModel, BlockerRow, VarianceRow, EscalationRow } from "./types"

export function buildReportModel(input: ReportInput): ReportModel {
  const { period, periodStart, periodEnd, generatedAt, scope, rag, budget, dependencyGraph, escalations, deltas } =
    input

  // ── Title ─────────────────────────────────────────────────────────────────
  const title = `${period === "weekly" ? "Weekly" : "Monthly"} Governance Report — ${scope.label}`
  const subtitle = `${periodStart} → ${periodEnd} · generated ${generatedAt}`

  // ── Unresolved blockers (§11, ADR 0002) ───────────────────────────────────
  // Only "blocks" edges where the SOURCE node is red. A green/amber blocker is
  // not considered unresolved for report purposes. If a node id doesn't exist in
  // the nodes array, fall back: use dept name from the edge's dept id (boundary
  // node pattern from CLAUDE.md §8 + dependencies.ts) or literal "hidden".
  const nodeIndex = new Map(dependencyGraph.nodes.map((n) => [n.id, n]))

  function nodeLabel(nodeId: string, deptId: string | null): string {
    const node = nodeIndex.get(nodeId)
    if (node) return node.title
    // Boundary node — we have no task title; use department name if available.
    const deptName = deptId ? (dependencyGraph.departments[deptId] ?? null) : null
    return deptName ? `${deptName} · hidden` : "hidden"
  }

  const blockers: BlockerRow[] = dependencyGraph.edges
    .filter((e) => {
      if (e.relationType !== "blocks") return false
      const src = nodeIndex.get(e.source)
      // If the source node isn't visible (boundary node), we can't confirm it's
      // red — exclude it rather than guessing.
      return src?.ragStatus === "red"
    })
    .map((e) => ({
      blockerLabel: nodeLabel(e.source, e.sourceDeptId),
      blockedLabel: nodeLabel(e.target, e.targetDeptId),
    }))

  // ── Variance (projects with changes only) ─────────────────────────────────
  const variance: VarianceRow[] = deltas
    .filter((d) => d.delta.hasChanges)
    .map((d) => ({
      projectName: d.projectName,
      addedCount: d.delta.addedTasks.length,
      removedCount: d.delta.removedTasks.length,
      scheduleChangedCount: d.delta.scheduleVariances.length,
      ragChangedCount: d.delta.ragChanges.length,
      scheduleVariances: d.delta.scheduleVariances,
    }))

  // ── Escalations ───────────────────────────────────────────────────────────
  const escalationRows: EscalationRow[] = escalations.map((e) => ({
    level: e.level,
    kind: e.kind,
    department: e.departmentName ?? "—",
    triggeredAt: e.triggeredAt,
  }))

  return {
    title,
    subtitle,
    scopeLabel: scope.label,
    period,
    rag,
    budget,
    blockers,
    variance,
    escalations: escalationRows,
  }
}

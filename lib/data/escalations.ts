import "server-only"

import { createClient } from "@/lib/supabase/server"

/**
 * Escalation reads for the dashboard (CLAUDE.md §5 module 8, §10). RLS-scoped:
 * escalation_events carries a denormalized department_id, so a director sees
 * their own department's open escalations and an executive sees all — the policy
 * decides, no app-layer department filter (§6, §17).
 *
 * We read ONLY escalation_events: escalation_rules is executive-only SELECT (a
 * director cannot join to it for rule_type), so the human "kind" is derived from
 * target_entity_type instead — which is exactly the information a director needs
 * and avoids widening the rules policy.
 */

export type EscalationKind = "late_update" | "red_item" | "other"

export type OpenEscalation = {
  id: string
  level: number
  kind: EscalationKind
  departmentName: string | null
  triggeredAt: string
}

function kindOf(targetEntityType: string): EscalationKind {
  if (targetEntityType === "department_update") return "late_update"
  if (targetEntityType === "task") return "red_item"
  return "other"
}

/** Open (unresolved) escalations visible to the caller, newest first. */
export async function getOpenEscalations(
  limit = 8,
): Promise<{ items: OpenEscalation[]; total: number }> {
  const supabase = await createClient()

  // Bound the row transfer AND get the true total in one round-trip: count:"exact"
  // returns the full unresolved count (RLS-scoped) while .limit() caps the rows
  // actually fetched — so a large backlog never pulls every row into the RSC.
  const { data, count, error } = await supabase
    .from("escalation_events")
    .select("id, level, target_entity_type, department_id, triggered_at", { count: "exact" })
    .is("resolved_at", null)
    .order("triggered_at", { ascending: false })
    .limit(limit)
  if (error) throw new Error(`getOpenEscalations: ${error.message}`)

  const rows = data ?? []

  // Resolve department names from the all-readable lookup (only for the rows shown).
  const deptIds = [...new Set(rows.map((r) => r.department_id).filter(Boolean))] as string[]
  const names = new Map<string, string>()
  if (deptIds.length > 0) {
    const { data: depts, error: dErr } = await supabase
      .from("departments")
      .select("id, name")
      .in("id", deptIds)
    if (dErr) throw new Error(`getOpenEscalations departments: ${dErr.message}`)
    for (const d of depts ?? []) names.set(d.id, d.name)
  }

  const items = rows.map((r): OpenEscalation => ({
    id: r.id,
    level: r.level,
    kind: kindOf(r.target_entity_type),
    departmentName: r.department_id ? names.get(r.department_id) ?? null : null,
    triggeredAt: r.triggered_at,
  }))

  return { items, total: count ?? rows.length }
}

"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"
import { type ActionResult, rlsAwareMessage } from "@/lib/actions/shared"

/**
 * Lock a baseline for a project (CLAUDE.md §5 module 5). Executive/PMO only
 * (§18 Q9 default) — enforced by the baselines INSERT policy (migration 0018),
 * not here. We call the lock_baseline() DB function which serializes the current
 * project state into an immutable snapshot in ONE transaction, so the snapshot
 * is consistent. The baseline can never be edited afterward (UPDATE/DELETE
 * revoked at the role level).
 */
export async function lockBaseline(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const projectId = String(formData.get("projectId") ?? "")
  const name = String(formData.get("name") ?? "").trim()
  if (!projectId) return { ok: false, errors: { _form: "Missing project." } }
  if (name.length < 2) {
    return { ok: false, errors: { name: "Give the baseline a name (≥2 chars)." } }
  }

  const supabase = await createClient()
  const { error } = await supabase.rpc("lock_baseline", {
    p_project_id: projectId,
    p_name: name,
  })

  if (error) {
    return {
      ok: false,
      errors: { _form: rlsAwareMessage(error.message, "lock a baseline") },
    }
  }

  revalidatePath(`/projects/${projectId}`)
  return { ok: true }
}

"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"
import { type ActionResult, rlsAwareMessage } from "@/lib/actions/shared"
import { dependencyCreateSchema, fieldErrors } from "@/lib/validation"

/**
 * Dependency Server Actions (CLAUDE.md §5 module 7). The role gate lives in RLS
 * (migration 0026, ADR 0002): a non-exec may only create/delete an edge whose
 * BOTH endpoints are in their department; a cross-department edge needs an
 * executive. Never the service-role client. The denormalized endpoint departments
 * are set by the DB trigger, never here.
 */

/** Create a typed dependency edge between two tasks. */
export async function createDependency(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = dependencyCreateSchema.safeParse({
    sourceTaskId: formData.get("sourceTaskId"),
    targetTaskId: formData.get("targetTaskId"),
    relationType: formData.get("relationType") ?? "blocks",
  })
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) }

  const supabase = await createClient()
  // Stamp created_by from the authenticated session for accountability (the column
  // is for the audit trail; RLS still decides whether the insert is allowed).
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      ok: false,
      errors: { _form: "Your session has expired — please sign in again." },
    }
  }

  const { error } = await supabase.from("dependencies").insert({
    source_task_id: parsed.data.sourceTaskId,
    target_task_id: parsed.data.targetTaskId,
    relation_type: parsed.data.relationType,
    created_by: user.id,
  })

  if (error) {
    return {
      ok: false,
      errors: { _form: rlsAwareMessage(error.message, "create this dependency") },
    }
  }

  revalidatePath("/dependencies")
  revalidatePath("/")
  return { ok: true }
}

/** Delete a dependency edge. RLS allows it only for an edge the caller could create. */
export async function deleteDependency(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "")
  if (!id) return

  const supabase = await createClient()
  // RLS scopes the delete: a foreign / cross-department edge simply affects 0 rows
  // (no error, no data change) — the UI only ever shows ids the caller may act on.
  const { count } = await supabase
    .from("dependencies")
    .delete({ count: "exact" })
    .eq("id", id)

  if (count === 0) return
  revalidatePath("/dependencies")
  revalidatePath("/")
}

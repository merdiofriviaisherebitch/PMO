"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"
import { fieldErrors, workspaceRagSchema } from "@/lib/validation"

export type ActionResult =
  | { ok: true }
  | { ok: false; errors: Record<string, string> }

/**
 * Set a workspace's RAG health. RLS (migration 0014) allows this only for the
 * owning department (or an executive); the WITH CHECK keeps department_id
 * unchanged, so this can never move a workspace between departments.
 */
export async function setWorkspaceRag(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = workspaceRagSchema.safeParse({
    id: formData.get("id"),
    ragStatus: formData.get("ragStatus"),
  })
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) }

  const supabase = await createClient()
  const { error } = await supabase
    .from("department_workspaces")
    .update({ rag_status: parsed.data.ragStatus })
    .eq("id", parsed.data.id)

  if (error) {
    const msg =
      error.message.includes("row-level security") ||
      error.message.includes("permission denied")
        ? "You don't have permission to update this workspace."
        : error.message
    return { ok: false, errors: { _form: msg } }
  }

  revalidatePath("/projects")
  return { ok: true }
}

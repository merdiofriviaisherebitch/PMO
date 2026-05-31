"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"
import { type ActionResult, rlsAwareMessage } from "@/lib/actions/shared"
import { fieldErrors, workspaceRagSchema } from "@/lib/validation"

/**
 * Set a workspace's RAG health. RLS (migration 0015) allows this only for a
 * DIRECTOR/EXECUTIVE of the owning department; the WITH CHECK keeps
 * department_id unchanged, so this can never move a workspace between
 * departments. A member's attempt is rejected at the DB layer.
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
  // Return the row so we know its project_id for targeted revalidation, and so a
  // blocked update (RLS → 0 rows) is distinguishable from a successful one.
  const { data, error } = await supabase
    .from("department_workspaces")
    .update({ rag_status: parsed.data.ragStatus })
    .eq("id", parsed.data.id)
    .select("project_id")

  if (error) {
    return {
      ok: false,
      errors: { _form: rlsAwareMessage(error.message, "update this workspace") },
    }
  }
  if (!data || data.length === 0) {
    return {
      ok: false,
      errors: { _form: "You don't have permission to update this workspace." },
    }
  }

  // Bust both the project list and the affected project detail page (which
  // renders the workspace RAG badge), plus the dashboard roll-up.
  revalidatePath("/projects")
  revalidatePath(`/projects/${data[0].project_id}`)
  revalidatePath("/")
  return { ok: true }
}

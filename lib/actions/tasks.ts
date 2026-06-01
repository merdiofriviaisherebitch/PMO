"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"
import { type ActionResult, rlsAwareMessage } from "@/lib/actions/shared"
import {
  fieldErrors,
  taskCreateSchema,
  taskUpdateSchema,
} from "@/lib/validation"

/**
 * Create a task. RLS (migration 0010) enforces the task lands in a workspace the
 * caller's department owns (or any, for an executive); a cross-department
 * workspace_id is rejected by the WITH CHECK at the DB layer.
 */
export async function createTask(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = taskCreateSchema.safeParse({
    workspaceId: formData.get("workspaceId"),
    title: formData.get("title"),
    description: formData.get("description") ?? "",
    ragStatus: formData.get("ragStatus") ?? "green",
    startDate: formData.get("startDate") ?? "",
    dueDate: formData.get("dueDate") ?? "",
  })
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) }

  const supabase = await createClient()
  // Stamp the real actor (§9, §17 accountability). The DB trigger stamp_actor
  // (0032) also forces created_by = auth.uid() un-spoofably; this records intent.
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from("tasks").insert({
    workspace_id: parsed.data.workspaceId,
    title: parsed.data.title,
    description: parsed.data.description || null,
    rag_status: parsed.data.ragStatus,
    start_date: parsed.data.startDate || null,
    due_date: parsed.data.dueDate || null,
    created_by: user?.id ?? null,
  })

  if (error) {
    return {
      ok: false,
      errors: {
        _form: rlsAwareMessage(error.message, "add tasks to that workspace"),
      },
    }
  }

  revalidatePath("/tasks")
  revalidatePath("/")
  return { ok: true }
}

export async function updateTask(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = taskUpdateSchema.safeParse({
    id: formData.get("id"),
    title: formData.get("title"),
    description: formData.get("description") ?? "",
    ragStatus: formData.get("ragStatus") ?? "green",
    startDate: formData.get("startDate") ?? "",
    dueDate: formData.get("dueDate") ?? "",
  })
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) }

  const supabase = await createClient()
  const { error } = await supabase
    .from("tasks")
    .update({
      title: parsed.data.title,
      description: parsed.data.description || null,
      rag_status: parsed.data.ragStatus,
      start_date: parsed.data.startDate || null,
      due_date: parsed.data.dueDate || null,
    })
    .eq("id", parsed.data.id)

  if (error) {
    return {
      ok: false,
      errors: { _form: rlsAwareMessage(error.message, "edit this task") },
    }
  }

  // Task RAG also rolls up into the project detail page; bust /projects too.
  revalidatePath("/tasks")
  revalidatePath("/projects", "layout")
  revalidatePath("/")
  return { ok: true }
}

export async function deleteTask(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "")
  if (!id) return

  const supabase = await createClient()
  // RLS ensures only own-department (or exec) deletes succeed. In the normal UI
  // the task list is RLS-scoped, so a user only ever sees ids they may delete;
  // a tampered foreign id simply affects 0 rows (no error, no data change). We
  // request the count so a future UI can distinguish blocked from done.
  const { count } = await supabase
    .from("tasks")
    .delete({ count: "exact" })
    .eq("id", id)

  if (count === 0) {
    // Forbidden or already gone — nothing to revalidate, surface nothing
    // (the page will simply still show the row for anyone allowed to see it).
    return
  }
  revalidatePath("/tasks")
  revalidatePath("/projects", "layout")
  revalidatePath("/")
}

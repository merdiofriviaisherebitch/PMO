"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"
import {
  fieldErrors,
  taskCreateSchema,
  taskUpdateSchema,
} from "@/lib/validation"

export type ActionResult =
  | { ok: true }
  | { ok: false; errors: Record<string, string> }

function rlsAwareMessage(raw: string, action: string): string {
  if (
    raw.includes("row-level security") ||
    raw.includes("violates row-level") ||
    raw.includes("permission denied")
  ) {
    return `You don't have permission to ${action}.`
  }
  return raw
}

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
  const { error } = await supabase.from("tasks").insert({
    workspace_id: parsed.data.workspaceId,
    title: parsed.data.title,
    description: parsed.data.description || null,
    rag_status: parsed.data.ragStatus,
    start_date: parsed.data.startDate || null,
    due_date: parsed.data.dueDate || null,
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

  revalidatePath("/tasks")
  return { ok: true }
}

export async function deleteTask(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "")
  if (!id) return

  const supabase = await createClient()
  // RLS ensures only own-department (or exec) deletes succeed.
  await supabase.from("tasks").delete().eq("id", id)
  revalidatePath("/tasks")
}

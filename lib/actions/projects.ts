"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"
import { type ActionResult, rlsAwareMessage } from "@/lib/actions/shared"
import {
  fieldErrors,
  projectCreateSchema,
  projectUpdateSchema,
} from "@/lib/validation"

export type { ActionResult }

/**
 * Create a project. Executive/PMO only — but we do NOT check the role here; the
 * INSERT policy (migration 0014) rejects non-executives at the DB layer. If RLS
 * blocks it, PostgREST returns an error and we surface it. This keeps the
 * security decision in ONE place (CLAUDE.md §6, §17).
 */
export async function createProject(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = projectCreateSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") ?? "",
    status: formData.get("status") ?? "green",
  })
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) }

  const supabase = await createClient()
  const { error } = await supabase.from("projects").insert({
    name: parsed.data.name,
    description: parsed.data.description || null,
    status: parsed.data.status,
  })

  if (error) {
    return {
      ok: false,
      errors: { _form: rlsAwareMessage(error.message, "create projects") },
    }
  }

  revalidatePath("/projects")
  revalidatePath("/")
  return { ok: true }
}

export async function updateProject(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = projectUpdateSchema.safeParse({
    id: formData.get("id"),
    name: formData.get("name"),
    description: formData.get("description") ?? "",
    status: formData.get("status") ?? "green",
  })
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) }

  const supabase = await createClient()
  const { error } = await supabase
    .from("projects")
    .update({
      name: parsed.data.name,
      description: parsed.data.description || null,
      status: parsed.data.status,
    })
    .eq("id", parsed.data.id)

  if (error) {
    return {
      ok: false,
      errors: { _form: rlsAwareMessage(error.message, "edit this project") },
    }
  }

  revalidatePath("/projects")
  revalidatePath(`/projects/${parsed.data.id}`)
  return { ok: true }
}

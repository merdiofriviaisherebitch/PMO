"use server"

import { revalidatePath } from "next/cache"

import { createClient } from "@/lib/supabase/server"
import { type ActionResult, rlsAwareMessage } from "@/lib/actions/shared"

/**
 * Weekly-update workflow actions (CLAUDE.md §5 module 4). The state machine and
 * role rules live in the DB (migration 0017: RLS gates who can touch the row,
 * the transition guard validates the move by role). These actions just drive the
 * status column; an illegal move or wrong role is rejected at the DB layer and
 * surfaced as a human message. Never the service-role client.
 */

/**
 * Member/director starts a draft for their workspace in a cycle. Used directly
 * as a `<form action>`, so it takes FormData only and returns void; RLS rejects
 * a foreign workspace, and the unique(cycle,workspace) constraint makes a repeat
 * a no-op.
 */
export async function startDraft(formData: FormData): Promise<void> {
  const cycleId = String(formData.get("cycleId") ?? "")
  const workspaceId = String(formData.get("workspaceId") ?? "")
  if (!cycleId || !workspaceId) return

  const supabase = await createClient()
  const { error } = await supabase
    .from("department_updates")
    .insert({ cycle_id: cycleId, workspace_id: workspaceId, status: "draft" })

  // A unique-violation (a draft already exists for this cycle×workspace) is the
  // one benign no-op. ANY other error must NOT be swallowed (silent failures are
  // a non-negotiable, CLAUDE.md §6) — log it server-side so it's diagnosable.
  if (error && error.code !== "23505") {
    console.error("[startDraft] unexpected error:", error.message)
  }
  revalidatePath("/updates")
}

/** Save draft content (free-form notes). Only valid while draft/rejected. */
export async function saveDraftContent(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "")
  const summary = String(formData.get("summary") ?? "").trim()
  if (!id) return { ok: false, errors: { _form: "Missing update id." } }

  const supabase = await createClient()
  // Content is editable only while draft/rejected. The transition guard
  // (migration 0019) enforces this at the DB layer; we also scope the UPDATE to
  // those statuses so a tampered request on a pending/approved row matches 0
  // rows instead of erroring — defense in depth + clearer outcome.
  const { data, error } = await supabase
    .from("department_updates")
    .update({ content: { summary } })
    .eq("id", id)
    .in("status", ["draft", "rejected"])
    .select("id")

  if (error) {
    return {
      ok: false,
      errors: { _form: rlsAwareMessage(error.message, "edit this update") },
    }
  }
  if (!data || data.length === 0) {
    return {
      ok: false,
      errors: { _form: "This update can no longer be edited." },
    }
  }
  revalidatePath("/updates")
  return { ok: true }
}

/** Transition helper: flips status and lets the DB guard validate the move. */
async function transition(
  id: string,
  toStatus: "pending" | "approved" | "rejected" | "draft",
  verb: string,
): Promise<ActionResult> {
  if (!id) return { ok: false, errors: { _form: "Missing update id." } }
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("department_updates")
    .update({ status: toStatus })
    .eq("id", id)
    .select("id")

  if (error) {
    return { ok: false, errors: { _form: rlsAwareMessage(error.message, verb) } }
  }
  if (!data || data.length === 0) {
    return { ok: false, errors: { _form: `You don't have permission to ${verb}.` } }
  }
  revalidatePath("/updates")
  revalidatePath("/")
  return { ok: true }
}

/** Member submits a draft for director approval (draft → pending). */
export async function submitUpdate(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return transition(String(formData.get("id") ?? ""), "pending", "submit this update")
}

/** Director approves a pending update (pending → approved). */
export async function approveUpdate(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return transition(String(formData.get("id") ?? ""), "approved", "approve this update")
}

/** Director rejects a pending update back for revision (pending → rejected). */
export async function rejectUpdate(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return transition(String(formData.get("id") ?? ""), "rejected", "reject this update")
}

/** Member returns a rejected update to draft to revise (rejected → draft). */
export async function reviseUpdate(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return transition(String(formData.get("id") ?? ""), "draft", "revise this update")
}

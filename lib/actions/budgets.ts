"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { createClient } from "@/lib/supabase/server"
import { type ActionResult, rlsAwareMessage } from "@/lib/actions/shared"
import { fieldErrors } from "@/lib/validation"

/**
 * Budget Server Actions (CLAUDE.md §5 module 9). Role gates live in RLS
 * (migration 0021): setBudget is director/exec-only; recordActual is any
 * own-department member. Never the service-role client.
 */

const budgetSchema = z.object({
  workspaceId: z.guid(),
  budgetAmount: z.coerce.number().min(0, "Budget must be ≥ 0").max(1_000_000_000),
})

const actualSchema = z.object({
  budgetId: z.guid(),
  amount: z.coerce.number().min(0, "Amount must be ≥ 0").max(1_000_000_000),
  description: z.string().trim().max(500).optional().or(z.literal("")),
})

/** Director/exec sets (or updates) a workspace budget. */
export async function setBudget(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = budgetSchema.safeParse({
    workspaceId: formData.get("workspaceId"),
    budgetAmount: formData.get("budgetAmount"),
  })
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  // Upsert on the unique(workspace_id) so a director can revise the figure.
  // approved_by records the acting director (§9); the stamp_actor trigger (0032)
  // also forces it un-spoofably on both the insert and the revise (update) path.
  const { error } = await supabase
    .from("budgets")
    .upsert(
      {
        workspace_id: parsed.data.workspaceId,
        budget_amount: parsed.data.budgetAmount,
        approved_by: user?.id ?? null,
      },
      { onConflict: "workspace_id" },
    )

  if (error) {
    return { ok: false, errors: { _form: rlsAwareMessage(error.message, "set this budget") } }
  }
  revalidatePath("/projects", "layout")
  revalidatePath("/")
  return { ok: true }
}

/** Own-department member records an actual against a budget. */
export async function recordActual(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = actualSchema.safeParse({
    budgetId: formData.get("budgetId"),
    amount: formData.get("amount"),
    description: formData.get("description") ?? "",
  })
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from("budget_actuals").insert({
    budget_id: parsed.data.budgetId,
    amount: parsed.data.amount,
    description: parsed.data.description || null,
    recorded_by: user?.id ?? null,
  })

  if (error) {
    return { ok: false, errors: { _form: rlsAwareMessage(error.message, "record this spend") } }
  }
  revalidatePath("/projects", "layout")
  revalidatePath("/")
  return { ok: true }
}

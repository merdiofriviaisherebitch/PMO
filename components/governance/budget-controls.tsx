"use client"

import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { recordActual, setBudget } from "@/lib/actions/budgets"
import type { ActionResult } from "@/lib/actions/shared"

/**
 * Budget controls for one workspace. The "set budget" row shows only to
 * directors/execs (RLS rejects others anyway); recording an actual is open to
 * own-department members. Both are thin wrappers over the Server Actions; the DB
 * is the authority on who may write.
 */
export function BudgetControls({
  workspaceId,
  budgetId,
  canSetBudget,
}: {
  workspaceId: string
  budgetId: string | null
  canSetBudget: boolean
}) {
  const [setState, setAction, setting] = useActionState<ActionResult | null, FormData>(
    setBudget,
    null,
  )
  const [actState, actAction, recording] = useActionState<ActionResult | null, FormData>(
    recordActual,
    null,
  )

  return (
    <div className="space-y-3">
      {canSetBudget ? (
        <form action={setAction} className="flex items-end gap-2">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <div className="flex-1">
            <label className="text-muted-foreground text-xs">Set budget (EUR)</label>
            <Input name="budgetAmount" type="number" min="0" step="0.01" required />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={setting}>
            Save
          </Button>
        </form>
      ) : null}
      {setState && !setState.ok ? (
        <p className="text-destructive text-xs">{setState.errors._form ?? setState.errors.budgetAmount}</p>
      ) : null}

      {budgetId ? (
        <form action={actAction} className="flex items-end gap-2">
          <input type="hidden" name="budgetId" value={budgetId} />
          <div className="flex-1">
            <label className="text-muted-foreground text-xs">Record spend (EUR)</label>
            <Input name="amount" type="number" min="0" step="0.01" required />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={recording}>
            Record
          </Button>
        </form>
      ) : (
        <p className="text-muted-foreground text-xs">
          No budget set{canSetBudget ? " yet — set one above." : "."}
        </p>
      )}
      {actState && !actState.ok ? (
        <p className="text-destructive text-xs">{actState.errors._form ?? actState.errors.amount}</p>
      ) : null}
    </div>
  )
}

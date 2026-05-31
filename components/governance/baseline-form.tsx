"use client"

import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { lockBaseline } from "@/lib/actions/baselines"
import type { ActionResult } from "@/lib/actions/shared"

/**
 * Lock-baseline form (executive only). The baselines INSERT policy + lock_baseline
 * RPC (migration 0018) enforce exec-only at the DB layer; this form is shown only
 * to executives for clean UX, but a non-exec call is rejected regardless.
 */
export function BaselineForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    lockBaseline,
    null,
  )
  const errors = state && !state.ok ? state.errors : {}

  return (
    <form action={action} className="flex items-end gap-3">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex-1 space-y-1.5">
        <Label htmlFor="name">Baseline name</Label>
        <Input id="name" name="name" required placeholder="e.g. Q1 Plan v1" />
        {errors.name ? (
          <p className="text-destructive text-sm">{errors.name}</p>
        ) : null}
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Locking…" : "Lock baseline"}
      </Button>
      {errors._form ? (
        <p className="text-destructive text-sm" role="alert">
          {errors._form}
        </p>
      ) : null}
      {state?.ok ? (
        <p className="text-sm text-emerald-600">Baseline locked.</p>
      ) : null}
    </form>
  )
}

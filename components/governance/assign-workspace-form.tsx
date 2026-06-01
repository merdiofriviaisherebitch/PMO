"use client"

import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { createWorkspace } from "@/lib/actions/workspaces"
import type { ActionResult } from "@/lib/actions/shared"

/**
 * Executive-only: assign a department to this project (creates its workspace).
 * createWorkspace is RLS-gated to executives (migration 0014). `departments` is
 * pre-filtered to those not yet assigned; if empty, every department is in.
 */
export function AssignWorkspaceForm({
  projectId,
  departments,
}: {
  projectId: string
  departments: Array<{ id: string; name: string }>
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    createWorkspace,
    null,
  )

  if (departments.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Every department is already assigned to this project.
      </p>
    )
  }

  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="space-y-1.5">
        <Label htmlFor="departmentId">Department</Label>
        <Select name="departmentId" defaultValue={departments[0]?.id}>
          <SelectTrigger id="departmentId" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {departments.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Assigning…" : "Assign department"}
      </Button>
      {state && !state.ok ? (
        <p className="text-destructive w-full text-sm" role="alert">
          {state.errors._form}
        </p>
      ) : null}
      {state?.ok ? (
        <p className="w-full text-sm text-emerald-600">Department assigned.</p>
      ) : null}
    </form>
  )
}

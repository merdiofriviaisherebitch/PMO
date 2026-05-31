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
import { createDependency } from "@/lib/actions/dependencies"
import type { ActionResult } from "@/lib/actions/shared"
import type { DependencyTaskOption } from "@/lib/data/dependencies"

/**
 * New-dependency form. The task lists are RLS-pre-filtered, so a member only sees
 * their department's tasks and can only build intra-department edges; an executive
 * sees all and can link across departments (ADR 0002). Even a tampered task id is
 * rejected by the INSERT policy at the DB layer.
 */
export function DependencyForm({ tasks }: { tasks: DependencyTaskOption[] }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    createDependency,
    null,
  )
  const errors = state && !state.ok ? state.errors : {}

  if (tasks.length < 2) {
    return (
      <p className="text-muted-foreground text-sm">
        You need at least two visible tasks before you can link them. Add tasks
        first (an executive can link tasks across departments).
      </p>
    )
  }

  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="sourceTaskId">Source task (blocker)</Label>
          <Select name="sourceTaskId" defaultValue={tasks[0]?.id}>
            <SelectTrigger id="sourceTaskId" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tasks.map((t) => (
                <SelectItem key={`s-${t.id}`} value={t.id}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.sourceTaskId ? (
            <p className="text-destructive text-sm">{errors.sourceTaskId}</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="targetTaskId">Target task (dependent)</Label>
          <Select name="targetTaskId" defaultValue={tasks[1]?.id}>
            <SelectTrigger id="targetTaskId" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tasks.map((t) => (
                <SelectItem key={`t-${t.id}`} value={t.id}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.targetTaskId ? (
            <p className="text-destructive text-sm">{errors.targetTaskId}</p>
          ) : null}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="relationType">Relation</Label>
        <Select name="relationType" defaultValue="blocks">
          <SelectTrigger id="relationType" className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="blocks">Blocks (source must finish first)</SelectItem>
            <SelectItem value="precedes">Precedes (scheduled before)</SelectItem>
            <SelectItem value="relates">Relates to (informational)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {errors._form ? (
        <p className="text-destructive text-sm" role="alert">
          {errors._form}
        </p>
      ) : null}
      {state?.ok ? (
        <p className="text-sm text-emerald-600">Dependency created.</p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Linking…" : "Add dependency"}
      </Button>
    </form>
  )
}

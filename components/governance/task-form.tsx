"use client"

import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { createTask, type ActionResult } from "@/lib/actions/tasks"

/**
 * New-task form. The workspace list is pre-filtered to ones the caller may write
 * to (RLS), so a member only ever sees their own department's workspaces. Even
 * if the select were tampered with, the INSERT policy rejects a foreign
 * workspace_id at the DB layer.
 */
export function TaskForm({
  workspaces,
}: {
  workspaces: Array<{ id: string; label: string }>
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    createTask,
    null,
  )
  const errors = state && !state.ok ? state.errors : {}

  if (workspaces.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        You have no workspace to add tasks to yet. An executive assigns your
        department to a project first.
      </p>
    )
  }

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="workspaceId">Workspace</Label>
        <Select name="workspaceId" defaultValue={workspaces[0]?.id}>
          <SelectTrigger id="workspaceId" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {workspaces.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errors.workspaceId ? (
          <p className="text-destructive text-sm">{errors.workspaceId}</p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" required placeholder="e.g. Submit permit application" />
        {errors.title ? (
          <p className="text-destructive text-sm">{errors.title}</p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="ragStatus">Status</Label>
          <Select name="ragStatus" defaultValue="green">
            <SelectTrigger id="ragStatus" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="green">On track</SelectItem>
              <SelectItem value="amber">At risk</SelectItem>
              <SelectItem value="red">Off track</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dueDate">Due date</Label>
          <Input id="dueDate" name="dueDate" type="date" />
          {errors.dueDate ? (
            <p className="text-destructive text-sm">{errors.dueDate}</p>
          ) : null}
        </div>
      </div>

      {errors._form ? (
        <p className="text-destructive text-sm" role="alert">
          {errors._form}
        </p>
      ) : null}
      {state?.ok ? <p className="text-sm text-emerald-600">Task created.</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add task"}
      </Button>
    </form>
  )
}

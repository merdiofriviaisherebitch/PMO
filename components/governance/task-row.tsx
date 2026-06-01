"use client"

import { useState, useTransition } from "react"

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
import { TableCell, TableRow } from "@/components/ui/table"
import { RagBadge } from "@/components/governance/rag-badge"
import { deleteTask, updateTask } from "@/lib/actions/tasks"
import type { ActionResult } from "@/lib/actions/shared"
import type { Database } from "@/lib/types/database"

type Rag = Database["public"]["Enums"]["rag_status"]

export type EditableTask = {
  id: string
  title: string
  description: string | null
  rag_status: Rag
  start_date: string | null
  due_date: string | null
}

/**
 * One task row with inline edit + delete. Both actions are RLS-scoped: a member
 * can only edit/delete their own department's tasks; a foreign id matches 0 rows
 * at the DB layer (CLAUDE.md §6 — the database is the boundary, not this UI).
 *
 * The edit form pre-fills EVERY field (title, description, status, both dates) so
 * saving never blanks an unshown value — updateTask sets each column from the form.
 */
export function TaskRow({ task }: { task: EditableTask }) {
  const [editing, setEditing] = useState(false)
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ActionResult | null>(null)
  const errors = result && !result.ok ? result.errors : {}

  // Run the Server Action, then close the editor on success — no setState-in-effect.
  function onSubmit(formData: FormData) {
    startTransition(async () => {
      const res = await updateTask(null, formData)
      setResult(res)
      if (res.ok) setEditing(false)
    })
  }

  if (editing) {
    return (
      <TableRow>
        <TableCell colSpan={4}>
          <form action={onSubmit} className="space-y-3 py-1">
            <input type="hidden" name="id" value={task.id} />
            <div className="space-y-1.5">
              <Label htmlFor={`title-${task.id}`}>Title</Label>
              <Input
                id={`title-${task.id}`}
                name="title"
                required
                defaultValue={task.title}
              />
              {errors.title ? (
                <p className="text-destructive text-sm">{errors.title}</p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`description-${task.id}`}>Description</Label>
              <Input
                id={`description-${task.id}`}
                name="description"
                defaultValue={task.description ?? ""}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor={`ragStatus-${task.id}`}>Status</Label>
                <Select name="ragStatus" defaultValue={task.rag_status}>
                  <SelectTrigger id={`ragStatus-${task.id}`} className="w-full">
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
                <Label htmlFor={`startDate-${task.id}`}>Start</Label>
                <Input
                  id={`startDate-${task.id}`}
                  name="startDate"
                  type="date"
                  defaultValue={task.start_date ?? ""}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`dueDate-${task.id}`}>Due</Label>
                <Input
                  id={`dueDate-${task.id}`}
                  name="dueDate"
                  type="date"
                  defaultValue={task.due_date ?? ""}
                />
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

            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? "Saving…" : "Save"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        </TableCell>
      </TableRow>
    )
  }

  return (
    <TableRow>
      <TableCell className="font-medium">{task.title}</TableCell>
      <TableCell>
        <RagBadge status={task.rag_status} />
      </TableCell>
      <TableCell className="text-muted-foreground">
        {task.due_date ? new Date(task.due_date).toLocaleDateString() : "—"}
      </TableCell>
      <TableCell className="text-right">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setEditing(true)}
        >
          Edit
        </Button>
        {/* delete is RLS-scoped: a no-op for rows you can't write */}
        <form action={deleteTask} className="inline">
          <input type="hidden" name="id" value={task.id} />
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
          >
            Delete
          </Button>
        </form>
      </TableCell>
    </TableRow>
  )
}

"use client"

import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { createProject } from "@/lib/actions/projects"
import type { ActionResult } from "@/lib/actions/shared"

/**
 * New-project form (executive only). The action calls createProject; if RLS
 * rejects a non-executive the server returns a permission error into `_form`.
 * useActionState wires the async action to progressive-enhancement-friendly UI.
 */
export function ProjectForm() {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    createProject,
    null,
  )
  const errors = state && !state.ok ? state.errors : {}

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="name">Project name</Label>
        <Input id="name" name="name" required placeholder="e.g. Geothermal Plant Beta" />
        {errors.name ? (
          <p className="text-destructive text-sm">{errors.name}</p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">Description</Label>
        <Textarea id="description" name="description" rows={3} />
        {errors.description ? (
          <p className="text-destructive text-sm">{errors.description}</p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="status">Initial status</Label>
        <Select name="status" defaultValue="green">
          <SelectTrigger id="status" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="green">On track</SelectItem>
            <SelectItem value="amber">At risk</SelectItem>
            <SelectItem value="red">Off track</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {errors._form ? (
        <p className="text-destructive text-sm" role="alert">
          {errors._form}
        </p>
      ) : null}
      {state?.ok ? (
        <p className="text-sm text-emerald-600">Project created.</p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create project"}
      </Button>
    </form>
  )
}

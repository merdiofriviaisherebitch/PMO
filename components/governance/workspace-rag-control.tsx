"use client"

import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { setWorkspaceRag } from "@/lib/actions/workspaces"
import type { ActionResult } from "@/lib/actions/shared"
import type { Database } from "@/lib/types/database"

type Rag = Database["public"]["Enums"]["rag_status"]

/**
 * RAG control for a department workspace (CLAUDE.md §5 module 3). Wired to
 * setWorkspaceRag, which RLS gates (migration 0015) to a DIRECTOR/EXECUTIVE of the
 * OWNING department — a member, or a director of another department, is rejected
 * at the DB layer even if this rendered. Setting a workspace RAG rolls up into the
 * project status via the 0033 trigger.
 */
export function WorkspaceRagControl({
  workspaceId,
  current,
}: {
  workspaceId: string
  current: Rag
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    setWorkspaceRag,
    null,
  )

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="id" value={workspaceId} />
      <Select name="ragStatus" defaultValue={current}>
        <SelectTrigger className="h-8 w-32" aria-label="Workspace status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="green">On track</SelectItem>
          <SelectItem value="amber">At risk</SelectItem>
          <SelectItem value="red">Off track</SelectItem>
        </SelectContent>
      </Select>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Set"}
      </Button>
      {state && !state.ok ? (
        <span className="text-destructive text-xs">{state.errors._form}</span>
      ) : null}
    </form>
  )
}

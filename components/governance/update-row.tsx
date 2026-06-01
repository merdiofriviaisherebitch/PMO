"use client"

import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import {
  approveUpdate,
  rejectUpdate,
  reviseUpdate,
  saveDraftContent,
  submitUpdate,
} from "@/lib/actions/updates"
import type { ActionResult } from "@/lib/actions/shared"
import type { Database } from "@/lib/types/database"

type UpdateStatus = Database["public"]["Enums"]["update_status"]

const STATUS_VARIANT: Record<UpdateStatus, "secondary" | "default" | "outline" | "destructive"> = {
  draft: "outline",
  pending: "secondary",
  approved: "default",
  rejected: "destructive",
}

/**
 * One weekly-update row with the controls appropriate to its status and the
 * caller's role. The DB is the real gate: every button maps to a transition the
 * trigger validates by role (migration 0017). A member's "Approve" would be
 * rejected at the DB layer even if it rendered — but we only show controls the
 * role can use, for clean UX.
 */
export function UpdateRow({
  update,
  canApprove,
  canEdit,
}: {
  update: {
    id: string
    status: UpdateStatus
    label: string
    summary: string
  }
  canApprove: boolean
  /** Owning-department member/director (not a viewer): may submit/revise/edit notes. */
  canEdit: boolean
}) {
  const [, submitAction, submitting] = useActionState<ActionResult | null, FormData>(
    submitUpdate,
    null,
  )
  const [, approveAction, approving] = useActionState<ActionResult | null, FormData>(
    approveUpdate,
    null,
  )
  const [, rejectAction, rejecting] = useActionState<ActionResult | null, FormData>(
    rejectUpdate,
    null,
  )
  const [, reviseAction, revising] = useActionState<ActionResult | null, FormData>(
    reviseUpdate,
    null,
  )
  const [saveState, saveAction, saving] = useActionState<ActionResult | null, FormData>(
    saveDraftContent,
    null,
  )

  // Content (the weekly narrative) is editable only while draft/rejected — the DB
  // transition guard (migration 0019) enforces the same rule server-side.
  const canEditNotes =
    canEdit && (update.status === "draft" || update.status === "rejected")

  return (
    <div className="rounded-md border px-4 py-3">
      <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{update.label}</span>
          <Badge variant={STATUS_VARIANT[update.status]} className="capitalize">
            {update.status}
          </Badge>
        </div>
        {update.summary ? (
          <p className="text-muted-foreground mt-0.5 truncate text-sm">
            {update.summary}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {update.status === "draft" && canEdit ? (
          <form action={submitAction}>
            <input type="hidden" name="id" value={update.id} />
            <Button type="submit" size="sm" disabled={submitting}>
              Submit
            </Button>
          </form>
        ) : null}

        {update.status === "rejected" && canEdit ? (
          <form action={reviseAction}>
            <input type="hidden" name="id" value={update.id} />
            <Button type="submit" size="sm" variant="outline" disabled={revising}>
              Revise
            </Button>
          </form>
        ) : null}

        {update.status === "pending" && canApprove ? (
          <>
            <form action={approveAction}>
              <input type="hidden" name="id" value={update.id} />
              <Button type="submit" size="sm" disabled={approving}>
                Approve
              </Button>
            </form>
            <form action={rejectAction}>
              <input type="hidden" name="id" value={update.id} />
              <Button
                type="submit"
                size="sm"
                variant="outline"
                className="text-destructive"
                disabled={rejecting}
              >
                Reject
              </Button>
            </form>
          </>
        ) : null}
      </div>
      </div>

      {canEditNotes ? (
        <form action={saveAction} className="mt-3 space-y-2">
          <input type="hidden" name="id" value={update.id} />
          <Textarea
            name="summary"
            defaultValue={update.summary}
            rows={3}
            placeholder="Progress notes for this week…"
            aria-label="Weekly update notes"
          />
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" variant="outline" disabled={saving}>
              {saving ? "Saving…" : "Save notes"}
            </Button>
            {saveState?.ok ? (
              <span className="text-xs text-emerald-600">Saved.</span>
            ) : null}
            {saveState && !saveState.ok ? (
              <span className="text-destructive text-xs">
                {saveState.errors._form}
              </span>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  )
}

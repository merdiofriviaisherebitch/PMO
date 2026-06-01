import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { UpdateRow } from "@/components/governance/update-row"
import { getAppIdentity } from "@/lib/auth/claims"
import {
  getOpenCycle,
  listUpdatesForCycle,
  listWritableWorkspaces,
} from "@/lib/data/governance"
import { startDraft } from "@/lib/actions/updates"
import { Button } from "@/components/ui/button"

/**
 * Weekly update cycle workflow (CLAUDE.md §5 module 4). Members draft + submit;
 * directors approve/reject. The state machine + role rules are enforced in the
 * DB (migration 0017); this page just renders the right controls per row.
 */
export default async function UpdatesPage() {
  const identity = await getAppIdentity()
  const cycle = await getOpenCycle()

  if (!cycle) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Weekly updates</h1>
        <Card>
          <CardContent className="text-muted-foreground py-8 text-center text-sm">
            No update cycle is currently open. Cycles open automatically each week
            (Phase 4) or can be opened by an executive.
          </CardContent>
        </Card>
      </div>
    )
  }

  const [updates, writable] = await Promise.all([
    listUpdatesForCycle(cycle.id),
    listWritableWorkspaces(),
  ])

  const canApprove = identity?.role === "director" || identity?.isExecutive
  // Viewers are read-only (§4): hide draft/submit/revise/narrative affordances
  // the DB would reject. RLS stays the real boundary; this is UX hygiene.
  const canWrite = !!identity && identity.role !== "viewer"
  const existingWorkspaceIds = new Set(updates.map((u) => u.workspace_id))
  const startable = writable.filter((w) => !existingWorkspaceIds.has(w.id))

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Weekly updates</h1>
        <p className="text-muted-foreground text-sm">
          Cycle open until {new Date(cycle.closes_at).toLocaleDateString()}.
          {canApprove
            ? " Review and approve your department's submissions."
            : " Draft and submit your department's update."}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {updates.length} update{updates.length === 1 ? "" : "s"} this cycle
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {updates.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No updates started yet.
            </p>
          ) : (
            updates.map((u) => (
              <UpdateRow
                key={u.id}
                canApprove={!!canApprove}
                canEdit={canWrite}
                update={{
                  id: u.id,
                  status: u.status,
                  label:
                    u.department_workspaces?.projects?.name &&
                    u.department_workspaces?.departments?.name
                      ? `${u.department_workspaces.projects.name} · ${u.department_workspaces.departments.name}`
                      : "Update",
                  summary: u.content?.summary ?? "",
                }}
              />
            ))
          )}
        </CardContent>
      </Card>

      {canWrite && startable.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Start an update</CardTitle>
            <CardDescription>
              Begin a draft for a workspace that doesn&apos;t have one yet.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {startable.map((w) => (
              <form
                key={w.id}
                action={startDraft}
                className="flex items-center justify-between rounded-md border px-4 py-2.5"
              >
                <input type="hidden" name="cycleId" value={cycle.id} />
                <input type="hidden" name="workspaceId" value={w.id} />
                <span className="text-sm">{w.label}</span>
                <Button type="submit" size="sm" variant="outline">
                  Start draft
                </Button>
              </form>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

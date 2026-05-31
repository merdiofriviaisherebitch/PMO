import { notFound } from "next/navigation"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { RagBadge } from "@/components/governance/rag-badge"
import { BaselineForm } from "@/components/governance/baseline-form"
import { getAppIdentity } from "@/lib/auth/claims"
import {
  getLatestBaseline,
  getProject,
  listTasks,
  listWorkspacesForProject,
} from "@/lib/data/governance"
import {
  computeDelta,
  type BaselineSnapshot,
  type CurrentState,
} from "@/lib/data/delta"

/**
 * Project detail: the project, its department workspaces (RLS-scoped), the
 * baseline-lock control (executives), and a delta-vs-baseline panel computed by
 * the single delta() module (CLAUDE.md §5, §20 C4 — never recomputed elsewhere).
 */
export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const [identity, project] = await Promise.all([getAppIdentity(), getProject(id)])
  if (!project) notFound()

  const [workspaces, latestBaseline] = await Promise.all([
    listWorkspacesForProject(id),
    getLatestBaseline(id),
  ])
  // Fetch each workspace's tasks in parallel, then render synchronously —
  // an async callback inside .map() would yield Promises React can't render.
  const tasksByWorkspace = new Map(
    await Promise.all(
      workspaces.map(async (w) => [w.id, await listTasks(w.id)] as const),
    ),
  )

  // Build current state in the snapshot shape and diff against the baseline.
  const currentState: CurrentState = {
    workspaces: workspaces.map((w) => ({
      workspace_id: w.id,
      department_id: w.department_id,
      rag_status: w.rag_status,
      tasks: (tasksByWorkspace.get(w.id) ?? []).map((t) => ({
        task_id: t.id,
        title: t.title,
        rag_status: t.rag_status,
        start_date: t.start_date,
        due_date: t.due_date,
      })),
    })),
  }
  const delta = latestBaseline
    ? computeDelta(latestBaseline.snapshot as BaselineSnapshot, currentState)
    : null

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
          {project.description ? (
            <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
              {project.description}
            </p>
          ) : null}
        </div>
        <RagBadge status={project.status} />
      </div>

      <div className="space-y-4">
        <h2 className="text-lg font-medium">Department workspaces</h2>
        {workspaces.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No workspaces visible to you for this project.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {workspaces.map((w) => {
              const tasks = tasksByWorkspace.get(w.id) ?? []
              return (
                <Card key={w.id}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">
                        {w.departments?.name ?? "Department"}
                      </CardTitle>
                      <RagBadge status={w.rag_status} />
                    </div>
                    <CardDescription>
                      {tasks.length} task{tasks.length === 1 ? "" : "s"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-1.5">
                    {tasks.length === 0 ? (
                      <p className="text-muted-foreground text-sm">No tasks yet.</p>
                    ) : (
                      tasks.map((t) => (
                        <div
                          key={t.id}
                          className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                        >
                          <span>{t.title}</span>
                          <RagBadge status={t.rag_status} />
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* Baseline + delta (CLAUDE.md §5 module 5) */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Baseline</h2>
          {latestBaseline ? (
            <Badge variant="outline">
              Locked: {latestBaseline.name} ·{" "}
              {new Date(latestBaseline.locked_at).toLocaleDateString()}
            </Badge>
          ) : (
            <Badge variant="secondary">No baseline locked</Badge>
          )}
        </div>

        {delta ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Delta vs. baseline</CardTitle>
              <CardDescription>
                {delta.hasChanges
                  ? "Differences since the locked plan."
                  : "Current state matches the locked baseline."}
              </CardDescription>
            </CardHeader>
            {delta.hasChanges ? (
              <CardContent className="grid gap-4 text-sm sm:grid-cols-2">
                <DeltaStat label="Tasks added" value={delta.addedTasks.length} />
                <DeltaStat label="Tasks removed" value={delta.removedTasks.length} />
                <DeltaStat
                  label="Schedule changes"
                  value={delta.scheduleVariances.length}
                />
                <DeltaStat label="RAG changes" value={delta.ragChanges.length} />
              </CardContent>
            ) : null}
          </Card>
        ) : null}

        {identity?.isExecutive ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Lock a new baseline</CardTitle>
              <CardDescription>
                Snapshots the current plan; the snapshot is immutable once locked.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BaselineForm projectId={project.id} />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  )
}

function DeltaStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border px-4 py-3">
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-2xl font-semibold">{value}</div>
    </div>
  )
}

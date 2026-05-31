import { notFound } from "next/navigation"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { RagBadge } from "@/components/governance/rag-badge"
import {
  getProject,
  listTasks,
  listWorkspacesForProject,
} from "@/lib/data/governance"

/**
 * Project detail: the project plus the department workspaces visible to the
 * caller. A member sees only their own department's workspace here (RLS); an
 * executive sees every participating department. If the project isn't visible
 * at all, getProject returns null → 404 (no information leak).
 */
export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const project = await getProject(id)
  if (!project) notFound()

  const workspaces = await listWorkspacesForProject(id)
  // Fetch each workspace's tasks in parallel, then render synchronously —
  // an async callback inside .map() would yield Promises React can't render.
  const tasksByWorkspace = new Map(
    await Promise.all(
      workspaces.map(
        async (w) => [w.id, await listTasks(w.id)] as const,
      ),
    ),
  )

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {project.name}
          </h1>
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
                      <p className="text-muted-foreground text-sm">
                        No tasks yet.
                      </p>
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
    </div>
  )
}

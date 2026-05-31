import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { DependencyMap } from "@/components/dependencies/dependency-map"
import { DependencyForm } from "@/components/dependencies/dependency-form"
import { deleteDependency } from "@/lib/actions/dependencies"
import {
  listDependencyGraph,
  listTasksForDependencyForm,
} from "@/lib/data/dependencies"
import { getAppIdentity } from "@/lib/auth/claims"

/**
 * Dependency map page (CLAUDE.md §5 module 7, §7). Server Component: both reads
 * run in parallel (no waterfall) and are RLS-scoped — a member sees only edges
 * touching their department; the foreign endpoint of a cross-department edge is a
 * department-labelled boundary, never a task. The interactive map is a client
 * island fed this already-filtered data.
 */
export default async function DependenciesPage() {
  const [graph, tasks, identity] = await Promise.all([
    listDependencyGraph(),
    listTasksForDependencyForm(),
    getAppIdentity(),
  ])

  const knownTitle = new Map(graph.nodes.map((n) => [n.id, n.title]))
  const endpointLabel = (id: string, deptId: string | null) =>
    knownTitle.get(id) ??
    `${(deptId && graph.departments[deptId]) || "Another department"} · hidden`

  // Only show "Remove" on edges the caller could actually delete (mirrors the RLS
  // delete policy: exec, or BOTH endpoints in their department). A non-exec can SEE
  // a cross-department edge (symmetric SELECT) but not delete it — without this the
  // button would silently no-op, so we hide it ("UI only shows actionable ids").
  const myDept = identity?.departmentId ?? null
  const isExec = identity?.isExecutive ?? false
  const canDelete = (e: { sourceDeptId: string | null; targetDeptId: string | null }) =>
    isExec || (!!myDept && e.sourceDeptId === myDept && e.targetDeptId === myDept)

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dependencies</h1>
        <p className="text-muted-foreground text-sm">
          Cross-department task dependencies. A red, animated edge is an active
          block — its source task is off-track, which the escalation engine chases.
        </p>
      </div>

      <DependencyMap graph={graph} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Links</CardTitle>
            <CardDescription>
              {graph.edges.length === 0
                ? "No dependencies yet"
                : `${graph.edges.length} visible`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {graph.edges.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nothing to show.</p>
            ) : (
              graph.edges.map((e) => (
                <div
                  key={e.id}
                  className="flex items-center justify-between gap-3 rounded-md border px-4 py-2.5"
                >
                  <div className="min-w-0 text-sm">
                    <span className="font-medium">{endpointLabel(e.source, e.sourceDeptId)}</span>
                    <span className="text-muted-foreground mx-2 lowercase">{e.relationType}</span>
                    <span className="font-medium">{endpointLabel(e.target, e.targetDeptId)}</span>
                  </div>
                  {canDelete(e) ? (
                    <form action={deleteDependency}>
                      <input type="hidden" name="id" value={e.id} />
                      <Button type="submit" variant="ghost" size="sm">
                        Remove
                      </Button>
                    </form>
                  ) : null}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Add a dependency</CardTitle>
            <CardDescription>Link two tasks with a typed relation</CardDescription>
          </CardHeader>
          <CardContent>
            <DependencyForm tasks={tasks} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

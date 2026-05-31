import Link from "next/link"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { RagBadge } from "@/components/governance/rag-badge"
import { getAppIdentity } from "@/lib/auth/claims"
import { listProjects, listTasks } from "@/lib/data/governance"

/**
 * Executive / department dashboard. The SAME page serves both — RLS decides
 * whether the counts span all departments (executive) or one (member). The
 * numbers here are literally "what this user is allowed to see" (CLAUDE.md §13).
 */
export default async function DashboardPage() {
  const identity = await getAppIdentity()
  const [projects, tasks] = await Promise.all([listProjects(), listTasks()])

  const byRag = (rows: { rag_status?: string; status?: string }[], key: "rag_status" | "status") => ({
    red: rows.filter((r) => r[key] === "red").length,
    amber: rows.filter((r) => r[key] === "amber").length,
    green: rows.filter((r) => r[key] === "green").length,
  })
  const projectHealth = byRag(projects, "status")
  const taskHealth = byRag(tasks, "rag_status")

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground text-sm">
          {identity?.isExecutive
            ? "Live view across every department."
            : "Your department's governance view."}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Projects visible</CardDescription>
            <CardTitle className="text-3xl">{projects.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Tasks visible</CardDescription>
            <CardTitle className="text-3xl">{tasks.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Projects off-track</CardDescription>
            <CardTitle className="text-3xl text-red-600">
              {projectHealth.red}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Tasks off-track</CardDescription>
            <CardTitle className="text-3xl text-red-600">
              {taskHealth.red}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent projects</CardTitle>
          <CardDescription>
            Newest first · {projects.length} visible to you
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {projects.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No projects yet.{" "}
              {identity?.isExecutive ? (
                <Link href="/projects" className="underline">
                  Create one
                </Link>
              ) : (
                "An executive will set these up."
              )}
            </p>
          ) : (
            projects.slice(0, 6).map((p) => (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                className="hover:bg-muted/50 flex items-center justify-between rounded-md border px-4 py-2.5"
              >
                <span className="font-medium">{p.name}</span>
                <RagBadge status={p.status} />
              </Link>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

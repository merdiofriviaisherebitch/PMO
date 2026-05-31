import Link from "next/link"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { RagBadge } from "@/components/governance/rag-badge"
import { ProjectForm } from "@/components/governance/project-form"
import { getAppIdentity } from "@/lib/auth/claims"
import { listProjects } from "@/lib/data/governance"

export default async function ProjectsPage() {
  const identity = await getAppIdentity()
  const projects = await listProjects()

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="text-muted-foreground text-sm">
          {identity?.isExecutive
            ? "All projects across every department."
            : "Projects your department participates in."}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {projects.length} project{projects.length === 1 ? "" : "s"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {projects.length === 0 ? (
            <p className="text-muted-foreground text-sm">No projects visible.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">
                      <Link href={`/projects/${p.id}`} className="hover:underline">
                        {p.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <RagBadge status={p.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right">
                      {new Date(p.created_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {identity?.isExecutive ? (
        <Card>
          <CardHeader>
            <CardTitle>New project</CardTitle>
            <CardDescription>
              Executives create projects; departments are added as workspaces.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ProjectForm />
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

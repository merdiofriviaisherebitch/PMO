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
import { Button } from "@/components/ui/button"
import { RagBadge } from "@/components/governance/rag-badge"
import { TaskForm } from "@/components/governance/task-form"
import { deleteTask } from "@/lib/actions/tasks"
import { listTasks, listWritableWorkspaces } from "@/lib/data/governance"

export default async function TasksPage() {
  const [tasks, workspaces] = await Promise.all([
    listTasks(),
    listWritableWorkspaces(),
  ])

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <p className="text-muted-foreground text-sm">
          Tasks in workspaces you can see. Edits and deletes are scoped to your
          department by the database.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {tasks.length} task{tasks.length === 1 ? "" : "s"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {tasks.length === 0 ? (
            <p className="text-muted-foreground text-sm">No tasks visible.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.title}</TableCell>
                    <TableCell>
                      <RagBadge status={t.rag_status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {t.due_date
                        ? new Date(t.due_date).toLocaleDateString()
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {/* delete is RLS-scoped: a no-op for rows you can't write */}
                      <form action={deleteTask} className="inline">
                        <input type="hidden" name="id" value={t.id} />
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
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>New task</CardTitle>
          <CardDescription>
            Add a task to one of your department&apos;s workspaces.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TaskForm workspaces={workspaces} />
        </CardContent>
      </Card>
    </div>
  )
}

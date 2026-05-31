import Link from "next/link"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { RagDonut } from "@/components/charts/rag-donut"
import { BudgetBars } from "@/components/charts/budget-bars"
import { RealtimeRefresh } from "@/components/dashboard/realtime-refresh"
import { getAppIdentity } from "@/lib/auth/claims"
import {
  getBudgetSummary,
  getCycleStatus,
  getRagRollup,
} from "@/lib/data/dashboard"
import { listProjects } from "@/lib/data/governance"

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n)

/**
 * Executive / department dashboard (CLAUDE.md §5 module 10). One page for both
 * roles — RLS decides whether the aggregations span all departments or one. All
 * independent reads run in parallel (Promise.all, no waterfall) per the Vercel
 * guidance; charts are client islands fed plain server data; a Realtime island
 * refreshes the Server Components when the department channel broadcasts.
 */
export default async function DashboardPage() {
  const identity = await getAppIdentity()

  // Parallel, independent aggregations — no request waterfall.
  const [rag, budget, cycle, projects] = await Promise.all([
    getRagRollup(),
    getBudgetSummary(),
    getCycleStatus(),
    listProjects(),
  ])

  const projectName = new Map(projects.map((p) => [p.id, p.name]))
  const budgetBars = budget.lines
    .slice(0, 8)
    .map((l) => ({
      label: projectName.get(l.workspace_id)?.slice(0, 18) ?? "Workspace",
      pctUsed: l.pct_used,
      rag: l.rag,
    }))

  return (
    <div className="space-y-8">
      <RealtimeRefresh departmentId={identity?.departmentId ?? null} />

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground text-sm">
          {identity?.isExecutive
            ? "Live view across every department."
            : "Your department's governance view."}
        </p>
      </div>

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Projects" value={rag.projects.total} sub={`${rag.projects.red} off-track`} subTone={rag.projects.red > 0 ? "red" : "muted"} />
        <Kpi label="Tasks" value={rag.tasks.total} sub={`${rag.tasks.red} off-track`} subTone={rag.tasks.red > 0 ? "red" : "muted"} />
        <Kpi label="Budget" value={fmt(budget.totalBudget)} sub={`${fmt(budget.remaining)} remaining`} subTone={budget.remaining < 0 ? "red" : "muted"} />
        <Kpi
          label="This cycle"
          value={cycle.total === 0 ? "—" : `${cycle.submitted}/${cycle.total}`}
          sub={cycle.total === 0 ? "no open cycle" : `${cycle.outstanding} outstanding`}
          subTone={cycle.outstanding > 0 ? "amber" : "muted"}
        />
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Project health</CardTitle>
            <CardDescription>RAG roll-up</CardDescription>
          </CardHeader>
          <CardContent>
            <RagDonut green={rag.projects.green} amber={rag.projects.amber} red={rag.projects.red} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Task health</CardTitle>
            <CardDescription>RAG roll-up</CardDescription>
          </CardHeader>
          <CardContent>
            <RagDonut green={rag.tasks.green} amber={rag.tasks.amber} red={rag.tasks.red} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Budget usage</CardTitle>
            <CardDescription>
              {budget.red} over · {budget.amber} at risk
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BudgetBars data={budgetBars} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent projects</CardTitle>
          <CardDescription>Newest first · {projects.length} visible</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {projects.length === 0 ? (
            <p className="text-muted-foreground text-sm">No projects visible.</p>
          ) : (
            projects.slice(0, 6).map((p) => (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                className="hover:bg-muted/50 flex items-center justify-between rounded-md border px-4 py-2.5"
              >
                <span className="font-medium">{p.name}</span>
                <span className="text-muted-foreground text-sm capitalize">{p.status}</span>
              </Link>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Kpi({
  label,
  value,
  sub,
  subTone,
}: {
  label: string
  value: string | number
  sub: string
  subTone: "red" | "amber" | "muted"
}) {
  const toneClass =
    subTone === "red" ? "text-red-600" : subTone === "amber" ? "text-amber-600" : "text-muted-foreground"
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl">{value}</CardTitle>
        <p className={`text-xs ${toneClass}`}>{sub}</p>
      </CardHeader>
    </Card>
  )
}

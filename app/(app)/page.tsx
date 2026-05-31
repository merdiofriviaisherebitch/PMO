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
import { getOpenEscalations, type EscalationKind } from "@/lib/data/escalations"
import { listProjects } from "@/lib/data/governance"

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n)

// The governance timeline is anchored to Europe/Budapest (§18 Q2); build the
// formatter once at module scope rather than per escalation row.
const escalationDateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Budapest",
})

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
  const [rag, budget, cycle, projects, escalations] = await Promise.all([
    getRagRollup(),
    getBudgetSummary(),
    getCycleStatus(),
    listProjects(),
    getOpenEscalations(),
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

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Accountability: who's overdue and how far up the ladder it has gone. */}
        <Card>
          <CardHeader>
            <CardTitle>Open escalations</CardTitle>
            <CardDescription>
              {escalations.total === 0 ? "None — all clear" : `${escalations.total} unresolved`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {escalations.items.length === 0 ? (
              <p className="text-muted-foreground text-sm">No open escalations.</p>
            ) : (
              escalations.items.map((e) => (
                <div
                  key={e.id}
                  className="flex items-center justify-between rounded-md border px-4 py-2.5"
                >
                  <div className="flex items-center gap-3">
                    <LevelChip level={e.level} />
                    <span className="text-sm font-medium">{kindLabel(e.kind)}</span>
                    {e.departmentName && (
                      <span className="text-muted-foreground text-sm">· {e.departmentName}</span>
                    )}
                  </div>
                  <span className="text-muted-foreground text-xs">{fmtDate(e.triggeredAt)}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

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
    </div>
  )
}

/** Ladder rung → who it has reached, coloured by severity. */
function LevelChip({ level }: { level: number }) {
  const map: Record<number, { label: string; cls: string }> = {
    1: { label: "L1 · Member", cls: "bg-amber-100 text-amber-800" },
    2: { label: "L2 · Director", cls: "bg-orange-100 text-orange-800" },
    3: { label: "L3 · Executive", cls: "bg-red-100 text-red-800" },
  }
  const m = map[level] ?? { label: `L${level}`, cls: "bg-muted text-muted-foreground" }
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${m.cls}`}>{m.label}</span>
  )
}

function kindLabel(kind: EscalationKind): string {
  if (kind === "late_update") return "Late update"
  if (kind === "red_item") return "Lingering red item"
  return "Escalation"
}

function fmtDate(iso: string): string {
  return escalationDateFmt.format(new Date(iso))
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

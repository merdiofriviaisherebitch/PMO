import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { GenerateReportButton } from "@/components/reports/generate-report-button"
import { listReports } from "@/lib/data/reports"
import { listDepartments } from "@/lib/data/governance"
import { getAppIdentity } from "@/lib/auth/claims"

/**
 * Reports list page (CLAUDE.md §5 module 11, §10).
 *
 * Server Component: all reads run in parallel (no waterfall).
 * RLS scopes listReports() automatically — a member/viewer sees their
 * department's rows only; an executive sees all.
 *
 * Download links point to /api/reports/[id]/download?format=pdf|xlsx, which
 * performs the server-side scope check + signs the URL (§10 Storage).
 *
 * The "Generate" client island is shown only to directors and executives
 * (affordance-gating). The action + RLS are the real enforcement.
 */
export default async function ReportsPage() {
  const [reports, departments, identity] = await Promise.all([
    listReports(),
    listDepartments(),
    getAppIdentity(),
  ])

  const deptName = new Map(departments.map((d) => [d.id, d.name]))

  const canGenerate =
    identity?.role === "director" || identity?.role === "executive"

  const dtFmt = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Budapest",
  })

  const dateFmt = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Europe/Budapest",
  })

  function scopeLabel(departmentId: string | null): string {
    if (departmentId === null) return "All Departments (Executive)"
    return deptName.get(departmentId) ?? "Department report"
  }

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="text-muted-foreground text-sm">
            {identity?.isExecutive
              ? "Weekly and monthly governance reports across all departments."
              : "Your department's governance reports."}
          </p>
        </div>
        {canGenerate ? (
          <div className="shrink-0">
            <GenerateReportButton />
          </div>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Generated reports</CardTitle>
          <CardDescription>
            {reports.length === 0
              ? "No reports yet"
              : `${reports.length} report${reports.length === 1 ? "" : "s"} · newest first`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {reports.length === 0 ? (
            <p className="text-muted-foreground text-sm py-4 text-center">
              No reports have been generated yet.
              {canGenerate
                ? " Use the buttons above to generate a report for this period."
                : " A director or executive can generate reports."}
            </p>
          ) : (
            <div className="space-y-2">
              {reports.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between gap-4 rounded-md border px-4 py-3"
                >
                  <div className="min-w-0 grid gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium capitalize">{r.period}</span>
                      <span className="text-muted-foreground text-xs">·</span>
                      <span className="text-muted-foreground text-sm">{scopeLabel(r.departmentId)}</span>
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {dateFmt.format(new Date(r.periodStart))} → {dateFmt.format(new Date(r.periodEnd))}
                      <span className="mx-2">·</span>
                      Generated {dtFmt.format(new Date(r.generatedAt))}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button variant="outline" size="sm" asChild>
                      <a href={`/api/reports/${r.id}/download?format=pdf`}>
                        PDF
                      </a>
                    </Button>
                    <Button variant="outline" size="sm" asChild>
                      <a href={`/api/reports/${r.id}/download?format=xlsx`}>
                        Excel
                      </a>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

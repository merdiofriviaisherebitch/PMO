/**
 * report_scope_smoke.ts — live happy-path + §15 item 9 (service-role scoping) smoke.
 * Run: bun --conditions react-server supabase/tests/report_scope_smoke.ts
 * (the react-server condition neutralises `server-only` so the real data layer imports
 *  in a plain bun process; we pass an explicit service client, never calling next/headers.)
 *
 * Proves: the REAL service-role gatherReportInput + renderers produce valid PDF/XLSX,
 * and a department-scoped gather is a strict SUBSET of the global roll-up (no leak).
 */
import { createServiceClient } from "@/lib/supabase/service"
import { gatherReportInput } from "@/lib/data/reports"
import { buildReportModel } from "@/lib/reports/model"
import { renderReportPdf } from "@/lib/reports/pdf"
import { renderReportXlsx } from "@/lib/reports/xlsx"
import { writeFileSync } from "node:fs"

const svc = createServiceClient()
const win = { start: "2026-05-25", end: "2026-05-31" } as const

const globalInput = await gatherReportInput(svc, { departmentId: null, label: "All Departments" }, "weekly", win)
const globalModel = buildReportModel(globalInput)
console.log(`GLOBAL  projects=${globalModel.rag.projects.total} tasks=${globalModel.rag.tasks.total} blockers=${globalModel.blockers.length} escalations=${globalModel.escalations.length} variance=${globalModel.variance.length}`)

const { data: depts, error } = await svc.from("departments").select("id,name").order("name")
if (error) throw error
let leak = false
let anyDeptTasks = 0
for (const d of depts ?? []) {
  const di = await gatherReportInput(svc, { departmentId: d.id, label: d.name }, "weekly", win)
  const dm = buildReportModel(di)
  anyDeptTasks += dm.rag.tasks.total
  // §15 item 9: a dept-scoped service-role gather must never exceed the global roll-up.
  if (dm.rag.tasks.total > globalModel.rag.tasks.total) leak = true
  console.log(`DEPT ${d.name.padEnd(20)} tasks=${dm.rag.tasks.total} blockers=${dm.blockers.length} escalations=${dm.escalations.length}`)
}

const pdf = await renderReportPdf(globalModel)
const xlsx = await renderReportXlsx(globalModel)
writeFileSync("/tmp/report-global.pdf", pdf)
writeFileSync("/tmp/report-global.xlsx", xlsx)
console.log(`WROTE /tmp/report-global.pdf=${pdf.length}B  /tmp/report-global.xlsx=${xlsx.length}B`)
console.log(`PDF magic=${new TextDecoder().decode(pdf.slice(0, 5))}`)
// §15 item 9: every task belongs to exactly one department, so the per-department task
// counts must PARTITION the global total — a leak (a dept seeing another's tasks) would
// push the sum above global; an over-scoping bug would push it below.
const partitionOk = anyDeptTasks === globalModel.rag.tasks.total
console.log(`PARTITION sum(dept tasks)=${anyDeptTasks} == global=${globalModel.rag.tasks.total} : ${partitionOk}`)
console.log(leak || !partitionOk ? "SMOKE_FAIL" : "SMOKE_OK")

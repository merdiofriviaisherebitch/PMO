/**
 * app/api/reports/generate/route.ts — pg_cron / scheduled cron entrypoint.
 *
 * Called by the pg_cron jobs defined in 0030_report_cron.sql via pg_net:
 *   POST /api/reports/generate
 *   Authorization: Bearer <REPORTS_FUNCTION_SECRET>
 *   { "period": "weekly" | "monthly" }
 *
 * AUTH: constant-time shared-secret compare (same technique as escalation-sender,
 * CLAUDE.md §6 non-negotiable #3). The secret is read from the server-side env
 * var REPORTS_FUNCTION_SECRET — never NEXT_PUBLIC_, never from the request body.
 *
 * SERVICE-ROLE SCOPING (§10, §17): gatherReportInput() already applies an
 * explicit department filter for every per-department scope. The service client
 * bypasses RLS; the filter in code is what enforces isolation. The global roll-up
 * intentionally fetches all rows (departmentId: null = executive view).
 *
 * Error handling: each scope (global + each department) is wrapped in try/catch
 * so a single failure does not abort the rest. All errors are collected and
 * returned in the summary — no silent total failure.
 */

import { createHash, timingSafeEqual } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { gatherReportInput } from "@/lib/data/reports"
import { generateReport } from "@/lib/reports/generate"
import { createServiceReportStore, reportWindow } from "@/lib/reports/store"

// Constant-time secret compare (§6). Hash BOTH sides to a fixed 32-byte digest first so
// the comparison neither early-returns on a length mismatch nor leaks the secret's length
// (Phase 7 security review), then timingSafeEqual on the equal-length buffers.
function secretMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest()
  const b = createHash("sha256").update(expected).digest()
  return timingSafeEqual(a, b)
}

export async function POST(req: Request): Promise<Response> {
  // ── AUTH ──────────────────────────────────────────────────────────────────────
  const secret = process.env.REPORTS_FUNCTION_SECRET
  if (!secret) {
    console.error("reports/generate: REPORTS_FUNCTION_SECRET env var not set")
    return Response.json({ error: "server misconfiguration" }, { status: 500 })
  }

  const auth = req.headers.get("Authorization") ?? ""
  if (!secretMatches(auth, `Bearer ${secret}`)) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  // ── Body validation ────────────────────────────────────────────────────────────
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 })
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !("period" in body) ||
    (body.period !== "weekly" && body.period !== "monthly")
  ) {
    return Response.json(
      { error: "body must be { period: 'weekly' | 'monthly' }" },
      { status: 400 },
    )
  }
  const period = (body as { period: "weekly" | "monthly" }).period

  // ── Shared setup ───────────────────────────────────────────────────────────────
  const service = createServiceClient()
  const window = reportWindow(period, new Date())
  const store = createServiceReportStore()
  const errors: Array<{ scope: string; error: string }> = []
  let generated = 0

  // ── Global roll-up ─────────────────────────────────────────────────────────────
  // §10: departmentId null = executive view; gatherReportInput fetches all rows.
  // generatedBy null = system-generated (no user actor for a cron job).
  try {
    const input = await gatherReportInput(
      service,
      { departmentId: null, label: "All Departments" },
      period,
      window,
    )
    await generateReport({ input, store, generatedBy: null })
    generated++
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`reports/generate: global roll-up failed: ${msg}`)
    errors.push({ scope: "global", error: msg })
  }

  // ── Per-department ─────────────────────────────────────────────────────────────
  // §10 service-role path: gatherReportInput applies .eq("department_id", deptId)
  // on every section — that explicit filter is the isolation mechanism here since
  // RLS is bypassed by the service role.
  const { data: departments, error: deptErr } = await service
    .from("departments")
    .select("id, name")

  if (deptErr) {
    console.error(`reports/generate: failed to list departments: ${deptErr.message}`)
    errors.push({ scope: "departments-list", error: deptErr.message })
  } else {
    for (const dept of departments ?? []) {
      try {
        const input = await gatherReportInput(
          service,
          { departmentId: dept.id, label: dept.name },
          period,
          window,
        )
        await generateReport({ input, store, generatedBy: null })
        generated++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`reports/generate: dept ${dept.id} (${dept.name}) failed: ${msg}`)
        errors.push({ scope: dept.name, error: msg })
      }
    }
  }

  return Response.json({
    generated,
    errors: errors.length > 0 ? errors : undefined,
  })
}

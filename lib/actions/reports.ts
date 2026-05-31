"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { createClient } from "@/lib/supabase/server"
import { getAppIdentity } from "@/lib/auth/claims"
import { type ActionResult } from "@/lib/actions/shared"
import { gatherReportInput } from "@/lib/data/reports"
import { generateReport } from "@/lib/reports/generate"
import { createServiceReportStore, reportWindow } from "@/lib/reports/store"

/**
 * lib/actions/reports.ts — On-demand report generation Server Action.
 *
 * SECURITY (§10, §17):
 *   - Identity is read from the verified JWT (getAppIdentity), never from
 *     a client-supplied value.
 *   - Only directors and executives may generate reports.
 *   - The gather step uses the RLS client (user session) so department scoping
 *     is doubly enforced: the explicit scope filter AND the user's RLS policies.
 *   - Upload + insertMeta use the service-role store (app role has no storage
 *     write policy and no reports INSERT grant). The path is derived from the
 *     verified scope, not from user input.
 */

const periodSchema = z.enum(["weekly", "monthly"])

/** On-demand report generation. Director → their department. Executive → global. */
export async function generateMyReport(
  period: "weekly" | "monthly",
): Promise<ActionResult> {
  const parsed = periodSchema.safeParse(period)
  if (!parsed.success) {
    return { ok: false, errors: { _form: "Invalid period — must be 'weekly' or 'monthly'." } }
  }

  const identity = await getAppIdentity()
  if (!identity) {
    return { ok: false, errors: { _form: "Unauthorized." } }
  }

  // AUTHZ: only directors and executives may generate reports.
  if (identity.role !== "director" && identity.role !== "executive") {
    return {
      ok: false,
      errors: { _form: "Only directors and executives can generate reports." },
    }
  }

  // Scope: executive → global roll-up; director → their own department.
  let scope: { departmentId: string | null; label: string }

  if (identity.isExecutive) {
    scope = { departmentId: null, label: "All Departments" }
  } else {
    // Director — must have a departmentId in their claims (§4).
    if (!identity.departmentId) {
      return { ok: false, errors: { _form: "Your account has no department assigned." } }
    }
    // Fetch the department name via the RLS client; RLS allows own-department SELECT.
    const supabase = await createClient()
    const { data: dept, error: deptErr } = await supabase
      .from("departments")
      .select("name")
      .eq("id", identity.departmentId)
      .maybeSingle()
    if (deptErr || !dept) {
      return { ok: false, errors: { _form: "Could not resolve your department — please try again." } }
    }
    scope = { departmentId: identity.departmentId, label: dept.name }
  }

  const window = reportWindow(parsed.data, new Date())

  // Gather: RLS client — user session applies both explicit scope filter AND row-level isolation.
  const supabase = await createClient()
  let input
  try {
    input = await gatherReportInput(supabase, scope, parsed.data, window)
  } catch (err) {
    return {
      ok: false,
      errors: { _form: `Failed to gather report data: ${err instanceof Error ? err.message : String(err)}` },
    }
  }

  // Generate + store: service-role store (app role has no storage/reports write grant).
  try {
    await generateReport({
      input,
      store: createServiceReportStore(),
      generatedBy: identity.userId,
    })
  } catch (err) {
    return {
      ok: false,
      errors: { _form: `Failed to generate report: ${err instanceof Error ? err.message : String(err)}` },
    }
  }

  revalidatePath("/reports")
  return { ok: true }
}

import "server-only"

/**
 * lib/reports/store.ts — Service-role ReportStore adapter.
 *
 * SECURITY (§10, §17): createServiceReportStore() uses the service-role client
 * which BYPASSES RLS. The storage path encodes scope (per generateReport's
 * `scopeSegment` — "global" or a department UUID). insertMeta deletes any
 * existing row for the same scope+window before inserting, making re-runs safe
 * (the 0029 unique index would otherwise reject the second INSERT).
 *
 * reportWindow is a pure helper — it lives in window.ts (no server-only) so
 * tests can import it directly without triggering the server-only guard.
 * It is re-exported here so callers only need one import.
 *
 * Never expose createServiceReportStore to the browser; service.ts is
 * server-only and must never carry a NEXT_PUBLIC_ prefix.
 */

import { createServiceClient } from "@/lib/supabase/service"
import type { ReportStore, ReportMeta } from "@/lib/reports/generate"

// Re-export the pure window helper so callers (actions, route handler) import
// from one place, while tests import from window.ts directly.
export { reportWindow } from "@/lib/reports/window"

// ─── ReportStore adapter ───────────────────────────────────────────────────────

/**
 * Returns a ReportStore backed by the service-role Supabase client.
 *
 * upload()     — stores bytes in the non-public "reports" bucket (upsert so a
 *                re-run can overwrite the previous file for the same window).
 * insertMeta() — idempotent: deletes any existing reports row for the same
 *                scope+window before inserting the new one, so the 0029 unique
 *                index (period, period_start, department_id, project_id) is
 *                never violated on re-runs. Uses `.is()` for null columns so
 *                PostgREST generates `IS NULL` rather than `= NULL`.
 */
export function createServiceReportStore(): ReportStore {
  const client = createServiceClient()

  return {
    async upload(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
      const { error } = await client.storage
        .from("reports")
        .upload(path, bytes, { contentType, upsert: true })
      if (error) throw new Error(`ReportStore.upload(${path}): ${error.message}`)
    },

    async insertMeta(meta: ReportMeta): Promise<void> {
      // Delete any existing row for this scope+window so the unique index never
      // rejects a re-run. The match must handle nullable department_id and
      // project_id correctly via IS NULL / = <value>.
      let deleteQuery = client
        .from("reports")
        .delete()
        .eq("period", meta.period)
        .eq("period_start", meta.periodStart)

      if (meta.departmentId === null) {
        deleteQuery = deleteQuery.is("department_id", null)
      } else {
        deleteQuery = deleteQuery.eq("department_id", meta.departmentId)
      }

      if (meta.projectId === null) {
        deleteQuery = deleteQuery.is("project_id", null)
      } else {
        deleteQuery = deleteQuery.eq("project_id", meta.projectId)
      }

      const { error: delErr } = await deleteQuery
      if (delErr) throw new Error(`ReportStore.insertMeta delete: ${delErr.message}`)

      const { error: insErr } = await client.from("reports").insert({
        period: meta.period,
        department_id: meta.departmentId,
        project_id: meta.projectId,
        period_start: meta.periodStart,
        period_end: meta.periodEnd,
        pdf_path: meta.pdfPath,
        xlsx_path: meta.xlsxPath,
        generated_by: meta.generatedBy,
      })
      if (insErr) throw new Error(`ReportStore.insertMeta insert: ${insErr.message}`)
    },
  }
}

// The escalation-sender's delivery logic, kept free of Deno.serve and the
// Supabase client so it is unit-testable through its public interface with an
// in-memory Notifier and stubbed data access (CLAUDE.md §20 C2/C3, tdd skill).

import type { Notifier } from "./notifier.ts"

export type OutboxRow = {
  id: string
  recipient_email: string | null
  subject: string
  body: string
}

export type ProcessDeps = {
  /** Load the claimed rows (service-role read, joined to the recipient email). */
  fetchRows: (ids: string[]) => Promise<OutboxRow[]>
  notifier: Notifier
  /** Demote a row back to `failed` with backoff (the SQL outbox_mark_failed). */
  markFailed: (id: string, error: string) => Promise<void>
}

export type ProcessResult = { processed: number; sent: number; failed: number }

/**
 * Deliver a claimed batch of outbox rows.
 *
 * The rows were already marked `sent` optimistically by outbox_send_batch
 * (CLAUDE.md §6 "mark items sent before delivery to prevent retries from
 * double-sending"), so this function's only job is to DEMOTE failures back to
 * `failed` (markFailed applies the backoff). Every non-delivery path — a Resend
 * error OR a missing recipient — records a reason; nothing is ever swallowed
 * (§6 "no silent failures").
 */
export async function processOutbox(
  ids: string[],
  deps: ProcessDeps,
): Promise<ProcessResult> {
  const rows = await deps.fetchRows(ids)
  let sent = 0
  let failed = 0

  for (const row of rows) {
    if (!row.recipient_email) {
      await deps.markFailed(row.id, "no recipient email on record")
      failed++
      continue
    }
    const result = await deps.notifier.send({
      to: row.recipient_email,
      subject: row.subject,
      body: row.body,
    })
    if (result.ok) {
      sent++
    } else {
      await deps.markFailed(row.id, result.error)
      failed++
    }
  }

  return { processed: rows.length, sent, failed }
}

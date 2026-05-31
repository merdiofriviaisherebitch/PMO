// Deno tests for the escalation-sender delivery logic (CLAUDE.md §15).
// Drives processOutbox through its public interface with the InMemoryNotifier —
// no Resend, no network, no Supabase client. Run with:  deno test
// (Deno is the Edge Functions runtime; these run in CI / wherever Deno is present.)

import { assertEquals } from "jsr:@std/assert@1"
import { processOutbox, type OutboxRow } from "./process.ts"
import { InMemoryNotifier } from "./notifier.ts"

Deno.test("processOutbox delivers each row and counts sends", async () => {
  const notifier = new InMemoryNotifier()
  const failed: Array<{ id: string; error: string }> = []
  const rows: OutboxRow[] = [
    { id: "1", recipient_email: "a@x.test", subject: "S1", body: "B1" },
    { id: "2", recipient_email: "b@x.test", subject: "S2", body: "B2" },
  ]

  const result = await processOutbox(["1", "2"], {
    fetchRows: () => Promise.resolve(rows),
    notifier,
    markFailed: (id, error) => {
      failed.push({ id, error })
      return Promise.resolve()
    },
  })

  assertEquals(result, { processed: 2, sent: 2, failed: 0 })
  assertEquals(notifier.sent.length, 2)
  assertEquals(notifier.sent[0].to, "a@x.test")
  assertEquals(failed.length, 0)
})

Deno.test("a Resend failure is demoted via markFailed, never swallowed", async () => {
  const notifier = new InMemoryNotifier()
  notifier.failWhen = (m) => m.to === "b@x.test"
  const failed: Array<{ id: string; error: string }> = []
  const rows: OutboxRow[] = [
    { id: "1", recipient_email: "a@x.test", subject: "S1", body: "B1" },
    { id: "2", recipient_email: "b@x.test", subject: "S2", body: "B2" },
  ]

  const result = await processOutbox(["1", "2"], {
    fetchRows: () => Promise.resolve(rows),
    notifier,
    markFailed: (id, error) => {
      failed.push({ id, error })
      return Promise.resolve()
    },
  })

  assertEquals(result, { processed: 2, sent: 1, failed: 1 })
  assertEquals(notifier.sent.length, 1)
  assertEquals(failed.length, 1)
  assertEquals(failed[0].id, "2")
})

Deno.test("a missing recipient email is recorded as failed, not skipped silently", async () => {
  const notifier = new InMemoryNotifier()
  const failed: Array<{ id: string; error: string }> = []
  const rows: OutboxRow[] = [{ id: "1", recipient_email: null, subject: "S", body: "B" }]

  const result = await processOutbox(["1"], {
    fetchRows: () => Promise.resolve(rows),
    notifier,
    markFailed: (id, error) => {
      failed.push({ id, error })
      return Promise.resolve()
    },
  })

  assertEquals(result, { processed: 1, sent: 0, failed: 1 })
  assertEquals(notifier.sent.length, 0)
  assertEquals(failed[0].error, "no recipient email on record")
})

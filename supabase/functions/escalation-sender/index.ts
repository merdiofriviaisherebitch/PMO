// escalation-sender Edge Function (CLAUDE.md §8, §11, §12).
//
// Invoked by pg_net from outbox_send_batch with { outbox_ids: [...] }. Delivers
// each already-claimed outbox row via the Notifier port (Resend) and demotes any
// failure back to `failed` with backoff via the outbox_mark_failed RPC.
//
// AUTH: a shared secret, NOT a Supabase user JWT. outbox_send_batch sends
// `Authorization: Bearer <ESCALATION_FUNCTION_SECRET>`; we reject anything else.
// config.toml sets verify_jwt = false so Supabase does not pre-reject our
// non-JWT bearer.
//
// SECRETS (set via `supabase secrets set`, never committed, never NEXT_PUBLIC_):
//   ESCALATION_FUNCTION_SECRET  shared secret matching the Vault value pg_net sends
//   RESEND_API_KEY              Resend API key
//   ESCALATION_FROM_EMAIL       verified From address
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by the runtime.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { ResendNotifier } from "./notifier.ts"
import { processOutbox, type OutboxRow } from "./process.ts"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

// Constant-time comparison so the shared-secret check on this public endpoint
// (verify_jwt=false) cannot be probed byte-by-byte with a timing oracle.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

Deno.serve(async (req: Request) => {
  // ── auth: constant-time compare against the shared secret ───────────────────
  const secret = Deno.env.get("ESCALATION_FUNCTION_SECRET")
  const auth = req.headers.get("Authorization") ?? ""
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return json({ error: "unauthorized" }, 401)
  }

  let payload: { outbox_ids?: unknown }
  try {
    payload = await req.json()
  } catch {
    return json({ error: "invalid json" }, 400)
  }
  const ids = Array.isArray(payload.outbox_ids)
    ? payload.outbox_ids.filter((x): x is string => typeof x === "string")
    : []
  if (ids.length === 0) {
    return json({ processed: 0, sent: 0, failed: 0 })
  }

  // Service role: bypasses RLS. It only ever touches the specific outbox ids it
  // was handed (it does not widen scope), per the §10 service-role discipline.
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  )

  const notifier = new ResendNotifier(
    Deno.env.get("RESEND_API_KEY") ?? "",
    Deno.env.get("ESCALATION_FROM_EMAIL") ?? "PMO Control Tower <noreply@example.com>",
  )

  const result = await processOutbox(ids, {
    async fetchRows(rowIds) {
      // Two simple queries (no PostgREST embed) → robust to FK-constraint names.
      const { data: rows, error } = await supabase
        .from("notification_outbox")
        .select("id, recipient_id, subject, body")
        .in("id", rowIds)
      if (error) throw error

      const recipientIds = [
        ...new Set((rows ?? []).map((r) => r.recipient_id).filter(Boolean) as string[]),
      ]
      const emailById = new Map<string, string>()
      if (recipientIds.length > 0) {
        const { data: users, error: uErr } = await supabase
          .from("users")
          .select("id, email")
          .in("id", recipientIds)
        if (uErr) throw uErr
        for (const u of users ?? []) emailById.set(u.id as string, u.email as string)
      }

      return (rows ?? []).map((r): OutboxRow => ({
        id: r.id as string,
        subject: r.subject as string,
        body: r.body as string,
        recipient_email: r.recipient_id
          ? emailById.get(r.recipient_id as string) ?? null
          : null,
      }))
    },
    notifier,
    async markFailed(id, errorText) {
      const { error } = await supabase.rpc("outbox_mark_failed", {
        p_id: id,
        p_error: errorText,
      })
      // Last-resort: surface in the function logs; never swallow (§6).
      if (error) console.error(`outbox_mark_failed failed for ${id}: ${error.message}`)
    },
  })

  return json(result)
})

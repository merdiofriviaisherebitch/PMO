# escalation-sender

Delivers queued `notification_outbox` rows via the **Notifier** port (Resend
adapter today; a Teams/Graph adapter is added behind the same interface at
Phase 8). Invoked by `pg_net` from `outbox_send_batch()` every 5 minutes
(CLAUDE.md §8, §11, §12, §20 C3).

## Flow

```
pg_cron → outbox_send_batch()          -- claims un-sent rows FOR UPDATE SKIP LOCKED,
          (SQL, migration 0025)           marks them `sent`, fires net.http_post
   → POST /functions/v1/escalation-sender { outbox_ids: [...] }
   → this function                      -- validates the shared secret, sends each via Resend
   → outbox_mark_failed(id, error)      -- ONLY on failure: demote to `failed` + backoff
```

The row is marked `sent` *before* delivery (§6 "mark sent before delivery to
prevent retries from double-sending"); this function only ever **demotes**
failures, so a failed send is retried in place with backoff — never duplicated.
No failure path is silent: a Resend error *and* a missing recipient email both
record a reason.

## Files

- `notifier.ts` — the `Notifier` port + `ResendNotifier` / `InMemoryNotifier`.
- `process.ts` — `processOutbox()`, the delivery logic (deps injected, no network).
- `index.ts` — the `Deno.serve` handler wiring the real Supabase client + Resend.
- `process_test.ts` — `deno test` covering send / failure-demotion / missing-email.

## Test

```bash
deno test supabase/functions/escalation-sender/
```

## Deploy (per environment — secrets never live in git)

```bash
# 1) Function secrets (NOT NEXT_PUBLIC_; server-side only — CLAUDE.md §14, §17)
supabase secrets set ESCALATION_FUNCTION_SECRET="$(openssl rand -hex 32)"
supabase secrets set RESEND_API_KEY="re_..."
supabase secrets set ESCALATION_FROM_EMAIL="PMO Control Tower <noreply@your-domain>"

# 2) Deploy (verify_jwt=false is set in config.toml — we use our own shared secret)
supabase functions deploy escalation-sender

# 3) Tell the SQL sender where to POST + the SAME shared secret, via Vault:
#    (run in the DB; values must match the function secrets above)
#    select vault.create_secret('https://<ref>.supabase.co/functions/v1/escalation-sender', 'escalation_function_url');
#    select vault.create_secret('<the ESCALATION_FUNCTION_SECRET value>',                   'escalation_function_secret');
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the runtime.

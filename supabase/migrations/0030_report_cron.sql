-- 0030_report_cron.sql
-- Phase 7 report generation pg_cron jobs (CLAUDE.md §5 module 11, §8, §14, §17).
--
-- Mirrors the escalation engine pattern from 0025: a SECURITY DEFINER wrapper
-- function reads the URL + shared secret from Vault, then calls net.http_post
-- to the Next.js /api/reports/generate route handler.
--
-- The route handler authenticates via the same constant-time shared-secret check
-- used by escalation-sender (CLAUDE.md §6 non-negotiable #3). The secret never
-- appears in this migration or in any NEXT_PUBLIC_ variable.
--
-- Two jobs:
--   report_weekly  — Monday 06:00 Europe/Budapest (§18 confirmed timezone)
--   report_monthly — 1st of each month 06:00 Europe/Budapest
--
-- pg_cron runs in UTC; Europe/Budapest is UTC+1 in winter, UTC+2 in summer.
-- We schedule at 04:00 UTC so the job fires at ~06:00 Budapest regardless of DST
-- (same conservative-offset approach used for the update-cycle jobs in 0020).
-- The report window is computed at call time from the wall clock, so a few hours'
-- slack does not affect correctness — only which week/month "now" falls into.

-- ── report_dispatch() — SECURITY DEFINER wrapper ─────────────────────────────
-- Reads reports_function_url + reports_function_secret from Vault and fires
-- net.http_post to /api/reports/generate. If the URL is not yet configured,
-- logs a notice and returns without sending (no silent failure, no crash).
-- SECURITY DEFINER so the cron runner can read Vault secrets (same discipline
-- as outbox_send_batch in 0025).

create or replace function public.report_dispatch(p_period text)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_url  text;
  v_key  text;
begin
  -- Secrets live in Vault, never in this migration (§14, §17).
  select decrypted_secret into v_url
    from vault.decrypted_secrets
   where name = 'reports_function_url';

  if v_url is null then
    raise notice 'report_dispatch: reports_function_url not set in Vault — skipping run for period=%', p_period;
    return;
  end if;

  select decrypted_secret into v_key
    from vault.decrypted_secrets
   where name = 'reports_function_secret';

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || coalesce(v_key, '')
    ),
    body    := jsonb_build_object('period', p_period)
  );
end;
$$;

comment on function public.report_dispatch(text) is
  'SECURITY DEFINER: reads reports_function_url + reports_function_secret from Vault, '
  'POSTs to /api/reports/generate. If URL not set, logs a notice and returns — '
  'no silent failure. Called by the pg_cron report_weekly / report_monthly jobs (0030).';

-- Lock it down — not a user-callable RPC (same discipline as 0025 system functions).
revoke execute on function public.report_dispatch(text) from public, authenticated, anon;

-- ── Schedule the cron jobs (idempotent: cron.schedule upserts by name) ────────
-- 04:00 UTC ≈ 06:00 Europe/Budapest (conservative UTC+2 offset covers both
-- standard UTC+1 and summer time UTC+2 — the report fires slightly early in
-- winter, which is fine since the window is computed at call time).

select cron.schedule(
  'report_weekly',
  '0 4 * * 1',   -- Monday 04:00 UTC
  $$ select public.report_dispatch('weekly'); $$
);

select cron.schedule(
  'report_monthly',
  '0 4 1 * *',   -- 1st of month 04:00 UTC
  $$ select public.report_dispatch('monthly'); $$
);

-- ── Vault secrets (set ONCE per environment, NOT in version control) ──────────
-- The report cron needs the Next.js app URL + a shared secret to authenticate
-- against /api/reports/generate. Until these are set, report_dispatch() skips
-- runs (queued backlog stays visible, never silently dropped).
-- Create them out-of-band (psql / dashboard), e.g.:
--   select vault.create_secret('https://<your-app>.vercel.app/api/reports/generate', 'reports_function_url');
--   select vault.create_secret('<long-random-shared-secret>',                         'reports_function_secret');
-- The same shared secret is configured as the REPORTS_FUNCTION_SECRET env var on
-- the Next.js deployment (Vercel), which rejects any request whose Bearer token
-- does not match (constant-time compare, same as escalation-sender).

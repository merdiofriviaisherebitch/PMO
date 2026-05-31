-- 0020_update_cycle_automation.sql
-- Weekly update-cycle automation (CLAUDE.md §5 module 2, §8 scheduled jobs).
-- Two pg_cron jobs:
--   open_update_cycle  — Monday: create the week's cycle + a draft update per
--                        workspace, so the cycle tracks submission status for
--                        every department from the start (§5).
--   close_update_cycle — hourly heartbeat: close any cycle whose deadline has
--                        passed.
--
-- DST-correctness (the important bit): pg_cron runs in UTC, but the cut-off is
-- "Friday 17:00 Europe/Budapest" (§18 Q2), which is 16:00 UTC in winter and
-- 15:00 UTC in summer. We do NOT encode the deadline in the cron expression.
-- Instead the cycle stores `closes_at` as a real timestamptz computed in
-- Europe/Budapest (Postgres's tz database handles DST), and the close heartbeat
-- just closes whatever is past `closes_at`. The cron schedule is only a tick.
--
-- Both functions are SECURITY DEFINER (pg_cron runs them as the postgres
-- superuser, bypassing RLS — correct for a system job that spans all
-- departments) and are revoked from app roles (not user-callable RPCs).
-- Idempotent: safe to run twice (open guards on one-cycle-per-ISO-week).

-- ── helper: this week's Friday 17:00 Europe/Budapest as a timestamptz ─────────
create or replace function public.week_cutoff(p_at timestamptz default now())
returns timestamptz
language sql
stable
set search_path = ''
as $$
  -- Monday 00:00 (Budapest) of p_at's week, + 4 days + 17h = Friday 17:00 local,
  -- converted back to an absolute instant. DST handled by the tz database.
  select (
    date_trunc('week', (p_at at time zone 'Europe/Budapest'))
    + interval '4 days 17 hours'
  ) at time zone 'Europe/Budapest'
$$;

comment on function public.week_cutoff(timestamptz) is
  'Friday 17:00 Europe/Budapest for the given instant''s week, as a DST-correct timestamptz (CLAUDE.md §18 Q2).';

-- ── open_update_cycle(): create this week's cycle + draft updates ─────────────
create or replace function public.open_update_cycle()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cycle_id uuid;
  v_week_start date := (date_trunc('week', (now() at time zone 'Europe/Budapest')))::date;
begin
  -- Idempotent: one cycle per ISO week (guard against a double cron fire).
  select id into v_cycle_id
  from public.update_cycles
  where (opens_at at time zone 'Europe/Budapest')::date >= v_week_start
    and (opens_at at time zone 'Europe/Budapest')::date < v_week_start + 7;
  if v_cycle_id is not null then
    return v_cycle_id;  -- already opened this week
  end if;

  insert into public.update_cycles (opens_at, closes_at, status)
  values (now(), public.week_cutoff(now()), 'open')
  returning id into v_cycle_id;

  -- Track submission status for every department from the start: a draft per
  -- existing workspace (unique(cycle,workspace) makes this safe to re-run).
  insert into public.department_updates (cycle_id, workspace_id, status)
  select v_cycle_id, w.id, 'draft'
  from public.department_workspaces w
  on conflict (cycle_id, workspace_id) do nothing;

  return v_cycle_id;
end;
$$;

comment on function public.open_update_cycle() is
  'Opens the current week''s update cycle + a draft update per workspace (CLAUDE.md §5, §8). Idempotent per ISO week. Run by pg_cron as superuser.';

-- ── close_update_cycle(): close cycles past their deadline (heartbeat) ────────
create or replace function public.close_update_cycle()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_closed integer;
begin
  update public.update_cycles
  set status = 'closed'
  where status = 'open'
    and closes_at <= now();
  get diagnostics v_closed = row_count;
  return v_closed;
end;
$$;

comment on function public.close_update_cycle() is
  'Closes any open cycle whose closes_at has passed (CLAUDE.md §8). DST-safe: closes_at is an absolute instant, so this works regardless of when the heartbeat ticks.';

-- These are system jobs, not user RPCs.
revoke execute on function public.open_update_cycle() from public, authenticated, anon;
revoke execute on function public.close_update_cycle() from public, authenticated, anon;
-- week_cutoff is a pure helper; harmless but keep it off the public RPC surface.
revoke execute on function public.week_cutoff(timestamptz) from public, authenticated, anon;

-- ── non-submitters helper for the dashboard (who hasn't submitted this cycle) ─
-- A workspace "submitted" when its update for the cycle is pending or approved.
-- SECURITY INVOKER: runs under the caller's RLS, so a director sees only their
-- own department's laggards and an executive sees all.
create or replace function public.cycle_non_submitters(p_cycle_id uuid)
returns table (workspace_id uuid, department_id uuid, status public.update_status)
language sql
stable
security invoker
set search_path = ''
as $$
  select du.workspace_id, w.department_id, du.status
  from public.department_updates du
  join public.department_workspaces w on w.id = du.workspace_id
  where du.cycle_id = p_cycle_id
    and du.status in ('draft', 'rejected')
$$;

comment on function public.cycle_non_submitters(uuid) is
  'Workspaces that have not yet submitted (draft/rejected) for a cycle (CLAUDE.md §5). SECURITY INVOKER → RLS-scoped per caller.';

grant execute on function public.cycle_non_submitters(uuid) to authenticated;

-- ── schedule the jobs (idempotent: cron.schedule upserts by name in pg_cron 1.6)
-- open: Monday 00:01 UTC. Idempotent per ISO week, so the exact UTC minute is
-- not load-bearing (DST drift just shifts WHEN the week's cycle is created, not
-- the deadline).
select cron.schedule('open_update_cycle', '1 0 * * 1', $$ select public.open_update_cycle(); $$);
-- close: hourly heartbeat at :07. Closes whatever is past its real deadline.
select cron.schedule('close_update_cycle', '7 * * * *', $$ select public.close_update_cycle(); $$);

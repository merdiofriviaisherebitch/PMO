-- 0032_stamp_accountability_actors.sql
-- C10 (Codex/Gemini adjudication, confirmed): tasks.created_by, budgets.approved_by
-- and budget_actuals.recorded_by were never set (the Server Actions omitted them)
-- and had no DB default, so they were (a) always NULL and (b) SPOOFABLE — a direct
-- PostgREST insert could claim any actor id. Accountability columns (§9, §17) must
-- record the REAL actor and must not be forgeable.
--
-- Fix: a generic BEFORE-INSERT (and, for the budgets upsert, BEFORE-UPDATE) trigger
-- that FORCES the named column to auth.uid() for an authenticated caller, ignoring
-- whatever the client sent. For a service-role / system write (auth.uid() IS NULL —
-- seeds, future system jobs) it is a no-op so those paths can set the actor
-- explicitly. Mirrors the department_updates.approved_by stamping in 0019; the app
-- layer also sets these columns (lib/actions/{tasks,budgets}.ts) for intent, but the
-- trigger is the authoritative, un-spoofable guarantee.

create or replace function public.stamp_actor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  -- Only override for an authenticated user (spoof-proofing). System / service-role
  -- inserts (auth.uid() null) keep whatever they explicitly set.
  if v_actor is not null then
    new := jsonb_populate_record(new, jsonb_build_object(tg_argv[0], v_actor));
  end if;
  return new;
end;
$$;

comment on function public.stamp_actor() is
  'BEFORE INSERT/UPDATE actor stamper (CLAUDE.md §9, §17 accountability). Forces the column named in tg_argv[0] to auth.uid() for authenticated callers so it cannot be spoofed; no-op for service-role/system writes.';

revoke execute on function public.stamp_actor() from public, authenticated, anon;

-- tasks.created_by — plain INSERT path.
create trigger tasks_stamp_created_by
  before insert on public.tasks
  for each row execute function public.stamp_actor('created_by');

-- budgets.approved_by — director sets/REVISES the figure (setBudget upserts), so
-- stamp on UPDATE too: the acting director is recorded as the current approver.
create trigger budgets_stamp_approved_by
  before insert or update on public.budgets
  for each row execute function public.stamp_actor('approved_by');

-- budget_actuals.recorded_by — plain INSERT path.
create trigger budget_actuals_stamp_recorded_by
  before insert on public.budget_actuals
  for each row execute function public.stamp_actor('recorded_by');

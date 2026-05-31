-- 0022_dashboard_broadcast.sql
-- Make the live dashboard actually live (CLAUDE.md §5 module 10, §10 Realtime).
-- Phase 4 added a RealtimeRefresh client island that SUBSCRIBES to the private
-- channel `department:<department_id>` (authorized by the RLS on
-- realtime.messages from 0012). This migration adds the PUBLISH half: a trigger
-- that broadcasts a lightweight "change" event to a department's channel when
-- its governance rows change, so subscribed dashboards re-fetch (RLS-scoped)
-- without polling.
--
-- We broadcast only a signal (empty payload) — the client calls router.refresh()
-- and the server re-reads through RLS, so no data crosses the channel itself
-- (defense in depth: the channel is private + RLS-gated, but we also never put
-- row data on it). Phase 5's escalation engine reuses the same publisher.

create or replace function public.broadcast_department_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entity_type text := tg_argv[0];
  v_dept uuid;
  v_id uuid;
begin
  v_id := coalesce(new.id, old.id);
  -- Reuse the single scope resolver (§20 C1) to find the department.
  select s.department_id into v_dept
  from public.resolve_scope(v_entity_type, v_id) s;

  if v_dept is not null then
    perform realtime.send(
      jsonb_build_object('changed', v_entity_type),  -- payload: just a signal
      'change',                                       -- event name
      'department:' || v_dept::text,                  -- private channel topic
      true                                            -- private
    );
  end if;

  return null;  -- AFTER trigger
end;
$$;

comment on function public.broadcast_department_change() is
  'Broadcasts a "change" signal to the affected department''s private Realtime channel so dashboards refresh (CLAUDE.md §5 module 10, §10). Reuses resolve_scope (§20 C1).';

revoke execute on function public.broadcast_department_change() from public, authenticated, anon;

-- Attach to the department-scoped governance tables whose changes the dashboard
-- reflects. (Statement-level would be lighter, but row-level lets us resolve the
-- department per row; at ~50 users the volume is trivial.)
create trigger broadcast_tasks
  after insert or update or delete on public.tasks
  for each row execute function public.broadcast_department_change('task');

create trigger broadcast_workspaces
  after insert or update or delete on public.department_workspaces
  for each row execute function public.broadcast_department_change('department_workspace');

create trigger broadcast_department_updates
  after insert or update or delete on public.department_updates
  for each row execute function public.broadcast_department_change('department_update');

create trigger broadcast_budgets
  after insert or update or delete on public.budgets
  for each row execute function public.broadcast_department_change('budget');

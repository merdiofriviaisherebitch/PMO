-- 0016_rag_status_history.sql
-- Append-only RAG status history (CLAUDE.md §5 module 3, §9, §15 RAG tests).
-- Every change to a task/workspace/project rag_status records a row: who, when,
-- from→to. Like audit_log it is immutable to the app role and written ONLY by a
-- SECURITY DEFINER trigger. Scope (department_id/project_id) is denormalized via
-- the SAME resolve_scope() resolver the audit trigger uses (§20 C1) so a director
-- can be granted own-department SELECT.

create table public.rag_status_history (
  id            bigint generated always as identity primary key,
  entity_type   text not null,            -- 'task' | 'workspace' | 'project'
  entity_id     uuid not null,
  old_status    public.rag_status,        -- null on first set / insert
  new_status    public.rag_status not null,
  department_id uuid references public.departments (id) on delete set null,
  project_id    uuid references public.projects (id) on delete set null,
  changed_by    uuid,                      -- auth.uid(), null on system writes
  changed_at    timestamptz not null default now()
);

comment on table public.rag_status_history is
  'Append-only RAG change log (CLAUDE.md §3, §5). Immutable to app role; written only by capture_rag_change() trigger; scope denormalized via resolve_scope (§20 C1).';

-- FKs used by the director SELECT policy + by lookups → index them (RLS perf).
create index rag_status_history_department_id_idx on public.rag_status_history (department_id);
create index rag_status_history_entity_idx on public.rag_status_history (entity_type, entity_id);
create index rag_status_history_changed_at_idx on public.rag_status_history (changed_at desc);

alter table public.rag_status_history enable row level security;

-- ── Trigger: capture a row whenever rag_status actually changes ───────────────
-- One generic function attached to each table that has a rag column. The
-- entity_type is passed as a trigger argument (mirrors audit_capture's shape).
-- Column name differs (tasks/workspaces use rag_status, projects use status), so
-- the function reads the right column per entity_type from the NEW/OLD records.
create or replace function public.capture_rag_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entity_type text := tg_argv[0];
  v_old public.rag_status;
  v_new public.rag_status;
  v_scope record;
  v_actor uuid;
begin
  -- Resolve old/new rag from whichever column this table uses.
  if v_entity_type = 'project' then
    v_old := (case when tg_op = 'UPDATE' then old.status else null end);
    v_new := new.status;
  else
    v_old := (case when tg_op = 'UPDATE' then old.rag_status else null end);
    v_new := new.rag_status;
  end if;

  -- Only record real transitions (and the initial value on INSERT).
  if tg_op = 'UPDATE' and v_old is not distinct from v_new then
    return null;
  end if;

  select s.department_id, s.project_id
    into v_scope
  from public.resolve_scope(v_entity_type, new.id) s;

  begin
    v_actor := (select auth.uid());
  exception when others then
    v_actor := null;
  end;

  insert into public.rag_status_history (
    entity_type, entity_id, old_status, new_status,
    department_id, project_id, changed_by
  ) values (
    v_entity_type, new.id, v_old, v_new,
    v_scope.department_id, v_scope.project_id, v_actor
  );

  return null;  -- AFTER trigger
end;
$$;

comment on function public.capture_rag_change() is
  'Append-only RAG history writer (CLAUDE.md §5). Attach AFTER INSERT/UPDATE with the entity_type as the first trigger arg.';

revoke execute on function public.capture_rag_change() from public, authenticated, anon;

create trigger rag_history_tasks
  after insert or update of rag_status on public.tasks
  for each row execute function public.capture_rag_change('task');

create trigger rag_history_workspaces
  after insert or update of rag_status on public.department_workspaces
  for each row execute function public.capture_rag_change('workspace');

create trigger rag_history_projects
  after insert or update of status on public.projects
  for each row execute function public.capture_rag_change('project');

-- ── RLS: director/own-department SELECT; INSERT trigger-only; no UPDATE/DELETE ─
create policy "rag history read: own department or all-if-exec"
  on public.rag_status_history for select to authenticated
  using ( department_id = public.current_department() or public.is_executive() );

-- Lock down mutations at the role level (mirrors audit_log immutability, §6).
revoke all on public.rag_status_history from authenticated, anon;
grant select on public.rag_status_history to authenticated;

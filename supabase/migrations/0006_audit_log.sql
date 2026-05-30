-- 0006_audit_log.sql
-- Append-only, tamper-resistant audit trail (CLAUDE.md §6 non-negotiable #2, §9).
-- Immutable to the application role: UPDATE/DELETE are REVOKED; rows are written
-- ONLY by the SECURITY DEFINER trigger audit_capture(). One generic trigger +
-- one resolve_scope() resolver is the single home for scope denormalization
-- (§20 C1) — every audited table reuses it instead of bespoke per-table logic.

create table public.audit_log (
  id             bigint generated always as identity primary key,
  entity_type    text not null,
  entity_id      uuid not null,
  action         public.audit_action not null,
  actor_id       uuid,                 -- auth.uid() of the actor (nullable for system writes)
  actor_snapshot jsonb,                -- denormalized actor identity; survives user deletion (§17)
  department_id  uuid references public.departments (id) on delete set null,  -- denormalized for RLS (§9,§10)
  project_id     uuid references public.projects (id) on delete set null,     -- denormalized for RLS (§9,§10)
  old_values     jsonb,
  new_values     jsonb,
  occurred_at    timestamptz not null default now()
);

comment on table public.audit_log is
  'Append-only audit trail. Immutable to app role (UPDATE/DELETE revoked); written only by audit_capture() SECURITY DEFINER trigger (CLAUDE.md §6).';

create index audit_log_entity_idx on public.audit_log (entity_type, entity_id);
create index audit_log_department_id_idx on public.audit_log (department_id);
create index audit_log_occurred_at_idx on public.audit_log (occurred_at desc);

alter table public.audit_log enable row level security;

-- ── resolve_scope(): the ONE place that derives (department_id, project_id) ───
-- for any audited entity (§20 C1). Reused by audit_capture and, later, by
-- rag_status_history / approvals / escalation_events writers.
create or replace function public.resolve_scope(p_entity_type text, p_entity_id uuid)
returns table (department_id uuid, project_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_entity_type = 'task' then
    return query
      select w.department_id, w.project_id
      from public.tasks t
      join public.department_workspaces w on w.id = t.workspace_id
      where t.id = p_entity_id;
  elsif p_entity_type = 'department_workspace' then
    return query
      select w.department_id, w.project_id
      from public.department_workspaces w
      where w.id = p_entity_id;
  elsif p_entity_type = 'project' then
    return query
      select null::uuid, p.id
      from public.projects p
      where p.id = p_entity_id;
  elsif p_entity_type = 'user' then
    return query
      select u.department_id, null::uuid
      from public.users u
      where u.id = p_entity_id;
  else
    -- Unknown entity type → unscoped (global). Executive-only visibility via RLS.
    return query select null::uuid, null::uuid;
  end if;
end;
$$;

-- ── audit_capture(): the ONE generic trigger function for every audited table ─
create or replace function public.audit_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action       public.audit_action;
  v_entity_id    uuid;
  v_old          jsonb;
  v_new          jsonb;
  v_scope        record;
  v_actor        uuid;
begin
  if (tg_op = 'INSERT') then
    v_action := 'create'; v_new := to_jsonb(new); v_old := null; v_entity_id := new.id;
  elsif (tg_op = 'UPDATE') then
    v_action := 'update'; v_new := to_jsonb(new); v_old := to_jsonb(old); v_entity_id := new.id;
  elsif (tg_op = 'DELETE') then
    v_action := 'delete'; v_new := null; v_old := to_jsonb(old); v_entity_id := old.id;
  end if;

  select s.department_id, s.project_id
    into v_scope
  from public.resolve_scope(tg_argv[0], v_entity_id) s;

  -- auth.uid() may be null on service-role / system writes.
  begin
    v_actor := (select auth.uid());
  exception when others then
    v_actor := null;
  end;

  insert into public.audit_log (
    entity_type, entity_id, action, actor_id, actor_snapshot,
    department_id, project_id, old_values, new_values
  )
  values (
    tg_argv[0], v_entity_id, v_action, v_actor,
    case when v_actor is not null
      then (select to_jsonb(u) from public.users u where u.id = v_actor)
      else null end,
    v_scope.department_id, v_scope.project_id, v_old, v_new
  );

  return null;  -- AFTER trigger; return value ignored
end;
$$;

comment on function public.audit_capture() is
  'Generic append-only audit writer (CLAUDE.md §14, §20 C1). Attach AFTER INSERT/UPDATE/DELETE with the entity_type as the first trigger argument.';

-- Attach to the core Phase-1 tables. (Phase 3 extends to baselines/approvals/etc.)
create trigger audit_tasks
  after insert or update or delete on public.tasks
  for each row execute function public.audit_capture('task');

create trigger audit_department_workspaces
  after insert or update or delete on public.department_workspaces
  for each row execute function public.audit_capture('department_workspace');

create trigger audit_projects
  after insert or update or delete on public.projects
  for each row execute function public.audit_capture('project');

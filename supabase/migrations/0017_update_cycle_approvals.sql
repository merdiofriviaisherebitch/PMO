-- 0017_update_cycle_approvals.sql
-- Weekly update cycle + approval state machine (CLAUDE.md §5 modules 2 & 4, §9).
-- State machine (§4): draft → pending → approved, OR pending → rejected → draft.
-- A rejected update returns to draft for revision; it never dead-ends.
--
-- Enforcement is two-layer (same pattern as the users self-update guard):
--   * RLS gates WHO may touch a department_update (own-department members for
--     drafting/submitting; own-department directors for approving) + exec.
--   * a BEFORE UPDATE transition guard validates the MOVE itself against the
--     actor's role, which RLS alone cannot express (it depends on OLD vs NEW).
-- Cron opening/closing of cycles is Phase 4; here cycles are created by the
-- service role / an executive action.

-- ── update_cycles: the recurring weekly window ───────────────────────────────
create table public.update_cycles (
  id         uuid primary key default gen_random_uuid(),
  opens_at   timestamptz not null,
  closes_at  timestamptz not null,
  status     text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now()
);

comment on table public.update_cycles is
  'Recurring weekly update window (CLAUDE.md §5 module 2). Opened/closed by pg_cron in Phase 4.';

alter table public.update_cycles enable row level security;

-- Cycles are global (not department-scoped): everyone authenticated can read the
-- current window; only service role / exec create them (no write policy → only
-- RLS-bypassing service role, plus the exec policy below).
create policy "authenticated read update cycles"
  on public.update_cycles for select to authenticated using (true);
create policy "exec manage update cycles (insert)"
  on public.update_cycles for insert to authenticated with check (public.is_executive());
create policy "exec manage update cycles (update)"
  on public.update_cycles for update to authenticated
  using (public.is_executive()) with check (public.is_executive());

-- ── department_updates: one submission per (cycle, workspace) ─────────────────
create table public.department_updates (
  id            uuid primary key default gen_random_uuid(),
  cycle_id      uuid not null references public.update_cycles (id) on delete cascade,
  workspace_id  uuid not null references public.department_workspaces (id) on delete cascade,
  content       jsonb not null default '{}'::jsonb,
  status        public.update_status not null default 'draft',
  submitted_by  uuid references public.users (id) on delete set null,
  submitted_at  timestamptz,
  approved_by   uuid references public.users (id) on delete set null,
  approved_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (cycle_id, workspace_id)
);

comment on table public.department_updates is
  'A department''s weekly update submission with approval lifecycle (CLAUDE.md §5 module 4).';

create index department_updates_workspace_id_idx on public.department_updates (workspace_id);
create index department_updates_cycle_id_idx on public.department_updates (cycle_id);

alter table public.department_updates enable row level security;

-- ── approvals: append-only record of every transition ────────────────────────
create table public.approvals (
  id            bigint generated always as identity primary key,
  entity_type   text not null default 'department_update',
  entity_id     uuid not null,
  from_status   public.update_status,
  to_status     public.update_status not null,
  actor_id      uuid,
  department_id uuid references public.departments (id) on delete set null,  -- denormalized (§9,§10)
  project_id    uuid references public.projects (id) on delete set null,
  notes         text,
  actioned_at   timestamptz not null default now()
);

comment on table public.approvals is
  'Append-only approval/transition log (CLAUDE.md §9). Immutable to app role; written only by the transition trigger.';

create index approvals_entity_idx on public.approvals (entity_type, entity_id);
create index approvals_department_id_idx on public.approvals (department_id);

alter table public.approvals enable row level security;

-- ── resolve_scope: teach it about department_update ──────────────────────────
-- Extend the single resolver (§20 C1) so audit + approvals can denormalize scope
-- for the new entity type.
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
  elsif p_entity_type = 'department_update' then
    return query
      select w.department_id, w.project_id
      from public.department_updates du
      join public.department_workspaces w on w.id = du.workspace_id
      where du.id = p_entity_id;
  elsif p_entity_type = 'project' then
    return query select null::uuid, p.id from public.projects p where p.id = p_entity_id;
  elsif p_entity_type = 'baseline' then
    return query
      select null::uuid, b.project_id
      from public.baselines b
      where b.id = p_entity_id;
  elsif p_entity_type = 'user' then
    return query select u.department_id, null::uuid from public.users u where u.id = p_entity_id;
  else
    return query select null::uuid, null::uuid;
  end if;
end;
$$;

-- ── transition guard: validate (old, new, role) on every status change ───────
create or replace function public.enforce_update_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role  text := coalesce((select auth.jwt()) ->> 'user_role', '');
  v_actor uuid := (select auth.uid());
  v_scope record;
  v_is_exec boolean := v_role = 'executive';
  v_is_dir  boolean := v_role in ('director', 'executive');
begin
  -- Only police status changes; other column edits (content) pass through.
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- Legal transitions by role:
  --   member/director (own dept): draft → pending ; rejected → draft
  --   director/exec: pending → approved ; pending → rejected
  if old.status = 'draft' and new.status = 'pending' then
    new.submitted_by := v_actor; new.submitted_at := now();
  elsif old.status = 'rejected' and new.status = 'draft' then
    null;  -- resubmission path; any own-dept member may revise
  elsif old.status = 'pending' and new.status = 'approved' then
    if not v_is_dir then
      raise exception 'Only a director or executive may approve an update'
        using errcode = 'check_violation';
    end if;
    new.approved_by := v_actor; new.approved_at := now();
  elsif old.status = 'pending' and new.status = 'rejected' then
    if not v_is_dir then
      raise exception 'Only a director or executive may reject an update'
        using errcode = 'check_violation';
    end if;
  else
    raise exception 'Illegal update transition: % → %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  -- Append the transition to the immutable approvals log (denormalized scope).
  select s.department_id, s.project_id into v_scope
  from public.resolve_scope('department_update', new.id) s;

  insert into public.approvals (
    entity_type, entity_id, from_status, to_status, actor_id,
    department_id, project_id
  ) values (
    'department_update', new.id, old.status, new.status, v_actor,
    v_scope.department_id, v_scope.project_id
  );

  return new;
end;
$$;

comment on function public.enforce_update_transition() is
  'Validates the department_update state machine (CLAUDE.md §5 module 4) by (old,new,role) and logs each transition to approvals. SECURITY DEFINER so it can write the append-only log.';

create trigger department_updates_transition_guard
  before update on public.department_updates
  for each row execute function public.enforce_update_transition();

-- audit_capture on the new table (reuses the generic trigger, §20 C1)
create trigger audit_department_updates
  after insert or update or delete on public.department_updates
  for each row execute function public.audit_capture('department_update');

-- ── RLS on department_updates ────────────────────────────────────────────────
-- Read: own department or exec.
create policy "updates read: own department or exec"
  on public.department_updates for select to authenticated
  using ( public.belongs_to_my_department(workspace_id) or public.is_executive() );

-- Insert (start a draft): own-department member/director or exec.
create policy "updates insert: own department or exec"
  on public.department_updates for insert to authenticated
  with check ( public.belongs_to_my_department(workspace_id) or public.is_executive() );

-- Update: own-department or exec MAY attempt; the transition guard enforces
-- which moves their role can actually make. Needs USING + WITH CHECK.
create policy "updates update: own department or exec"
  on public.department_updates for update to authenticated
  using ( public.belongs_to_my_department(workspace_id) or public.is_executive() )
  with check ( public.belongs_to_my_department(workspace_id) or public.is_executive() );

-- ── RLS on approvals: read own-dept/exec; INSERT trigger-only; no UPDATE/DELETE
create policy "approvals read: own department or exec"
  on public.approvals for select to authenticated
  using ( department_id = public.current_department() or public.is_executive() );

revoke all on public.approvals from authenticated, anon;
grant select on public.approvals to authenticated;

-- enforce_update_transition is a trigger fn → not callable as RPC; revoke anyway.
revoke execute on function public.enforce_update_transition() from public, authenticated, anon;

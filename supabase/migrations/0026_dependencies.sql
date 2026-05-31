-- 0026_dependencies.sql
-- Phase 6 — cross-department task dependencies + the data the visual map renders
-- (CLAUDE.md §5 module 7, §7 @xyflow/react, §9, §16 OpenProject relation taxonomy).
--
-- THE TENSION (§6 #1 vs §7). §7 wants CROSS-department dependency tracking; §6
-- forbids a member reading another department's data. The resolution is to split
-- the EXISTENCE of an edge from the CONTENTS of its endpoints:
--   * A dependency row is visible to BOTH endpoint departments — so each side
--     knows it is blocking / blocked — via two DENORMALIZED department ids + a
--     symmetric RLS predicate, mirroring audit_log / escalation_events (§9, §10, §17).
--   * The foreign TASK stays hidden by tasks-RLS, so the map renders it as a
--     department-labeled boundary node ("Legal · task hidden"), never its title.
--     That is the minimum disclosure the cross-department escalation needs (§5, §11)
--     and no more.
--   * WRITE MODEL (ADR 0002, docs/adr/0002): a non-executive may only create or
--     delete an edge whose BOTH endpoints are in their OWN department (an
--     intra-department edge). A cross-department edge requires an executive — the
--     only role that can see both tasks to pick them. The exact authority (should a
--     director request cross-department links?) is a §18 open question for the client.

-- ── relation_type enum (§9; OpenProject precedes/blocks/relates taxonomy, §16) ──
-- 'blocks'   : source must resolve before target can proceed (the escalation case).
-- 'precedes' : source is scheduled before target (ordering, no hard block).
-- 'relates'  : informational link, no scheduling/blocking semantics.
create type public.relation_type as enum ('blocks', 'precedes', 'relates');

-- ── task_in_my_department(): does a task belong to the caller's department? ─────
-- The tasks analogue of belongs_to_my_department(workspace) — ONE home for the
-- task -> workspace -> department join so the dependency policies never re-implement
-- it (§20 C5). SECURITY INVOKER (the default): it must reflect the CALLER's
-- department, exactly like belongs_to_my_department. STABLE so the planner caches
-- it per statement; reuses tasks_workspace_id_idx + the workspace department index.
create or replace function public.task_in_my_department(p_task_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.tasks t
    join public.department_workspaces w on w.id = t.workspace_id
    where t.id = p_task_id
      and w.department_id = public.current_department()
  )
$$;

comment on function public.task_in_my_department(uuid) is
  'True if the task belongs to the caller''s department (task->workspace->department). One home for the join the dependency policies use (CLAUDE.md §20 C5).';

-- ── dependencies: a typed edge between two tasks (§9) ─────────────────────────
create table public.dependencies (
  id                   uuid primary key default gen_random_uuid(),
  source_task_id       uuid not null references public.tasks (id) on delete cascade,
  target_task_id       uuid not null references public.tasks (id) on delete cascade,
  relation_type        public.relation_type not null default 'blocks',
  -- Denormalized endpoint departments. Set ONLY by the BEFORE INSERT trigger below
  -- (never by the client), so the SELECT policy is a fast indexed equality and the
  -- map can label a foreign endpoint by department WITHOUT reading the hidden task
  -- (§6, §10). Dependencies are immutable (no UPDATE policy) so these never drift.
  -- Left NULLABLE on purpose: (1) the client never supplies them, so the generated
  -- Insert type keeps them optional; (2) it is FAIL-SAFE — a (never-expected) null
  -- makes the RLS predicate false on that side, so the edge would be over-HIDDEN
  -- (exec-only), never cross-department-LEAKED. dependencies_test TEST 1 asserts the
  -- trigger always populates them.
  source_department_id uuid references public.departments (id) on delete cascade,
  target_department_id uuid references public.departments (id) on delete cascade,
  created_by           uuid references public.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  -- An edge connects two DISTINCT tasks…
  constraint dependencies_distinct_endpoints check (source_task_id <> target_task_id),
  -- …and a given (source, target, relation) triple is unique (no duplicate edges).
  unique (source_task_id, target_task_id, relation_type)
);

comment on table public.dependencies is
  'A typed cross-department task dependency (CLAUDE.md §5 module 7, §9). relation_type per OpenProject (§16). Endpoint departments are denormalized for RLS + map labeling (§6, §10); the foreign task itself stays hidden by tasks-RLS.';

-- Both endpoint FKs (graph traversal + the escalation join) and both denormalized
-- department columns (the RLS predicate keys on them) — supabase-postgres-best-practices.
create index dependencies_source_task_idx on public.dependencies (source_task_id);
create index dependencies_target_task_idx on public.dependencies (target_task_id);
create index dependencies_source_dept_idx on public.dependencies (source_department_id);
create index dependencies_target_dept_idx on public.dependencies (target_department_id);

-- ── denormalize endpoint departments at write time ────────────────────────────
-- BEFORE INSERT so the columns are present when RLS WITH CHECK and the row itself
-- are evaluated. SECURITY DEFINER (like audit_capture / capture_rag_change) so the
-- lookup always resolves regardless of the caller's RLS — the values are derived,
-- not user-supplied. A missing task is impossible (the FKs guarantee both exist),
-- so the trigger always populates both; dependencies_test TEST 1 guards that, and a
-- (never-expected) null fails SAFE per the column comment above.
create or replace function public.dependencies_set_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select w.department_id into new.source_department_id
  from public.tasks t
  join public.department_workspaces w on w.id = t.workspace_id
  where t.id = new.source_task_id;

  select w.department_id into new.target_department_id
  from public.tasks t
  join public.department_workspaces w on w.id = t.workspace_id
  where t.id = new.target_task_id;

  return new;
end;
$$;

comment on function public.dependencies_set_scope() is
  'Denormalizes the source/target task departments onto a new dependency (CLAUDE.md §9, §10). BEFORE INSERT so RLS WITH CHECK and the map can rely on the columns.';

revoke execute on function public.dependencies_set_scope() from public, authenticated, anon;

create trigger dependencies_set_scope_trg
  before insert on public.dependencies
  for each row execute function public.dependencies_set_scope();

-- ── audit: extend the ONE resolver + attach the ONE generic trigger (§20 C1) ──
-- resolve_scope() gains a 'dependency' branch so audit_capture('dependency') can
-- denormalize (department_id, project_id) for the audit row. We scope a dependency
-- to its SOURCE task's department/project (the owning side); the target side gets
-- its picture from the blocked_dependency escalation event instead (0027). On
-- DELETE the row is gone, so scope resolves null (an exec-only-visible delete audit
-- row, identical to every other entity).
--
-- CRITICAL (§20 C1): resolve_scope() is ONE function redefined WHOLE on every
-- extension, so each redefinition MUST be a strict SUPERSET of the latest (0023) —
-- otherwise branches earlier phases added (department_update / baseline / budget /
-- budget_actual) silently vanish and every update transition / budget audit breaks.
-- The branches below are 0023's verbatim; only 'dependency' is new.
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
      from public.tasks t join public.department_workspaces w on w.id = t.workspace_id
      where t.id = p_entity_id;
  elsif p_entity_type = 'department_workspace' then
    return query select w.department_id, w.project_id from public.department_workspaces w where w.id = p_entity_id;
  elsif p_entity_type = 'department_update' then
    return query
      select w.department_id, w.project_id
      from public.department_updates du join public.department_workspaces w on w.id = du.workspace_id
      where du.id = p_entity_id;
  elsif p_entity_type = 'project' then
    return query select null::uuid, p.id from public.projects p where p.id = p_entity_id;
  elsif p_entity_type = 'baseline' then
    return query select null::uuid, b.project_id from public.baselines b where b.id = p_entity_id;
  elsif p_entity_type = 'budget' then
    return query
      select w.department_id, w.project_id
      from public.budgets bd join public.department_workspaces w on w.id = bd.workspace_id
      where bd.id = p_entity_id;
  elsif p_entity_type = 'budget_actual' then
    return query
      select w.department_id, w.project_id
      from public.budget_actuals a
      join public.budgets bd on bd.id = a.budget_id
      join public.department_workspaces w on w.id = bd.workspace_id
      where a.id = p_entity_id;
  elsif p_entity_type = 'dependency' then
    -- Phase 6: scope a dependency to its SOURCE task's workspace (department + project).
    return query
      select w.department_id, w.project_id
      from public.dependencies d
      join public.tasks t on t.id = d.source_task_id
      join public.department_workspaces w on w.id = t.workspace_id
      where d.id = p_entity_id;
  elsif p_entity_type = 'user' then
    return query select u.department_id, null::uuid from public.users u where u.id = p_entity_id;
  else
    -- Unknown entity type → unscoped (global). Executive-only visibility via RLS.
    return query select null::uuid, null::uuid;
  end if;
end;
$$;
revoke execute on function public.resolve_scope(text, uuid) from public, authenticated, anon;

create trigger audit_dependencies
  after insert or update or delete on public.dependencies
  for each row execute function public.audit_capture('dependency');

-- ── RLS (§6 non-negotiable #1, §10; regression test requires RLS + ≥1 policy) ──
alter table public.dependencies enable row level security;

-- SELECT: visible if EITHER endpoint is in the caller's department, or exec. This
-- is the "split existence from contents" rule — the row is visible to both sides;
-- the foreign task row stays hidden by tasks-RLS.
create policy "dependencies read: either endpoint dept or all-if-exec"
  on public.dependencies for select to authenticated
  using (
    source_department_id = public.current_department()
    or target_department_id = public.current_department()
    or public.is_executive()
  );

-- INSERT: a non-exec may only create an edge whose BOTH endpoints are in their own
-- department (an intra-department edge); a cross-department edge requires an exec
-- (the only role that can see both tasks). ADR 0002 / §18 open question.
create policy "dependencies insert: both endpoints in-dept, or exec"
  on public.dependencies for insert to authenticated
  with check (
    public.is_executive()
    or (
      public.task_in_my_department(source_task_id)
      and public.task_in_my_department(target_task_id)
    )
  );

-- DELETE: symmetric with INSERT — you may remove an edge you could have created.
create policy "dependencies delete: both endpoints in-dept, or exec"
  on public.dependencies for delete to authenticated
  using (
    public.is_executive()
    or (
      public.task_in_my_department(source_task_id)
      and public.task_in_my_department(target_task_id)
    )
  );

-- No UPDATE policy: dependencies are immutable edges (create / delete only). This
-- also keeps the denormalized department columns from ever drifting from the tasks.

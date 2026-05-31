-- 0021_budgets.sql
-- Budget & cost governance (CLAUDE.md §5 module 9, §9). A workspace has at most
-- one budget (director-approved). Members record actuals (spend) against it.
-- Variance = budget − sum(actuals); thresholds flag amber/red.
--
-- Role model (§4, §9): the budget figure is DIRECTOR-approved (set/changed by a
-- director or executive of the owning department). Members may record ACTUALS
-- in their own department. All scoped via the workspace → department join, so
-- the same isolation guarantees as tasks apply.

create table public.budgets (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.department_workspaces (id) on delete cascade,
  budget_amount numeric(14, 2) not null check (budget_amount >= 0),
  -- variance thresholds: amber when actuals exceed amber_pct of budget, red at red_pct.
  amber_pct     numeric(5, 2) not null default 80 check (amber_pct between 0 and 100),
  red_pct       numeric(5, 2) not null default 100 check (red_pct between 0 and 200),
  approved_by   uuid references public.users (id) on delete set null,
  approved_at   timestamptz not null default now(),
  unique (workspace_id)
);

comment on table public.budgets is
  'Director-approved budget per workspace (CLAUDE.md §5 module 9, §9). One per workspace.';

create index budgets_workspace_id_idx on public.budgets (workspace_id);

alter table public.budgets enable row level security;

create table public.budget_actuals (
  id          uuid primary key default gen_random_uuid(),
  budget_id   uuid not null references public.budgets (id) on delete cascade,
  amount      numeric(14, 2) not null check (amount >= 0),
  description text,
  recorded_by uuid references public.users (id) on delete set null,
  recorded_at timestamptz not null default now()
);

comment on table public.budget_actuals is
  'Actual spend recorded against a workspace budget (CLAUDE.md §9). Own-department members may record.';

create index budget_actuals_budget_id_idx on public.budget_actuals (budget_id);

alter table public.budget_actuals enable row level security;

-- ── scope helper: a budget's department (for the actuals join policies) ───────
-- resolve_scope already covers task/workspace/etc.; add budget so the audit
-- trigger and any consumer can denormalize consistently (§20 C1).
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
  elsif p_entity_type = 'user' then
    return query select u.department_id, null::uuid from public.users u where u.id = p_entity_id;
  else
    return query select null::uuid, null::uuid;
  end if;
end;
$$;
-- CREATE OR REPLACE keeps the 0013 EXECUTE revoke (signature unchanged), but
-- re-assert it for safety in case the signature ever changes.
revoke execute on function public.resolve_scope(text, uuid) from public, authenticated, anon;

-- ── budget_variance(): the one place variance + rag is computed ──────────────
-- SECURITY INVOKER → RLS-scoped; returns one row per budget the caller can see.
create or replace function public.budget_variance()
returns table (
  budget_id uuid,
  workspace_id uuid,
  budget_amount numeric,
  actual_total numeric,
  remaining numeric,
  pct_used numeric,
  rag public.rag_status
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    b.id,
    b.workspace_id,
    b.budget_amount,
    coalesce(sum(a.amount), 0) as actual_total,
    b.budget_amount - coalesce(sum(a.amount), 0) as remaining,
    case when b.budget_amount > 0
      then round(coalesce(sum(a.amount), 0) / b.budget_amount * 100, 1)
      else 0 end as pct_used,
    case
      when b.budget_amount > 0 and coalesce(sum(a.amount), 0) / b.budget_amount * 100 >= b.red_pct then 'red'::public.rag_status
      when b.budget_amount > 0 and coalesce(sum(a.amount), 0) / b.budget_amount * 100 >= b.amber_pct then 'amber'::public.rag_status
      else 'green'::public.rag_status
    end as rag
  from public.budgets b
  left join public.budget_actuals a on a.budget_id = b.id
  group by b.id, b.workspace_id, b.budget_amount, b.amber_pct, b.red_pct
$$;

comment on function public.budget_variance() is
  'The single budget variance + RAG computation (CLAUDE.md §9). SECURITY INVOKER → RLS-scoped per caller. The one place variance is derived.';

grant execute on function public.budget_variance() to authenticated;

-- ── audit triggers (reuse generic, §20 C1) ───────────────────────────────────
create trigger audit_budgets
  after insert or update or delete on public.budgets
  for each row execute function public.audit_capture('budget');

-- ── RLS: budgets ──────────────────────────────────────────────────────────────
-- Read: own department (via workspace) or exec.
create policy "budgets read: own department or exec"
  on public.budgets for select to authenticated
  using ( public.belongs_to_my_department(workspace_id) or public.is_executive() );

-- Insert/Update/Delete: director/exec of the owning department (budget is
-- director-approved, §9). Members cannot set budgets.
create policy "budgets insert: own-dept director or exec"
  on public.budgets for insert to authenticated
  with check (
    public.is_executive()
    or (public.belongs_to_my_department(workspace_id) and public.is_director_or_executive())
  );
create policy "budgets update: own-dept director or exec"
  on public.budgets for update to authenticated
  using (
    public.is_executive()
    or (public.belongs_to_my_department(workspace_id) and public.is_director_or_executive())
  )
  with check (
    public.is_executive()
    or (public.belongs_to_my_department(workspace_id) and public.is_director_or_executive())
  );
create policy "budgets delete: own-dept director or exec"
  on public.budgets for delete to authenticated
  using (
    public.is_executive()
    or (public.belongs_to_my_department(workspace_id) and public.is_director_or_executive())
  );

-- ── RLS: budget_actuals (scoped via the parent budget's workspace) ───────────
-- Read: anyone who can see the budget. Write: own-department member+ (recording
-- spend is a normal member activity), or exec.
create policy "actuals read: visible budget or exec"
  on public.budget_actuals for select to authenticated
  using (
    public.is_executive()
    or exists (
      select 1 from public.budgets b
      where b.id = budget_actuals.budget_id
        and public.belongs_to_my_department(b.workspace_id)
    )
  );

create policy "actuals insert: own-department or exec"
  on public.budget_actuals for insert to authenticated
  with check (
    public.is_executive()
    or exists (
      select 1 from public.budgets b
      where b.id = budget_actuals.budget_id
        and public.belongs_to_my_department(b.workspace_id)
    )
  );

create policy "actuals update: own-department or exec"
  on public.budget_actuals for update to authenticated
  using (
    public.is_executive()
    or exists (
      select 1 from public.budgets b
      where b.id = budget_actuals.budget_id
        and public.belongs_to_my_department(b.workspace_id)
    )
  )
  with check (
    public.is_executive()
    or exists (
      select 1 from public.budgets b
      where b.id = budget_actuals.budget_id
        and public.belongs_to_my_department(b.workspace_id)
    )
  );

create policy "actuals delete: own-department or exec"
  on public.budget_actuals for delete to authenticated
  using (
    public.is_executive()
    or exists (
      select 1 from public.budgets b
      where b.id = budget_actuals.budget_id
        and public.belongs_to_my_department(b.workspace_id)
    )
  );

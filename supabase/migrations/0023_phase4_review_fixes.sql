-- 0023_phase4_review_fixes.sql
-- Phase 4 review fixes (built-in /code-review deep pass + adversarial verify).
--
-- F1 (governance gap, confirmed): budget_actuals had NO audit trigger — spend
--   entries escaped the append-only audit log (§6 non-negotiable #2). The
--   §20 C1 invariant (every auditable table: audit_capture + a resolve_scope
--   branch) was only half-applied in Phase 4 (budgets got it, actuals didn't).
--   Fix: add the resolve_scope('budget_actual') branch AND the trigger together.
--
-- F2 (correctness, confirmed by exploit): budget_variance() returned 'green' for
--   a zero budget with any spend (both red/amber arms gate on budget_amount>0,
--   so spend-on-zero fell through to green). €50k on a €0 budget showed
--   on-track. Fix: any spend on a zero (or absent) budget is RED.

-- ── F1: resolve_scope gains a budget_actual branch (join through the budget) ──
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
  elsif p_entity_type = 'user' then
    return query select u.department_id, null::uuid from public.users u where u.id = p_entity_id;
  else
    return query select null::uuid, null::uuid;
  end if;
end;
$$;
revoke execute on function public.resolve_scope(text, uuid) from public, authenticated, anon;

-- audit budget_actuals (reuse the generic trigger, §20 C1)
create trigger audit_budget_actuals
  after insert or update or delete on public.budget_actuals
  for each row execute function public.audit_capture('budget_actual');

-- ── F2: zero/absent budget with spend is RED, not green ──────────────────────
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
      -- Spend against a zero (or unset) budget is an overspend → RED.
      when b.budget_amount = 0 and coalesce(sum(a.amount), 0) > 0 then 'red'::public.rag_status
      when b.budget_amount > 0 and coalesce(sum(a.amount), 0) / b.budget_amount * 100 >= b.red_pct then 'red'::public.rag_status
      when b.budget_amount > 0 and coalesce(sum(a.amount), 0) / b.budget_amount * 100 >= b.amber_pct then 'amber'::public.rag_status
      else 'green'::public.rag_status
    end as rag
  from public.budgets b
  left join public.budget_actuals a on a.budget_id = b.id
  group by b.id, b.workspace_id, b.budget_amount, b.amber_pct, b.red_pct
$$;
grant execute on function public.budget_variance() to authenticated;

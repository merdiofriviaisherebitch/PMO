-- 0034_baseline_budget_snapshot.sql
-- C2 (Codex/Gemini adjudication): §3 + §5 define the baseline delta as showing
-- schedule variance, scope drift AND budget variance, but lock_baseline() captured
-- only workspaces + tasks — so the single delta() module (§20 C4) could never
-- surface budget drift. Add the workspace's locked budget_amount to the snapshot;
-- computeDelta + its consumers gain budgetVariances in the app layer (lib/data/delta.ts).
--
-- (The `revisions` table remains intentionally unwired: no flow records revisions
-- yet, and shipping an unused write path would violate §17 "do not over-engineer".
-- It is tracked as a deferred enhancement, not built speculatively.)
--
-- Preserves 0019's M2 empty-snapshot guard verbatim; only the per-workspace
-- 'budget_amount' key is new.
create or replace function public.lock_baseline(p_project_id uuid, p_name text)
returns public.baselines
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_snapshot jsonb;
  v_row public.baselines;
begin
  select jsonb_build_object(
    'project_id', p_project_id,
    'captured_at', now(),
    'workspaces', coalesce((
      select jsonb_agg(jsonb_build_object(
        'workspace_id', w.id,
        'department_id', w.department_id,
        'rag_status', w.rag_status,
        -- C2: locked budget at snapshot time (null when the workspace has no budget).
        'budget_amount', (select bd.budget_amount from public.budgets bd where bd.workspace_id = w.id),
        'tasks', coalesce((
          select jsonb_agg(jsonb_build_object(
            'task_id', t.id,
            'title', t.title,
            'rag_status', t.rag_status,
            'start_date', t.start_date,
            'due_date', t.due_date
          ) order by t.created_at)
          from public.tasks t where t.workspace_id = w.id
        ), '[]'::jsonb)
      ) order by w.created_at)
      from public.department_workspaces w where w.project_id = p_project_id
    ), '[]'::jsonb)
  ) into v_snapshot;

  -- A baseline over zero workspaces is almost always a mistake (wrong project, or a
  -- non-exec caller whose RLS hid everything). Fail loudly, don't lock junk (0019 M2).
  if jsonb_array_length(v_snapshot -> 'workspaces') = 0 then
    raise exception 'Refusing to lock a baseline with no visible workspaces for project %', p_project_id
      using errcode = 'check_violation';
  end if;

  insert into public.baselines (project_id, name, snapshot, locked_by)
  values (p_project_id, p_name, v_snapshot, (select auth.uid()))
  returning * into v_row;

  return v_row;
end;
$$;

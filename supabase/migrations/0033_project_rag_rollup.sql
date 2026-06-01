-- 0033_project_rag_rollup.sql
-- C8 (Codex/Gemini adjudication, confirmed): the executive dashboard reads
-- projects.status (lib/data/dashboard.ts getRagRollup), but nothing maintained it —
-- it was whatever a user typed at create time. §5 module 3 requires a project to
-- AGGREGATE its department workspaces' RAG into an executive-visible roll-up.
--
-- Fix: keep projects.status = worst-case(red > amber > green) across the project's
-- department_workspaces, via an AFTER trigger on workspace RAG changes. Updating
-- projects.status fires the existing rag_history_projects + audit_projects triggers,
-- so each roll-up transition is itself recorded (§9). A project with NO workspaces
-- keeps its seeded status (the roll-up is a no-op) so a freshly-created project is
-- not forced green before any department is assigned. No recursion: the workspace
-- trigger writes projects, whose triggers never write department_workspaces.

create or replace function public.recompute_project_rag(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rag public.rag_status;
begin
  if p_project_id is null then return; end if;
  -- No workspaces yet → leave the seeded status untouched.
  if not exists (select 1 from public.department_workspaces where project_id = p_project_id) then
    return;
  end if;

  select case
           when count(*) filter (where rag_status = 'red')   > 0 then 'red'
           when count(*) filter (where rag_status = 'amber') > 0 then 'amber'
           else 'green'
         end::public.rag_status
    into v_rag
  from public.department_workspaces
  where project_id = p_project_id;

  update public.projects
  set status = v_rag
  where id = p_project_id and status is distinct from v_rag;
end;
$$;

comment on function public.recompute_project_rag(uuid) is
  'Rolls department_workspace RAG up to projects.status as worst-case (CLAUDE.md §5 module 3). No-op for a project with no workspaces (preserves its seeded status).';

revoke execute on function public.recompute_project_rag(uuid) from public, authenticated, anon;

create or replace function public.project_rag_rollup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform public.recompute_project_rag(old.project_id);
  else
    perform public.recompute_project_rag(new.project_id);
    -- A workspace reassigned to a different project must refresh both projects.
    if tg_op = 'UPDATE' and new.project_id is distinct from old.project_id then
      perform public.recompute_project_rag(old.project_id);
    end if;
  end if;
  return null;
end;
$$;

comment on function public.project_rag_rollup() is
  'AFTER trigger on department_workspaces keeping projects.status in sync with worst-case workspace RAG (CLAUDE.md §5 module 3).';

revoke execute on function public.project_rag_rollup() from public, authenticated, anon;

create trigger project_rag_rollup_trg
  after insert or update of rag_status, project_id or delete on public.department_workspaces
  for each row execute function public.project_rag_rollup();

-- Backfill existing projects from their current workspaces.
do $$
declare
  r record;
begin
  for r in select distinct project_id from public.department_workspaces loop
    perform public.recompute_project_rag(r.project_id);
  end loop;
end $$;

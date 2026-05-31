-- 0015_workspace_rag_director_only.sql
-- Phase 2 review fix: a workspace's RAG health is a DIRECTOR/EXECUTIVE concern,
-- not a member one (CLAUDE.md §4: members enter tasks; directors own their
-- department's status). Migration 0014's UPDATE policy keyed only on department,
-- so any member of the owning department could change workspace RAG. Tighten it
-- to require director-or-executive.
--
-- Add a small role helper alongside is_executive() so the predicate is named
-- once and reused (no inline role-string checks scattered across policies, §20).

create or replace function public.is_director_or_executive()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select auth.jwt()) ->> 'user_role', '') in ('director', 'executive')
$$;

comment on function public.is_director_or_executive() is
  'True if the JWT user_role claim is director or executive (CLAUDE.md §4). Used to gate department-level governance writes (e.g. workspace RAG).';

revoke execute on function public.is_director_or_executive() from public;
grant execute on function public.is_director_or_executive() to authenticated;

-- Replace the 0014 workspace UPDATE policy with a director/exec-gated one.
drop policy if exists "workspaces update: own department or exec"
  on public.department_workspaces;

create policy "workspaces update: own-dept director or exec"
  on public.department_workspaces for update to authenticated
  using (
    public.is_executive()
    or (
      department_id = public.current_department()
      and public.is_director_or_executive()
    )
  )
  with check (
    public.is_executive()
    or (
      department_id = public.current_department()
      and public.is_director_or_executive()
    )
  );

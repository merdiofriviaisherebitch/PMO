-- 0014_core_write_policies.sql
-- Phase 2 write-path RLS (CLAUDE.md §13 gate "CRUD respects RLS", §4 roles).
-- Phase 1 (0010) shipped SELECT isolation everywhere + full tasks CRUD. This
-- migration adds the remaining write policies for the governance hierarchy, with
-- the role model from §4:
--   * projects + workspace STRUCTURE (which departments are in a project) are
--     executive/PMO actions — members never create projects or add/remove
--     workspaces.
--   * a workspace's OWN rag_status is department-level — a director/member sets
--     their own workspace health, never another department's, and can never
--     move the workspace to a different department (WITH CHECK pins it).
-- tasks INSERT/UPDATE/DELETE already exist in 0010 (own-department-or-exec).

-- ── projects: executive/PMO only for all writes ──────────────────────────────
-- SELECT policy already exists (0010). Writes are exec-only; PostgREST UPDATE
-- also needs the existing SELECT policy to locate the row (supabase checklist).
create policy "projects insert: exec only"
  on public.projects for insert to authenticated
  with check ( public.is_executive() );

create policy "projects update: exec only"
  on public.projects for update to authenticated
  using ( public.is_executive() )
  with check ( public.is_executive() );

create policy "projects delete: exec only"
  on public.projects for delete to authenticated
  using ( public.is_executive() );

-- ── department_workspaces: structure is exec; rag is the owning department ────
-- INSERT/DELETE (adding/removing a department from a project) = exec only.
create policy "workspaces insert: exec only"
  on public.department_workspaces for insert to authenticated
  with check ( public.is_executive() );

create policy "workspaces delete: exec only"
  on public.department_workspaces for delete to authenticated
  using ( public.is_executive() );

-- UPDATE: the owning department (or an exec) may update its workspace row
-- (e.g. rag_status). WITH CHECK keeps department_id = the caller's department
-- (or exec), so a member can NEVER reassign their workspace to another
-- department and can NEVER edit another department's workspace.
create policy "workspaces update: own department or exec"
  on public.department_workspaces for update to authenticated
  using (
    department_id = public.current_department() or public.is_executive()
  )
  with check (
    department_id = public.current_department() or public.is_executive()
  );

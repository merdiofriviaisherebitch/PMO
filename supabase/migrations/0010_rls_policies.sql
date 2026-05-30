-- 0010_rls_policies.sql
-- THE department isolation mechanism (CLAUDE.md §6 non-negotiable #1, §10).
-- Numbered 0010 (gap from 0007) to reserve room and keep RLS in its own file
-- per §14. Helpers are defined ONCE and every policy reuses them — no policy
-- re-implements the predicate (§20 C5).
--
-- Performance (§10, supabase-postgres-best-practices):
--   * helpers are STABLE so the planner caches them per statement;
--   * each wraps auth.jwt() as (SELECT auth.jwt()) so it is evaluated ONCE per
--     query, not once per row;
--   * the department_id / workspace_id columns the policies key on are indexed
--     in 0004/0005.

-- ── Helpers ──────────────────────────────────────────────────────────────────
-- Defined in public (never the managed `auth` schema). Read the custom claims
-- set by the access-token hook (ADR 0001: app role lives in `user_role`).

create or replace function public.current_department()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif((select auth.jwt()) ->> 'department_id', 'null')::uuid
$$;

create or replace function public.is_executive()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select auth.jwt()) ->> 'user_role', '') = 'executive'
$$;

-- Deepen the repeated "join through workspace to a department" predicate into ONE
-- helper so no workspace-child policy re-implements the join (§20 C5).
create or replace function public.belongs_to_my_department(p_workspace_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.department_workspaces w
    where w.id = p_workspace_id
      and w.department_id = public.current_department()
  )
$$;

comment on function public.current_department() is
  'Department UUID from the JWT department_id claim (CLAUDE.md §10). STABLE; auth.jwt() wrapped in subselect for once-per-query eval.';
comment on function public.is_executive() is
  'True if the JWT user_role claim is executive (ADR 0001). The cross-department override predicate.';
comment on function public.belongs_to_my_department(uuid) is
  'True if the workspace belongs to the caller''s department (CLAUDE.md §20 C5). Single home for the workspace->department join.';

-- ── departments: everyone authenticated may read the lookup list ─────────────
-- Department names are not sensitive; rows elsewhere are what's scoped. Members
-- need the list to render labels. No INSERT/UPDATE/DELETE policy → only service
-- role (which bypasses RLS) manages departments.
create policy "authenticated can read departments"
  on public.departments
  for select
  to authenticated
  using (true);

-- ── users ────────────────────────────────────────────────────────────────────
-- Read: own row always; same-department rows; executives read all. (Directors
-- seeing their department's members is required for approvals UX.)
create policy "users read self, own-department, or all-if-exec"
  on public.users
  for select
  to authenticated
  using (
    id = (select auth.uid())
    or department_id = public.current_department()
    or public.is_executive()
  );

-- Update: a user may update only their OWN row, and the BEFORE UPDATE trigger
-- (0004) forbids changing role/department_id. WITH CHECK keeps the row theirs.
-- (Admin role/department changes go through the service role, which bypasses RLS.)
create policy "users update only their own row"
  on public.users
  for update
  to authenticated
  using ( id = (select auth.uid()) )
  with check ( id = (select auth.uid()) );

-- ── projects ─────────────────────────────────────────────────────────────────
-- A project is visible to a member if their department has a workspace in it;
-- executives see all. Writes (create/edit projects) are an executive/PMO action
-- in Phase 2+, done via server paths; no member write policy here.
create policy "projects visible via a department workspace, or all-if-exec"
  on public.projects
  for select
  to authenticated
  using (
    public.is_executive()
    or exists (
      select 1
      from public.department_workspaces w
      where w.project_id = projects.id
        and w.department_id = public.current_department()
    )
  );

-- ── department_workspaces ────────────────────────────────────────────────────
create policy "workspaces: own department or all-if-exec"
  on public.department_workspaces
  for select
  to authenticated
  using (
    department_id = public.current_department()
    or public.is_executive()
  );

-- ── tasks (join through workspace via the helper) ────────────────────────────
create policy "tasks read: own department or all-if-exec"
  on public.tasks
  for select
  to authenticated
  using (
    public.belongs_to_my_department(workspace_id)
    or public.is_executive()
  );

-- Members/directors may create/edit/delete tasks in their OWN department's
-- workspaces. Executives may write across all. Each command needs USING and/or
-- WITH CHECK; UPDATE needs both (supabase security checklist).
create policy "tasks insert: own department or exec"
  on public.tasks
  for insert
  to authenticated
  with check (
    public.belongs_to_my_department(workspace_id)
    or public.is_executive()
  );

create policy "tasks update: own department or exec"
  on public.tasks
  for update
  to authenticated
  using (
    public.belongs_to_my_department(workspace_id)
    or public.is_executive()
  )
  with check (
    public.belongs_to_my_department(workspace_id)
    or public.is_executive()
  );

create policy "tasks delete: own department or exec"
  on public.tasks
  for delete
  to authenticated
  using (
    public.belongs_to_my_department(workspace_id)
    or public.is_executive()
  );

-- ── audit_log ────────────────────────────────────────────────────────────────
-- SELECT only, scoped via the DENORMALIZED department_id (§9, §10). INSERT is
-- via the SECURITY DEFINER trigger only (no INSERT policy needed for the app
-- role); UPDATE/DELETE are revoked at the role level in 0011.
create policy "audit_log read: own department or all-if-exec"
  on public.audit_log
  for select
  to authenticated
  using (
    department_id = public.current_department()
    or public.is_executive()
  );

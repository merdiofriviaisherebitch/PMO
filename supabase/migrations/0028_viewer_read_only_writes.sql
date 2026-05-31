-- 0028_viewer_read_only_writes.sql
-- Phase 9 hardening candidate (CLAUDE.md §4: "Viewer — Read-only; no edits").
--
-- THE GAP. The task and dependency WRITE policies gate on DEPARTMENT only
-- (belongs_to_my_department / task_in_my_department) with an is_executive()
-- override, but carry NO role predicate. So a `viewer` whose department_id matches
-- can INSERT/UPDATE/DELETE tasks (0010) and create/delete intra-department
-- dependency edges (0026) — writes §4 forbids. This is a ROLE-axis hole, orthogonal
-- to the DEPARTMENT-axis isolation Phase 1 proved; it predates Phase 6 (consistent
-- across tasks since Phase 1/2, mirrored onto dependencies in Phase 6), so this is a
-- correction of a long-standing gap, not a Phase 6 regression.
--
-- THE FIX. Name the missing predicate ONCE as can_write() and AND it onto the
-- in-department write branch of each policy — exactly as 0015 added
-- is_director_or_executive() to the workspace-RAG update policy. The executive
-- override is untouched: execs still write across all departments via is_executive().
--
-- WHY AN ALLOWLIST, NOT `role <> 'viewer'`. can_write() enumerates the WRITING
-- roles (member/director/executive). A denylist would fail OPEN if the user_role
-- claim were ever null / empty / misspelled; the allowlist fails CLOSED — the same
-- defensive shape as is_executive() / is_director_or_executive() (coalesce(...,'')).
--
-- SCOPE. EVERY department-scoped DIRECT write surface that lacked a role gate is
-- closed here, so the §4 "viewer = read-only; no edits" invariant holds end-to-end:
--   * tasks              (0010) — insert / update / delete
--   * dependencies       (0026) — insert / delete  (intra-department branch only)
--   * department_updates (0017) — insert / update   (drafting/submitting a weekly update)
--   * budget_actuals     (0021) — insert / update / delete  (recording spend)
-- Surfaces already role-gated need no change: budgets + workspace-RAG use
-- is_director_or_executive(); update_cycles + projects are is_executive()-only.
-- audit_log / rag_status_history / approvals are written only by SECURITY DEFINER
-- triggers / the service role (no app-role write policy), so a viewer cannot reach
-- them regardless. (CLAUDE.md §4, §9, §17.)

-- ── role helper: may the caller's role write at all? ─────────────────────────
-- SECURITY INVOKER (default) + STABLE, like is_executive() / is_director_or_executive():
-- it runs under the caller's RLS and returns only the caller's OWN claim-derived
-- role, so granting EXECUTE to `authenticated` discloses nothing cross-department
-- (cf. 0013's note on the other claim helpers). Reads the custom `user_role` claim
-- (ADR 0001), NOT the reserved `role` claim. auth.jwt() wrapped in a subselect so it
-- is evaluated once per query, not once per row (RLS perf pattern, §10).
create or replace function public.can_write()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select auth.jwt()) ->> 'user_role', '') in ('member', 'director', 'executive')
$$;

comment on function public.can_write() is
  'True if the JWT user_role claim is a WRITING role (member/director/executive) — i.e. NOT viewer (CLAUDE.md §4). Allowlist so a null/unknown role fails closed. AND-ed onto every department-scoped write policy alongside the department predicate.';

revoke execute on function public.can_write() from public;
grant execute on function public.can_write() to authenticated;

-- ── tasks: require a writing role on the own-department branch (was dept-only) ─
drop policy if exists "tasks insert: own department or exec" on public.tasks;
create policy "tasks insert: own-dept writer or exec"
  on public.tasks for insert to authenticated
  with check (
    public.is_executive()
    or (public.belongs_to_my_department(workspace_id) and public.can_write())
  );

drop policy if exists "tasks update: own department or exec" on public.tasks;
create policy "tasks update: own-dept writer or exec"
  on public.tasks for update to authenticated
  using (
    public.is_executive()
    or (public.belongs_to_my_department(workspace_id) and public.can_write())
  )
  with check (
    public.is_executive()
    or (public.belongs_to_my_department(workspace_id) and public.can_write())
  );

drop policy if exists "tasks delete: own department or exec" on public.tasks;
create policy "tasks delete: own-dept writer or exec"
  on public.tasks for delete to authenticated
  using (
    public.is_executive()
    or (public.belongs_to_my_department(workspace_id) and public.can_write())
  );

-- ── dependencies: same role gate on the intra-department write branch ─────────
-- Cross-department edges remain exec-only via is_executive() (ADR 0002); we only
-- AND can_write() onto the intra-department (both-endpoints-in-dept) branch, so a
-- viewer can no longer create or delete even a wholly-own-department edge.
drop policy if exists "dependencies insert: both endpoints in-dept, or exec" on public.dependencies;
create policy "dependencies insert: both endpoints in-dept writer, or exec"
  on public.dependencies for insert to authenticated
  with check (
    public.is_executive()
    or (
      public.task_in_my_department(source_task_id)
      and public.task_in_my_department(target_task_id)
      and public.can_write()
    )
  );

drop policy if exists "dependencies delete: both endpoints in-dept, or exec" on public.dependencies;
create policy "dependencies delete: both endpoints in-dept writer, or exec"
  on public.dependencies for delete to authenticated
  using (
    public.is_executive()
    or (
      public.task_in_my_department(source_task_id)
      and public.task_in_my_department(target_task_id)
      and public.can_write()
    )
  );

-- ── department_updates: a viewer must not draft or submit a weekly update ─────
-- The 0017 transition guard still governs WHICH status move a writing role may make;
-- can_write() only stops a viewer from writing at all. (Drafting/submitting an update
-- is a governance act — §4, §5 module 2.)
-- CRITICAL: the LIVE insert policy is 0019's "…draft only", which RENAMED 0017's and
-- pinned the starting state to 'draft' to kill self-approval-via-insert (B1, a
-- confirmed exploit). We must DROP THAT name and PRESERVE the status='draft' pin while
-- adding the viewer gate — dropping the original 0017 name is a no-op that would leave
-- 0019's policy OR-combined with a non-pinning one, reopening B1 (pen-test TEST 25).
drop policy if exists "updates insert: own department, draft only" on public.department_updates;
create policy "updates insert: own-dept writer, draft only"
  on public.department_updates for insert to authenticated
  with check (
    status = 'draft'
    and (
      public.is_executive()
      or (public.belongs_to_my_department(workspace_id) and public.can_write())
    )
  );

drop policy if exists "updates update: own department or exec" on public.department_updates;
create policy "updates update: own-dept writer or exec"
  on public.department_updates for update to authenticated
  using (
    public.is_executive()
    or (public.belongs_to_my_department(workspace_id) and public.can_write())
  )
  with check (
    public.is_executive()
    or (public.belongs_to_my_department(workspace_id) and public.can_write())
  );

-- ── budget_actuals: a viewer must not record / edit / delete spend ────────────
-- The department check joins THROUGH budgets (budget_actuals has no workspace_id of
-- its own), so can_write() is AND-ed alongside the EXISTS rather than folded into it.
drop policy if exists "actuals insert: own-department or exec" on public.budget_actuals;
create policy "actuals insert: own-dept writer or exec"
  on public.budget_actuals for insert to authenticated
  with check (
    public.is_executive()
    or (
      public.can_write()
      and exists (
        select 1 from public.budgets b
        where b.id = budget_actuals.budget_id
          and public.belongs_to_my_department(b.workspace_id)
      )
    )
  );

drop policy if exists "actuals update: own-department or exec" on public.budget_actuals;
create policy "actuals update: own-dept writer or exec"
  on public.budget_actuals for update to authenticated
  using (
    public.is_executive()
    or (
      public.can_write()
      and exists (
        select 1 from public.budgets b
        where b.id = budget_actuals.budget_id
          and public.belongs_to_my_department(b.workspace_id)
      )
    )
  )
  with check (
    public.is_executive()
    or (
      public.can_write()
      and exists (
        select 1 from public.budgets b
        where b.id = budget_actuals.budget_id
          and public.belongs_to_my_department(b.workspace_id)
      )
    )
  );

drop policy if exists "actuals delete: own-department or exec" on public.budget_actuals;
create policy "actuals delete: own-dept writer or exec"
  on public.budget_actuals for delete to authenticated
  using (
    public.is_executive()
    or (
      public.can_write()
      and exists (
        select 1 from public.budgets b
        where b.id = budget_actuals.budget_id
          and public.belongs_to_my_department(b.workspace_id)
      )
    )
  );

-- 0019_phase3_review_fixes.sql
-- Phase 3 review fixes (two fresh-context reviewers + adversarial verification).
--
-- B1 (BLOCKER, confirmed by exploit): a member could INSERT a department_update
--   with status='approved' directly via PostgREST, bypassing the entire approval
--   state machine — the transition guard is BEFORE UPDATE only and the INSERT
--   policy didn't constrain status. Fix: a new department_update may ONLY be
--   created in 'draft'. (Belt: a CHECK-style guard in the INSERT WITH CHECK.)
--
-- Content-edit hole (M3, confirmed): the UPDATE policy let an own-department
--   member overwrite the content of an already approved/pending update (the
--   transition guard passed through when status was unchanged). Fix: the guard
--   now rejects content edits once a row leaves draft/rejected, unless the actor
--   is a director/executive.
--
-- M1 (defense-in-depth): if scope can't be resolved (e.g. workspace deleted
--   mid-transaction) the approval row would record NULL scope and become
--   invisible to directors. Fix: raise instead of logging a corrupt row.
--
-- NOT changed: resolve_scope EXECUTE — verified still revoked after the 0017
--   CREATE OR REPLACE (authenticated has no execute); and lock_baseline EXECUTE
--   stays granted to authenticated BY DESIGN (executives are the `authenticated`
--   Postgres role; the baselines INSERT policy is the exec gate; revoking would
--   break locking for everyone).

-- ── B1: lock the INSERT starting state to 'draft' ────────────────────────────
drop policy if exists "updates insert: own department or exec"
  on public.department_updates;

create policy "updates insert: own department, draft only"
  on public.department_updates for insert to authenticated
  with check (
    status = 'draft'
    and (public.belongs_to_my_department(workspace_id) or public.is_executive())
  );

-- ── B1 belt + content-edit hole: rebuild the transition guard ────────────────
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
  v_is_dir boolean := v_role in ('director', 'executive');
begin
  -- Content (or any non-status) edit with status unchanged: only allowed while
  -- the update is still draft/rejected. Once pending/approved, the reviewed
  -- content is frozen for members (a director/exec may still correct it).
  if new.status is not distinct from old.status then
    if (new.content is distinct from old.content)
       and old.status not in ('draft', 'rejected')
       and not v_is_dir then
      raise exception
        'This update is % and can no longer be edited', old.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- Status transitions by role:
  if old.status = 'draft' and new.status = 'pending' then
    new.submitted_by := v_actor; new.submitted_at := now();
  elsif old.status = 'rejected' and new.status = 'draft' then
    null;  -- resubmission path
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

  -- M1: scope must resolve, or we'd write a director-invisible audit row.
  select s.department_id, s.project_id into v_scope
  from public.resolve_scope('department_update', new.id) s;
  if v_scope.department_id is null and v_scope.project_id is null then
    raise exception 'Cannot resolve scope for update % — transition aborted', new.id
      using errcode = 'check_violation';
  end if;

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

revoke execute on function public.enforce_update_transition() from public, authenticated, anon;

-- ── M2: lock_baseline refuses to capture an empty snapshot ───────────────────
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

  -- A baseline over zero workspaces is almost always a mistake (wrong project,
  -- or a non-exec caller whose RLS hid everything). Fail loudly, don't lock junk.
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

-- 0018_baselines_revisions.sql
-- Baseline lock + revisions (CLAUDE.md §5 module 5, §9). A baseline is a LOCKED
-- snapshot of a project plan (scope/schedule/budget) at a point in time. Once
-- locked it is immutable — only a new revision records subsequent change. The
-- current-vs-baseline diff is computed by the single delta() module in app code
-- (§5, §20 C4), never recomputed per consumer.
--
-- Locking authority: executive/PMO by default (CLAUDE.md §18 Q9 — confirm with
-- client; this is the safe default and matches the projects-are-exec model).

create table public.baselines (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  name       text not null,
  snapshot   jsonb not null,           -- full serialized project state at lock time
  locked_by  uuid references public.users (id) on delete set null,
  locked_at  timestamptz not null default now()
);

comment on table public.baselines is
  'Immutable locked snapshot of a project plan (CLAUDE.md §5). UPDATE/DELETE revoked; new change is recorded as a revision.';

create index baselines_project_id_idx on public.baselines (project_id);

alter table public.baselines enable row level security;

create table public.revisions (
  id          uuid primary key default gen_random_uuid(),
  baseline_id uuid not null references public.baselines (id) on delete cascade,
  delta       jsonb not null,          -- computed by the single delta() module (§20 C4)
  created_by  uuid references public.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

comment on table public.revisions is
  'A recorded change against a locked baseline (CLAUDE.md §5). delta is produced by the one delta() module, never diffed ad hoc.';

create index revisions_baseline_id_idx on public.revisions (baseline_id);

alter table public.revisions enable row level security;

-- ── lock_baseline(): serialize current project state into an immutable snapshot
-- SECURITY INVOKER so it runs under the caller's RLS — an exec sees the whole
-- project; a non-exec simply can't insert (policy below) so this is exec-path.
-- Captures workspaces + their tasks as the snapshot shape the delta() module
-- expects.
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

  insert into public.baselines (project_id, name, snapshot, locked_by)
  values (p_project_id, p_name, v_snapshot, (select auth.uid()))
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.lock_baseline(uuid, text) is
  'Serializes current project state (workspaces+tasks) into an immutable baseline snapshot (CLAUDE.md §5). SECURITY INVOKER: relies on the baselines INSERT policy to gate to executives.';

-- ── audit triggers (reuse generic, §20 C1) ───────────────────────────────────
create trigger audit_baselines
  after insert or update or delete on public.baselines
  for each row execute function public.audit_capture('baseline');

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Baselines/revisions are project-scoped. A user may READ a baseline for a
-- project they can see (i.e. their department has a workspace in it), or exec.
create policy "baselines read: visible project or exec"
  on public.baselines for select to authenticated
  using (
    public.is_executive()
    or exists (
      select 1 from public.department_workspaces w
      where w.project_id = baselines.project_id
        and w.department_id = public.current_department()
    )
  );

-- Lock (INSERT) is executive/PMO only (§18 Q9 default).
create policy "baselines insert: exec only"
  on public.baselines for insert to authenticated
  with check ( public.is_executive() );

-- Immutability: UPDATE/DELETE revoked at the role level — a locked baseline can
-- never be altered (CLAUDE.md §5). New change goes through revisions.
revoke update, delete on public.baselines from authenticated, anon;

create policy "revisions read: visible project or exec"
  on public.revisions for select to authenticated
  using (
    public.is_executive()
    or exists (
      select 1
      from public.baselines b
      join public.department_workspaces w on w.project_id = b.project_id
      where b.id = revisions.baseline_id
        and w.department_id = public.current_department()
    )
  );

create policy "revisions insert: exec only"
  on public.revisions for insert to authenticated
  with check ( public.is_executive() );

revoke update, delete on public.revisions from authenticated, anon;

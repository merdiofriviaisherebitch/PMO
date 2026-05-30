-- 0005_projects_workspaces_tasks.sql
-- Core governance hierarchy (CLAUDE.md §5 module 1, §9):
--   projects ──< department_workspaces (one per dept involved) ──< tasks
-- A project spans one or more departments; each department only ever sees its
-- own workspace and the tasks under it. Isolation is enforced in 0010 via RLS.

create table public.projects (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  description  text,
  status       public.rag_status not null default 'green',
  owner_id     uuid references public.users (id) on delete set null,
  created_at   timestamptz not null default now()
);

comment on table public.projects is
  'A governance project spanning >=1 departments (CLAUDE.md §5, §9).';

alter table public.projects enable row level security;

-- ── department_workspaces: the project × department intersection ─────────────
create table public.department_workspaces (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  department_id  uuid not null references public.departments (id) on delete restrict,
  rag_status     public.rag_status not null default 'green',
  created_at     timestamptz not null default now(),
  unique (project_id, department_id)
);

comment on table public.department_workspaces is
  'A department''s scoped area within a project (CLAUDE.md §3 "Department workspace"). Carries department_id — the column RLS keys on.';

-- department_id drives the workspace SELECT policy; project_id is a frequent join.
create index department_workspaces_department_id_idx on public.department_workspaces (department_id);
create index department_workspaces_project_id_idx on public.department_workspaces (project_id);

alter table public.department_workspaces enable row level security;

-- ── tasks: a department's work items within a workspace ──────────────────────
create table public.tasks (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.department_workspaces (id) on delete cascade,
  title                text not null,
  description          text,
  assignee_id          uuid references public.users (id) on delete set null,
  rag_status           public.rag_status not null default 'green',
  start_date           date,
  due_date             date,
  baseline_start_date  date,  -- snapshot at baseline lock (§5); delta() diffs against these
  baseline_due_date    date,
  created_at           timestamptz not null default now(),
  created_by           uuid references public.users (id) on delete set null
);

comment on table public.tasks is
  'Department task within a workspace (CLAUDE.md §5, §9). Scoped via workspace_id -> department (RLS helper belongs_to_my_department).';

-- workspace_id is the RLS join key (tasks -> workspace -> department) → index it.
create index tasks_workspace_id_idx on public.tasks (workspace_id);
create index tasks_assignee_id_idx on public.tasks (assignee_id);

alter table public.tasks enable row level security;

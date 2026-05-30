-- 0003_departments.sql
-- The 9 SolServices departments (CLAUDE.md §2, §9). The unit of isolation:
-- every department-scoped row carries a department_id and RLS keys on it.

create table public.departments (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);

comment on table public.departments is
  'The 9 SolServices departments. Unit of RLS isolation (CLAUDE.md §2, §10).';

-- RLS enabled now; policies added in 0010 (CLAUDE.md §6 non-negotiable #1:
-- every table in an exposed schema must have RLS enabled).
alter table public.departments enable row level security;

-- Seed the 9 canonical departments (CLAUDE.md §2). Idempotent.
insert into public.departments (name) values
  ('Accounting'),
  ('Legal'),
  ('Finance'),
  ('Geothermal'),
  ('Back Office'),
  ('IT'),
  ('Technical'),
  ('Lumentrade'),
  ('Project Development')
on conflict (name) do nothing;

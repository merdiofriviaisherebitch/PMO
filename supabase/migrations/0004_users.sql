-- 0004_users.sql
-- Application user profiles, keyed to Supabase auth.users by id (CLAUDE.md §9).
-- This table is the SECURITY KEYSTONE: the custom access token hook reads
-- `role` and `department_id` from here at token issuance (§4, §10), so a user
-- must NEVER be able to change their own role/department (that would defeat all
-- department isolation). Enforced two ways below: a column-safe UPDATE policy
-- (0010) AND a BEFORE UPDATE trigger here.

create table public.users (
  id             uuid primary key references auth.users (id) on delete cascade,
  department_id  uuid references public.departments (id) on delete restrict,
  role           public.user_role not null default 'member',
  email          text not null,
  display_name   text,
  entra_oid      text unique,  -- Entra `oid` claim for stable cross-system identity (§12); null until SSO
  created_at     timestamptz not null default now()
);

comment on table public.users is
  'App user profiles (id = auth.uid). role + department_id are read by the access-token hook (CLAUDE.md §10) and are NOT self-editable.';
comment on column public.users.role is
  'Application role, surfaced in the JWT as the custom `user_role` claim (ADR 0001). Self-update forbidden.';

-- FK used by RLS helper joins and by the hook lookup → index it (§10 perf note).
create index users_department_id_idx on public.users (department_id);

alter table public.users enable row level security;

-- ── Guard: forbid self-change of role / department_id ────────────────────────
-- RLS WITH CHECK cannot compare NEW vs OLD, so we add a trigger. It allows the
-- privileged roles (service_role for admin ops, supabase_auth_admin for the
-- hook) through, but blocks a normal user from escalating their own row.
create or replace function public.enforce_user_self_update_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Privileged paths (service role, auth admin) may change anything.
  if current_user in ('service_role', 'supabase_auth_admin', 'postgres') then
    return new;
  end if;

  if new.role is distinct from old.role
     or new.department_id is distinct from old.department_id then
    raise exception
      'Users cannot change their own role or department_id (CLAUDE.md §4, §10)'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger users_self_update_guard
  before update on public.users
  for each row
  execute function public.enforce_user_self_update_guard();

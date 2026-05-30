-- 0007_access_token_hook.sql
-- Custom Access Token Hook (CLAUDE.md §4, §10). Runs at token issuance as the
-- `supabase_auth_admin` role and stamps the user's app role + department into
-- the JWT so RLS policies can trust them. The user never sets these — they are
-- read server-side from public.users.
--
-- IMPORTANT (ADR 0001): we write the app role to a custom `user_role` claim and
-- leave the reserved `role` claim (= the Postgres role PostgREST assumes)
-- untouched. Overwriting `role` would break PostgREST/Realtime.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claims    jsonb;
  v_role    public.user_role;
  v_dept    uuid;
begin
  select u.role, u.department_id
    into v_role, v_dept
  from public.users u
  where u.id = (event->>'user_id')::uuid;

  claims := event->'claims';

  -- App role as a dedicated claim (NOT the reserved `role`).
  if v_role is not null then
    claims := jsonb_set(claims, '{user_role}', to_jsonb(v_role::text));
  else
    claims := jsonb_set(claims, '{user_role}', 'null'::jsonb);
  end if;

  -- Department as a top-level claim; null encodes "no department" (e.g. a
  -- not-yet-provisioned user). Executives typically carry a department too but
  -- gain cross-department read via is_executive(), not via department match.
  if v_dept is not null then
    claims := jsonb_set(claims, '{department_id}', to_jsonb(v_dept::text));
  else
    claims := jsonb_set(claims, '{department_id}', 'null'::jsonb);
  end if;

  event := jsonb_set(event, '{claims}', claims);
  return event;
end;
$$;

comment on function public.custom_access_token_hook(jsonb) is
  'Stamps user_role + department_id claims into the JWT from public.users (CLAUDE.md §10, ADR 0001). Runs as supabase_auth_admin at token issuance.';

-- ── Grants: only the auth admin may execute the hook and read the table ───────
grant usage on schema public to supabase_auth_admin;

grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;

-- The hook (running as supabase_auth_admin) must read public.users. Grant it,
-- and add an RLS policy permitting that role to SELECT (RLS is on for users).
grant select on public.users to supabase_auth_admin;

create policy "auth admin can read users for the token hook"
  on public.users
  as permissive
  for select
  to supabase_auth_admin
  using (true);

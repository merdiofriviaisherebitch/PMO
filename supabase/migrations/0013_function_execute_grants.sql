-- 0013_function_execute_grants.sql
-- Lock down EXECUTE on internal / SECURITY DEFINER functions (Phase 1 security
-- review, HIGH H1). Postgres grants EXECUTE to PUBLIC by default for every new
-- function, so a SECURITY DEFINER function in `public` is silently a public RPC
-- endpoint (supabase security checklist).
--
-- resolve_scope() is SECURITY DEFINER and reads tasks/workspaces/projects/users
-- with RLS bypassed. If callable via PostgREST (/rest/v1/rpc/resolve_scope), any
-- authenticated member could resolve the department_id/project_id of ANY task
-- UUID they enumerate — a cross-department metadata disclosure. It is only ever
-- called from audit_capture() (a trigger running as the owner), so it needs no
-- caller-facing grant.
revoke execute on function public.resolve_scope(text, uuid) from public, authenticated, anon;

-- These are trigger functions (return trigger; not RPC-exposable by PostgREST),
-- but revoke anyway for defense-in-depth and to remove any ambiguity about the
-- intended caller set.
revoke execute on function public.audit_capture() from public, authenticated, anon;
revoke execute on function public.enforce_user_self_update_guard() from public, authenticated, anon;

-- NOTE: current_department(), is_executive(), belongs_to_my_department() are
-- intentionally left executable by `authenticated` — they are SECURITY INVOKER,
-- run under the caller's RLS, and only ever return the caller's OWN claim-derived
-- info (your department, your role, whether a workspace you can already see is
-- yours). Policies depend on them. No cross-department information is exposed.

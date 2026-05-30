-- 0011_audit_immutability.sql
-- Enforce the append-only guarantee at the ROLE level (CLAUDE.md §6 #2, §17).
-- The audit_log is written ONLY by the SECURITY DEFINER trigger audit_capture()
-- (which runs as the definer, bypassing these grants). The application roles
-- (`authenticated`, `anon`) must be unable to UPDATE or DELETE audit rows, and
-- must not INSERT directly either — all writes go through the trigger.
--
-- Tested by the pen-test (§15 items 5–6): UPDATE/DELETE as the app role fail.

-- Revoke everything, then grant back only SELECT (RLS in 0010 scopes which rows).
revoke all on public.audit_log from authenticated, anon;
grant select on public.audit_log to authenticated;

-- Direct INSERT/UPDATE/DELETE are NOT granted to authenticated/anon → blocked.
-- The trigger function is SECURITY DEFINER (owned by postgres), so it still
-- writes successfully regardless of the caller's grants.

comment on table public.audit_log is
  'Append-only. SELECT granted to authenticated (RLS-scoped); INSERT/UPDATE/DELETE NOT granted to app roles — written only by audit_capture() SECURITY DEFINER trigger (CLAUDE.md §6 #2).';

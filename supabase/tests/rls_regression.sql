-- rls_regression.sql — exhaustive, catalog-driven isolation regression (§15).
-- Runs on every migration in CI. Enumerates EVERY base table in `public` from
-- the catalog and asserts RLS is ENABLED on each. A new table or a dropped
-- ENABLE fails the build immediately — so isolation can never silently regress.
--
-- Tables that are intentionally global-readable lookups (no department column)
-- are allowed to exist, but they must STILL have RLS enabled (with an explicit
-- permissive read policy), so "RLS enabled everywhere" is the invariant we test.

\set ON_ERROR_STOP on

do $$
declare
  r record;
  v_missing text := '';
  v_no_policy text := '';
  v_pcount int;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
    order by c.relname
  loop
    -- 1) RLS must be enabled on every public base table.
    if not (select relrowsecurity from pg_class where oid = ('public.'||quote_ident(r.relname))::regclass) then
      v_missing := v_missing || ' ' || r.relname;
    end if;

    -- 2) Every RLS-enabled table must have at least one policy (an enabled table
    --    with zero policies denies all access — usually a mistake, and at minimum
    --    a sign the table was added without an access model).
    select count(*) into v_pcount from pg_policies
      where schemaname='public' and tablename = r.relname;
    if v_pcount = 0 then
      v_no_policy := v_no_policy || ' ' || r.relname;
    end if;
  end loop;

  if length(v_missing) > 0 then
    raise exception 'RLS REGRESSION: RLS not enabled on:%', v_missing;
  end if;
  if length(v_no_policy) > 0 then
    raise exception 'RLS REGRESSION: no policies on:%', v_no_policy;
  end if;

  raise notice 'RLS REGRESSION PASS: all public base tables have RLS enabled and at least one policy';
end $$;

-- ── Part 2: catalog-driven CROSS-DEPARTMENT READ (§15) ───────────────────────
-- "RLS enabled + a policy exists" does NOT prove the policy is CORRECT — a policy
-- that forgot its department predicate still counts. So we also enumerate every
-- public base table that carries a denormalized department_id and assert that a
-- MEMBER of department A sees ZERO rows belonging to department B. A new
-- department_id-bearing table is covered automatically; a policy that leaks
-- cross-department rows fails the build. (The join-scoped tables — tasks, budgets,
-- department_updates, dependencies — are covered exhaustively in rls_pentest.sql.)
--
-- The RLS helpers (current_department(), is_executive()) read the JWT claims, NOT
-- the users table, so no user row is needed — we set a member-of-Finance JWT and
-- attack as the `authenticated` role. Everything is rolled back.
begin;

-- Fixtures as owner: one project spanning Finance (A) + Legal (B), a workspace and
-- a task in each. The audit / rag-history triggers then denormalize department_id
-- for BOTH departments into audit_log + rag_status_history, giving us foreign-dept
-- rows that MUST stay invisible to a Finance member.
do $$
declare
  v_fin uuid; v_legal uuid;
  v_proj uuid := '00000000-0000-0000-0000-00000000ee01';
  v_ws_fin uuid := '00000000-0000-0000-0000-00000000ee02';
  v_ws_legal uuid := '00000000-0000-0000-0000-00000000ee03';
begin
  select id into v_fin from public.departments where name = 'Finance';
  select id into v_legal from public.departments where name = 'Legal';
  if v_fin is null or v_legal is null then
    raise exception 'RLS REGRESSION: seed is missing Finance/Legal departments';
  end if;

  insert into public.projects (id, name, status)
    values (v_proj, 'RLS regression project', 'amber');
  insert into public.department_workspaces (id, project_id, department_id) values
    (v_ws_fin, v_proj, v_fin),
    (v_ws_legal, v_proj, v_legal);
  insert into public.tasks (id, workspace_id, title) values
    ('00000000-0000-0000-0000-00000000ee04', v_ws_fin, 'A: finance task'),
    ('00000000-0000-0000-0000-00000000ee05', v_ws_legal, 'B: legal task');
end $$;

-- Impersonate a MEMBER of Finance (claims only — no user row required).
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '00000000-0000-0000-0000-00000000eeff',
    'role', 'authenticated',
    'user_role', 'member',
    'department_id', (select id from public.departments where name = 'Finance')
  )::text,
  true
);
set local role authenticated;

do $$
declare
  r record;
  v_legal uuid;
  v_cnt int;
  v_checked int := 0;
  v_leak text := '';
begin
  -- departments is a global lookup readable by all authenticated users, so the
  -- member can resolve Legal's id even though Legal's DATA is hidden from them.
  select id into v_legal from public.departments where name = 'Legal';

  for r in
    select c.relname as t
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join information_schema.columns col
      on col.table_schema = 'public'
     and col.table_name = c.relname
     and col.column_name = 'department_id'
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname
  loop
    execute format('select count(*) from public.%I where department_id = $1', r.t)
      using v_legal into v_cnt;
    v_checked := v_checked + 1;
    if v_cnt > 0 then
      v_leak := v_leak || format(' %s=%s', r.t, v_cnt);
    end if;
  end loop;

  if v_checked = 0 then
    raise exception 'RLS REGRESSION: no department_id-scoped tables found — catalog query is wrong';
  end if;
  if length(v_leak) > 0 then
    raise exception 'RLS REGRESSION CROSS-DEPT LEAK (Finance member sees Legal rows):%', v_leak;
  end if;

  raise notice 'RLS REGRESSION CROSS-DEPT PASS: member sees 0 foreign-department rows across % department_id-scoped tables', v_checked;
end $$;

reset role;
rollback;

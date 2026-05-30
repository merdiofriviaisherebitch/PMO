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

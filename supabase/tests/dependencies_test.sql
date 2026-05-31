-- dependencies_test.sql — Phase 6 dependency access-model tests (CLAUDE.md §15).
-- Proves the table's CONTRACT through the same impersonation harness the pen-test
-- uses (SET ROLE authenticated + SET request.jwt.claims, exactly what PostgREST
-- does per request): the denormalize trigger, the symmetric "either endpoint dept"
-- visibility rule, the intra- vs cross-department write model (ADR 0002), and the
-- audit row. The blocked_dependency ESCALATION branch is exercised in
-- escalation_test.sql, where the engine fixtures live.
--   psql "$DBURL" -v ON_ERROR_STOP=1 -f supabase/tests/dependencies_test.sql
-- Everything is wrapped in BEGIN/ROLLBACK so fixtures vanish.

\set ON_ERROR_STOP on

begin;

truncate table public.dependencies cascade;
truncate table public.audit_log restart identity cascade;
truncate table public.projects cascade;
truncate table public.department_workspaces cascade;
truncate table public.tasks cascade;

create or replace function pg_temp.assert(cond boolean, msg text)
returns void language plpgsql as $$
begin
  if not cond then raise exception 'DEPENDENCY FAIL: %', msg;
  else raise notice 'DEPENDENCY PASS: %', msg; end if;
end $$;

-- ── Fixtures (created as owner; RLS does not restrict the owner) ──────────────
-- Finance (A) + Legal (B), one project spanning both, a workspace + two tasks each
-- (two-per-dept so an intra-department edge is possible), users in each role, and
-- three owner-made edges: a Finance-internal edge, a Legal-internal edge, and a
-- cross-department edge (Finance -> Legal).
do $$
declare
  v_fin uuid; v_legal uuid;
  v_proj   uuid := '00000000-0000-0000-0000-0000000006a1';
  v_ws_fin uuid := '00000000-0000-0000-0000-0000000006b1';
  v_ws_leg uuid := '00000000-0000-0000-0000-0000000006b2';
  v_fin1   uuid := '00000000-0000-0000-0000-0000000006d1';
  v_fin2   uuid := '00000000-0000-0000-0000-0000000006d2';
  v_leg1   uuid := '00000000-0000-0000-0000-0000000006d3';
  v_leg2   uuid := '00000000-0000-0000-0000-0000000006d4';
  v_m_fin  uuid := '00000000-0000-0000-0000-0000000006c1';
  v_d_fin  uuid := '00000000-0000-0000-0000-0000000006c2';
  v_m_leg  uuid := '00000000-0000-0000-0000-0000000006c3';
  v_exec   uuid := '00000000-0000-0000-0000-0000000006c4';
begin
  select id into v_fin   from public.departments where name = 'Finance';
  select id into v_legal from public.departments where name = 'Legal';

  insert into public.projects (id, name, status) values (v_proj, 'Dependency Test Project', 'amber');
  insert into public.department_workspaces (id, project_id, department_id) values
    (v_ws_fin, v_proj, v_fin),
    (v_ws_leg, v_proj, v_legal);

  insert into public.tasks (id, workspace_id, title) values
    (v_fin1, v_ws_fin, 'Finance: capex forecast'),
    (v_fin2, v_ws_fin, 'Finance: cash plan'),
    (v_leg1, v_ws_leg, 'Legal: permit review'),
    (v_leg2, v_ws_leg, 'Legal: contract draft');

  insert into auth.users (id, email, aud, role) values
    (v_m_fin, 'dep.fin.member@dependency.test', 'authenticated','authenticated'),
    (v_d_fin, 'dep.fin.dir@dependency.test',    'authenticated','authenticated'),
    (v_m_leg, 'dep.legal.member@dependency.test','authenticated','authenticated'),
    (v_exec,  'dep.exec@dependency.test',        'authenticated','authenticated')
    on conflict (id) do nothing;
  insert into public.users (id, department_id, role, email, display_name) values
    (v_m_fin, v_fin,   'member',    'dep.fin.member@dependency.test', 'Dep Fin Member'),
    (v_d_fin, v_fin,   'director',  'dep.fin.dir@dependency.test',    'Dep Fin Director'),
    (v_m_leg, v_legal, 'member',    'dep.legal.member@dependency.test','Dep Legal Member'),
    (v_exec,  v_fin,   'executive', 'dep.exec@dependency.test',       'Dep Exec')
    on conflict (id) do update set role = excluded.role, department_id = excluded.department_id;

  -- Owner-made edges (the denormalize trigger fires on all of these).
  insert into public.dependencies (id, source_task_id, target_task_id, relation_type) values
    ('00000000-0000-0000-0000-0000000006e1', v_fin1, v_fin2, 'blocks'),   -- Finance-internal
    ('00000000-0000-0000-0000-0000000006e2', v_leg1, v_leg2, 'blocks'),   -- Legal-internal
    ('00000000-0000-0000-0000-0000000006e3', v_fin1, v_leg1, 'blocks');   -- cross: Finance -> Legal
end $$;

-- ── TEST 1: the BEFORE INSERT trigger denormalized both endpoint departments ──
do $$
declare v_fin uuid; v_legal uuid; v_s uuid; v_t uuid; v_cs uuid; v_ct uuid;
begin
  select id into v_fin   from public.departments where name='Finance';
  select id into v_legal from public.departments where name='Legal';
  select source_department_id, target_department_id into v_s, v_t
    from public.dependencies where id='00000000-0000-0000-0000-0000000006e1';
  select source_department_id, target_department_id into v_cs, v_ct
    from public.dependencies where id='00000000-0000-0000-0000-0000000006e3';
  perform pg_temp.assert(v_s = v_fin and v_t = v_fin,
    'trigger: intra-Finance edge has both departments = Finance');
  perform pg_temp.assert(v_cs = v_fin and v_ct = v_legal,
    'trigger: cross edge has source=Finance, target=Legal');
end $$;

-- ── TEST 2: a Finance member sees edges TOUCHING Finance, never Legal-internal ─
do $$
declare v_fin uuid; v_total int; v_legal_internal int;
begin
  select id into v_fin from public.departments where name='Finance';
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub','00000000-0000-0000-0000-0000000006c1','role','authenticated',
                      'user_role','member','department_id',v_fin)::text, true);
  select count(*) into v_total from public.dependencies;
  select count(*) into v_legal_internal from public.dependencies
    where id='00000000-0000-0000-0000-0000000006e2';
  perform set_config('request.jwt.claims', null, true);
  reset role;
  -- Finance-internal + cross (target Legal but source Finance) = 2; Legal-internal hidden.
  perform pg_temp.assert(v_total = 2, format('Finance member sees 2 edges touching Finance (saw %s)', v_total));
  perform pg_temp.assert(v_legal_internal = 0, 'Finance member cannot see the Legal-internal edge');
end $$;

-- ── TEST 3: a Legal member is symmetric (sees Legal-internal + cross, not Finance) ─
do $$
declare v_legal uuid; v_total int; v_fin_internal int;
begin
  select id into v_legal from public.departments where name='Legal';
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub','00000000-0000-0000-0000-0000000006c3','role','authenticated',
                      'user_role','member','department_id',v_legal)::text, true);
  select count(*) into v_total from public.dependencies;
  select count(*) into v_fin_internal from public.dependencies
    where id='00000000-0000-0000-0000-0000000006e1';
  perform set_config('request.jwt.claims', null, true);
  reset role;
  perform pg_temp.assert(v_total = 2, format('Legal member sees 2 edges touching Legal (saw %s)', v_total));
  perform pg_temp.assert(v_fin_internal = 0, 'Legal member cannot see the Finance-internal edge');
end $$;

-- ── TEST 4: an executive sees ALL edges across departments ────────────────────
do $$
declare v_fin uuid; v_total int;
begin
  select id into v_fin from public.departments where name='Finance';
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub','00000000-0000-0000-0000-0000000006c4','role','authenticated',
                      'user_role','executive','department_id',v_fin)::text, true);
  select count(*) into v_total from public.dependencies;
  perform set_config('request.jwt.claims', null, true);
  reset role;
  perform pg_temp.assert(v_total = 3, format('Executive sees all 3 edges (saw %s)', v_total));
end $$;

-- ── TEST 5: a Finance member CAN create an intra-Finance edge ─────────────────
do $$
declare v_fin uuid; v_ok boolean := false;
begin
  select id into v_fin from public.departments where name='Finance';
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub','00000000-0000-0000-0000-0000000006c1','role','authenticated',
                      'user_role','member','department_id',v_fin)::text, true);
  begin
    insert into public.dependencies (id, source_task_id, target_task_id, relation_type)
    values ('00000000-0000-0000-0000-0000000006e5',
            '00000000-0000-0000-0000-0000000006d1',
            '00000000-0000-0000-0000-0000000006d2', 'relates');
    v_ok := true;
  exception when others then v_ok := false;
  end;
  perform set_config('request.jwt.claims', null, true);
  reset role;
  perform pg_temp.assert(v_ok, 'Finance member creates an intra-Finance edge');
end $$;

-- ── TEST 6: a Finance member CANNOT create a cross-department edge (WITH CHECK) ─
do $$
declare v_fin uuid; v_blocked boolean := false;
begin
  select id into v_fin from public.departments where name='Finance';
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub','00000000-0000-0000-0000-0000000006c1','role','authenticated',
                      'user_role','member','department_id',v_fin)::text, true);
  begin
    insert into public.dependencies (source_task_id, target_task_id, relation_type)
    values ('00000000-0000-0000-0000-0000000006d2',   -- Finance task
            '00000000-0000-0000-0000-0000000006d3', 'blocks');  -- Legal task → cross
  exception when others then v_blocked := true;  -- RLS WITH CHECK violation expected
  end;
  perform set_config('request.jwt.claims', null, true);
  reset role;
  perform pg_temp.assert(v_blocked, 'Finance member INSERT of a cross-department edge is rejected');
end $$;

-- ── TEST 7: an executive CAN create a cross-department edge ───────────────────
do $$
declare v_fin uuid; v_ok boolean := false;
begin
  select id into v_fin from public.departments where name='Finance';
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub','00000000-0000-0000-0000-0000000006c4','role','authenticated',
                      'user_role','executive','department_id',v_fin)::text, true);
  begin
    insert into public.dependencies (source_task_id, target_task_id, relation_type)
    values ('00000000-0000-0000-0000-0000000006d2',   -- Finance task
            '00000000-0000-0000-0000-0000000006d4', 'blocks');  -- Legal task
    v_ok := true;
  exception when others then v_ok := false;
  end;
  perform set_config('request.jwt.claims', null, true);
  reset role;
  perform pg_temp.assert(v_ok, 'Executive creates a cross-department edge');
end $$;

-- ── TEST 8: a Finance member CANNOT delete the exec-made cross edge ───────────
-- They can SEE it (source is Finance), but DELETE is gated on BOTH endpoints
-- in-dept → the Legal endpoint blocks it → 0 rows affected, no error.
do $$
declare v_fin uuid; v_n int;
begin
  select id into v_fin from public.departments where name='Finance';
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub','00000000-0000-0000-0000-0000000006c1','role','authenticated',
                      'user_role','member','department_id',v_fin)::text, true);
  delete from public.dependencies where id='00000000-0000-0000-0000-0000000006e3';  -- cross edge
  get diagnostics v_n = row_count;
  perform set_config('request.jwt.claims', null, true);
  reset role;
  perform pg_temp.assert(v_n = 0, format('Finance member cannot delete the cross edge (deleted %s)', v_n));
end $$;

-- ── TEST 9: a Finance member CAN delete an intra-Finance edge ─────────────────
do $$
declare v_fin uuid; v_n int;
begin
  select id into v_fin from public.departments where name='Finance';
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub','00000000-0000-0000-0000-0000000006c1','role','authenticated',
                      'user_role','member','department_id',v_fin)::text, true);
  delete from public.dependencies where id='00000000-0000-0000-0000-0000000006e5';  -- member-made intra edge
  get diagnostics v_n = row_count;
  perform set_config('request.jwt.claims', null, true);
  reset role;
  perform pg_temp.assert(v_n = 1, format('Finance member deletes an intra-Finance edge (deleted %s)', v_n));
end $$;

-- ── TEST 10: inserting a dependency wrote a department-scoped audit row ────────
do $$
declare v_fin uuid; v_cnt int; v_dept uuid;
begin
  select id into v_fin from public.departments where name='Finance';
  select count(*) into v_cnt from public.audit_log where entity_type='dependency' and action='create';
  -- The Finance-internal fixture edge resolves its scope to the Finance source task.
  select department_id into v_dept from public.audit_log
    where entity_type='dependency' and entity_id='00000000-0000-0000-0000-0000000006e1' limit 1;
  perform pg_temp.assert(v_cnt >= 1, format('dependency insert writes an audit row (found %s)', v_cnt));
  perform pg_temp.assert(v_dept = v_fin, 'dependency audit row is scoped to the source department (Finance)');
end $$;

rollback;

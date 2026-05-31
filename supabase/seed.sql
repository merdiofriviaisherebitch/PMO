-- seed.sql — local/dev seed for Phase 1 manual smoke testing (CLAUDE.md §15).
-- Runs automatically on `supabase db reset`. Creates one test user per role so
-- the auth → hook → claims → RLS pipeline can be exercised by hand in the app.
-- Passwords are the well-known local dev password; this file is for the LOCAL
-- stack only and must never carry real credentials.
--
-- The 9 departments themselves are seeded in migration 0003 (idempotent).

-- Test login password for every seeded user: "password123"
-- (bcrypt hashed below via crypt()).

do $$
declare
  v_fin uuid; v_legal uuid; v_geo uuid;
  v_pwd text := crypt('password123', gen_salt('bf'));
  rec record;
  -- (auth user id, email, role, department name, display)
  seed_users constant jsonb := jsonb_build_array(
    jsonb_build_object('id','aaaaaaaa-0000-0000-0000-000000000001','email','exec@solservices.test',       'role','executive','dept','Finance',  'name','Executive One'),
    jsonb_build_object('id','aaaaaaaa-0000-0000-0000-000000000002','email','fin.director@solservices.test','role','director', 'dept','Finance',  'name','Finance Director'),
    jsonb_build_object('id','aaaaaaaa-0000-0000-0000-000000000003','email','fin.member@solservices.test',  'role','member',   'dept','Finance',  'name','Finance Member'),
    jsonb_build_object('id','aaaaaaaa-0000-0000-0000-000000000004','email','legal.member@solservices.test','role','member',   'dept','Legal',    'name','Legal Member'),
    jsonb_build_object('id','aaaaaaaa-0000-0000-0000-000000000005','email','geo.viewer@solservices.test',  'role','viewer',   'dept','Geothermal','name','Geothermal Viewer')
  );
begin
  for rec in select * from jsonb_array_elements(seed_users) as u(obj)
  loop
    -- auth.users row with a usable password (email confirmed).
    -- IMPORTANT: GoTrue scans the token columns into non-nullable Go strings, so
    -- they MUST be '' (empty string), never NULL — a NULL there yields the opaque
    -- "Database error querying schema" 500 at sign-in. (Manual-seed gotcha.)
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      confirmation_token, recovery_token, email_change,
      email_change_token_new, email_change_token_current,
      phone_change, phone_change_token, reauthentication_token
    )
    values (
      '00000000-0000-0000-0000-000000000000',
      (rec.obj->>'id')::uuid, 'authenticated','authenticated',
      rec.obj->>'email', v_pwd,
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}', '{}',
      '', '', '', '', '', '', '', ''
    )
    on conflict (id) do nothing;

    -- matching identity row (required by GoTrue for password sign-in)
    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
    )
    values (
      gen_random_uuid(), (rec.obj->>'id')::uuid,
      jsonb_build_object('sub', rec.obj->>'id', 'email', rec.obj->>'email'),
      'email', rec.obj->>'email', now(), now(), now()
    )
    on conflict (provider, provider_id) do nothing;

    -- app profile (drives the hook). role/department here is what gets stamped.
    insert into public.users (id, department_id, role, email, display_name)
    values (
      (rec.obj->>'id')::uuid,
      (select id from public.departments where name = rec.obj->>'dept'),
      (rec.obj->>'role')::public.user_role,
      rec.obj->>'email',
      rec.obj->>'name'
    )
    on conflict (id) do update
      set role = excluded.role, department_id = excluded.department_id;
  end loop;
end $$;

-- A demo project spanning Finance + Legal, with a task in each, so the
-- dashboard task-count differs by role (member: 1, executive: 2).
do $$
declare
  v_proj uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
  v_ws_fin uuid := 'bbbbbbbb-0000-0000-0000-0000000000f1';
  v_ws_legal uuid := 'bbbbbbbb-0000-0000-0000-0000000000f2';
begin
  insert into public.projects (id, name, description, status)
  values (v_proj, 'Geothermal Plant Alpha', 'Flagship cross-department build', 'amber')
  on conflict (id) do nothing;

  insert into public.department_workspaces (id, project_id, department_id) values
    (v_ws_fin,   v_proj, (select id from public.departments where name='Finance')),
    (v_ws_legal, v_proj, (select id from public.departments where name='Legal'))
  on conflict (id) do nothing;

  insert into public.tasks (workspace_id, title, rag_status) values
    (v_ws_fin,   'Q3 capex forecast', 'amber'),
    (v_ws_legal, 'Land-use permit review', 'red')
  on conflict do nothing;
end $$;

-- Phase 3: an open weekly update cycle + a draft per seeded workspace, so the
-- /updates workflow is exercisable by hand (member submits, director approves).
do $$
declare
  v_cycle uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_ws_fin uuid := 'bbbbbbbb-0000-0000-0000-0000000000f1';
  v_ws_legal uuid := 'bbbbbbbb-0000-0000-0000-0000000000f2';
begin
  insert into public.update_cycles (id, opens_at, closes_at, status)
  values (v_cycle, now() - interval '1 day', now() + interval '6 days', 'open')
  on conflict (id) do nothing;

  insert into public.department_updates (cycle_id, workspace_id, status, content)
  values
    (v_cycle, v_ws_fin,   'draft', '{"summary":"Capex tracking on plan."}'),
    (v_cycle, v_ws_legal, 'draft', '{"summary":"Permit under review."}')
  on conflict (cycle_id, workspace_id) do nothing;
end $$;

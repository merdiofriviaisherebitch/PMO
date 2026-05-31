-- escalation_test.sql — Phase 5 escalation-engine behavior tests (CLAUDE.md §15).
-- Drives the engine through its PUBLIC function interfaces (due_escalations /
-- escalation_dispatch / outbox_send_batch / outbox_mark_failed) and asserts the
-- observable outbox + event rows — the engine's contract, not its internals.
-- The clock is injected (p_now), so every case is deterministic with no real time
-- and no real email. Run against the local stack:
--   psql "$DBURL" -v ON_ERROR_STOP=1 -f supabase/tests/escalation_test.sql
-- Everything is wrapped in BEGIN/ROLLBACK so fixtures vanish.

\set ON_ERROR_STOP on

begin;

-- A fixed base instant T so the ladder maths is exact and reproducible.
-- (The engine never reads the wall clock — p_now is always passed explicitly.)
\set T '2026-05-29 12:00:00+00'

-- ── Determinism: own a clean fixture set (rolled back at the end) ─────────────
truncate table public.notification_outbox cascade;
truncate table public.escalation_events   cascade;
truncate table public.escalation_steps    cascade;
truncate table public.escalation_rules    cascade;
truncate table public.rag_status_history  restart identity cascade;
truncate table public.department_updates  cascade;
truncate table public.update_cycles       cascade;
truncate table public.tasks               cascade;
truncate table public.department_workspaces cascade;
truncate table public.projects            cascade;

create or replace function pg_temp.assert(cond boolean, msg text)
returns void language plpgsql as $$
begin
  if not cond then raise exception 'ESCALATION FAIL: %', msg;
  else raise notice 'ESCALATION PASS: %', msg; end if;
end $$;

-- ── Fixtures (created as postgres/owner; RLS does not restrict the owner) ─────
do $$
declare
  v_fin uuid;
  v_proj uuid    := '00000000-0000-0000-0000-0000000005a1';
  v_ws   uuid    := '00000000-0000-0000-0000-0000000005b1';
  v_cycle uuid   := '00000000-0000-0000-0000-0000000005e1';
  v_du   uuid    := '00000000-0000-0000-0000-0000000005d1';
  v_task uuid    := '00000000-0000-0000-0000-0000000005f1';
  v_member uuid  := '00000000-0000-0000-0000-0000000005c1';
  v_director uuid:= '00000000-0000-0000-0000-0000000005c2';
  v_exec uuid    := '00000000-0000-0000-0000-0000000005c3';
  v_rule uuid    := '00000000-0000-0000-0000-0000000005aa';
  v_redrule uuid := '00000000-0000-0000-0000-0000000005ab';
  v_T timestamptz := '2026-05-29 12:00:00+00';
begin
  select id into v_fin from public.departments where name = 'Finance';

  insert into public.projects (id, name, status) values (v_proj, 'Escalation Test Project', 'amber');
  insert into public.department_workspaces (id, project_id, department_id) values (v_ws, v_proj, v_fin);

  -- Users: a member (the update owner / hint), a director, an executive — so the
  -- recipient resolver has a real ladder to resolve against.
  insert into auth.users (id, email, aud, role) values
    (v_member,   'esc.member@escalation.test',   'authenticated','authenticated'),
    (v_director, 'esc.director@escalation.test', 'authenticated','authenticated'),
    (v_exec,     'esc.exec@escalation.test',     'authenticated','authenticated')
    on conflict (id) do nothing;
  insert into public.users (id, department_id, role, email, display_name) values
    (v_member,   v_fin, 'member',    'esc.member@escalation.test',   'Esc Member'),
    (v_director, v_fin, 'director',  'esc.director@escalation.test', 'Esc Director'),
    (v_exec,     v_fin, 'executive', 'esc.exec@escalation.test',     'Esc Exec')
    on conflict (id) do update set role = excluded.role, department_id = excluded.department_id;

  -- A cycle whose deadline is exactly T, and an unsubmitted (draft) update owned
  -- by the member.
  insert into public.update_cycles (id, opens_at, closes_at, status)
  values (v_cycle, v_T - interval '5 days', v_T, 'closed');
  insert into public.department_updates (id, cycle_id, workspace_id, content, status, submitted_by)
  values (v_du, v_cycle, v_ws, '{}'::jsonb, 'draft', v_member);

  -- late_update rule: L1 member @0h, L2 director @+24h, L3 exec @+24h (=48h past).
  insert into public.escalation_rules (id, rule_type, period_bucket, active)
  values (v_rule, 'late_update', 'iso_week', true);
  insert into public.escalation_steps (rule_id, level, threshold_hours, recipient_scope) values
    (v_rule, 1, 0,  'member'),
    (v_rule, 2, 24, 'director'),
    (v_rule, 3, 24, 'executive');

  -- A task that has been RED since T-50h, for red_lingering. Insert red (the
  -- rag_history_tasks trigger logs the transition), then backdate that history row
  -- as owner so the "red since" anchor is 50h before T.
  insert into public.tasks (id, workspace_id, title, rag_status, assignee_id)
  values (v_task, v_ws, 'Escalation: stuck red task', 'red', v_member);
  update public.rag_status_history
    set changed_at = v_T - interval '50 hours'
    where entity_type = 'task' and entity_id = v_task and new_status = 'red';

  -- red_lingering rule: L1 director @48h, L2 exec @+48h (=96h). period = day.
  insert into public.escalation_rules (id, rule_type, period_bucket, active)
  values (v_redrule, 'red_lingering', 'day', true);
  insert into public.escalation_steps (rule_id, level, threshold_hours, recipient_scope) values
    (v_redrule, 1, 48, 'director'),
    (v_redrule, 2, 48, 'executive');

  -- outbox_send_batch now refuses to claim rows unless the Edge Function URL is
  -- configured in Vault (so a misconfigured env can't silently mark everything
  -- sent). Set a throwaway URL so the send tests exercise the claim path. These
  -- live only inside this rolled-back transaction; pg_net dispatches AFTER commit,
  -- so the rollback means no HTTP request is ever actually made.
  perform vault.create_secret('http://127.0.0.1:9/noop', 'escalation_function_url');
  perform vault.create_secret('test-shared-secret',      'escalation_function_secret');
end $$;

-- ── TEST 1: due_escalations at the deadline yields exactly L1, to the member ──
do $$
declare v_du uuid := '00000000-0000-0000-0000-0000000005d1';
        v_member uuid := '00000000-0000-0000-0000-0000000005c1';
        v_cnt int; v_lvl int; v_rcpt uuid;
begin
  select count(*) into v_cnt from public.due_escalations('2026-05-29 12:00:00+00')
    where target_entity_id = v_du and target_entity_type = 'department_update';
  select level, recipient_id into v_lvl, v_rcpt from public.due_escalations('2026-05-29 12:00:00+00')
    where target_entity_id = v_du and target_entity_type = 'department_update';
  perform pg_temp.assert(v_cnt = 1, format('late_update: exactly L1 due at the deadline (saw %s rows)', v_cnt));
  perform pg_temp.assert(v_lvl = 1, format('late_update: the due step is level 1 (saw %s)', v_lvl));
  perform pg_temp.assert(v_rcpt = v_member, 'late_update: L1 recipient is the update owner (member)');
end $$;

-- ── TEST 2: outbox row created exactly once per target; re-dispatch is a no-op ─
-- (At T the red task is ALSO due, so the dispatch total is >1; the §15 invariant
-- is per-target idempotency, asserted by filtering to the late-update target.)
do $$
declare v_du uuid := '00000000-0000-0000-0000-0000000005d1'; v_second int; v_rows1 int; v_rows2 int;
begin
  perform public.escalation_dispatch('2026-05-29 12:00:00+00');
  select count(*) into v_rows1 from public.notification_outbox where dedup_key like '%target:' || v_du || '%';
  v_second := public.escalation_dispatch('2026-05-29 12:00:00+00');   -- same instant => all dedups
  select count(*) into v_rows2 from public.notification_outbox where dedup_key like '%target:' || v_du || '%';
  perform pg_temp.assert(v_rows1 = 1,  format('dispatch: target queued exactly once (got %s)', v_rows1));
  perform pg_temp.assert(v_second = 0, format('dispatch: a re-run at the same instant queues 0 (dedup) (got %s)', v_second));
  perform pg_temp.assert(v_rows2 = 1,  format('dispatch: still exactly one row for the target (got %s)', v_rows2));
end $$;

-- ── TEST 3: advancing the clock through all three rungs => three distinct sends ─
do $$
declare v_du uuid := '00000000-0000-0000-0000-0000000005d1'; v_levels int; v_max_per_level int;
begin
  perform public.escalation_dispatch('2026-05-30 12:00:00+00');  -- T + 24h => L2 becomes due
  perform public.escalation_dispatch('2026-05-31 12:00:00+00');  -- T + 48h => L3 becomes due
  select count(distinct level) into v_levels from public.notification_outbox
    where dedup_key like '%target:' || v_du || '%';
  select max(c) into v_max_per_level from (
    select count(*) c from public.notification_outbox
    where dedup_key like '%target:' || v_du || '%' group by level
  ) q;
  perform pg_temp.assert(v_levels = 3, format('ladder: three distinct levels sent, not collapsed (got %s)', v_levels));
  perform pg_temp.assert(v_max_per_level = 1, format('ladder: each level sent exactly once (max per level %s)', v_max_per_level));
end $$;

-- ── TEST 4: an open event exists per (rule,level,target), not one per send ────
do $$
declare v_du uuid := '00000000-0000-0000-0000-0000000005d1'; v_events int;
begin
  select count(*) into v_events from public.escalation_events
    where target_entity_id = v_du and resolved_at is null;
  perform pg_temp.assert(v_events = 3, format('events: 3 open events (one per fired level) (got %s)', v_events));
end $$;

-- ── TEST 5: when the update is submitted, nothing is due and events resolve ───
do $$
declare v_du uuid := '00000000-0000-0000-0000-0000000005d1'; v_due int; v_open int;
begin
  -- 'pending' is the legal "submitted" transition (draft→pending) and already
  -- satisfies the resolve condition (status in pending/approved).
  update public.department_updates set status = 'pending' where id = v_du;
  select count(*) into v_due from public.due_escalations('2026-05-31 12:00:00+00')
    where target_entity_id = v_du;
  perform public.escalation_dispatch('2026-05-31 12:00:00+00');
  select count(*) into v_open from public.escalation_events
    where target_entity_id = v_du and resolved_at is null;
  perform pg_temp.assert(v_due = 0,  format('resolved: a submitted update is no longer due (got %s)', v_due));
  perform pg_temp.assert(v_open = 0, format('resolved: its open events are stamped resolved (got %s)', v_open));
end $$;

-- ── TEST 6: outbox_send_batch claims queued rows and marks them sent ──────────
do $$
declare v_du uuid := '00000000-0000-0000-0000-0000000005d1'; v_claimed int; v_unsent int;
begin
  v_claimed := public.outbox_send_batch(50, '2026-05-31 12:00:00+00');
  select count(*) into v_unsent from public.notification_outbox
    where dedup_key like '%target:' || v_du || '%' and status <> 'sent';
  perform pg_temp.assert(v_claimed >= 3, format('send: claimed the 3 queued rows (got %s)', v_claimed));
  perform pg_temp.assert(v_unsent = 0, format('send: all target rows are now sent (unsent %s)', v_unsent));
end $$;

-- ── TEST 7: a failed send is retried IN PLACE with backoff, never duplicated ──
do $$
declare
  v_id uuid; v_before int; v_after int; v_status public.notification_status;
  v_attempts int; v_next timestamptz;
begin
  select id into v_id from public.notification_outbox order by created_at limit 1;
  select count(*) into v_before from public.notification_outbox;

  -- Simulate what the Edge Function does on a Resend 500.
  perform public.outbox_mark_failed(v_id, 'resend 500', '2026-05-31 12:00:00+00');
  select status, next_attempt_at into v_status, v_next from public.notification_outbox where id = v_id;
  perform pg_temp.assert(v_status = 'failed', 'retry: a rejected send is marked failed');
  -- attempts=1 after the TEST 6 claim, so backoff = 2^1 = 2 min from p_now — assert
  -- the exact instant so a weakened backoff formula can't pass vacuously.
  perform pg_temp.assert(v_next = timestamptz '2026-05-31 12:02:00+00',
    format('retry: backoff sets next_attempt_at to p_now + 2 min (got %s)', v_next));

  -- Before the backoff elapses, the row must NOT be re-claimed.
  perform public.outbox_send_batch(50, '2026-05-31 12:01:00+00');  -- +1 min < 2 min backoff
  select status into v_status from public.notification_outbox where id = v_id;
  perform pg_temp.assert(v_status = 'failed', 'retry: not re-claimed before backoff elapses');

  -- After the backoff, it IS re-claimed — same row, attempts incremented, no dup.
  perform public.outbox_send_batch(50, '2026-05-31 12:05:00+00');  -- +5 min > 2 min backoff
  select status, attempts into v_status, v_attempts from public.notification_outbox where id = v_id;
  select count(*) into v_after from public.notification_outbox;
  perform pg_temp.assert(v_status = 'sent', 'retry: re-claimed and sent after backoff');
  perform pg_temp.assert(v_attempts = 2, format('retry: attempts incremented in place (got %s)', v_attempts));
  perform pg_temp.assert(v_after = v_before, format('retry: no duplicate row created (%s -> %s)', v_before, v_after));
end $$;

-- ── TEST 8: red_lingering — a task red past the threshold is due to the director ─
do $$
declare v_task uuid := '00000000-0000-0000-0000-0000000005f1';
        v_fin uuid;
        v_cnt int; v_lvl int; v_rcpt uuid; v_is_dir boolean;
begin
  select id into v_fin from public.departments where name = 'Finance';
  select count(*) into v_cnt from public.due_escalations('2026-05-29 12:00:00+00')
    where target_entity_id = v_task and target_entity_type = 'task';
  select level, recipient_id into v_lvl, v_rcpt from public.due_escalations('2026-05-29 12:00:00+00')
    where target_entity_id = v_task and target_entity_type = 'task';
  -- The director-scope step resolves to A Finance director (the earliest-created),
  -- which may be a seed user rather than the fixture's — assert the contract
  -- (role + department), not a specific id.
  select exists (
    select 1 from public.users u where u.id = v_rcpt and u.department_id = v_fin and u.role = 'director'
  ) into v_is_dir;
  perform pg_temp.assert(v_cnt = 1, format('red_lingering: exactly L1 due for a 50h-red task (got %s)', v_cnt));
  perform pg_temp.assert(v_lvl = 1, format('red_lingering: due step is level 1 (got %s)', v_lvl));
  perform pg_temp.assert(v_is_dir, 'red_lingering: L1 recipient is a director of the task''s department');
end $$;

-- ── TEST 9: red_lingering ladder advances to L2 once its threshold elapses ────
-- Parity with TEST 3 (late_update) for the other rule type. The task is red since
-- T-50h; L1 (director) fires at +48h cumulative, L2 (executive) at +96h cumulative
-- (= T+46h). At T+48h both are due — asserted through the pure evaluator so it is
-- independent of the accumulated outbox/send state from earlier tests.
do $$
declare v_task uuid := '00000000-0000-0000-0000-0000000005f1'; v_cnt int; v_l1 int; v_l2 int;
begin
  select count(*),
         count(*) filter (where level = 1),
         count(*) filter (where level = 2)
    into v_cnt, v_l1, v_l2
  from public.due_escalations('2026-05-31 12:00:00+00')
  where target_entity_id = v_task and target_entity_type = 'task';
  perform pg_temp.assert(v_cnt = 2, format('red_lingering ladder: L1+L2 both due once threshold elapses (got %s)', v_cnt));
  perform pg_temp.assert(v_l1 = 1 and v_l2 = 1,
    format('red_lingering ladder: exactly one of each level, not collapsed (L1=%s L2=%s)', v_l1, v_l2));
end $$;

rollback;

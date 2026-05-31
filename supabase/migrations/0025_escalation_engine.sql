-- 0025_escalation_engine.sql
-- Phase 5 escalation engine logic (CLAUDE.md §5 module 8, §6 non-negotiable #3,
-- §8 scheduled jobs, §11, §20 C2/C3). Separates WHAT IS DUE from HOW IT SENDS:
--
--   due_escalations(p_now)   — PURE evaluator. The clock is an argument (§20 C2),
--                              so the whole "what fires when" logic is unit-tested
--                              with a fake clock and never touches real time or
--                              real email. One branch per rule_type, each computing
--                              its own anchor + period behind the one interface.
--   escalation_dispatch()    — consumes due_escalations: writes the period-deduped
--                              outbox rows, opens one event per (rule,level,target),
--                              and resolves events whose condition has cleared.
--   outbox_send_batch()      — claims un-sent rows FOR UPDATE SKIP LOCKED, marks
--                              them sent BEFORE delivery (§6), and fires pg_net at
--                              the escalation-sender Edge Function.
--   outbox_mark_failed()     — the ONE place backoff math lives; the Edge Function
--                              calls it on a Resend failure (no silent failures).
--
-- All are SECURITY DEFINER system functions (they span departments by design, like
-- the 0020 cron jobs) and are revoked from app roles — none is a user-callable RPC.
-- The clock is injected everywhere (p_now) so cron is "just a tick": the schedule
-- only decides WHEN to check; the timestamps decide WHAT is due (same principle as
-- week_cutoff() in 0020).

-- ── escalation_recipient(): resolve a step's scope to ONE accountable user ─────
-- Degrades UP the ladder if a level is unstaffed (member->director->exec), so a
-- send always has an owner even with sparse org data. recipient_id is singular by
-- design (the dedup_key is per step, NOT per recipient — non-negotiable #3); the
-- exact multi-exec routing is deferred to §18 Q8 and handled in the Edge Function.
create or replace function public.escalation_recipient(
  p_scope public.recipient_scope,
  p_department_id uuid,
  p_member_hint uuid default null            -- the update's submitted_by / task assignee, if any
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    case p_scope
      when 'member' then coalesce(
        p_member_hint,
        -- TODO §18 Q8: with no submitted_by hint, "the member" is ambiguous —
        -- confirm with the client who is accountable. Until then: oldest-tenured.
        (select u.id from public.users u
          where u.department_id = p_department_id and u.role = 'member'
          order by u.created_at limit 1),
        (select u.id from public.users u
          where u.department_id = p_department_id and u.role = 'director'
          order by u.created_at limit 1)
      )
      when 'director' then
        (select u.id from public.users u
          where u.department_id = p_department_id and u.role = 'director'
          order by u.created_at limit 1)
      when 'executive' then null            -- falls through to the executive fallback below
    end,
    -- Final fallback for any scope: the primary executive (deterministic).
    (select u.id from public.users u where u.role = 'executive' order by u.created_at limit 1)
  )
$$;

comment on function public.escalation_recipient(public.recipient_scope, uuid, uuid) is
  'Resolves a ladder step''s recipient_scope to one accountable user, degrading up the ladder when a level is unstaffed (CLAUDE.md §11, §4).';

-- ── escalation_period_token(): the dedup_key period component (§11) ───────────
-- The period bucket label MUST come from the rule's period_bucket, never be
-- hard-coded per rule_type (§11: "<bucket> granularity comes from
-- escalation_rules.period_bucket, NOT hard-coded iso-week"). One home for that
-- mapping so a re-cadenced rule can never drift from its dedup_key.
create or replace function public.escalation_period_token(
  p_bucket public.escalation_period,
  p_at timestamptz
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case p_bucket
    when 'iso_week' then to_char(p_at at time zone 'Europe/Budapest', 'IYYY"-W"IW')
    when 'day'      then to_char(p_at at time zone 'Europe/Budapest', 'YYYY-MM-DD')
  end
$$;

comment on function public.escalation_period_token(public.escalation_period, timestamptz) is
  'The dedup_key period bucket label for a rule''s period_bucket at an instant (CLAUDE.md §11). One home for the iso_week/day mapping.';

-- ── cumulative_threshold(): a ladder step's offset from the anchor (§9, §11) ──
-- Each step's threshold_hours is "hours after the previous step", so step N fires
-- at anchor + sum(threshold_hours for level <= N). One home for that sum, shared
-- by every rule_type branch (no copy-paste correlated subquery).
create or replace function public.cumulative_threshold(p_rule_id uuid, p_level int)
returns interval
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(s.threshold_hours), 0) * interval '1 hour'
  from public.escalation_steps s
  where s.rule_id = p_rule_id and s.level <= p_level
$$;

comment on function public.cumulative_threshold(uuid, int) is
  'Sum of threshold_hours up to and including p_level, as an interval — the offset from a rule''s anchor at which the step fires (CLAUDE.md §9, §11).';

-- ── due_escalations(p_now): the pure evaluator (§20 C2) ───────────────────────
-- Returns every (rule, step, target) tuple whose cumulative threshold has elapsed
-- by p_now and whose underlying condition is still unmet. Stateless and idempotent:
-- the dispatcher dedups sends and opens events; this function only answers "what is
-- due right now?". The clock is the p_now argument — pass any instant in a test.
create or replace function public.due_escalations(p_now timestamptz default now())
returns table (
  rule_id            uuid,
  level              int,
  recipient_id       uuid,
  recipient_scope    public.recipient_scope,
  target_entity_type text,
  target_entity_id   uuid,
  department_id      uuid,
  project_id         uuid,
  period_bucket      public.escalation_period,
  dedup_key          text,
  subject            text,
  body               text
)
language sql
stable
security definer
set search_path = ''
as $$
  -- ── late_update: a workspace's update is still unsubmitted past the deadline ──
  -- anchor = update_cycles.closes_at; period token derived from the rule's bucket.
  select
    r.id,
    s.level,
    public.escalation_recipient(s.recipient_scope, w.department_id, du.submitted_by),
    s.recipient_scope,
    'department_update'::text,
    du.id,
    w.department_id,
    w.project_id,
    r.period_bucket,
    -- period anchor = the cycle's close time (NOT p_now), so a missed deadline
    -- dedups to the same bucket no matter when the dispatcher tick runs.
    format('rule:%s:step:%s:target:%s:period:%s', r.id, s.level, du.id,
           public.escalation_period_token(r.period_bucket, c.closes_at)),
    format('Weekly update overdue — %s', coalesce(d.name, 'department')),
    format('The weekly update for %s (cycle closing %s) is still %s. Escalation level %s.',
           coalesce(d.name, 'department'),
           to_char(c.closes_at at time zone 'Europe/Budapest', 'YYYY-MM-DD HH24:MI'),
           du.status, s.level)
  from public.escalation_rules r
  join public.escalation_steps s on s.rule_id = r.id
  join public.department_updates du on du.status in ('draft', 'rejected')          -- not submitted
  join public.update_cycles c on c.id = du.cycle_id and c.closes_at <= p_now        -- deadline passed
  join public.department_workspaces w on w.id = du.workspace_id
  left join public.departments d on d.id = w.department_id
  where r.active and r.rule_type = 'late_update'
    and (r.department_id is null or r.department_id = w.department_id)              -- rule scope (null = global)
    and (r.project_id   is null or r.project_id   = w.project_id)
    and c.closes_at + public.cumulative_threshold(r.id, s.level) <= p_now           -- this step is DUE

  union all

  -- ── red_lingering: a task currently RED, red since `since`, past threshold ────
  -- anchor = the most recent transition INTO red; period token derived from bucket.
  -- NOTE: the `day` bucket re-anchors on p_now, so a dispatch straddling local
  -- midnight intentionally re-nags (new day = new period) and can place two sends
  -- minutes apart across the boundary — correct per §11's daily cadence.
  select
    r.id,
    s.level,
    public.escalation_recipient(s.recipient_scope, w.department_id, t.assignee_id),
    s.recipient_scope,
    'task'::text,
    t.id,
    w.department_id,
    w.project_id,
    r.period_bucket,
    format('rule:%s:step:%s:target:%s:period:%s', r.id, s.level, t.id,
           public.escalation_period_token(r.period_bucket, p_now)),
    format('Red item lingering — %s', t.title),
    format('Task "%s" has been RED since %s. Escalation level %s.',
           t.title,
           to_char(red.since at time zone 'Europe/Budapest', 'YYYY-MM-DD HH24:MI'),
           s.level)
  from public.escalation_rules r
  join public.escalation_steps s on s.rule_id = r.id
  join public.tasks t on t.rag_status = 'red'
  join public.department_workspaces w on w.id = t.workspace_id
  join lateral (
    select max(h.changed_at) as since
    from public.rag_status_history h
    where h.entity_type = 'task' and h.entity_id = t.id and h.new_status = 'red'
  ) red on true
  where r.active and r.rule_type = 'red_lingering'
    and (r.department_id is null or r.department_id = w.department_id)
    and (r.project_id   is null or r.project_id   = w.project_id)
    and red.since is not null
    and red.since + public.cumulative_threshold(r.id, s.level) <= p_now

  -- blocked_dependency: no-op until Phase 6 (the dependencies table does not exist
  -- yet). When it lands, add a third UNION ALL branch here behind this same
  -- interface — the dispatcher and sender need no change.
$$;

comment on function public.due_escalations(timestamptz) is
  'Pure clock-injected evaluator (CLAUDE.md §20 C2): every (rule, step, target) due by p_now with its condition still unmet. One branch per rule_type, each computing its own anchor + period. No side effects.';

-- ── resolve_escalations(): close events whose cause has cleared ───────────────
-- The inverse of each due_escalations() branch's condition, in ONE place, so the
-- dispatcher stays a clean pipeline (evaluate → queue+open → resolve).
-- CONTRACT: every rule_type branch added to due_escalations() must add a matching
-- resolve condition here, or its events never close (Phase 6 blocked_dependency).
create or replace function public.resolve_escalations(p_now timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.escalation_events e set resolved_at = p_now
  where e.resolved_at is null
    and e.target_entity_type = 'department_update'
    and exists (
      select 1 from public.department_updates du
      where du.id = e.target_entity_id and du.status in ('pending', 'approved')
    );

  update public.escalation_events e set resolved_at = p_now
  where e.resolved_at is null
    and e.target_entity_type = 'task'
    and exists (
      select 1 from public.tasks t
      where t.id = e.target_entity_id and t.rag_status <> 'red'
    );
end;
$$;

comment on function public.resolve_escalations(timestamptz) is
  'Closes escalation_events whose underlying cause has cleared — the inverse of each due_escalations() branch, in one home (CLAUDE.md §11, §20). Extend alongside every new rule_type.';

-- ── escalation_dispatch(): consume due_escalations → outbox + events ──────────
-- Idempotent. Returns the number of NEW outbox rows queued this run.
create or replace function public.escalation_dispatch(p_now timestamptz default now())
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_queued int;
begin
  -- One statement evaluates due_escalations ONCE and feeds BOTH writes from the
  -- same snapshot (a re-call could see a concurrently-changed condition and queue
  -- a send with no matching event). Both INSERTs are data-modifying CTEs, which
  -- Postgres always runs to completion even though the final SELECT reads only one.
  with due as (
    select * from public.due_escalations(p_now)
  ),
  ins_outbox as (
    -- Period-deduped sends. dedup_key UNIQUE => a re-run in the same period is a
    -- silent no-op (non-negotiable #3). next_attempt_at stays null for queued rows
    -- (it only governs the retry backoff of FAILED rows).
    insert into public.notification_outbox
      (rule_id, level, recipient_id, channel, subject, body, dedup_key, status)
    select d.rule_id, d.level, d.recipient_id, 'email', d.subject, d.body, d.dedup_key, 'queued'
    from due d
    on conflict (dedup_key) do nothing
    returning 1
  ),
  ins_events as (
    -- Open exactly ONE event per (rule, level, target) — independent of how many
    -- times the send re-fires across periods. (A daily-renagged red item keeps a
    -- single open event, not one per day.)
    insert into public.escalation_events
      (rule_id, level, target_entity_type, target_entity_id, department_id, project_id, triggered_at)
    select distinct d.rule_id, d.level, d.target_entity_type, d.target_entity_id,
           d.department_id, d.project_id, p_now
    from due d
    where not exists (    -- fast path: skip the obvious already-open case
      select 1 from public.escalation_events e
      where e.rule_id = d.rule_id and e.level = d.level
        and e.target_entity_id = d.target_entity_id and e.resolved_at is null
    )
    -- constraint-enforced backstop: a concurrent dispatcher that passed the same
    -- NOT EXISTS check cannot create a duplicate open event (escalation_events_open_uniq).
    on conflict (rule_id, level, target_entity_id) where resolved_at is null do nothing
    returning 1
  )
  select count(*) into v_queued from ins_outbox;

  -- Close events whose cause has cleared (the resolve policy lives in one home).
  perform public.resolve_escalations(p_now);

  return v_queued;
end;
$$;

comment on function public.escalation_dispatch(timestamptz) is
  'Consumes due_escalations(p_now) ONCE: writes period-deduped outbox rows, opens one event per (rule,level,target), resolves cleared events (CLAUDE.md §8, §11). Idempotent; returns rows newly queued.';

-- ── outbox_mark_failed(): the single home for retry backoff (§6, §11) ─────────
-- Called by the Edge Function (service role) when Resend rejects a send. attempts
-- was already incremented at claim time, so backoff = 2^attempts minutes, capped
-- at 60. A failed row is re-claimed by outbox_send_batch only once next_attempt_at
-- passes — retried IN PLACE, never re-queued as a new row.
create or replace function public.outbox_mark_failed(
  p_id uuid,
  p_error text,
  p_now timestamptz default now()
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.notification_outbox
  set status = 'failed',
      last_error = p_error,
      -- cap inside power's double domain BEFORE ::int, so a high attempts count
      -- (2^31+) can never overflow integer.
      next_attempt_at = p_now + (least(power(2, attempts), 60)::int || ' minutes')::interval
  where id = p_id;
$$;

comment on function public.outbox_mark_failed(uuid, text, timestamptz) is
  'Marks an outbox row failed with exponential backoff (2^attempts min, cap 60). Called by the escalation-sender Edge Function on a Resend failure — no silent failures (CLAUDE.md §6, §11).';

-- ── outbox_send_batch(): claim → mark sent → fire pg_net (§6, §8, §11) ────────
-- Reads the Vault-configured Edge Function URL FIRST. If it is unset, NOTHING is
-- claimed — rows stay `queued` as a visible backlog rather than being marked
-- `sent` with no delivery attempt (a misconfiguration must never silently drop
-- escalations, §6). When the URL is present: claims un-sent, due rows with FOR
-- UPDATE SKIP LOCKED so concurrent runs never grab the same row, marks them sent
-- BEFORE delivery (§6 "mark sent before delivery to prevent retries from
-- double-sending" — a deliberate at-most-once bias: NO double-send is preferred
-- over a rare transport-loss), then fires ONE pg_net request. The Edge Function
-- delivers via Resend and demotes any failure back to `failed` via
-- outbox_mark_failed. Returns the number of rows claimed this run.
create or replace function public.outbox_send_batch(
  p_limit int default 50,
  p_now timestamptz default now()
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_count int;
  v_url text;
  v_key text;
begin
  -- Secrets live in Vault, never in this migration or a NEXT_PUBLIC_ var (§14, §17).
  -- Read the URL first: with no URL we cannot deliver, so we must NOT claim/mark
  -- rows sent — leave them queued (visible backlog) for a later, configured run.
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'escalation_function_url';
  if v_url is null then
    raise notice 'outbox_send_batch: escalation_function_url not set in Vault — leaving queued rows for a later run';
    return 0;
  end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'escalation_function_secret';

  with claimable as (
    select id
    from public.notification_outbox
    where status = 'queued'
       or (status = 'failed' and (next_attempt_at is null or next_attempt_at <= p_now))
    order by created_at
    for update skip locked
    limit p_limit
  ),
  claimed as (
    update public.notification_outbox o
    set status = 'sent', sent_at = p_now, attempts = attempts + 1
    from claimable c
    where o.id = c.id
    returning o.id
  )
  select coalesce(array_agg(id), '{}') into v_ids from claimed;

  v_count := coalesce(array_length(v_ids, 1), 0);
  if v_count = 0 then
    return 0;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(v_key, '')
    ),
    body := jsonb_build_object('outbox_ids', to_jsonb(v_ids))
  );

  return v_count;
end;
$$;

comment on function public.outbox_send_batch(int, timestamptz) is
  'Claims un-sent due outbox rows (FOR UPDATE SKIP LOCKED), marks them sent before delivery, and fires pg_net at the escalation-sender Edge Function (CLAUDE.md §6, §8, §11). No Vault URL => claims nothing (queued backlog stays visible, never silently dropped).';

-- ── lock down: system functions, not user RPCs (0013 / 0020 discipline) ───────
revoke execute on function public.escalation_recipient(public.recipient_scope, uuid, uuid) from public, authenticated, anon;
revoke execute on function public.escalation_period_token(public.escalation_period, timestamptz) from public, authenticated, anon;
revoke execute on function public.cumulative_threshold(uuid, int)     from public, authenticated, anon;
revoke execute on function public.due_escalations(timestamptz)        from public, authenticated, anon;
revoke execute on function public.resolve_escalations(timestamptz)    from public, authenticated, anon;
revoke execute on function public.escalation_dispatch(timestamptz)    from public, authenticated, anon;
revoke execute on function public.outbox_mark_failed(uuid, text, timestamptz) from public, authenticated, anon;
revoke execute on function public.outbox_send_batch(int, timestamptz) from public, authenticated, anon;

-- The escalation-sender Edge Function runs as the service role and calls
-- outbox_mark_failed to demote a rejected send. Grant it back to service_role
-- only (server-side, never exposed to the browser per §14) — the revoke above
-- already keeps it off the authenticated/anon RPC surface.
grant execute on function public.outbox_mark_failed(uuid, text, timestamptz) to service_role;

-- ── schedule the jobs (idempotent: cron.schedule upserts by name, pg_cron 1.6) ─
-- "Just a tick" — the thresholds, not the cron expression, decide what is due.
select cron.schedule('escalation_dispatch', '*/15 * * * *', $$ select public.escalation_dispatch(); $$);
select cron.schedule('outbox_send_batch',   '*/5  * * * *', $$ select public.outbox_send_batch(); $$);

-- ── Vault secrets (set ONCE per environment, NOT in version control) ──────────
-- The escalation engine needs the Edge Function URL + a shared secret to call it.
-- Until these are set, outbox_send_batch leaves rows queued (no silent drops).
-- Create them out-of-band (psql / dashboard), e.g.:
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/escalation-sender', 'escalation_function_url');
--   select vault.create_secret('<long-random-shared-secret>',                              'escalation_function_secret');
-- The same shared secret is configured as the ESCALATION_FUNCTION_SECRET env var on
-- the Edge Function, which rejects any request whose Bearer token does not match.

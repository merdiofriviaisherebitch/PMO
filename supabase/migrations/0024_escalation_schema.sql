-- 0024_escalation_schema.sql
-- Phase 5 escalation engine — schema, indexes, access model (CLAUDE.md §5 module 8, §9, §11).
-- The engine logic (due_escalations / dispatch / outbox sender / pg_cron) is 0025;
-- this migration is the data model + RLS it runs on.
--
-- SCOPE VOCABULARY (§3 glossary, §20 C6): §9 sketches escalation_rules with a
-- `target_scope` enum + an untyped `target_id`. We instead use the ONE scope
-- representation the rest of the schema already speaks — a nullable
-- (department_id, project_id) pair, both null = global. escalation_rules then
-- shares the exact isolation vocabulary of audit_log / escalation_events and
-- gets real foreign keys instead of an untyped id. This is the "finish during
-- build" half of C6.
--
-- AUDIT (§20 C1): the escalation_* tables are machine-written operational logs
-- and system config, NOT user-mutated governance entities, so they deliberately
-- carry NO audit_capture trigger (auditing the audit-like log would be circular).
-- If an executive rule-editing UI is added later, attach the generic trigger then.

-- ── enums ─────────────────────────────────────────────────────────────────────
-- The four §9 finite-value domains not created in 0002 (relation_type is Phase 6),
-- plus an enum for rule_type (§14: finite-value fields are enums, never varchar).
create type public.notification_channel as enum ('email', 'teams');
create type public.notification_status   as enum ('queued', 'sent', 'failed');
create type public.escalation_period     as enum ('iso_week', 'day');
create type public.recipient_scope       as enum ('member', 'director', 'executive');
create type public.escalation_rule_type  as enum ('late_update', 'red_lingering', 'blocked_dependency');

-- ── escalation_rules: one row per governance rule (WHAT to watch) ─────────────
create table public.escalation_rules (
  id            uuid primary key default gen_random_uuid(),
  rule_type     public.escalation_rule_type not null,
  -- Scope (§3, §20 C6): both null => the rule applies to every department/project.
  department_id uuid references public.departments (id) on delete cascade,
  project_id    uuid references public.projects (id)    on delete cascade,
  period_bucket public.escalation_period not null,  -- re-send cadence for THIS rule (§11)
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

comment on table public.escalation_rules is
  'A time-based governance rule (CLAUDE.md §8, §11). Scope = (department_id, project_id), both null = global. period_bucket sets the re-send cadence (iso_week vs day).';

-- ── escalation_steps: the ordered ladder for a rule (HOW it escalates) ────────
-- threshold_hours is "hours after the PREVIOUS step before this step fires" (§9),
-- so the absolute fire time of step N is anchor + sum(threshold_hours[1..N]).
create table public.escalation_steps (
  id              uuid primary key default gen_random_uuid(),
  rule_id         uuid not null references public.escalation_rules (id) on delete cascade,
  level           int  not null check (level >= 1),                  -- 1=member, 2=director, 3=exec (convention)
  threshold_hours numeric not null check (threshold_hours >= 0),     -- hours after the previous step (§9)
  recipient_scope public.recipient_scope not null,
  unique (rule_id, level)
);

comment on table public.escalation_steps is
  'One rung of a rule''s escalation ladder (CLAUDE.md §11). threshold_hours is measured from the previous step, so step fire times are cumulative.';

-- ── escalation_events: append-style log of every fired ladder step (§9) ───────
-- Polymorphic target (entity_type + id) like audit_log; department_id/project_id
-- are denormalized so a director can read their own department's escalations (§10).
create table public.escalation_events (
  id                 uuid primary key default gen_random_uuid(),
  rule_id            uuid not null references public.escalation_rules (id) on delete cascade,
  level              int  not null,                                  -- which ladder rung fired (§9)
  target_entity_type text not null,                                  -- 'department_update' | 'task' | 'department_workspace' | 'project'
  target_entity_id   uuid not null,
  department_id      uuid references public.departments (id) on delete set null,  -- denormalized for RLS (§9, §10)
  project_id         uuid references public.projects (id)    on delete set null,  -- denormalized for RLS (§9, §10)
  triggered_at       timestamptz not null default now(),
  resolved_at        timestamptz                                     -- stamped when the underlying condition clears
);

comment on table public.escalation_events is
  'Append-style record of each fired ladder step (CLAUDE.md §9). resolved_at is set when the condition clears (update submitted / item no longer red). department_id is denormalized for director-scoped RLS.';

-- ── notification_outbox: the idempotent send queue (§9, §11, non-negotiable #3) ─
create table public.notification_outbox (
  id              uuid primary key default gen_random_uuid(),
  rule_id         uuid references public.escalation_rules (id) on delete set null,
  level           int,
  recipient_id    uuid references public.users (id) on delete cascade,
  channel         public.notification_channel not null default 'email',
  subject         text not null,
  body            text not null,
  -- "rule:<id>:step:<level>:target:<id>:period:<bucket>" (§11). The UNIQUE
  -- constraint IS the idempotency guarantee: a second insert for the same
  -- (rule, step, target, period) is silently dropped (ON CONFLICT DO NOTHING).
  dedup_key       text not null unique,
  status          public.notification_status not null default 'queued',
  attempts        int  not null default 0,
  last_error      text,
  next_attempt_at timestamptz,                 -- backoff: a failed row is re-claimed only once this passes
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);

comment on table public.notification_outbox is
  'Idempotent escalation/notification send queue (CLAUDE.md §6 non-negotiable #3, §9, §11). dedup_key UNIQUE prevents double-sends; failed sends are retried in place with backoff, never re-queued as a new row.';

comment on column public.notification_outbox.dedup_key is
  'rule:<id>:step:<level>:target:<id>:period:<bucket> — UNIQUE. <bucket> granularity comes from the rule''s period_bucket, NOT hard-coded iso-week (§11).';

-- ── indexes (supabase-postgres-best-practices: index every FK + hot predicate) ─
create index escalation_rules_active_idx          on public.escalation_rules (active) where active;
create index escalation_steps_rule_idx            on public.escalation_steps (rule_id);
create index escalation_events_rule_target_idx    on public.escalation_events (rule_id, level, target_entity_id);
-- "still-open escalations" is the hot read for the dashboard + the resolver.
create index escalation_events_open_idx           on public.escalation_events (target_entity_id) where resolved_at is null;
create index escalation_events_department_idx     on public.escalation_events (department_id);
-- One OPEN event per (rule, level, target), constraint-enforced: two concurrent
-- dispatchers cannot both insert (a NOT EXISTS guard alone is best-effort). A
-- resolved event leaves this partial index, so a genuine recurrence can open a
-- fresh event later.
create unique index escalation_events_open_uniq
  on public.escalation_events (rule_id, level, target_entity_id) where resolved_at is null;
-- The outbox drain repeatedly scans only un-sent rows → a partial index keeps it tiny.
create index notification_outbox_claimable_idx    on public.notification_outbox (created_at) where status <> 'sent';
create index notification_outbox_recipient_idx    on public.notification_outbox (recipient_id);

-- ── RLS (§6 non-negotiable #1, §10; regression test requires RLS + ≥1 policy) ──
alter table public.escalation_rules     enable row level security;
alter table public.escalation_steps     enable row level security;
alter table public.escalation_events    enable row level security;
alter table public.notification_outbox  enable row level security;

-- rules + steps are system configuration → executive-only read. All writes go
-- through the service role (dispatcher / admin paths), which bypasses RLS, so no
-- write policy is needed (and none is granted to members/directors).
create policy "escalation_rules read: exec only"
  on public.escalation_rules for select to authenticated
  using ( public.is_executive() );

create policy "escalation_steps read: exec only"
  on public.escalation_steps for select to authenticated
  using ( public.is_executive() );

-- events: department-scoped via the denormalized department_id, exactly like
-- audit_log (§10). A global/project event (department_id null) is exec-only.
create policy "escalation_events read: own department or all-if-exec"
  on public.escalation_events for select to authenticated
  using ( department_id = public.current_department() or public.is_executive() );

-- outbox: a user may read notifications addressed to them; executives read all.
-- (Directors get the department-level picture from escalation_events above.)
create policy "notification_outbox read: own or all-if-exec"
  on public.notification_outbox for select to authenticated
  using ( recipient_id = (select auth.uid()) or public.is_executive() );

-- ── seed default rules (§18 Q7 PLACEHOLDERS — confirm thresholds with client) ─
-- The engine needs at least one rule to do anything, so seed sensible global
-- defaults here (system config, present on every environment). Thresholds and
-- the exact ladder are open client question §18 Q7 — tune via a later migration.
do $$
declare v_late uuid; v_red uuid;
begin
  -- Weekly late-update chase: at the deadline remind the member, +24h the
  -- director, +24h more (=48h past deadline) the executive. Re-anchors per ISO week.
  insert into public.escalation_rules (rule_type, period_bucket, active)
  values ('late_update', 'iso_week', true)
  returning id into v_late;
  insert into public.escalation_steps (rule_id, level, threshold_hours, recipient_scope) values
    (v_late, 1, 0,  'member'),
    (v_late, 2, 24, 'director'),
    (v_late, 3, 24, 'executive');

  -- Lingering-red chase: a task/workspace red for >48h pings the director, +48h
  -- more the executive. Re-nags daily (period_bucket = day) until it clears.
  insert into public.escalation_rules (rule_type, period_bucket, active)
  values ('red_lingering', 'day', true)
  returning id into v_red;
  insert into public.escalation_steps (rule_id, level, threshold_hours, recipient_scope) values
    (v_red, 1, 48, 'director'),
    (v_red, 2, 48, 'executive');
end $$;

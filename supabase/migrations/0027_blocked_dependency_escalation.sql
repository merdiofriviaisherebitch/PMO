-- 0027_blocked_dependency_escalation.sql
-- Phase 6 — wire the dependencies table (0026) into the Phase 5 escalation engine
-- (CLAUDE.md §5 module 7 "Blocked dependencies trigger automatic escalation", §8,
-- §11, §20 C2/C3). This was the reserved third rule_type: 0025 left an explicit
-- seam ("add a third UNION ALL branch here … the dispatcher and sender need no
-- change") and the resolve CONTRACT ("every rule_type branch added to
-- due_escalations() must add a matching resolve condition here").
--
-- We redefine due_escalations() and resolve_escalations() WHOLE — Postgres cannot
-- patch a function body, only CREATE OR REPLACE it — keeping the two existing
-- branches verbatim and adding blocked_dependency. CREATE OR REPLACE preserves the
-- 0025 privilege revokes (same signature), but we re-issue them at the end to keep
-- the lockdown explicit and self-evident.
--
-- SEMANTICS. A dependency of relation_type 'blocks' means the SOURCE must resolve
-- before the TARGET can proceed. If the source (the blocker) is RED — off-track or
-- blocked (§3) — the target is stuck, so we escalate to the TARGET (blocked) task's
-- department: the people waiting on the work. Anchor = the most recent transition
-- of the SOURCE task INTO red (the same anchor style as red_lingering, but on the
-- blocker). The event targets the DEPENDENCY itself, so there is one open event per
-- (rule, level, dependency) no matter how the daily re-nag fires.

-- ── due_escalations(p_now): now THREE branches behind one interface (§20 C2) ──
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

  union all

  -- ── blocked_dependency: a 'blocks' edge whose BLOCKER (source) task is RED ────
  -- The target (blocked) task can't proceed → escalate to the TARGET department.
  -- anchor = the source's most recent transition INTO red; target = the dependency
  -- (one open event per rule/level/edge). Rule scope is matched against the BLOCKED
  -- (target) department/project — a rule "for Finance" chases Finance's blockers.
  select
    r.id,
    s.level,
    public.escalation_recipient(s.recipient_scope, tw.department_id, tgt.assignee_id),
    s.recipient_scope,
    'dependency'::text,
    dep.id,
    tw.department_id,                       -- the BLOCKED (target) department is accountable
    tw.project_id,
    r.period_bucket,
    format('rule:%s:step:%s:target:%s:period:%s', r.id, s.level, dep.id,
           public.escalation_period_token(r.period_bucket, p_now)),
    format('Blocked dependency — %s', tgt.title),
    format('Task "%s" is blocked by "%s", RED since %s. Escalation level %s.',
           tgt.title, src.title,
           to_char(red.since at time zone 'Europe/Budapest', 'YYYY-MM-DD HH24:MI'),
           s.level)
  from public.escalation_rules r
  join public.escalation_steps s on s.rule_id = r.id
  join public.dependencies dep on dep.relation_type = 'blocks'
  join public.tasks src on src.id = dep.source_task_id and src.rag_status = 'red'   -- the blocker is red
  join public.tasks tgt on tgt.id = dep.target_task_id                              -- the blocked task
  join public.department_workspaces tw on tw.id = tgt.workspace_id                  -- blocked dept/project
  join lateral (
    select max(h.changed_at) as since
    from public.rag_status_history h
    where h.entity_type = 'task' and h.entity_id = src.id and h.new_status = 'red'
  ) red on true
  where r.active and r.rule_type = 'blocked_dependency'
    and (r.department_id is null or r.department_id = tw.department_id)
    and (r.project_id   is null or r.project_id   = tw.project_id)
    and red.since is not null
    and red.since + public.cumulative_threshold(r.id, s.level) <= p_now
$$;

comment on function public.due_escalations(timestamptz) is
  'Pure clock-injected evaluator (CLAUDE.md §20 C2): every (rule, step, target) due by p_now with its condition still unmet. THREE branches — late_update, red_lingering, blocked_dependency — each computing its own anchor + period behind the one interface. No side effects.';

-- ── resolve_escalations(): close events whose cause has cleared (§11, §20) ────
-- Adds the blocked_dependency inverse alongside the existing two — the CONTRACT
-- from 0025: a branch added to due_escalations() MUST get a matching close here, or
-- its events never resolve.
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

  -- blocked_dependency clears when the edge no longer represents an active block:
  -- the dependency was deleted, its relation is no longer 'blocks', OR the blocker
  -- (source) task is no longer red. NOT EXISTS covers all three at once.
  update public.escalation_events e set resolved_at = p_now
  where e.resolved_at is null
    and e.target_entity_type = 'dependency'
    and not exists (
      select 1
      from public.dependencies dep
      join public.tasks src on src.id = dep.source_task_id
      where dep.id = e.target_entity_id
        and dep.relation_type = 'blocks'
        and src.rag_status = 'red'
    );
end;
$$;

comment on function public.resolve_escalations(timestamptz) is
  'Closes escalation_events whose underlying cause has cleared — the inverse of each due_escalations() branch (late_update / red_lingering / blocked_dependency), in one home (CLAUDE.md §11, §20). Extend alongside every new rule_type.';

-- ── re-assert the lockdown (idempotent; signatures unchanged from 0025) ───────
revoke execute on function public.due_escalations(timestamptz)     from public, authenticated, anon;
revoke execute on function public.resolve_escalations(timestamptz) from public, authenticated, anon;

-- ── seed a default global blocked_dependency rule (§18 Q7 PLACEHOLDER) ─────────
-- A 'blocks' edge whose blocker has been red >24h pings the blocked department's
-- director; +24h more (=48h) the executive. Re-nags daily (period_bucket = day)
-- like red_lingering. Thresholds + ladder are the open client question §18 Q7.
do $$
declare v_blocked uuid;
begin
  insert into public.escalation_rules (rule_type, period_bucket, active)
  values ('blocked_dependency', 'day', true)
  returning id into v_blocked;
  insert into public.escalation_steps (rule_id, level, threshold_hours, recipient_scope) values
    (v_blocked, 1, 24, 'director'),
    (v_blocked, 2, 24, 'executive');
end $$;

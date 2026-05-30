-- 0012_realtime_authorization.sql
-- Realtime Authorization (CLAUDE.md §7, §10 "Realtime is scoped separately",
-- §15 item 7). Table RLS does NOT secure Realtime — a separate RLS policy on
-- realtime.messages gates who may subscribe to / broadcast on a private channel.
--
-- Channel convention: department dashboards subscribe to a PRIVATE channel
-- named `department:<department_uuid>`. A user may use that channel only if the
-- uuid matches their department claim, or they are an executive (cross-dept).
--
-- realtime.messages already has RLS enabled (by Supabase) with NO policies, i.e.
-- currently fail-closed (nobody can use any channel). These policies open up
-- exactly the department-scoped private channels and nothing else.
--
-- NOTE: Realtime is not consumed until the Phase 4 dashboards. Shipping the
-- authorization now means the guard is already in place when subscriptions land
-- (closes §15 item 7 instead of deferring it).

-- Receive (SELECT) on a department private channel.
create policy "realtime: receive own-department channel or exec"
  on realtime.messages
  for select
  to authenticated
  using (
    public.is_executive()
    or (
      realtime.topic() like 'department:%'
      and (select public.current_department()) is not null
      and split_part(realtime.topic(), ':', 2) = (select public.current_department())::text
    )
  );

-- Broadcast (INSERT) onto a department private channel — same scope check.
create policy "realtime: broadcast own-department channel or exec"
  on realtime.messages
  for insert
  to authenticated
  with check (
    public.is_executive()
    or (
      realtime.topic() like 'department:%'
      and (select public.current_department()) is not null
      and split_part(realtime.topic(), ':', 2) = (select public.current_department())::text
    )
  );

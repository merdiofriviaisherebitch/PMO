-- 0029_reports.sql
-- Phase 7 — Reports & Export (CLAUDE.md §5 module 11, §9, §10 Storage, §11; ADR 0003).
--
-- Creates the report metadata table, a NON-PUBLIC 'reports' Storage bucket, and the
-- storage.objects + reports RLS that scope report files to a department (executives
-- see all, including global roll-ups). The report FILES (PDF + XLSX) are produced by
-- the service-role report generator (ADR 0003) and uploaded under
-- reports/<department_id>/...  or  reports/global/...  ; this migration defines only
-- the schema + isolation.
--
-- §10 Storage doctrine baked in here:
--   * bucket is NON-PUBLIC;
--   * storage.objects RLS mirrors the department model via the object PATH;
--   * writes are service-role only (no app-role write policy);
--   * signed URLs are minted in app code ONLY after a server-side scope check — this
--     RLS is the DB-level backstop the pen-test exercises (member A cannot read B's
--     object by path or sign a URL for it).

-- ── period enum ──────────────────────────────────────────────────────────────
create type public.report_period as enum ('weekly', 'monthly');

-- ── reports metadata (§9; Scope = department_id + project_id, §3) ──────────────
create table public.reports (
  id            uuid primary key default gen_random_uuid(),
  period        public.report_period not null,
  -- Scope (§3 single vocabulary). department_id null AND project_id null = a GLOBAL
  -- executive roll-up across all departments (exec-only visibility).
  department_id uuid references public.departments (id) on delete cascade,
  project_id    uuid references public.projects (id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  -- Object paths within the non-public 'reports' bucket (the PDF + Excel exports of
  -- one logical report — §5 module 11 "Exportable as PDF and Excel").
  pdf_path      text not null,
  xlsx_path     text not null,
  generated_at  timestamptz not null default now(),
  generated_by  uuid references public.users (id) on delete set null,  -- null = system/cron
  check (period_end >= period_start)
);

comment on table public.reports is
  'Generated weekly/monthly governance report metadata (CLAUDE.md §5 module 11, §9). Scope = department_id + project_id (§3); both null = a global executive roll-up. Files live in the non-public reports Storage bucket; writes are service-role only (ADR 0003).';

-- One report per (scope, period type, window). NULL scope folded to the zero-uuid so a
-- global roll-up is unique per window too (NULLs are otherwise distinct in a unique index),
-- making generation idempotent (re-run upserts the same row instead of duplicating).
create unique index reports_scope_period_uidx on public.reports (
  coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(project_id,    '00000000-0000-0000-0000-000000000000'::uuid),
  period, period_start
);
create index reports_department_id_idx on public.reports (department_id);
create index reports_generated_at_idx on public.reports (generated_at desc);

-- ── grants: the app role may only READ; all writes are service-role (the generator) ──
-- Mirrors audit_log / approvals / rag_status_history (0011/0016/0017): SELECT granted,
-- writes denied at the privilege level so only the RLS-bypassing service role writes.
revoke all on public.reports from anon, authenticated;
grant select on public.reports to authenticated;

-- ── RLS: own-department reports, or executive sees all (incl. global roll-ups) ─
alter table public.reports enable row level security;

create policy "reports read: own department or exec"
  on public.reports for select to authenticated
  using (
    public.is_executive()
    or (department_id is not null and department_id = public.current_department())
  );
-- No insert/update/delete policy: the generator writes via the service role (RLS-bypassing,
-- re-scoped in code per §10, §14). The app role can never write a report row.

-- ── Storage: non-public 'reports' bucket ──────────────────────────────────────
insert into storage.buckets (id, name, public)
  values ('reports', 'reports', false)
  on conflict (id) do nothing;

-- storage.objects RLS mirrors the department model: the object PATH's first folder
-- segment encodes scope — reports/<department_id>/... (a UUID) or reports/global/...
-- A user reads only their own department's report objects; an executive reads all.
-- Writes (uploads) are service-role only (the generator) → no insert/update/delete
-- policy here; RLS denies app-role writes and the service role bypasses RLS.
create policy "reports bucket read: own-department path or exec"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'reports'
    and (
      public.is_executive()
      or (storage.foldername(name))[1] = public.current_department()::text
    )
  );

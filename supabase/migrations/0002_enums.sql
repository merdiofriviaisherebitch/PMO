-- 0002_enums.sql
-- Finite-value domains as Postgres ENUMs (CLAUDE.md §9 "Enumerations", §14).
-- Defined once here so every later migration references the type, never a varchar.

-- Application role. NOTE: this is the *app* role, carried in the JWT as the
-- custom `user_role` claim — NOT the reserved Postgres/`role` claim (see
-- docs/adr/0001-user-role-claim-not-role.md).
create type public.user_role as enum ('executive', 'director', 'member', 'viewer');

-- Red / Amber / Green health indicator on tasks, workspaces, projects (§3, §5).
create type public.rag_status as enum ('green', 'amber', 'red');

-- Weekly-update lifecycle (§5 module 4): draft -> pending -> approved, or
-- pending -> rejected -> draft (a rejected update returns to draft, never dead-ends).
create type public.update_status as enum ('draft', 'pending', 'approved', 'rejected');

-- Audit action verbs (§9 audit_log.action).
create type public.audit_action as enum ('create', 'update', 'delete', 'approve', 'reject', 'lock');

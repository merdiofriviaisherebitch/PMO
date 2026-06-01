-- 0031_fix_workspace_rag_history_scope.sql
-- C5 (Codex/Gemini adjudication, confirmed by psql): workspace RAG history rows
-- were written with NULL department_id/project_id, so a Director could NOT SELECT
-- their own department's workspace RAG history (§10 director visibility; §20 C1).
--
-- Root cause: rag_history_workspaces passed entity_type 'workspace' to
-- capture_rag_change(), which forwards it to resolve_scope(). resolve_scope speaks
-- 'department_workspace' (its vocabulary since 0021/0023/0026); the 'workspace'
-- string had no branch, so scope fell through to (null, null). That same string
-- also became the stored entity_type, splitting the one Scope vocabulary (§3).
--
-- Fix: re-attach the trigger with the canonical 'department_workspace' entity_type
-- (matches resolve_scope + audit_log), then backfill the existing NULL-scoped rows.
-- SAFE: every reader of rag_status_history filters entity_type = 'task'
-- (rls_pentest TEST 23; escalation red-lingering 0025:199 / 0027:107,148) — nothing
-- reads the 'workspace' literal, so renaming the stored value breaks no consumer.

drop trigger if exists rag_history_workspaces on public.department_workspaces;

create trigger rag_history_workspaces
  after insert or update of rag_status on public.department_workspaces
  for each row execute function public.capture_rag_change('department_workspace');

-- Backfill: normalize entity_type and denormalize the scope the old trigger failed
-- to set. rag_status_history is append-only to the APP role; this migration runs as
-- the owner (not the app role) and only repairs denormalized scope on rows that
-- already exist — it invents no events and deletes none (§6 audit immutability).
update public.rag_status_history h
set entity_type   = 'department_workspace',
    department_id = w.department_id,
    project_id    = w.project_id
from public.department_workspaces w
where h.entity_type = 'workspace'
  and w.id = h.entity_id;

comment on table public.rag_status_history is
  'Append-only RAG change log (CLAUDE.md §3, §5). entity_type in (task | department_workspace | project). Immutable to app role; written only by capture_rag_change(); scope denormalized via resolve_scope (§20 C1).';

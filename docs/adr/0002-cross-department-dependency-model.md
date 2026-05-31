# ADR 0002 — Cross-department dependency visibility & write model

**Status:** Accepted (2026-05-31, Phase 6)
**Relates to:** CLAUDE.md §5 module 7, §6 non-negotiable #1, §7, §10; migration `0026_dependencies.sql`.

## Context

Phase 6 adds task **dependencies** (typed edges: `blocks` / `precedes` / `relates`)
and a visual map. CLAUDE.md §7 explicitly wants **cross-department** dependency
tracking ("one department's task cannot start until another's resolves"), and §5
says a blocked dependency triggers escalation. But §6 non-negotiable #1 forbids a
department member from reading **another department's data** at the DB layer.

These pull in opposite directions: a dependency is inherently a relationship
*between* two departments' tasks, yet a member must not read the other
department's task. We need a model that delivers cross-department governance
without leaking task contents.

## Decision

**Split the EXISTENCE of an edge from the CONTENTS of its endpoints.**

1. **Denormalize both endpoint departments** onto `dependencies`
   (`source_department_id`, `target_department_id`), populated by a
   `SECURITY DEFINER` `BEFORE INSERT` trigger from each task's workspace — the same
   "denormalize department_id for RLS" doctrine used by `audit_log` /
   `escalation_events` (§9, §10, §17). The client never sets these.

2. **SELECT is symmetric:** a row is visible if *either* endpoint department is the
   caller's, or the caller is an executive. So both the blocking and blocked
   departments see the edge — each needs to know it exists — while the **foreign
   task row stays hidden by tasks-RLS**. The map renders the foreign endpoint as a
   department-labeled boundary node ("Legal · task hidden"), never its title,
   assignee, or dates. That is the *minimum* disclosure the cross-department
   escalation requires (§5, §11) and no more.

3. **Write model:** a non-executive may only **create or delete** an edge whose
   **both** endpoints are in their own department (an intra-department edge),
   enforced by `task_in_my_department(source) AND task_in_my_department(target)`.
   A **cross-department** edge requires an **executive** — the only role that can
   see both tasks to choose them. There is **no UPDATE policy**: edges are
   immutable (create / delete only), which also stops the denormalized department
   columns from ever drifting.

4. **Escalation** (`0027`) targets the **dependency**, is accountable to the
   **blocked (target) department**, and resolves when the edge is deleted, its
   relation is no longer `blocks`, or the blocker recovers from red.

## Consequences

- Cross-department blockers are governed and escalated **without** any member ever
  reading another department's task — isolation (§6 #1) holds; the pen-test adds an
  explicit case (TEST 35).
- Cross-department edges are an **executive** action in v1. A director cannot create
  one (they can't see the foreign task to pick it). **Open question for the client
  (§18):** should a director be able to *request* a cross-department link, or is
  exec-owned sufficient? Recorded as a §18-style open item; the conservative
  exec-only default ships now and can be widened later without schema change.
- The denormalized department columns are an extra write-time derivation, justified
  because the **map also needs them** to label boundary nodes (the foreign workspace
  is RLS-hidden, so the app cannot learn the foreign department any other way).

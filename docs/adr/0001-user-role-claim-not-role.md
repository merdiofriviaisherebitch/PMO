# ADR 0001 — Store the app role in a `user_role` JWT claim, not `role`

**Status:** Accepted (2026-05-30, Phase 1)
**Supersedes:** the literal claim name in CLAUDE.md §10 (which reads `auth.jwt() ->> 'role'`).

## Context

CLAUDE.md §10 specifies a Custom Access Token Hook that stamps the user's role and
department into the JWT, and RLS helpers that read `auth.jwt() ->> 'role'` /
`->> 'department_id'`. The `department_id` part is fine. The `role` part is not.

`role` is a **reserved JWT claim** in the Supabase/PostgREST stack:

- **PostgREST** reads the `role` claim to decide which Postgres role to `SET ROLE`
  into for the request (normally `authenticated`). If the hook overwrites `role`
  with `executive` / `director` / `member`, PostgREST tries to switch into a
  Postgres role that does not exist and the request fails.
- **Realtime** also reserves `role` (and `exp`); reusing it causes problems.

Sources: Supabase "Custom Claims & RBAC" guide and "Custom Access Token Hook" /
"Auth Hooks" docs (verified 2026-05-30).

## Decision

Store the **application role** in a dedicated top-level claim **`user_role`**, and
never touch the reserved `role` claim.

- Hook sets `claims.user_role` (and `claims.department_id`) and returns the event
  with `role` left as Supabase issued it (`authenticated`).
- Postgres enum `public.user_role` with values
  `('executive','director','member','viewer')`; column `public.users.role` is of
  that type.
- RLS helpers read the claim:
  - `public.is_executive()` → `(select auth.jwt()) ->> 'user_role' = 'executive'`
  - `public.current_department()` → `(select auth.jwt()) ->> 'department_id'`

Everything else in §10 (helpers are `STABLE`, wrap `auth.jwt()` in a subselect,
executive override is an explicit `OR public.is_executive()`, denormalized
`department_id` for polymorphic tables) is unchanged.

## Consequences

- The executive cross-department override works (no broken `SET ROLE`).
- CLAUDE.md §10's wording (`->> 'role'`) is superseded by this ADR. When CLAUDE.md
  is next revised, §10 should read `user_role`.
- The application reads the app role from `user_role`; the Supabase `role` claim
  remains the Postgres role and is not used for authorization decisions.

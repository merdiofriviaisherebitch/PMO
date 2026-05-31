/**
 * Shared types + helpers for Server Actions (CLAUDE.md §20: one home for a
 * repeated concern). Centralizes the RLS-error → human-message translation so
 * the three action modules can't drift (they previously each had a copy, one
 * divergent).
 */

export type ActionResult =
  | { ok: true }
  | { ok: false; errors: Record<string, string> }

/**
 * Turn an opaque Postgres/PostgREST permission error into a governance-aware
 * message. RLS is the security boundary — this is purely for UX when a write is
 * (correctly) refused. `action` completes the sentence "You don't have
 * permission to <action>.".
 */
export function rlsAwareMessage(raw: string, action: string): string {
  if (
    raw.includes("row-level security") ||
    raw.includes("violates row-level") ||
    raw.includes("permission denied")
  ) {
    return `You don't have permission to ${action}.`
  }
  // Transition/role guards (migration 0017/0019) raise check_violation with a
  // human-readable message. Surface those verbatim (they're written for users:
  // "Only a director or executive may approve an update"), but strip anything
  // that looks like a raw SQL/internal error.
  if (
    raw.startsWith("Only a") ||
    raw.startsWith("Illegal update transition") ||
    raw.startsWith("This update is")
  ) {
    return raw
  }
  return `Couldn't ${action} — please try again.`
}

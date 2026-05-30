import "server-only"

import { createClient } from "@/lib/supabase/server"
import type { Database } from "@/lib/types/database"

export type UserRole = Database["public"]["Enums"]["user_role"]

/**
 * The app-specific identity derived from the JWT custom claims (ADR 0001):
 * `user_role` + `department_id`, stamped by the access-token hook (CLAUDE.md §10).
 */
export type AppIdentity = {
  userId: string
  email: string | null
  role: UserRole | null
  departmentId: string | null
  isExecutive: boolean
}

/**
 * Reads the verified claims for the current request. Uses getClaims(), which
 * verifies the JWT signature (asymmetric) or falls back to the Auth server —
 * never trust unverified cookie contents for authorization (CLAUDE.md §17).
 *
 * Returns null when there is no authenticated user.
 */
export async function getAppIdentity(): Promise<AppIdentity | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getClaims()

  if (error || !data?.claims) {
    return null
  }

  const claims = data.claims as Record<string, unknown>
  const role = (claims.user_role as UserRole | null) ?? null

  // A token with no app role means the user has no public.users row (not
  // provisioned). Treat as unauthenticated so callers redirect to /login rather
  // than rendering an authenticated-but-unscoped shell (Phase 1 review M3).
  if (!role) {
    return null
  }

  return {
    userId: String(claims.sub ?? ""),
    email: (claims.email as string | undefined) ?? null,
    role,
    departmentId: (claims.department_id as string | undefined) ?? null,
    isExecutive: role === "executive",
  }
}

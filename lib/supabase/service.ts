import "server-only"

import { createClient as createSupabaseClient } from "@supabase/supabase-js"

import type { Database } from "@/lib/types/database"

/**
 * Service-role Supabase client.
 *
 * BYPASSES RLS entirely (CLAUDE.md §4, §10, §17): every caller MUST re-apply
 * department/project scoping in code, and must never place cross-department
 * data into a department-scoped artifact (report, export, notification).
 *
 * The `server-only` import makes importing this from a Client Component a build
 * error, and the key must never be exposed with a NEXT_PUBLIC_ prefix (§14).
 * Env is read lazily inside the factory so `next build` never throws when the
 * service key is absent at build time (e.g. in CI). For that reason, call this
 * inside a request handler / function body — never at module scope — so the
 * env guard runs per request rather than at import time.
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing Supabase service-role env (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)",
    )
  }

  return createSupabaseClient<Database>(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}

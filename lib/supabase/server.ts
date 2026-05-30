import "server-only"

import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"

import type { Database } from "@/lib/types/database"

/**
 * Server Supabase client (anon key + cookie session) for Server Components,
 * Route Handlers, and Server Actions.
 *
 * RLS enforces department/role scoping from the JWT claims (CLAUDE.md §8, §10).
 * `cookies()` is async in Next.js 15+, so this factory is async too.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options)
            }
          } catch {
            // Invoked from a Server Component, where the cookie store is
            // read-only. Safe to ignore when middleware refreshes the session
            // (added in the Phase 1 auth work).
          }
        },
      },
    },
  )
}

import { createBrowserClient } from "@supabase/ssr"

import type { Database } from "@/lib/types/database"

/**
 * Browser Supabase client (anon key + the user's session cookie).
 *
 * Safe to import from Client Components. Row Level Security scopes every read
 * and write to the caller's department/role JWT claims (CLAUDE.md §8, §10) —
 * never rely on application-layer filtering for isolation.
 *
 * Memoised as a module singleton so repeated calls reuse one client (one set of
 * auth listeners and one token-refresh timer) instead of racing duplicates.
 */
let browserClient: ReturnType<typeof createBrowserClient<Database>> | undefined

export function createClient() {
  browserClient ??= createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
  return browserClient
}

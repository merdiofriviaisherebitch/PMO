import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

import type { Database } from "@/lib/types/database"

/**
 * Refreshes the Supabase auth session on every request and gates access.
 *
 * Critical @supabase/ssr contract: the SAME response object whose cookies we
 * mutate must be the one returned, or the refreshed session is silently lost.
 * Do not run logic between createServerClient and getClaims() (auth.getUser is
 * also fine) — it must be the first await so the token is fresh.
 *
 * Auth-method-agnostic (CLAUDE.md §10): this is identical for email auth (now)
 * and Entra OIDC (config swap later) — both yield the same session cookies.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value)
          }
          supabaseResponse = NextResponse.next({ request })
          for (const { name, value, options } of cookiesToSet) {
            supabaseResponse.cookies.set(name, value, options)
          }
        },
      },
    },
  )

  // IMPORTANT: refreshes the token. Must be the first thing after client setup.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl
  const isAuthRoute = pathname.startsWith("/login") || pathname.startsWith("/auth")

  // Unauthenticated user hitting a protected route → send to /login.
  if (!user && !isAuthRoute) {
    const url = request.nextUrl.clone()
    url.pathname = "/login"
    return NextResponse.redirect(url)
  }

  // Authenticated user hitting /login → send to the app.
  if (user && pathname === "/login") {
    const url = request.nextUrl.clone()
    url.pathname = "/"
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

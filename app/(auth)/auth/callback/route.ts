import { NextResponse } from "next/server"

import { createClient } from "@/lib/supabase/server"

/**
 * OAuth / PKCE callback (CLAUDE.md §8 auth flow). Used by Entra OIDC sign-in
 * (and any email magic-link that uses the code flow): exchanges the `code` for a
 * session, then redirects into the app. Already in place so enabling Entra later
 * is purely configuration, not new code.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get("code")
  const next = searchParams.get("next") ?? "/"

  // Open-redirect guard: only follow a same-origin absolute path. Reject
  // protocol-relative ("//evil.com") and scheme-bearing values so a crafted
  // ?next= cannot bounce an authenticated user to an attacker origin.
  const safeNext =
    next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")
      ? next
      : "/"

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${origin}${safeNext}`)
    }
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(error.message)}`,
    )
  }

  return NextResponse.redirect(
    `${origin}/login?error=${encodeURIComponent("Missing authorization code")}`,
  )
}

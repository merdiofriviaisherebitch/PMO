import { NextResponse } from "next/server"

import { createClient } from "@/lib/supabase/server"

/**
 * Sign-out endpoint. POST-only so it can't be triggered by a stray GET/prefetch.
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  await supabase.auth.signOut()

  const { origin } = new URL(request.url)
  return NextResponse.redirect(`${origin}/login`, { status: 303 })
}

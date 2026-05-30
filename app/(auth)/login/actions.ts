"use server"

import { redirect } from "next/navigation"

import { createClient } from "@/lib/supabase/server"

/**
 * Email/password sign-in Server Action. Stand-in for Entra OIDC during build
 * (CLAUDE.md §12); the session it establishes drives the same hook → claims →
 * RLS pipeline. On success the session cookies are set by the server client and
 * middleware keeps them fresh.
 */
export async function login(formData: FormData) {
  const email = String(formData.get("email") ?? "")
  const password = String(formData.get("password") ?? "")

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`)
  }

  redirect("/")
}

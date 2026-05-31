import Link from "next/link"
import { redirect } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { getAppIdentity } from "@/lib/auth/claims"
import { createClient } from "@/lib/supabase/server"

/**
 * Authenticated app shell. One layout serves every role — the data each page
 * shows is scoped by RLS, and we branch only on *affordances* (e.g. the
 * executive sees a global badge). Unauthenticated users never reach here; the
 * middleware redirects them, and we re-check identity server-side as defense in
 * depth (CLAUDE.md §4, §17).
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const identity = await getAppIdentity()
  if (!identity) redirect("/login")

  // Resolve the department name for display (RLS lets a user read their own).
  let departmentName: string | null = null
  if (identity.departmentId) {
    const supabase = await createClient()
    const { data } = await supabase
      .from("departments")
      .select("name")
      .eq("id", identity.departmentId)
      .maybeSingle()
    departmentName = data?.name ?? null
  }

  const nav = [
    { href: "/", label: "Dashboard" },
    { href: "/projects", label: "Projects" },
    { href: "/tasks", label: "Tasks" },
  ]

  return (
    <div className="min-h-svh">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link href="/" className="font-semibold tracking-tight">
            PMO Control Tower
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-muted-foreground hover:text-foreground rounded-md px-3 py-1.5 transition-colors"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            {identity.isExecutive ? (
              <Badge variant="secondary">Executive · all departments</Badge>
            ) : (
              <Badge variant="outline">
                {departmentName ?? "No department"} · {identity.role}
              </Badge>
            )}
            <form action="/auth/signout" method="post">
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  )
}

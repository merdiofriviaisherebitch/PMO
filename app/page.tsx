import { redirect } from "next/navigation"

import { Button } from "@/components/ui/button"
import { getAppIdentity } from "@/lib/auth/claims"
import { createClient } from "@/lib/supabase/server"

/**
 * Authenticated landing. Proves the end-to-end identity pipeline: the values
 * shown here come from the JWT custom claims (user_role, department_id) stamped
 * by the access-token hook, and the task count is what RLS lets THIS user see.
 * A member sees only their department's rows; an executive sees all.
 */
export default async function Home() {
  const identity = await getAppIdentity()
  if (!identity) {
    redirect("/login")
  }

  const supabase = await createClient()
  // RLS-scoped reads — no manual department filter, the policies do it.
  const { count: visibleTasks } = await supabase
    .from("tasks")
    .select("*", { count: "exact", head: true })
  const { data: department } = identity.departmentId
    ? await supabase
        .from("departments")
        .select("name")
        .eq("id", identity.departmentId)
        .maybeSingle()
    : { data: null }

  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-6 px-6">
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
          SolServices · PMO Control Tower
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Signed in{identity.email ? ` as ${identity.email}` : ""}
        </h1>
      </div>

      <dl className="grid grid-cols-2 gap-4 text-sm">
        <div className="bg-card rounded-lg border p-4">
          <dt className="text-muted-foreground">Role (from JWT claim)</dt>
          <dd className="mt-1 text-lg font-medium capitalize">
            {identity.role ?? "—"}
          </dd>
        </div>
        <div className="bg-card rounded-lg border p-4">
          <dt className="text-muted-foreground">Department</dt>
          <dd className="mt-1 text-lg font-medium">{department?.name ?? "—"}</dd>
        </div>
        <div className="bg-card col-span-2 rounded-lg border p-4">
          <dt className="text-muted-foreground">
            Tasks visible to you (RLS-scoped)
          </dt>
          <dd className="mt-1 text-lg font-medium">
            {visibleTasks ?? 0}
            {identity.isExecutive ? " — all departments (executive)" : " — your department only"}
          </dd>
        </div>
      </dl>

      <form action="/auth/signout" method="post">
        <Button type="submit" variant="outline">
          Sign out
        </Button>
      </form>
    </main>
  )
}

import { login } from "./actions"
import { Button } from "@/components/ui/button"

/**
 * Sign-in page. Microsoft Entra ID (OIDC) is the production front door
 * (CLAUDE.md §12) — wired but disabled until the app registration / credentials
 * land (tracked in issue #6). Email sign-in is the proven stand-in: the entire
 * pipeline behind it (access-token hook → claims → RLS) is identical regardless
 * of how the user authenticates.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>
}) {
  const params = await searchParams

  return (
    <main className="mx-auto flex min-h-svh max-w-sm flex-col justify-center gap-6 px-6">
      <div className="space-y-2 text-center">
        <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
          SolServices
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          PMO Control Tower
        </h1>
        <p className="text-muted-foreground text-sm">Sign in to continue</p>
      </div>

      <Button variant="outline" disabled className="w-full">
        Sign in with Microsoft (pending IT setup)
      </Button>

      <div className="flex items-center gap-3">
        <span className="bg-border h-px flex-1" />
        <span className="text-muted-foreground text-xs">or</span>
        <span className="bg-border h-px flex-1" />
      </div>

      <form className="space-y-3">
        <div className="space-y-1">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className="border-input focus-visible:ring-ring w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:ring-2 focus-visible:outline-none"
            placeholder="you@solservices.test"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="password" className="text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="border-input focus-visible:ring-ring w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:ring-2 focus-visible:outline-none"
          />
        </div>

        {params.error ? (
          <p className="text-destructive text-sm" role="alert">
            {params.error}
          </p>
        ) : null}
        {params.message ? (
          <p className="text-muted-foreground text-sm">{params.message}</p>
        ) : null}

        <Button type="submit" formAction={login} className="w-full">
          Sign in
        </Button>
      </form>
    </main>
  )
}

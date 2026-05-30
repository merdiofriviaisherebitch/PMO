import { Button } from "@/components/ui/button"

export default function Home() {
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col items-center justify-center gap-6 px-6 text-center">
      <p className="text-muted-foreground text-sm font-medium tracking-widest uppercase">
        SolServices
      </p>
      <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
        PMO Control Tower
      </h1>
      <p className="text-muted-foreground text-balance">
        Executive project governance and accountability — one live view of every
        project across every department.
      </p>
      <Button disabled>Sign in with Microsoft (Phase 1)</Button>
    </main>
  )
}

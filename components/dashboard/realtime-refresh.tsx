"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

import { createClient } from "@/lib/supabase/client"

/**
 * Subscribes to the caller's department PRIVATE Realtime channel
 * (`department:<uuid>`, authorized by the RLS policy on realtime.messages in
 * migration 0012) and calls router.refresh() when a change is broadcast. This
 * re-runs the Server Components (re-fetching RLS-scoped data) WITHOUT a full
 * reload and without the client over-fetching — the server stays the source of
 * truth. Executives pass their own department id; cross-department roll-up
 * refreshes are coarse-grained and acceptable for a dashboard.
 *
 * Renders nothing; it's a behavior-only island mounted by the dashboard.
 */
export function RealtimeRefresh({ departmentId }: { departmentId: string | null }) {
  const router = useRouter()

  useEffect(() => {
    if (!departmentId) return
    const supabase = createClient()
    const channel = supabase
      .channel(`department:${departmentId}`, { config: { private: true } })
      .on("broadcast", { event: "change" }, () => {
        router.refresh()
      })
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [departmentId, router])

  return null
}

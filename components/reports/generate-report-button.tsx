"use client"

import { useTransition } from "react"

import { Button } from "@/components/ui/button"
import { generateMyReport } from "@/lib/actions/reports"
import type { ActionResult } from "@/lib/actions/shared"
import { useState } from "react"

/**
 * Client island for on-demand report generation. Rendered only for directors
 * and executives (affordance-gating in the Server Component parent; the action +
 * RLS enforce authorization server-side). On success the page refreshes via the
 * server-side revalidatePath("/reports") in the action.
 */
export function GenerateReportButton() {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ActionResult | null>(null)

  function handleGenerate(period: "weekly" | "monthly") {
    setResult(null)
    startTransition(async () => {
      const res = await generateMyReport(period)
      setResult(res)
    })
  }

  const errorMsg = result && !result.ok ? result.errors._form ?? "An error occurred." : null
  const success = result?.ok === true

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => handleGenerate("weekly")}
        >
          {pending ? "Generating…" : "Weekly report"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => handleGenerate("monthly")}
        >
          {pending ? "Generating…" : "Monthly report"}
        </Button>
      </div>
      {errorMsg ? (
        <p className="text-destructive text-sm" role="alert">
          {errorMsg}
        </p>
      ) : null}
      {success ? (
        <p className="text-sm text-emerald-600">Report generated — refreshing list.</p>
      ) : null}
    </div>
  )
}

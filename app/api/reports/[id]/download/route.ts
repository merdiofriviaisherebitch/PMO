/**
 * app/api/reports/[id]/download/route.ts — scope-checked signed-URL redirect.
 *
 * §10 Storage doctrine: signed-URL minting happens server-side AFTER an RLS
 * read confirms the caller can see the reports row. If RLS returns nothing the
 * URL is never minted and the client sees a 404. The browser only ever receives
 * a redirect to a short-lived signed URL — never the storage path itself.
 *
 * Format comes from the query string (?format=pdf|xlsx, default pdf).
 */

import { getReportSignedUrl } from "@/lib/data/reports"

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params

  const url = new URL(req.url)
  const rawFormat = url.searchParams.get("format") ?? "pdf"

  if (rawFormat !== "pdf" && rawFormat !== "xlsx") {
    return Response.json(
      { error: "format must be 'pdf' or 'xlsx'" },
      { status: 400 },
    )
  }

  const format = rawFormat as "pdf" | "xlsx"

  let signedUrl: string | null
  try {
    signedUrl = await getReportSignedUrl(id, format)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`reports/download: ${msg}`)
    return Response.json({ error: "failed to generate download link" }, { status: 500 })
  }

  if (signedUrl === null) {
    // RLS denied or the row doesn't exist — never mint a URL.
    return Response.json({ error: "not found" }, { status: 404 })
  }

  return Response.redirect(signedUrl, 302)
}

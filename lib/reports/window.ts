/**
 * lib/reports/window.ts — Pure report-window helper.
 *
 * PURE module: no database, no I/O, no "server-only". Exported for both server-side
 * callers (store.ts, actions/reports.ts, route handler) and vitest (ADR 0003).
 *
 * The clock is injected (`now`) so tests are deterministic. The window is resolved in
 * Europe/Budapest (APP_TIMEZONE, §18 Q2) — the SAME zone the update-cycle automation uses
 * (migration 0020 `week_cutoff`) — so a report's "week"/"month" aligns with the app's
 * cycle boundaries regardless of the server timezone (Vercel serverless runs UTC).
 */

const APP_TZ = "Europe/Budapest"

/** The calendar year/month/day of an instant in Europe/Budapest. */
function budapestParts(now: Date): { y: number; m: number; d: number } {
  // en-CA formats as YYYY-MM-DD, so splitting on "-" yields [year, month, day].
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(now)
    .split("-")
    .map(Number)
  return { y, m, d }
}

/**
 * Compute the inclusive [start, end] date window for a report period, as ISO
 * YYYY-MM-DD strings in Europe/Budapest.
 *
 * weekly  → Monday … Sunday of the ISO week that contains `now` (Budapest).
 * monthly → first … last calendar day of the month that contains `now` (Budapest).
 */
export function reportWindow(
  period: "weekly" | "monthly",
  now: Date,
): { start: string; end: string } {
  const { y, m, d } = budapestParts(now)
  // Anchor the resolved Budapest calendar day as a UTC midnight so the week/month
  // arithmetic below is pure date math, independent of the runtime timezone.
  const anchor = new Date(Date.UTC(y, m - 1, d))

  if (period === "weekly") {
    // ISO week: Monday = day 1. getUTCDay() returns 0=Sun … 6=Sat.
    const dow = anchor.getUTCDay()
    const daysToMonday = dow === 0 ? 6 : dow - 1
    const monday = new Date(anchor)
    monday.setUTCDate(anchor.getUTCDate() - daysToMonday)
    const sunday = new Date(monday)
    sunday.setUTCDate(monday.getUTCDate() + 6)
    return { start: toDateStr(monday), end: toDateStr(sunday) }
  }

  // monthly — first and last day of the Budapest month.
  const first = new Date(Date.UTC(y, m - 1, 1))
  const last = new Date(Date.UTC(y, m, 0)) // day 0 of next month = last day of this month
  return { start: toDateStr(first), end: toDateStr(last) }
}

/** Format a Date as YYYY-MM-DD using its UTC fields (the anchor is built in UTC). */
function toDateStr(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

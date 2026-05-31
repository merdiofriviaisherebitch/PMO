import { describe, expect, it } from "vitest"
import { reportWindow } from "./window"

// ─── reportWindow unit tests ───────────────────────────────────────────────────
// All tests inject an explicit `now` so the helper never touches the real clock.
// reportWindow resolves the window in Europe/Budapest (§18 Q2). To stay deterministic
// regardless of the test runner's timezone, each `now` is pinned to NOON UTC — which is
// safely mid-afternoon in Budapest (UTC+1/+2), so the Budapest calendar day equals the
// constructed Y-M-D and the assertions don't depend on where the suite runs.
const at = (y: number, m0: number, d: number) => new Date(Date.UTC(y, m0, d, 12, 0, 0))

describe("reportWindow – weekly", () => {
  it("Wednesday mid-week → that week's Monday and Sunday", () => {
    const now = at(2026, 5, 3) // 2026-06-03 Wednesday (month 0-indexed: 5 = June)
    const { start, end } = reportWindow("weekly", now)
    expect(start).toBe("2026-06-01") // Monday
    expect(end).toBe("2026-06-07")   // Sunday
  })

  it("Monday itself → same Monday and following Sunday", () => {
    const now = at(2026, 5, 1) // 2026-06-01 Monday
    const { start, end } = reportWindow("weekly", now)
    expect(start).toBe("2026-06-01")
    expect(end).toBe("2026-06-07")
  })

  it("Sunday (week boundary) → prior Monday and that Sunday", () => {
    const now = at(2026, 5, 7) // 2026-06-07 Sunday
    const { start, end } = reportWindow("weekly", now)
    expect(start).toBe("2026-06-01")
    expect(end).toBe("2026-06-07")
  })

  it("week crossing a month boundary", () => {
    const now = at(2026, 4, 28) // 2026-05-28 Thursday → Mon 05-25, Sun 05-31
    const { start, end } = reportWindow("weekly", now)
    expect(start).toBe("2026-05-25")
    expect(end).toBe("2026-05-31")
  })
})

describe("reportWindow – monthly", () => {
  it("mid-month date → first and last day of that month", () => {
    const now = at(2026, 4, 15) // 2026-05-15
    const { start, end } = reportWindow("monthly", now)
    expect(start).toBe("2026-05-01")
    expect(end).toBe("2026-05-31")
  })

  it("February non-leap year → 28 days", () => {
    const now = at(2026, 1, 10) // 2026-02-10 (2026 not a leap year)
    const { start, end } = reportWindow("monthly", now)
    expect(start).toBe("2026-02-01")
    expect(end).toBe("2026-02-28")
  })

  it("February leap year → 29 days", () => {
    const now = at(2024, 1, 20) // 2024-02-20 (leap year)
    const { start, end } = reportWindow("monthly", now)
    expect(start).toBe("2024-02-01")
    expect(end).toBe("2024-02-29")
  })

  it("December → ends on 31st", () => {
    const now = at(2026, 11, 1) // 2026-12-01
    const { start, end } = reportWindow("monthly", now)
    expect(start).toBe("2026-12-01")
    expect(end).toBe("2026-12-31")
  })
})

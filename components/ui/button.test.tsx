import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Button } from "@/components/ui/button"

/**
 * Phase 0 smoke test: proves the whole front-end toolchain is wired up —
 * TSX compilation, the Tailwind/cva component, React Testing Library, and the
 * jsdom + Vitest runner. Real feature tests arrive with each later phase (§15).
 */
describe("Button", () => {
  it("renders its children as an accessible button", () => {
    render(<Button>Lock baseline</Button>)

    expect(
      screen.getByRole("button", { name: "Lock baseline" }),
    ).toBeInTheDocument()
  })

  it("applies variant + size classes via cva", () => {
    render(
      <Button variant="destructive" size="sm">
        Reject update
      </Button>,
    )

    const button = screen.getByRole("button", { name: "Reject update" })
    expect(button).toHaveClass("bg-destructive")
  })

  it("renders as a child element when asChild is set", () => {
    render(
      <Button asChild>
        <a href="https://example.com/dashboard">Open dashboard</a>
      </Button>,
    )

    const link = screen.getByRole("link", { name: "Open dashboard" })
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute("href", "https://example.com/dashboard")
  })
})

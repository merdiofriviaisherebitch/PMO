import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

// Adds jest-dom matchers (toBeInTheDocument, toHaveClass, ...) to Vitest's
// `expect`, and registers the matcher type augmentations for tsc.
import "@testing-library/jest-dom/vitest"

// @testing-library/react only auto-registers cleanup when `afterEach` is a
// global. We run with Vitest globals disabled, so wire it up explicitly —
// otherwise rendered DOM leaks across tests and `getByRole` matches the wrong
// tree once a file renders more than once.
afterEach(() => {
  cleanup()
})

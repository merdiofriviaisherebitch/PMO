import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

// Resolve the config dir portably — `import.meta.dirname` needs Node 20.11+,
// and contributors may be on an older Node 20 LTS patch.
const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirror the tsconfig path alias ("@/*" -> "./*") so tests import the same
    // way app code does.
    alias: {
      "@": rootDir,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // Only our own source trees — never the gitignored research/vendor clones,
    // which ship their own (network-bound) suites (CLAUDE.md §14, §16).
    include: ["{app,components,lib}/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "research/**", ".next/**"],
  },
})

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Gitignored third-party clones studied read-only (CLAUDE.md §16) — never
    // linted, never imported into app code.
    "research/**",
    // Supabase Edge Functions run on Deno (Deno globals, esm.sh/jsr imports);
    // they have their own runtime + `deno test` and must never be type-checked
    // or linted by the Next.js (Node) toolchain.
    "supabase/functions/**",
  ]),
]);

export default eslintConfig;

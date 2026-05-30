# Domain Docs

How the engineering skills (`improve-codebase-architecture`, `diagnose`, `tdd`) should consume this repo's domain documentation. **Layout: single-context.**

## Before exploring, read these

- **`CLAUDE.md`** at the repo root — the single source of truth for this project. **Until a dedicated `CONTEXT.md` exists, CLAUDE.md §3 (Glossary) is the domain glossary** and CLAUDE.md §9–§12 are the architecture of record. Use this vocabulary.
- **`CONTEXT.md`** at the repo root — not present yet; `grill-with-docs` creates it lazily as terms get sharpened. When it exists, prefer it for the glossary.
- **`docs/adr/`** — not present yet. When ADRs exist, read those that touch the area you're working in before proposing changes.

If `CONTEXT.md` / `docs/adr/` don't exist, **proceed silently** using CLAUDE.md — don't flag their absence or suggest creating them upfront.

## Use the glossary's vocabulary

When output names a domain concept (issue title, refactor proposal, hypothesis, test name), use the term as defined in CLAUDE.md §3 — RAG status, baseline, delta, escalation, dependency block, audit trail, department workspace, update cycle, **Scope**, the 9 department names. Do not drift to synonyms the glossary avoids (e.g. say **seam**, not "boundary"; **Scope**, not ad-hoc "target_scope"/"scope_type").

If the concept you need isn't in CLAUDE.md yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it; `grill-with-docs` would add it to `CONTEXT.md`).

## Flag ADR conflicts

There are no ADRs yet. The closest equivalents are the §20 deepening decisions (C1–C7) and the §6 non-negotiables. If your output contradicts one of those, surface it explicitly rather than silently overriding — e.g. _"contradicts §20 C3 (Notifier port) — but worth reopening because…"_

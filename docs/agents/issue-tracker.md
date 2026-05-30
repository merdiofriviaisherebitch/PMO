# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in **`merdiofriviaisherebitch/PMO`**. Use the `gh` CLI for all operations.

> Status (2026-05-30): **live** — the repo is pushed to `origin/main`, GitHub Issues is enabled, and the triage labels exist. `to-issues` / `to-prd` can publish directly.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, fetching labels too.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` / `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

`gh` infers the repo from `git remote -v` when run inside the clone.

## Convention mapping for PMO build phases

When `to-prd`/`to-issues` break a build phase (§13 of CLAUDE.md) into work:
- One PRD issue per phase (label `phase:N`), then tracer-bullet issues sliced vertically per §19/tdd guidance.
- Tag each phase boundary in git (`phase-N-start` / `phase-N-end`) so the review skills get exact diffs (§13, §19.2).

## When a skill says "publish to the issue tracker"
Create a GitHub issue.

## When a skill says "fetch the relevant ticket"
Run `gh issue view <number> --comments`.

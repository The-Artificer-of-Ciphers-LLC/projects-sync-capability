---
name: projects-sync
description: Mirror GSD .planning/ROADMAP.md phases and milestones to GitHub Issues, Milestones, and (optionally) a Projects v2 board. One-way, idempotent, opt-in. Use when the user wants their GSD roadmap reflected on GitHub for collaborator/stakeholder visibility, or asks to sync/push phases to GitHub Issues or a project board.
---

# Projects Sync

Mirror this project's GSD planning state to GitHub — one-way (GSD → GitHub), idempotent, and entirely opt-in. The capability never edits `ROADMAP.md`; it only reads structured phase data via `gsd-tools roadmap analyze` and writes to GitHub.

## Prerequisites

- A GitHub token available to `gh` (the runtime's `gh` CLI must be authenticated).
- For the **board** feature only: a **classic PAT with the `project` scope**. Fine-grained tokens cannot reach user-owned Projects v2 boards — this is a common silent-failure gotcha.
- `projects-sync.enabled` config must be `true` (default is `false`). The loop hooks and this command are inert until you enable it:
  - `gsd-tools config-set projects-sync.enabled true`

## Commands

Invoke through the capability command family:

- `gsd-tools projects-sync sync` — create/update a GitHub Issue per ROADMAP phase; close issues for completed (`[x]`) phases; group them under a GitHub Milestone. Idempotent: re-running matches existing issues by a hidden `<!-- gsd-phase:N -->` marker in the issue body (not by title, so phase renames don't create duplicates). Writes a receipt to `.planning/projects-sync/SYNC-RECEIPT.json`.
- `gsd-tools projects-sync status` — dry run: report what `sync` *would* create/update/close. Writes nothing, mutates no issues.
- `gsd-tools projects-sync init` — first-run convenience: ensure the milestone exists, then sync all phases in one pass.

Add `--repo <owner>/<name>` to target a specific repository (otherwise the current repo is detected via `gh repo view`).

## How it maps

| ROADMAP state | GitHub Issue |
| --- | --- |
| Phase (open) | open Issue, label `gsd:in-progress` or `gsd:pending` |
| Phase `[x]` complete | closed Issue, label `gsd:complete` |
| Milestone heading | GitHub Milestone grouping the phases |

## Safety

This capability's loop hooks are registered as `step` / `contribution` with `onError: skip` — a GitHub outage, missing token, or rate limit makes the sync a no-op for that run and the GSD loop continues uninterrupted. It is **agent-invoked only** and must not run in CI: `.planning/` is typically gitignored and the CI `GITHUB_TOKEN` lacks the `project` scope.

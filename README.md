# projects-sync — GitHub Projects Sync (GSD capability)

A [GSD](https://github.com/open-gsd/gsd-core) **third-party capability** (ADR-1244) that mirrors your local planning state to GitHub — one-way, idempotent, and entirely opt-in.

It reads your `.planning/ROADMAP.md` (via `gsd-tools roadmap analyze`, never by reparsing the file) and pushes each phase to a GitHub Issue, grouped under a GitHub Milestone, with status reflected as issue state + labels. Re-running updates in place instead of creating duplicates. GSD's own state is never modified.

> **Requires GSD ≥ 1.6.0** (the capability ecosystem ships in 1.6.0). On earlier versions the installer will refuse with an `engines.gsd` error.

---

## Why

GSD keeps authoritative planning state in `.planning/ROADMAP.md`, which is typically gitignored. Sharing progress on GitHub otherwise means hand-maintaining Issues in parallel — two sources of truth that drift. This capability makes GitHub a *projection* of your roadmap, so the board is always a `sync` away from correct without exposing `.planning/`.

## Install

```bash
# from the published repo (pin a tag for integrity)
gsd capability install https://github.com/The-Artificer-of-Ciphers-LLC/projects-sync-capability.git#v0.1.0

# or from a local checkout while developing
gsd capability install ./projects-sync-capability --scope project
```

Install discloses the executable surface it ships (one command module) and records your consent in the per-scope ledger. It is **opt-in and default-off** — enable it explicitly:

```bash
gsd-tools config-set projects-sync.enabled true
```

## Usage (how-to)

```bash
# Dry run — show what would change, mutate nothing
gsd-tools projects-sync status

# Sync — create/update an Issue per phase, close completed phases, group under a Milestone
gsd-tools projects-sync sync

# First run — ensure the Milestone exists, then sync everything
gsd-tools projects-sync init
```

Target a specific repo with `--repo <owner>/<name>` (otherwise the current repo is detected via `gh repo view`). A receipt is written to `.planning/projects-sync/SYNC-RECEIPT.json`.

Once enabled, the capability also runs automatically as a loop hook at `execute:pre` (sync) and contributes a Projects-Sync note at `ship:post`.

## How phases map (reference)

| ROADMAP state | GitHub Issue |
| --- | --- |
| Phase, in progress | open Issue · label `gsd:in-progress` |
| Phase, not started | open Issue · label `gsd:pending` |
| Phase `[x]` complete | closed Issue · label `gsd:complete` |
| Milestone heading | GitHub Milestone grouping the phases |

Idempotency key: a hidden `<!-- gsd-phase:N -->` marker in each issue body, matched via `gh search issues ... in:body`. Matching is by **phase number, not title**, so renaming a phase never creates a duplicate.

## Configuration (reference)

| Key | Default | Meaning |
| --- | --- | --- |
| `projects-sync.enabled` | `false` | Master switch. Hooks and commands are inert until `true`. |
| `projects-sync.board` | `false` | Also add issues to a Projects v2 board (see auth note). |
| `projects-sync.project_url` | `""` | The Projects v2 board URL when `board` is enabled. |

## Authentication & limits (reference)

- The runtime's `gh` CLI must be authenticated.
- **Board sync requires a classic PAT with the `project` scope.** Fine-grained tokens silently cannot reach user-owned Projects v2 boards — a common gotcha, so board sync is behind its own flag.
- GitHub's content-creation limit is ~500 issues/hour; large `init` runs are paced accordingly.
- This is **agent-invoked only — do not run it in CI.** `.planning/` is gitignored and the CI `GITHUB_TOKEN` lacks the `project` scope.

## Safety (explanation)

The loop hooks register as `step` / `contribution` with `onError: skip`. A GitHub outage, missing token, or rate limit makes a run a no-op and the GSD loop continues uninterrupted — the sync can never block your workflow. All GitHub and gsd-tools calls go through `execFileSync` with argv arrays (no shell), and the capability never edits `ROADMAP.md`.

## Development

```bash
npm test   # node --test, no runtime dependencies
```

The engine is structured behind injectable `gsdExec` (gsd-tools) and `ghExec` (gh) seams so every path is unit-tested without network access. See `lib/` (markers, roadmap-source, github-client, sync-engine) and `projects-sync-router.cjs`.

## License

MIT © The Artificer of Ciphers LLC

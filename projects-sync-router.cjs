'use strict';

/**
 * projects-sync-router.cjs
 *
 * GSD capability router for the `projects-sync` family.
 * Standard router signature: routeProjectsSyncCommand({ args, cwd, raw, error, deps })
 *
 * The dispatcher passes args = process.argv.slice(2), so:
 *   args[0] === 'projects-sync'  (family name)
 *   args[1] === subcommand       (sync | status | init)
 *   args[2..] === flags/positionals
 *
 * Subcommands:
 *   sync   — run full sync, write SYNC-RECEIPT.json
 *   status — dry run: report what would change, no mutations, no writes
 *   init   — alias for sync (also ensures milestone, which sync already does)
 *
 * Injectable `deps` seam allows unit testing without real network or FS I/O:
 *   deps.sync(opts)                — replaces sync-engine sync()
 *   deps.loadPhases(opts)          — replaces roadmap-source loadPhases()
 *   deps.createGitHubClient(opts)  — replaces github-client factory
 *   deps.writeFile(path, content)  — replaces fs.writeFileSync
 *   deps.mkdirp(dir)               — replaces fs.mkdirSync(..., {recursive:true})
 *   deps.log(msg)                  — replaces console.log
 *   deps.gsdExec(argv)             — replaces real gsd-tools exec (for loadPhases)
 *   deps.ghExec(argv)              — replaces real gh exec (for github-client + resolveRepo)
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { sync: engineSync } = require('./lib/sync-engine.cjs');
const { loadPhases } = require('./lib/roadmap-source.cjs');
const { createGitHubClient } = require('./lib/github-client.cjs');
const { statusForPhase, phaseMarker } = require('./lib/markers.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RECEIPT_SUBPATH = path.join('.planning', 'projects-sync', 'SYNC-RECEIPT.json');
const VALID_SUBCOMMANDS = ['sync', 'status', 'init'];

/**
 * Parses --repo owner/name from args. Returns the value or null.
 */
function parseRepoArg(args) {
  const idx = args.indexOf('--repo');
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return null;
}

/**
 * Parses --board flag.
 */
function parseBoardFlag(args) {
  return args.includes('--board');
}

/**
 * Resolves the repo string: --repo flag takes priority, then `gh repo view`.
 * Uses ghExec because `gh repo view` is a gh CLI call, not gsd-tools.
 */
function resolveRepo(args, ghExec) {
  const fromFlag = parseRepoArg(args);
  if (fromFlag) return fromFlag;

  // Fall back: ask `gh`
  const stdout = ghExec(['repo', 'view', '--json', 'nameWithOwner']);
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && parsed.nameWithOwner) return parsed.nameWithOwner;
  } catch {
    // stdout might be a plain "owner/repo" string (from test stubs returning plain text)
    const trimmed = String(stdout).trim();
    if (trimmed.includes('/')) return trimmed;
  }
  throw new Error(`projects-sync-router: could not resolve repo. Pass --repo owner/name.`);
}

/**
 * Default exec for gh CLI (github-client methods + resolveRepo).
 */
function defaultGhExec(argv) {
  return execFileSync('gh', argv, { encoding: 'utf8' });
}

/**
 * Default exec for gsd-tools CLI (loadPhases).
 * Re-invokes the running gsd-tools entry point when possible so the capability
 * does not depend on `gsd-tools` being on PATH separately.
 */
function defaultGsdExec(argv) {
  const bin = process.env.GSD_TOOLS_BIN;
  if (bin) {
    return execFileSync(bin, argv, { encoding: 'utf8' });
  }
  if (process.argv && process.argv[1]) {
    return execFileSync(process.execPath, [process.argv[1], ...argv], { encoding: 'utf8' });
  }
  return execFileSync('gsd-tools', argv, { encoding: 'utf8' });
}

/**
 * Human-readable summary line for a receipt.
 */
function humanSummary(receipt) {
  const parts = [];
  if (receipt.created && receipt.created.length > 0) {
    parts.push(`Created: ${receipt.created.length} issue(s)`);
  }
  if (receipt.updated && receipt.updated.length > 0) {
    parts.push(`Updated: ${receipt.updated.length} issue(s)`);
  }
  if (receipt.closed && receipt.closed.length > 0) {
    parts.push(`Closed: ${receipt.closed.length} issue(s)`);
  }
  if (receipt.errors && receipt.errors.length > 0) {
    parts.push(`Errors: ${receipt.errors.length}`);
  }
  if (parts.length === 0) parts.push('No changes.');
  if (receipt.milestone) {
    parts.unshift(`Milestone: "${receipt.milestone}"`);
  }
  return `projects-sync: ${parts.join(' | ')}`;
}

// ---------------------------------------------------------------------------
// Subcommand: status (dry run)
// ---------------------------------------------------------------------------

function runStatus({ cwd, flagArgs, raw, deps }) {
  const { loadPhases: lp, createGitHubClient: cgc, log, gsdExec, ghExec } = deps;
  const repo = resolveRepo(flagArgs, ghExec);

  const phasesData = lp({ cwd, exec: gsdExec });
  const github = cgc({ repo, exec: ghExec });

  // Build a dry-run report: inspect each phase without mutating
  const report = {
    dryRun: true,
    repo,
    phases: [],
  };

  for (const phase of phasesData.phases) {
    const { state: targetState, label } = statusForPhase(phase);
    const marker = phaseMarker(phase.number);
    const existing = github.findIssueByMarker(phase.number);

    let action;
    if (!existing) {
      action = 'would-create';
    } else if (existing.state !== targetState) {
      action = targetState === 'closed' ? 'would-close' : 'would-reopen';
    } else {
      action = 'would-update';
    }

    report.phases.push({
      phase: phase.number,
      name: phase.name,
      targetState,
      label,
      marker,
      existingIssue: existing ? existing.number : null,
      action,
    });
  }

  if (raw) {
    log(JSON.stringify(report, null, 2));
  } else {
    log(`projects-sync status (dry run) — repo: ${repo}`);
    for (const p of report.phases) {
      const issueRef = p.existingIssue ? `#${p.existingIssue}` : '(new)';
      log(`  Phase ${p.phase}: ${p.name} — ${p.action} ${issueRef} [${p.label}]`);
    }
  }

  return { ok: true, dryRun: true, report };
}

// ---------------------------------------------------------------------------
// Subcommand: sync / init
// ---------------------------------------------------------------------------

function runSyncCommand({ cwd, flagArgs, raw, deps, subcommand }) {
  const { sync: syncFn, log, writeFile, mkdirp, gsdExec, ghExec } = deps;
  const repo = resolveRepo(flagArgs, ghExec);
  const board = parseBoardFlag(flagArgs);

  const receipt = syncFn({ cwd, repo, gsdExec, ghExec, board });

  // Write receipt to disk
  const receiptPath = path.join(cwd, RECEIPT_SUBPATH);
  const receiptDir = path.dirname(receiptPath);
  mkdirp(receiptDir);
  writeFile(receiptPath, JSON.stringify(receipt, null, 2));

  if (raw) {
    log(JSON.stringify(receipt));
  } else {
    const verb = subcommand === 'init' ? 'Init complete.' : 'Sync complete.';
    log(`${verb} ${humanSummary(receipt)}`);
    if (receipt.boardDeferred) {
      log('  Note: Projects v2 board wiring is deferred (board flag accepted but not implemented).');
    }
  }

  return { ok: true, receipt };
}

// ---------------------------------------------------------------------------
// Main router export
// ---------------------------------------------------------------------------

/**
 * Routes a projects-sync capability command.
 *
 * The dispatcher passes args = process.argv.slice(2), so:
 *   args[0] === 'projects-sync'  (family name)
 *   args[1] === subcommand
 *   args[2..] === flags/positionals
 *
 * @param {object} options
 * @param {string[]} options.args    — full argv slice (args[0] is the family name)
 * @param {string}   options.cwd    — project root
 * @param {boolean}  options.raw    — emit JSON instead of human prose
 * @param {Function} options.error  — (msg: string) => void; called for user errors
 * @param {object}   [options.deps] — injectable collaborators (for testing)
 * @returns {object}
 */
function routeProjectsSyncCommand({ args = [], cwd, raw = false, error, deps = {} }) {
  // --- Build effective deps (defaults + injected overrides) -----------------
  const effectiveDeps = {
    sync: engineSync,
    loadPhases,
    createGitHubClient,
    writeFile: (filePath, content) => fs.writeFileSync(filePath, content, 'utf8'),
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
    log: (msg) => console.log(msg),
    gsdExec: defaultGsdExec,
    ghExec: defaultGhExec,
    ...deps,
  };

  // args[0] is the family name ('projects-sync'), args[1] is the subcommand
  const subcommand = args[1];
  // flags/positionals start at args[2]
  const flagArgs = args.slice(2);

  // --- Route ----------------------------------------------------------------
  switch (subcommand) {
    case 'sync':
      return runSyncCommand({ cwd, flagArgs, raw, deps: effectiveDeps, subcommand: 'sync' });

    case 'init':
      return runSyncCommand({ cwd, flagArgs, raw, deps: effectiveDeps, subcommand: 'init' });

    case 'status':
      return runStatus({ cwd, flagArgs, raw, deps: effectiveDeps });

    default: {
      const msg = subcommand
        ? `projects-sync: unknown subcommand "${subcommand}". Available: ${VALID_SUBCOMMANDS.join(', ')}`
        : `projects-sync: no subcommand given. Available: ${VALID_SUBCOMMANDS.join(', ')}`;
      error(msg);
      return { ok: false, error: msg };
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { routeProjectsSyncCommand };

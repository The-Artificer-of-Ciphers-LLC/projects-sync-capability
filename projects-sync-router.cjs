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

const { sync: engineSync } = require('./lib/sync-engine.cjs');
const { loadPhases } = require('./lib/roadmap-source.cjs');
const { createGitHubClient } = require('./lib/github-client.cjs');
const { statusForPhase, phaseMarker } = require('./lib/markers.cjs');
const { makeDefaultGhExec, makeDefaultGsdExec } = require('./lib/exec-factories.cjs');

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

  // F4: fail-open for status (no write, just return error report)
  let repo;
  try {
    repo = resolveRepo(flagArgs, ghExec);
  } catch (resolveErr) {
    const errMsg = String(resolveErr.message ?? resolveErr);
    log(`projects-sync: could not resolve repository — ${errMsg}`);
    return {
      ok: false,
      receipt: makeResolveRepoErrorReceipt(errMsg),
    };
  }

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
// Helpers for fail-open receipt writing
// ---------------------------------------------------------------------------

/**
 * Builds an empty fail-open receipt with a single error entry.
 * Used when resolveRepo throws before sync can start.
 */
function makeResolveRepoErrorReceipt(errMsg) {
  return {
    created: [],
    updated: [],
    closed: [],
    skipped: [],
    errors: [{ phase: null, kind: 'resolveRepo', error: errMsg }],
    milestone: null,
  };
}

// ---------------------------------------------------------------------------
// Subcommand: sync / init
// ---------------------------------------------------------------------------

function runSyncCommand({ cwd, flagArgs, raw, deps, subcommand }) {
  const { sync: syncFn, log, writeFile, mkdirp, gsdExec, ghExec } = deps;

  // F4: wrap resolveRepo so a failure does NOT throw out of the router
  let repo;
  try {
    repo = resolveRepo(flagArgs, ghExec);
  } catch (resolveErr) {
    const errMsg = String(resolveErr.message ?? resolveErr);
    log(`projects-sync: could not resolve repository — ${errMsg}`);
    const receipt = makeResolveRepoErrorReceipt(errMsg);
    // Still write the receipt so callers can inspect the failure
    const receiptPath = path.join(cwd, RECEIPT_SUBPATH);
    const receiptDir = path.dirname(receiptPath);
    try { mkdirp(receiptDir); } catch { /* best-effort */ }
    try { writeFile(receiptPath, JSON.stringify(receipt, null, 2)); } catch { /* best-effort */ }
    return { ok: false, receipt };
  }

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
  // Default exec factories bind the child process cwd to the GSD project
  // directory so that `gh repo view` auto-detection resolves the correct repo
  // (not whatever git repo the Node process happens to sit in).
  const effectiveDeps = {
    sync: engineSync,
    loadPhases,
    createGitHubClient,
    writeFile: (filePath, content) => fs.writeFileSync(filePath, content, 'utf8'),
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
    log: (msg) => console.log(msg),
    gsdExec: makeDefaultGsdExec(cwd),
    ghExec: makeDefaultGhExec(cwd),
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

module.exports = { routeProjectsSyncCommand, makeDefaultGhExec, makeDefaultGsdExec };

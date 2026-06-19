'use strict';

/**
 * projects-sync-router.cjs
 *
 * GSD capability router for the `projects-sync` family.
 * Standard router signature: routeProjectsSyncCommand({ args, cwd, raw, error, deps })
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
 *   deps.exec(argv)                — replaces real gh exec
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
 */
function resolveRepo(args, exec) {
  const fromFlag = parseRepoArg(args);
  if (fromFlag) return fromFlag;

  // Fall back: ask `gh`
  const stdout = exec(['repo', 'view', '--json', 'nameWithOwner']);
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
 * Default real exec implementation.
 */
function realExec(argv) {
  return execFileSync('gh', argv, { encoding: 'utf8' });
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

async function runStatus({ cwd, args, raw, deps }) {
  const { loadPhases: lp, createGitHubClient: cgc, log, exec } = deps;
  const repo = resolveRepo(args, exec);

  const phasesData = await lp({ cwd, exec });
  const github = cgc({ repo, exec });

  // Build a dry-run report: inspect each phase without mutating
  const report = {
    dryRun: true,
    repo,
    phases: [],
  };

  for (const phase of phasesData.phases) {
    const { state: targetState, label } = statusForPhase(phase);
    const marker = phaseMarker(phase.number);
    const existing = await github.findIssueByMarker(phase.number);

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

async function runSyncCommand({ cwd, args, raw, deps, subcommand }) {
  const { sync: syncFn, log, writeFile, mkdirp, exec } = deps;
  const repo = resolveRepo(args, exec);
  const board = parseBoardFlag(args);

  const receipt = await syncFn({ cwd, repo, exec, board });

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
 * @param {object} options
 * @param {string[]} options.args    — argv AFTER the family name
 * @param {string}   options.cwd    — project root
 * @param {boolean}  options.raw    — emit JSON instead of human prose
 * @param {Function} options.error  — (msg: string) => void; called for user errors
 * @param {object}   [options.deps] — injectable collaborators (for testing)
 * @returns {Promise<object>}
 */
async function routeProjectsSyncCommand({ args = [], cwd, raw = false, error, deps = {} }) {
  // --- Build effective deps (defaults + injected overrides) -----------------
  const effectiveDeps = {
    sync: engineSync,
    loadPhases,
    createGitHubClient,
    writeFile: (filePath, content) => fs.writeFileSync(filePath, content, 'utf8'),
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
    log: (msg) => console.log(msg),
    exec: realExec,
    ...deps,
  };

  const subcommand = args[0];

  // --- Route ----------------------------------------------------------------
  switch (subcommand) {
    case 'sync':
      return runSyncCommand({ cwd, args, raw, deps: effectiveDeps, subcommand: 'sync' });

    case 'init':
      return runSyncCommand({ cwd, args, raw, deps: effectiveDeps, subcommand: 'init' });

    case 'status':
      return runStatus({ cwd, args, raw, deps: effectiveDeps });

    default: {
      const msg = `projects-sync: unknown subcommand "${subcommand ?? ''}". `
        + `Available subcommands: ${VALID_SUBCOMMANDS.join(', ')}.`;
      error(msg);
      return { ok: false, error: msg };
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { routeProjectsSyncCommand };

'use strict';

/**
 * sync-engine.cjs
 *
 * Orchestration layer: maps roadmap-source phase data to GitHub issues.
 * Pure orchestration — no direct I/O beyond the injected github client seam.
 *
 * Exports:
 *   renderIssueBody(phase, milestoneTitle, marker) → string
 *   runSync({ phasesData, github, milestoneTitle }) → receipt
 *   sync({ cwd, repo, gsdExec, ghExec, board }) → receipt
 */

const { phaseMarker, statusForPhase } = require('./markers.cjs');
const { loadPhases } = require('./roadmap-source.cjs');
const { createGitHubClient } = require('./github-client.cjs');
// Import exec factories so direct callers of sync() also get cwd-bound children.
const { makeDefaultGhExec, makeDefaultGsdExec } = require('./exec-factories.cjs');

// ---------------------------------------------------------------------------
// renderIssueBody
// ---------------------------------------------------------------------------

/**
 * Renders the Markdown body for a GitHub issue representing a GSD phase.
 * The marker comment is placed on its own line and acts as the idempotency key.
 *
 * @param {{ number: string|number, name: string, goal: string }} phase
 * @param {string} milestoneTitle
 * @param {string} marker  — exact string from phaseMarker(phase.number)
 * @returns {string}
 */
function renderIssueBody(phase, milestoneTitle, marker) {
  return [
    `## Phase ${phase.number}: ${phase.name}`,
    '',
    `**Milestone:** ${milestoneTitle}`,
    '',
    `**Goal:** ${phase.goal}`,
    '',
    '---',
    '',
    marker,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// runSync
// ---------------------------------------------------------------------------

/**
 * Core orchestration: for each phase in phasesData, create or update its
 * corresponding GitHub issue.  Fail-open — errors per phase are collected in
 * receipt.errors and processing continues.
 *
 * @param {object} options
 * @param {{ milestones: Array, phases: Array }} options.phasesData
 * @param {object} options.github  — createGitHubClient() instance (or fake)
 * @param {string} options.milestoneTitle
 * @returns {{
 *   created: Array,
 *   updated: Array,
 *   closed: Array,
 *   skipped: Array,
 *   errors: Array,
 *   milestone: string|null
 * }}
 */
function runSync({ phasesData, github, milestoneTitle }) {
  const receipt = {
    created: [],
    updated: [],
    closed: [],
    skipped: [],
    errors: [],
    milestone: null,
  };

  // --- Ensure milestone (once, before phase loop) --------------------------
  if (phasesData.milestones && phasesData.milestones.length > 0) {
    receipt.milestone = milestoneTitle;
    try {
      github.ensureMilestone(milestoneTitle);
    } catch (err) {
      // Milestone failure is non-fatal — phases still get processed.
      // Log it as a non-phase error using a sentinel phase value.
      receipt.errors.push({ phase: null, kind: 'ensureMilestone', error: String(err.message ?? err) });
    }
  }

  // --- Phase loop -----------------------------------------------------------
  for (const phase of phasesData.phases) {
    try {
      const marker = phaseMarker(phase.number);
      const { state, label } = statusForPhase(phase);
      const body = renderIssueBody(phase, milestoneTitle, marker);
      const title = `Phase ${phase.number}: ${phase.name}`;

      const existing = github.findIssueByMarker(phase.number);

      if (existing === null || existing === undefined) {
        // Create path — F3: pass milestoneTitle so gh assigns the issue to the milestone
        // v1 limitation: all phases in this sync run belong to the same current milestone;
        // multi-milestone grouping (phases scoped to different milestones) is deferred.
        const created = github.createIssue({ title, body, labels: [label], milestone: milestoneTitle });
        receipt.created.push({ phase: phase.number, number: created.number });
      } else {
        // Update path — always sync body+label; F3: keep milestone in sync
        github.updateIssue(existing.number, { body, labels: [label], milestone: milestoneTitle });
        receipt.updated.push({ phase: phase.number, number: existing.number });

        // State transition only if needed (idempotent)
        if (existing.state !== state) {
          github.setIssueState(existing.number, state);
          if (state === 'closed') {
            receipt.closed.push({ phase: phase.number, number: existing.number });
          }
        }
      }
    } catch (err) {
      receipt.errors.push({ phase: phase.number, error: String(err.message ?? err) });
    }
  }

  return receipt;
}

// ---------------------------------------------------------------------------
// sync (thin wiring)
// ---------------------------------------------------------------------------

/**
 * Derives milestone title from phasesData.milestones[0].heading,
 * stripping markdown bold markers (**) and leading/trailing emoji/whitespace.
 *
 * @param {string|null} heading
 * @param {string|null} version
 * @returns {string}
 */
function deriveMilestoneTitle(heading, version) {
  if (heading) {
    // Strip markdown bold (**text** → text)
    const stripped = heading
      .replace(/\*\*/g, '')
      .trim();
    if (stripped) return stripped;
  }
  if (version) return version;
  return 'Milestone';
}

/**
 * Wires loadPhases → runSync with real collaborators.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} options.repo  — "owner/name"
 * @param {Function} [options.gsdExec]  — exec seam for gsd-tools CLI (loadPhases)
 * @param {Function} [options.ghExec]   — exec seam for gh CLI (createGitHubClient)
 * @param {boolean} [options.board]  — deferred: Projects v2 wiring not implemented
 * @returns {object}  receipt
 */
function sync({ cwd, repo, gsdExec, ghExec, board }) {
  // Build cwd-bound defaults when callers omit the exec seams, so that `gh`
  // and `gsd-tools` child processes always run in the GSD project directory.
  const resolvedGsdExec = gsdExec ?? makeDefaultGsdExec(cwd);
  const resolvedGhExec = ghExec ?? makeDefaultGhExec(cwd);

  const phasesData = loadPhases({ cwd, exec: resolvedGsdExec });

  const milestoneTitle = phasesData.milestones.length > 0
    ? deriveMilestoneTitle(
        phasesData.milestones[0].heading,
        phasesData.milestones[0].version
      )
    : 'Milestone';

  const github = createGitHubClient({ repo, exec: resolvedGhExec });

  const receipt = runSync({ phasesData, github, milestoneTitle });

  if (board) {
    receipt.boardDeferred = true;
    receipt.boardNote = 'Projects v2 board wiring is deferred; pass board:false to suppress this note.';
  }

  return receipt;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { renderIssueBody, runSync, sync, deriveMilestoneTitle };

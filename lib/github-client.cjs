'use strict';

/**
 * github-client.cjs
 *
 * A thin, fully-mockable seam over the `gh` CLI.
 * All network access flows through the injectable `exec` parameter —
 * nothing in this module ever calls the network directly.
 *
 * Factory: createGitHubClient({ repo, exec })
 *   repo — "owner/name" string
 *   exec — (argvArray: string[]) => stdoutString
 *          defaults to execFileSync('gh', ...)
 *
 * // board: addToProjectV2 — deferred to board module
 */

const { execFileSync } = require('node:child_process');
const { phaseMarker, LABELS, LABEL_COLORS } = require('./markers.cjs');

// All GSD status label values — used to compute the remove-set in updateIssue.
const ALL_STATUS_LABELS = Object.values(LABELS);

// ---------------------------------------------------------------------------
// Real exec default
// ---------------------------------------------------------------------------

function realExec(argv) {
  return execFileSync('gh', argv, { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a GitHub client scoped to a single repository.
 *
 * @param {object}   options
 * @param {string}   options.repo  "owner/name"
 * @param {Function} [options.exec]  (argvArray: string[]) => stdoutString
 * @returns {{
 *   findIssueByMarker: (phaseNumber: number) => {number:number,state:string,title:string}|null,
 *   createIssue: ({title:string,body:string,labels:string[],milestone?:string}) => {number:number},
 *   updateIssue: (number:number, {body?:string,labels?:string[],milestone?:string}) => void,
 *   setIssueState: (number:number, state:'open'|'closed') => void,
 *   ensureMilestone: (title:string) => number,
 * }}
 */
function createGitHubClient({ repo, exec = realExec }) {
  // -------------------------------------------------------------------------
  // findIssueByMarker
  // -------------------------------------------------------------------------

  /**
   * Searches for an existing issue whose body contains the idempotency marker.
   * Uses `gh search issues` so it works even on private repos with gh auth.
   *
   * F5 FIX: also requests `body` in --json output and performs an exact local
   * filter so full-text false-positives are excluded.  If multiple exact matches
   * exist, the one with the lowest issue number is returned (deterministic).
   *
   * @param {number|string} phaseNumber
   * @returns {{number:number, state:string, title:string}|null}
   */
  function findIssueByMarker(phaseNumber) {
    const marker = phaseMarker(phaseNumber);
    const argv = [
      'search', 'issues',
      '--repo', repo,
      '--match', 'body',
      marker,
      '--json', 'number,state,title,body',
    ];
    const stdout = exec(argv);
    // F6 guard: search results must be an array
    let issues;
    try {
      issues = JSON.parse(stdout);
    } catch {
      return null;
    }
    if (!Array.isArray(issues) || issues.length === 0) {
      return null;
    }
    // F5: exact-match filter — only issues whose body contains the exact marker string
    const exactMatches = issues
      .filter((i) => typeof i.body === 'string' && i.body.includes(marker))
      .sort((a, b) => a.number - b.number); // deterministic: lowest number first
    if (exactMatches.length === 0) return null;
    const first = exactMatches[0];
    return {
      number: first.number,
      state: first.state,
      title: first.title,
    };
  }

  // -------------------------------------------------------------------------
  // createIssue
  // -------------------------------------------------------------------------

  /**
   * Creates a new issue and returns its number.
   * `gh issue create` prints the issue URL to stdout.
   *
   * F3: accepts optional `milestone` title — gh issue create supports --milestone <title|number>.
   * F6: throws a clear error if the returned URL is unparseable.
   *
   * @param {{ title: string, body: string, labels: string[], milestone?: string }} opts
   * @returns {{ number: number }}
   */
  function createIssue({ title, body, labels, milestone }) {
    const argv = [
      'issue', 'create',
      '--repo', repo,
      '--title', title,
      '--body', body,
    ];
    if (labels && labels.length > 0) {
      for (const label of labels) {
        argv.push('--label', label);
      }
    }
    // F3: assign issue to the milestone when provided
    if (milestone) {
      argv.push('--milestone', milestone);
    }
    const stdout = exec(argv).trim();
    // stdout is a URL like https://github.com/owner/repo/issues/NNN
    const match = stdout.match(/\/issues\/(\d+)$/);
    if (!match) {
      throw new Error(`github-client.createIssue: could not parse issue number from: ${stdout}`);
    }
    return { number: parseInt(match[1], 10) };
  }

  // -------------------------------------------------------------------------
  // updateIssue
  // -------------------------------------------------------------------------

  /**
   * Updates an existing issue's body, labels, and/or milestone.
   *
   * F2 FIX: `gh issue edit` does NOT support --label.  Use --add-label for the
   * desired status label and --remove-label for every other GSD status label so
   * contradictory labels are cleared in the same call.
   *
   * F3: accepts optional `milestone` title — gh issue edit supports --milestone.
   *
   * F6: number must be defined (callers must guard before invoking).
   *
   * @param {number} number
   * @param {{ body?: string, labels?: string[], milestone?: string }} opts
   */
  function updateIssue(number, { body, labels, milestone }) {
    if (number === undefined || number === null) {
      throw new Error('github-client.updateIssue: issue number must not be undefined or null');
    }
    const argv = [
      'issue', 'edit',
      String(number),
      '--repo', repo,
    ];
    if (body !== undefined) {
      argv.push('--body', body);
    }
    // F2: use --add-label for each desired label; --remove-label all other GSD status labels
    if (labels && labels.length > 0) {
      for (const label of labels) {
        argv.push('--add-label', label);
        // Remove all other GSD status labels to avoid contradictory co-existing labels
        for (const other of ALL_STATUS_LABELS) {
          if (other !== label) {
            argv.push('--remove-label', other);
          }
        }
      }
    }
    // F3: assign issue to the milestone when provided
    if (milestone) {
      argv.push('--milestone', milestone);
    }
    exec(argv);
  }

  // -------------------------------------------------------------------------
  // setIssueState
  // -------------------------------------------------------------------------

  /**
   * Closes or reopens an issue.
   *
   * F6: number must be defined.
   *
   * @param {number} number
   * @param {'open'|'closed'} state
   */
  function setIssueState(number, state) {
    if (number === undefined || number === null) {
      throw new Error('github-client.setIssueState: issue number must not be undefined or null');
    }
    if (state !== 'open' && state !== 'closed') {
      throw new Error(`github-client.setIssueState: unknown state "${state}"; expected "open" or "closed"`);
    }
    const subcommand = state === 'closed' ? 'close' : 'reopen';
    const argv = [
      'issue', subcommand,
      String(number),
      '--repo', repo,
    ];
    exec(argv);
  }

  // -------------------------------------------------------------------------
  // ensureMilestone
  // -------------------------------------------------------------------------

  /**
   * Idempotent: ensures every label in `labels` exists in the repo, creating any
   * that are missing. `gh issue create --label <x>` fails hard when <x> does not
   * already exist, so this must run before the create path on a fresh repo.
   *
   * Lists existing labels once (`gh label list --json name`), then creates only
   * the missing ones (`gh label create <name> --color <hex>`). Colors come from
   * LABEL_COLORS, falling back to a neutral gray for unknown values.
   *
   * @param {string[]} labels
   * @returns {void}
   */
  function ensureLabels(labels) {
    if (!Array.isArray(labels) || labels.length === 0) return;

    const listArgv = ['label', 'list', '--repo', repo, '--json', 'name', '--limit', '200'];
    let existing;
    try {
      existing = JSON.parse(exec(listArgv));
    } catch {
      existing = [];
    }
    if (!Array.isArray(existing)) existing = [];
    const have = new Set(existing.map((l) => l && l.name).filter(Boolean));

    for (const name of labels) {
      if (have.has(name)) continue;
      const color = LABEL_COLORS[name] || 'ededed';
      exec(['label', 'create', name, '--repo', repo, '--color', color, '--force']);
      have.add(name); // guard against duplicate names in the input list
    }
  }

  /**
   * Idempotent: returns the milestone number for `title`, creating it if
   * it does not already exist.
   *
   * Uses `gh api repos/<repo>/milestones` (list, then create if needed).
   *
   * F1 FIX: use --raw-field (not --field) for the title so that a title
   * starting with `@` is NOT interpreted as a file path by gh.
   *
   * F6: milestone list must be an array; created milestone must have a numeric
   * `number` field.
   *
   * @param {string} title
   * @returns {number}
   */
  function ensureMilestone(title) {
    // List existing milestones
    const listArgv = ['api', `repos/${repo}/milestones`];
    const listStdout = exec(listArgv);
    // F6: milestone list must be an array
    let milestones;
    try {
      milestones = JSON.parse(listStdout);
    } catch {
      milestones = [];
    }
    if (!Array.isArray(milestones)) {
      milestones = [];
    }

    const existing = milestones.find((m) => m.title === title);
    if (existing) {
      return Number(existing.number);
    }

    // Create — F1: use --raw-field so @ titles are not file-expanded
    const createArgv = [
      'api', `repos/${repo}/milestones`,
      '--method', 'POST',
      '--raw-field', `title=${title}`,
    ];
    const createStdout = exec(createArgv);
    // F6: created milestone must have a numeric number
    let created;
    try {
      created = JSON.parse(createStdout);
    } catch {
      throw new Error(`github-client.ensureMilestone: could not parse create response: ${createStdout}`);
    }
    const milestoneNumber = Number(created.number);
    if (!Number.isFinite(milestoneNumber) || milestoneNumber <= 0) {
      throw new Error(`github-client.ensureMilestone: created milestone has invalid number: ${JSON.stringify(created)}`);
    }
    return milestoneNumber;
  }

  // -------------------------------------------------------------------------
  // Return the client
  // -------------------------------------------------------------------------

  return {
    findIssueByMarker,
    createIssue,
    updateIssue,
    setIssueState,
    ensureLabels,
    ensureMilestone,
    // board: addToProjectV2 — deferred to board module
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { createGitHubClient };

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
const { phaseMarker } = require('./markers.cjs');

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
 *   createIssue: ({title:string,body:string,labels:string[]}) => {number:number},
 *   updateIssue: (number:number, {body:string,labels:string[]}) => void,
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
      '--json', 'number,state,title',
    ];
    const stdout = exec(argv);
    const issues = JSON.parse(stdout);
    if (!Array.isArray(issues) || issues.length === 0) {
      return null;
    }
    const first = issues[0];
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
   * @param {{ title: string, body: string, labels: string[] }} opts
   * @returns {{ number: number }}
   */
  function createIssue({ title, body, labels }) {
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
   * Updates an existing issue's body and/or labels.
   *
   * @param {number} number
   * @param {{ body: string, labels: string[] }} opts
   */
  function updateIssue(number, { body, labels }) {
    const argv = [
      'issue', 'edit',
      String(number),
      '--repo', repo,
    ];
    if (body !== undefined) {
      argv.push('--body', body);
    }
    if (labels && labels.length > 0) {
      for (const label of labels) {
        argv.push('--label', label);
      }
    }
    exec(argv);
  }

  // -------------------------------------------------------------------------
  // setIssueState
  // -------------------------------------------------------------------------

  /**
   * Closes or reopens an issue.
   *
   * @param {number} number
   * @param {'open'|'closed'} state
   */
  function setIssueState(number, state) {
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
   * Idempotent: returns the milestone number for `title`, creating it if
   * it does not already exist.
   *
   * Uses `gh api repos/<repo>/milestones` (list, then create if needed).
   *
   * @param {string} title
   * @returns {number}
   */
  function ensureMilestone(title) {
    // List existing milestones
    const listArgv = ['api', `repos/${repo}/milestones`];
    const listStdout = exec(listArgv);
    const milestones = JSON.parse(listStdout);

    const existing = milestones.find((m) => m.title === title);
    if (existing) {
      return Number(existing.number);
    }

    // Create
    const createArgv = [
      'api', `repos/${repo}/milestones`,
      '--method', 'POST',
      '--field', `title=${title}`,
    ];
    const createStdout = exec(createArgv);
    const created = JSON.parse(createStdout);
    return Number(created.number);
  }

  // -------------------------------------------------------------------------
  // Return the client
  // -------------------------------------------------------------------------

  return {
    findIssueByMarker,
    createIssue,
    updateIssue,
    setIssueState,
    ensureMilestone,
    // board: addToProjectV2 — deferred to board module
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { createGitHubClient };

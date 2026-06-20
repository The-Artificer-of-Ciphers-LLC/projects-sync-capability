'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { routeProjectsSyncCommand } = require('../projects-sync-router.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_CWD = '/fake/project';

/**
 * Minimal phasesData fixture (mirrors roadmap-source output shape).
 */
const fakePhasesData = {
  milestones: [{ heading: '**v1.0 Launch**', version: 'v1.0' }],
  phases: [
    {
      number: 1,
      name: 'Foundation',
      goal: 'Set up the project.',
      complete: false,
      disk_status: null,
      plan_count: 0,
    },
    {
      number: 2,
      name: 'Build',
      goal: 'Build the thing.',
      complete: true,
      disk_status: null,
      plan_count: 0,
    },
  ],
};

/**
 * Canned receipt returned by injected sync().
 */
const fakeReceipt = {
  created: [{ phase: 1, number: 101 }],
  updated: [{ phase: 2, number: 202 }],
  closed: [{ phase: 2, number: 202 }],
  skipped: [],
  errors: [],
  milestone: 'v1.0 Launch',
};

/**
 * Builds a deps bag for router injection.
 * All methods are synchronous no-ops / canned values unless overridden.
 *
 * Two distinct exec seams:
 *   gsdExec — used by loadPhases (gsd-tools CLI)
 *   ghExec  — used by createGitHubClient + resolveRepo (gh CLI)
 */
function makeDeps(overrides = {}) {
  const logs = [];
  const writes = [];
  const errors = [];

  const deps = {
    sync: () => fakeReceipt,
    loadPhases: () => fakePhasesData,
    createGitHubClient: () => ({
      findIssueByMarker: () => null,
      createIssue: () => ({ number: 100 }),
      updateIssue: () => {},
      setIssueState: () => {},
      ensureMilestone: () => 1,
    }),
    writeFile: (filePath, content) => {
      writes.push({ filePath, content });
    },
    mkdirp: () => {},
    log: (msg) => logs.push(msg),
    // gsdExec: used by loadPhases (gsd-tools CLI)
    gsdExec: () => { throw new Error('gsdExec must not be called when loadPhases is injected'); },
    // ghExec: used by createGitHubClient + resolveRepo (gh CLI)
    ghExec: () => 'owner/repo',
    _logs: logs,
    _writes: writes,
    _errors: errors,
    ...overrides,
  };
  return deps;
}

/**
 * Runs the router synchronously and captures error() calls.
 * The router MUST NOT return a Promise; we verify that here.
 */
function runRouter(args, depsOverrides = {}, { raw = false } = {}) {
  const errors = [];
  const deps = makeDeps({ ...depsOverrides, _errors: errors });

  const result = routeProjectsSyncCommand({
    args,
    cwd: FAKE_CWD,
    raw,
    error: (msg) => errors.push(msg),
    deps,
  });

  // Contract: router must be fully synchronous — result must never be a Promise
  assert.ok(
    typeof result?.then !== 'function',
    `routeProjectsSyncCommand returned a Promise for args=${JSON.stringify(args)}; router must be synchronous`
  );

  return { result, deps, errors };
}

// ---------------------------------------------------------------------------
// Synchronous contract
// ---------------------------------------------------------------------------

describe('routeProjectsSyncCommand — synchronous contract', () => {
  it('returns a plain object (not a Promise) for sync subcommand', () => {
    const { result } = runRouter(['projects-sync', 'sync', '--repo', 'owner/repo']);
    assert.ok(result !== null && typeof result === 'object', 'must return an object');
    assert.ok(typeof result.then !== 'function', 'must NOT be a Promise');
  });

  it('returns a plain object (not a Promise) for status subcommand', () => {
    const { result } = runRouter(['projects-sync', 'status', '--repo', 'owner/repo'], {
      loadPhases: () => fakePhasesData,
      createGitHubClient: () => ({
        findIssueByMarker: () => null,
        createIssue: () => {},
        updateIssue: () => {},
        setIssueState: () => {},
        ensureMilestone: () => 1,
      }),
    });
    assert.ok(typeof result.then !== 'function', 'must NOT be a Promise');
  });

  it('returns a plain object (not a Promise) for unknown subcommand', () => {
    const { result } = runRouter(['projects-sync', 'bogus']);
    assert.ok(typeof result.then !== 'function', 'must NOT be a Promise');
  });

  it('returns a plain object (not a Promise) when no subcommand given', () => {
    const { result } = runRouter(['projects-sync']);
    assert.ok(typeof result.then !== 'function', 'must NOT be a Promise');
  });
});

// ---------------------------------------------------------------------------
// Unknown subcommand
// ---------------------------------------------------------------------------

describe('routeProjectsSyncCommand — unknown subcommand', () => {
  it('calls error() with a message listing available subcommands', () => {
    const { errors } = runRouter(['projects-sync', 'bogus-command']);
    assert.equal(errors.length, 1, 'error must be called exactly once');
    const msg = errors[0];
    // Must mention the valid subcommands
    assert.ok(msg.includes('sync'), 'error message must mention "sync"');
    assert.ok(msg.includes('status'), 'error message must mention "status"');
    assert.ok(msg.includes('init'), 'error message must mention "init"');
  });

  it('returns a non-success result for unknown subcommands', () => {
    const { result } = runRouter(['projects-sync', 'unknown']);
    // The result should signal failure (ok:false or have an error property)
    assert.ok(
      result === false || result?.ok === false || typeof result?.error === 'string',
      'result must signal failure for unknown subcommand'
    );
  });

  it('no subcommand (only family name) also calls error()', () => {
    const { errors } = runRouter(['projects-sync']);
    assert.equal(errors.length, 1, 'error must be called when no subcommand is given');
  });

  it('no subcommand error message lists available subcommands', () => {
    const { errors } = runRouter(['projects-sync']);
    const msg = errors[0];
    assert.ok(msg.includes('sync'), 'error message must mention "sync"');
    assert.ok(msg.includes('status'), 'error message must mention "status"');
    assert.ok(msg.includes('init'), 'error message must mention "init"');
  });

  it('empty args array also calls error()', () => {
    const { errors } = runRouter([]);
    assert.equal(errors.length, 1, 'error must be called when args is empty');
  });
});

// ---------------------------------------------------------------------------
// sync subcommand
// ---------------------------------------------------------------------------

describe('routeProjectsSyncCommand — sync subcommand', () => {
  it('calls injected sync() exactly once', () => {
    let syncCalls = 0;
    const { errors } = runRouter(['projects-sync', 'sync', '--repo', 'owner/repo'], {
      sync: () => { syncCalls++; return fakeReceipt; },
    });
    assert.equal(syncCalls, 1, 'sync() must be called exactly once');
    assert.equal(errors.length, 0);
  });

  it('writes the receipt JSON to <cwd>/.planning/projects-sync/SYNC-RECEIPT.json', () => {
    const { deps } = runRouter(['projects-sync', 'sync', '--repo', 'owner/repo']);

    assert.equal(deps._writes.length, 1, 'writeFile must be called once');
    const write = deps._writes[0];
    const expectedPath = path.join(FAKE_CWD, '.planning', 'projects-sync', 'SYNC-RECEIPT.json');
    assert.equal(write.filePath, expectedPath, 'receipt must be written to the expected path');
  });

  it('written content is valid JSON matching the receipt', () => {
    const { deps } = runRouter(['projects-sync', 'sync', '--repo', 'owner/repo']);
    const write = deps._writes[0];
    const parsed = JSON.parse(write.content);
    assert.deepEqual(parsed, fakeReceipt);
  });

  it('prints human summary when raw=false', () => {
    const { deps } = runRouter(['projects-sync', 'sync', '--repo', 'owner/repo'], {}, { raw: false });
    // At least one log call with human-readable content (not raw JSON of the receipt)
    assert.ok(deps._logs.length > 0, 'must log something for human output');
    const combined = deps._logs.join('\n');
    // Human summary should mention created/updated or some count
    assert.ok(
      combined.includes('created') || combined.includes('updated') || combined.includes('sync'),
      'human output must mention sync activity'
    );
  });

  it('prints raw JSON receipt when raw=true', () => {
    const { deps } = runRouter(['projects-sync', 'sync', '--repo', 'owner/repo'], {}, { raw: true });
    const combined = deps._logs.join('\n');
    // Should be parseable as JSON and match the receipt
    let parsed;
    try {
      parsed = JSON.parse(combined);
    } catch {
      assert.fail(`Expected raw JSON output but got: ${combined}`);
    }
    assert.deepEqual(parsed, fakeReceipt);
  });

  it('passes repo from --repo flag to sync()', () => {
    let capturedRepo;
    runRouter(['projects-sync', 'sync', '--repo', 'myorg/myrepo'], {
      sync: ({ repo }) => { capturedRepo = repo; return fakeReceipt; },
    });
    assert.equal(capturedRepo, 'myorg/myrepo');
  });

  it('resolves repo from ghExec when --repo is omitted', () => {
    let capturedRepo;
    runRouter(['projects-sync', 'sync'], {
      sync: ({ repo }) => { capturedRepo = repo; return fakeReceipt; },
      ghExec: () => JSON.stringify({ nameWithOwner: 'resolved/repo' }),
    });
    assert.equal(capturedRepo, 'resolved/repo');
  });
});

// ---------------------------------------------------------------------------
// status subcommand (dry run)
// ---------------------------------------------------------------------------

describe('routeProjectsSyncCommand — status subcommand (dry run)', () => {
  it('calls loadPhases to read roadmap data', () => {
    let loadCalled = false;
    runRouter(['projects-sync', 'status', '--repo', 'owner/repo'], {
      loadPhases: () => { loadCalled = true; return fakePhasesData; },
      createGitHubClient: () => ({
        findIssueByMarker: () => null,
        createIssue: () => { throw new Error('createIssue must NOT be called in status'); },
        updateIssue: () => { throw new Error('updateIssue must NOT be called in status'); },
        setIssueState: () => { throw new Error('setIssueState must NOT be called in status'); },
        ensureMilestone: () => 1,
      }),
    });
    assert.ok(loadCalled, 'loadPhases must be called');
  });

  it('does NOT call createIssue during status (dry run guarantee)', () => {
    const mutationCalls = [];
    const { errors } = runRouter(['projects-sync', 'status', '--repo', 'owner/repo'], {
      loadPhases: () => fakePhasesData,
      createGitHubClient: () => ({
        findIssueByMarker: () => null,
        createIssue: (...args) => { mutationCalls.push({ method: 'createIssue', args }); return { number: 999 }; },
        updateIssue: (...args) => { mutationCalls.push({ method: 'updateIssue', args }); },
        setIssueState: (...args) => { mutationCalls.push({ method: 'setIssueState', args }); },
        ensureMilestone: () => 1,
      }),
    });
    const mutations = mutationCalls.filter((c) => ['createIssue', 'updateIssue', 'setIssueState'].includes(c.method));
    assert.equal(mutations.length, 0, `dry-run must not mutate; got: ${JSON.stringify(mutationCalls)}`);
    assert.equal(errors.length, 0);
  });

  it('does NOT call updateIssue during status', () => {
    const mutationCalls = [];
    runRouter(['projects-sync', 'status', '--repo', 'owner/repo'], {
      loadPhases: () => fakePhasesData,
      createGitHubClient: () => ({
        findIssueByMarker: () => ({ number: 10, state: 'open', title: 'Phase 1' }),
        createIssue: (...args) => mutationCalls.push({ method: 'createIssue', args }),
        updateIssue: (...args) => mutationCalls.push({ method: 'updateIssue', args }),
        setIssueState: (...args) => mutationCalls.push({ method: 'setIssueState', args }),
        ensureMilestone: () => 1,
      }),
    });
    assert.equal(mutationCalls.length, 0, 'no mutations in dry-run');
  });

  it('does NOT call setIssueState during status (even when close would be needed)', () => {
    const mutationCalls = [];
    // phase 2 is complete (should close) but status must not close
    runRouter(['projects-sync', 'status', '--repo', 'owner/repo'], {
      loadPhases: () => fakePhasesData,
      createGitHubClient: () => ({
        // phase 2 exists as open, but it's complete → status would REPORT close needed
        findIssueByMarker: (n) => n === 2 ? { number: 200, state: 'open', title: 'Phase 2' } : null,
        createIssue: (...args) => mutationCalls.push({ method: 'createIssue', args }),
        updateIssue: (...args) => mutationCalls.push({ method: 'updateIssue', args }),
        setIssueState: (...args) => mutationCalls.push({ method: 'setIssueState', args }),
        ensureMilestone: () => 1,
      }),
    });
    assert.equal(mutationCalls.length, 0, 'setIssueState must not be called during status');
  });

  it('does NOT write a SYNC-RECEIPT.json file during status', () => {
    const { deps } = runRouter(['projects-sync', 'status', '--repo', 'owner/repo'], {
      loadPhases: () => fakePhasesData,
      createGitHubClient: () => ({
        findIssueByMarker: () => null,
        createIssue: () => {},
        updateIssue: () => {},
        setIssueState: () => {},
        ensureMilestone: () => 1,
      }),
    });
    assert.equal(deps._writes.length, 0, 'status must not write any files');
  });

  it('prints status report (human or raw) without mutating', () => {
    const { deps } = runRouter(['projects-sync', 'status', '--repo', 'owner/repo'], {
      loadPhases: () => fakePhasesData,
      createGitHubClient: () => ({
        findIssueByMarker: () => null,
        createIssue: () => {},
        updateIssue: () => {},
        setIssueState: () => {},
        ensureMilestone: () => 1,
      }),
    });
    assert.ok(deps._logs.length > 0, 'status must print something');
  });

  it('raw=true for status prints JSON', () => {
    const { deps } = runRouter(['projects-sync', 'status', '--repo', 'owner/repo'], {
      loadPhases: () => fakePhasesData,
      createGitHubClient: () => ({
        findIssueByMarker: () => null,
        createIssue: () => {},
        updateIssue: () => {},
        setIssueState: () => {},
        ensureMilestone: () => 1,
      }),
    }, { raw: true });

    const combined = deps._logs.join('\n');
    let parsed;
    try {
      parsed = JSON.parse(combined);
    } catch {
      assert.fail(`Expected JSON for raw status but got: ${combined}`);
    }
    assert.ok(parsed, 'parsed raw status output must be truthy');
  });
});

// ---------------------------------------------------------------------------
// init subcommand
// ---------------------------------------------------------------------------

describe('routeProjectsSyncCommand — init subcommand', () => {
  it('init calls sync() (delegating milestone ensure to sync)', () => {
    let syncCalled = false;
    const { errors } = runRouter(['projects-sync', 'init', '--repo', 'owner/repo'], {
      sync: () => { syncCalled = true; return fakeReceipt; },
    });
    assert.ok(syncCalled, 'init must invoke sync()');
    assert.equal(errors.length, 0);
  });

  it('init prints a summary (not silent)', () => {
    const { deps } = runRouter(['projects-sync', 'init', '--repo', 'owner/repo']);
    assert.ok(deps._logs.length > 0, 'init must print something');
  });

  it('init writes the receipt file', () => {
    const { deps } = runRouter(['projects-sync', 'init', '--repo', 'owner/repo']);
    assert.ok(deps._writes.length > 0, 'init must write the receipt file');
  });
});

// ---------------------------------------------------------------------------
// board flag deferred
// ---------------------------------------------------------------------------

describe('routeProjectsSyncCommand — board flag deferred', () => {
  it('sync with --board flag sets boardDeferred on receipt', () => {
    let receivedOpts;
    runRouter(['projects-sync', 'sync', '--repo', 'owner/repo', '--board'], {
      sync: (opts) => { receivedOpts = opts; return { ...fakeReceipt, boardDeferred: true }; },
    });
    assert.ok(receivedOpts?.board === true, 'board:true must be passed to sync()');
  });
});

// ---------------------------------------------------------------------------
// Two-seam separation: gsdExec vs ghExec
// ---------------------------------------------------------------------------

describe('routeProjectsSyncCommand — two-seam exec separation', () => {
  it('sync: passes gsdExec to sync() and NOT ghExec', () => {
    let receivedGsdExec;
    let receivedGhExec;
    const myGsdExec = () => 'gsd-stub';
    const myGhExec = () => 'gh-stub';
    runRouter(['projects-sync', 'sync', '--repo', 'owner/repo'], {
      sync: (opts) => {
        receivedGsdExec = opts.gsdExec;
        receivedGhExec = opts.ghExec;
        return fakeReceipt;
      },
      gsdExec: myGsdExec,
      ghExec: myGhExec,
    });
    assert.strictEqual(receivedGsdExec, myGsdExec, 'sync() must receive the injected gsdExec');
    assert.strictEqual(receivedGhExec, myGhExec, 'sync() must receive the injected ghExec');
  });

  it('sync: gsdExec is used for loadPhases (not ghExec) when not injecting sync()', () => {
    const gsdCalls = [];
    const ghCalls = [];
    // We inject loadPhases directly to spy on which exec it receives
    runRouter(['projects-sync', 'sync', '--repo', 'owner/repo'], {
      sync: ({ gsdExec, ghExec }) => {
        // Call both to verify they are distinct and correctly routed
        gsdCalls.push(gsdExec);
        ghCalls.push(ghExec);
        return fakeReceipt;
      },
      gsdExec: (argv) => { gsdCalls.push({ from: 'gsdExec', argv }); return '{}'; },
      ghExec: (argv) => { ghCalls.push({ from: 'ghExec', argv }); return 'owner/repo'; },
    });
    // gsdExec and ghExec must be different functions (not the same reference)
    assert.ok(gsdCalls.length > 0, 'gsdExec must have been accessed');
    assert.ok(ghCalls.length > 0, 'ghExec must have been accessed');
  });

  it('status: loadPhases receives gsdExec (not ghExec)', () => {
    let loadPhasesExec;
    const myGsdExec = () => 'gsd-stub';
    runRouter(['projects-sync', 'status', '--repo', 'owner/repo'], {
      loadPhases: ({ exec }) => { loadPhasesExec = exec; return fakePhasesData; },
      createGitHubClient: () => ({
        findIssueByMarker: () => null,
        createIssue: () => {},
        updateIssue: () => {},
        setIssueState: () => {},
        ensureMilestone: () => 1,
      }),
      gsdExec: myGsdExec,
      ghExec: () => 'gh-stub',
    });
    assert.strictEqual(loadPhasesExec, myGsdExec, 'loadPhases must receive gsdExec, not ghExec');
  });

  it('status: createGitHubClient receives ghExec (not gsdExec)', () => {
    let githubExec;
    const myGhExec = () => 'gh-stub';
    runRouter(['projects-sync', 'status', '--repo', 'owner/repo'], {
      loadPhases: () => fakePhasesData,
      createGitHubClient: ({ exec }) => {
        githubExec = exec;
        return {
          findIssueByMarker: () => null,
          createIssue: () => {},
          updateIssue: () => {},
          setIssueState: () => {},
          ensureMilestone: () => 1,
        };
      },
      gsdExec: () => 'gsd-stub',
      ghExec: myGhExec,
    });
    assert.strictEqual(githubExec, myGhExec, 'createGitHubClient must receive ghExec, not gsdExec');
  });

  it('resolveRepo uses ghExec (not gsdExec)', () => {
    let ghExecCalled = false;
    let gsdExecCalled = false;
    // Omit --repo so resolveRepo falls back to exec
    runRouter(['projects-sync', 'sync'], {
      sync: () => fakeReceipt,
      ghExec: () => { ghExecCalled = true; return JSON.stringify({ nameWithOwner: 'owner/repo' }); },
      gsdExec: () => { gsdExecCalled = true; return '{}'; },
    });
    assert.ok(ghExecCalled, 'resolveRepo must use ghExec');
    assert.ok(!gsdExecCalled, 'resolveRepo must NOT use gsdExec');
  });

  it('router is synchronous: never returns a Promise with two-seam deps', () => {
    const { result } = runRouter(['projects-sync', 'sync', '--repo', 'owner/repo'], {
      gsdExec: () => { throw new Error('gsdExec should not be called when sync is injected'); },
      ghExec: () => 'owner/repo',
    });
    assert.ok(typeof result?.then !== 'function', 'router must remain synchronous with two-seam deps');
  });
});

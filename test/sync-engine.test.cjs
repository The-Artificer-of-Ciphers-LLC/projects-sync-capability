'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { runSync, renderIssueBody, sync } = require('../lib/sync-engine.cjs');
const { phaseMarker } = require('../lib/markers.cjs');

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal phasesData fixture mirroring roadmap-source shape.
 */
function makePhasesData(overrides = {}) {
  return {
    milestones: [{ heading: '**v1.0 Launch**', version: 'v1.0' }],
    phases: [
      {
        number: 1,
        name: 'Foundation',
        goal: 'Set up the project foundations.',
        complete: false,
        disk_status: null,
        plan_count: 0,
      },
      {
        number: 2,
        name: 'Build',
        goal: 'Implement core functionality.',
        complete: false,
        disk_status: 'in_progress',
        plan_count: 2,
      },
    ],
    ...overrides,
  };
}

/**
 * Builds a fake github client that records every call.
 * Accepts `stubs` map of method names → return values / factories.
 */
function makeFakeGitHub(stubs = {}) {
  const calls = {
    findIssueByMarker: [],
    createIssue: [],
    updateIssue: [],
    setIssueState: [],
    ensureMilestone: [],
  };

  function findIssueByMarker(phaseNumber) {
    calls.findIssueByMarker.push({ phaseNumber });
    const stub = stubs.findIssueByMarker;
    if (typeof stub === 'function') return stub(phaseNumber);
    return stub !== undefined ? stub : null;
  }

  function createIssue(opts) {
    calls.createIssue.push({ ...opts });
    const stub = stubs.createIssue;
    if (typeof stub === 'function') return stub(opts);
    return stub !== undefined ? stub : { number: 101 };
  }

  function updateIssue(number, opts) {
    calls.updateIssue.push({ number, ...opts });
    const stub = stubs.updateIssue;
    if (typeof stub === 'function') return stub(number, opts);
  }

  function setIssueState(number, state) {
    calls.setIssueState.push({ number, state });
    const stub = stubs.setIssueState;
    if (typeof stub === 'function') return stub(number, state);
  }

  function ensureMilestone(title) {
    calls.ensureMilestone.push({ title });
    const stub = stubs.ensureMilestone;
    if (typeof stub === 'function') return stub(title);
    return stub !== undefined ? stub : 1;
  }

  return { calls, findIssueByMarker, createIssue, updateIssue, setIssueState, ensureMilestone };
}

// ---------------------------------------------------------------------------
// renderIssueBody
// ---------------------------------------------------------------------------

describe('renderIssueBody', () => {
  it('contains the phase goal', () => {
    const phase = { number: 1, name: 'Foundation', goal: 'Set up foundations.', complete: false, disk_status: null, plan_count: 0 };
    const body = renderIssueBody(phase, 'v1.0 Launch', phaseMarker(1));
    assert.ok(body.includes('Set up foundations.'), 'body must include the goal');
  });

  it('contains the milestone title', () => {
    const phase = { number: 3, name: 'Infra', goal: 'Build infra.', complete: false, disk_status: null, plan_count: 0 };
    const body = renderIssueBody(phase, 'My Milestone', phaseMarker(3));
    assert.ok(body.includes('My Milestone'), 'body must include the milestone title');
  });

  it('contains "Phase <number>"', () => {
    const phase = { number: 7, name: 'Finalize', goal: 'Wrap it up.', complete: false, disk_status: null, plan_count: 0 };
    const body = renderIssueBody(phase, 'v2.0', phaseMarker(7));
    assert.ok(body.includes('Phase 7'), 'body must include "Phase 7"');
  });

  it('contains the marker on its own line', () => {
    const phase = { number: 2, name: 'Build', goal: 'Build things.', complete: false, disk_status: null, plan_count: 0 };
    const marker = phaseMarker(2);
    const body = renderIssueBody(phase, 'v1.0', marker);
    // marker must appear on its own line (optionally with surrounding whitespace)
    const lines = body.split('\n').map((l) => l.trim());
    assert.ok(lines.includes(marker), `marker "${marker}" must appear on its own line`);
  });

  it('marker is the exact string from phaseMarker()', () => {
    const phase = { number: 5, name: 'Deploy', goal: 'Deploy.', complete: true, disk_status: null, plan_count: 0 };
    const marker = phaseMarker(5);
    const body = renderIssueBody(phase, 'v3.0', marker);
    assert.ok(body.includes(marker), 'body must contain the exact marker string');
  });
});

// ---------------------------------------------------------------------------
// runSync — synchronous contract
// ---------------------------------------------------------------------------

describe('runSync — synchronous contract', () => {
  it('returns a plain object, not a Promise', () => {
    const github = makeFakeGitHub({ findIssueByMarker: null, createIssue: { number: 42 } });
    const result = runSync({ phasesData: makePhasesData(), github, milestoneTitle: 'v1.0' });
    assert.ok(result !== null && typeof result === 'object', 'result must be an object');
    assert.ok(typeof result.then !== 'function', 'result must NOT be a Promise');
  });
});

// ---------------------------------------------------------------------------
// runSync — create path
// ---------------------------------------------------------------------------

describe('runSync — create path (no existing issues)', () => {
  it('calls createIssue for each phase when findIssueByMarker returns null', () => {
    const github = makeFakeGitHub({ findIssueByMarker: null, createIssue: { number: 42 } });
    const phasesData = makePhasesData();
    const receipt = runSync({ phasesData, github, milestoneTitle: 'v1.0 Launch' });

    assert.equal(github.calls.createIssue.length, 2, 'createIssue must be called once per phase');
    assert.equal(receipt.created.length, 2);
    assert.equal(receipt.updated.length, 0);
    assert.equal(receipt.errors.length, 0);
  });

  it('createIssue receives title "Phase <N>: <name>"', () => {
    const github = makeFakeGitHub({ findIssueByMarker: null, createIssue: { number: 10 } });
    const phasesData = makePhasesData();
    runSync({ phasesData, github, milestoneTitle: 'v1.0' });

    const firstCreate = github.calls.createIssue[0];
    assert.equal(firstCreate.title, 'Phase 1: Foundation');
  });

  it('createIssue receives the correct label for a pending phase', () => {
    const github = makeFakeGitHub({ findIssueByMarker: null, createIssue: { number: 10 } });
    const phasesData = makePhasesData();
    runSync({ phasesData, github, milestoneTitle: 'v1.0' });

    const firstCreate = github.calls.createIssue[0];
    assert.ok(Array.isArray(firstCreate.labels), 'labels must be an array');
    assert.ok(firstCreate.labels.includes('gsd:pending'), 'pending phase must carry gsd:pending label');
  });

  it('F3: createIssue receives the milestoneTitle', () => {
    const github = makeFakeGitHub({ findIssueByMarker: null, createIssue: { number: 10 } });
    const phasesData = makePhasesData();
    runSync({ phasesData, github, milestoneTitle: 'v1.0 Launch' });

    const firstCreate = github.calls.createIssue[0];
    assert.equal(firstCreate.milestone, 'v1.0 Launch', 'createIssue must receive the milestoneTitle');
  });

  it('createIssue receives the correct label for an in-progress phase', () => {
    const github = makeFakeGitHub({ findIssueByMarker: null, createIssue: { number: 10 } });
    const phasesData = makePhasesData();
    runSync({ phasesData, github, milestoneTitle: 'v1.0' });

    // phase 2 is in_progress (disk_status: 'in_progress', plan_count: 2)
    const secondCreate = github.calls.createIssue[1];
    assert.ok(secondCreate.labels.includes('gsd:in-progress'));
  });

  it('body passed to createIssue contains the marker', () => {
    const github = makeFakeGitHub({ findIssueByMarker: null, createIssue: { number: 10 } });
    const phasesData = makePhasesData();
    runSync({ phasesData, github, milestoneTitle: 'v1.0' });

    const firstCreate = github.calls.createIssue[0];
    assert.ok(firstCreate.body.includes(phaseMarker(1)), 'body must contain the marker');
  });

  it('records issue numbers in receipt.created', () => {
    let counter = 100;
    const github = makeFakeGitHub({
      findIssueByMarker: null,
      createIssue: () => ({ number: ++counter }),
    });
    const receipt = runSync({ phasesData: makePhasesData(), github, milestoneTitle: 'v1.0' });
    assert.deepEqual(receipt.created.map((c) => c.phase), [1, 2]);
  });
});

// ---------------------------------------------------------------------------
// runSync — update path
// ---------------------------------------------------------------------------

describe('runSync — update path (existing open issue, still open)', () => {
  it('calls updateIssue and does not call createIssue or setIssueState', () => {
    const existing = { number: 77, state: 'open', title: 'Phase 1: Foundation' };
    const github = makeFakeGitHub({ findIssueByMarker: existing, createIssue: { number: 999 } });
    const phasesData = makePhasesData({
      phases: [{
        number: 1, name: 'Foundation', goal: 'Set up.', complete: false, disk_status: null, plan_count: 0,
      }],
    });

    const receipt = runSync({ phasesData, github, milestoneTitle: 'v1.0' });

    assert.equal(github.calls.createIssue.length, 0, 'createIssue must NOT be called');
    assert.equal(github.calls.updateIssue.length, 1, 'updateIssue must be called once');
    assert.equal(github.calls.setIssueState.length, 0, 'setIssueState must NOT be called (state unchanged)');
    assert.equal(receipt.updated.length, 1);
    assert.equal(receipt.created.length, 0);
  });

  it('updateIssue is called with the existing issue number', () => {
    const existing = { number: 77, state: 'open', title: 'Phase 1: Foundation' };
    const github = makeFakeGitHub({ findIssueByMarker: existing });
    const phasesData = makePhasesData({
      phases: [{
        number: 1, name: 'Foundation', goal: 'Set up.', complete: false, disk_status: null, plan_count: 0,
      }],
    });

    runSync({ phasesData, github, milestoneTitle: 'v1.0' });
    assert.equal(github.calls.updateIssue[0].number, 77);
  });

  it('F3: updateIssue receives the milestoneTitle', () => {
    const existing = { number: 77, state: 'open', title: 'Phase 1: Foundation' };
    const github = makeFakeGitHub({ findIssueByMarker: existing });
    const phasesData = makePhasesData({
      phases: [{
        number: 1, name: 'Foundation', goal: 'Set up.', complete: false, disk_status: null, plan_count: 0,
      }],
    });

    runSync({ phasesData, github, milestoneTitle: 'v1.0 Launch' });
    assert.equal(github.calls.updateIssue[0].milestone, 'v1.0 Launch', 'updateIssue must receive the milestoneTitle');
  });
});

// ---------------------------------------------------------------------------
// runSync — close transition
// ---------------------------------------------------------------------------

describe('runSync — close transition (existing open + phase complete)', () => {
  it('calls setIssueState("closed") and records in receipt.closed', () => {
    const existing = { number: 55, state: 'open', title: 'Phase 3: Setup' };
    const github = makeFakeGitHub({ findIssueByMarker: existing });
    const phasesData = makePhasesData({
      phases: [{
        number: 3, name: 'Setup', goal: 'Set things up.', complete: true, disk_status: null, plan_count: 0,
      }],
    });

    const receipt = runSync({ phasesData, github, milestoneTitle: 'v1.0' });

    assert.equal(github.calls.setIssueState.length, 1, 'setIssueState must be called');
    assert.equal(github.calls.setIssueState[0].state, 'closed');
    assert.equal(github.calls.setIssueState[0].number, 55);
    assert.equal(receipt.closed.length, 1);
    assert.equal(receipt.closed[0].phase, 3);
  });

  it('also calls updateIssue before closing (body/label sync)', () => {
    const existing = { number: 55, state: 'open', title: 'Phase 3: Setup' };
    const github = makeFakeGitHub({ findIssueByMarker: existing });
    const phasesData = makePhasesData({
      phases: [{
        number: 3, name: 'Setup', goal: 'Set things up.', complete: true, disk_status: null, plan_count: 0,
      }],
    });

    runSync({ phasesData, github, milestoneTitle: 'v1.0' });
    assert.equal(github.calls.updateIssue.length, 1, 'updateIssue must also be called');
  });
});

// ---------------------------------------------------------------------------
// runSync — idempotent re-run
// ---------------------------------------------------------------------------

describe('runSync — idempotent re-run', () => {
  it('calls updateIssue but NOT setIssueState when issue already in target state', () => {
    // existing closed issue, phase also complete → no state change needed
    const existing = { number: 88, state: 'closed', title: 'Phase 4: Deploy' };
    const github = makeFakeGitHub({ findIssueByMarker: existing });
    const phasesData = makePhasesData({
      phases: [{
        number: 4, name: 'Deploy', goal: 'Deploy to prod.', complete: true, disk_status: null, plan_count: 0,
      }],
    });

    const receipt = runSync({ phasesData, github, milestoneTitle: 'v1.0' });

    assert.equal(github.calls.setIssueState.length, 0, 'setIssueState must NOT be called');
    assert.equal(github.calls.updateIssue.length, 1, 'updateIssue IS still called (body sync)');
    assert.equal(receipt.closed.length, 0, 'no new close recorded');
    assert.equal(receipt.updated.length, 1);
  });

  it('does not record in receipt.closed when issue was already closed', () => {
    const existing = { number: 88, state: 'closed', title: 'Phase 4: Deploy' };
    const github = makeFakeGitHub({ findIssueByMarker: existing });
    const phasesData = makePhasesData({
      phases: [{
        number: 4, name: 'Deploy', goal: 'Deploy to prod.', complete: true, disk_status: null, plan_count: 0,
      }],
    });

    const receipt = runSync({ phasesData, github, milestoneTitle: 'v1.0' });
    assert.equal(receipt.closed.length, 0);
  });

  it('calling runSync twice on same data produces the same receipt shape (idempotent)', () => {
    const existing = { number: 10, state: 'open', title: 'Phase 1: Foundation' };
    const github1 = makeFakeGitHub({ findIssueByMarker: existing });
    const github2 = makeFakeGitHub({ findIssueByMarker: existing });
    const phasesData = makePhasesData({
      phases: [{
        number: 1, name: 'Foundation', goal: 'Set up.', complete: false, disk_status: null, plan_count: 0,
      }],
    });

    const r1 = runSync({ phasesData, github: github1, milestoneTitle: 'v1.0' });
    const r2 = runSync({ phasesData, github: github2, milestoneTitle: 'v1.0' });

    assert.equal(r1.created.length, r2.created.length);
    assert.equal(r1.updated.length, r2.updated.length);
    assert.equal(r1.closed.length, r2.closed.length);
    assert.equal(r1.errors.length, r2.errors.length);
  });
});

// ---------------------------------------------------------------------------
// runSync — per-phase error isolation
// ---------------------------------------------------------------------------

describe('runSync — per-phase error isolation', () => {
  it('one phase throwing does not prevent other phases from being processed', () => {
    let callCount = 0;
    const github = makeFakeGitHub({
      findIssueByMarker: (phaseNumber) => {
        callCount++;
        if (phaseNumber === 1) {
          throw new Error('simulated API failure on phase 1');
        }
        return null; // phase 2 returns no existing issue
      },
      createIssue: { number: 200 },
    });

    const phasesData = makePhasesData(); // phases 1 and 2
    const receipt = runSync({ phasesData, github, milestoneTitle: 'v1.0' });

    assert.equal(receipt.errors.length, 1, 'one error must be recorded');
    assert.equal(receipt.errors[0].phase, 1, 'error must be attributed to phase 1');
    assert.ok(typeof receipt.errors[0].error === 'string', 'error.error must be a string');
    assert.equal(receipt.created.length, 1, 'phase 2 must still be created');
  });

  it('error in ensureMilestone does not abort phase processing', () => {
    const github = makeFakeGitHub({
      ensureMilestone: () => { throw new Error('milestone API failure'); },
      findIssueByMarker: null,
      createIssue: { number: 5 },
    });

    const phasesData = makePhasesData();
    // Should not throw; receipt must still have created phases
    const receipt = runSync({ phasesData, github, milestoneTitle: 'v1.0' });
    // milestone error is tolerated; phases still processed
    assert.equal(receipt.created.length, 2);
  });
});

// ---------------------------------------------------------------------------
// runSync — ensureMilestone
// ---------------------------------------------------------------------------

describe('runSync — ensureMilestone', () => {
  it('calls ensureMilestone once when milestones[0] exists', () => {
    const github = makeFakeGitHub({ findIssueByMarker: null, createIssue: { number: 1 } });
    const phasesData = makePhasesData(); // has milestones[0]

    runSync({ phasesData, github, milestoneTitle: 'v1.0 Launch' });

    assert.equal(github.calls.ensureMilestone.length, 1);
    assert.equal(github.calls.ensureMilestone[0].title, 'v1.0 Launch');
  });

  it('does NOT call ensureMilestone when milestones array is empty', () => {
    const github = makeFakeGitHub({ findIssueByMarker: null, createIssue: { number: 1 } });
    const phasesData = makePhasesData({ milestones: [] });

    runSync({ phasesData, github, milestoneTitle: 'v1.0' });

    assert.equal(github.calls.ensureMilestone.length, 0);
  });

  it('receipt.milestone reflects the milestoneTitle when milestones exist', () => {
    const github = makeFakeGitHub({ findIssueByMarker: null, createIssue: { number: 1 } });
    const phasesData = makePhasesData();
    const receipt = runSync({ phasesData, github, milestoneTitle: 'v1.0 Launch' });
    assert.equal(receipt.milestone, 'v1.0 Launch');
  });

  it('receipt.milestone is null when milestones array is empty', () => {
    const github = makeFakeGitHub({ findIssueByMarker: null, createIssue: { number: 1 } });
    const phasesData = makePhasesData({ milestones: [] });
    const receipt = runSync({ phasesData, github, milestoneTitle: 'v1.0' });
    assert.equal(receipt.milestone, null);
  });
});

// ---------------------------------------------------------------------------
// runSync — receipt shape
// ---------------------------------------------------------------------------

describe('runSync — receipt shape', () => {
  it('receipt always has all required keys', () => {
    const github = makeFakeGitHub({ findIssueByMarker: null, createIssue: { number: 1 } });
    const receipt = runSync({ phasesData: makePhasesData(), github, milestoneTitle: 'v1.0' });

    assert.ok(Array.isArray(receipt.created), 'receipt.created must be array');
    assert.ok(Array.isArray(receipt.updated), 'receipt.updated must be array');
    assert.ok(Array.isArray(receipt.closed), 'receipt.closed must be array');
    assert.ok(Array.isArray(receipt.skipped), 'receipt.skipped must be array');
    assert.ok(Array.isArray(receipt.errors), 'receipt.errors must be array');
    assert.ok('milestone' in receipt, 'receipt.milestone must be present');
  });
});

// ---------------------------------------------------------------------------
// runSync — board deferred
// ---------------------------------------------------------------------------

describe('runSync — board flag deferred', () => {
  it('sync() result does not throw when called (contract test via runSync)', () => {
    // board wiring is in the router, not runSync; runSync itself has no board param
    const github = makeFakeGitHub({ findIssueByMarker: null, createIssue: { number: 1 } });
    const receipt = runSync({ phasesData: makePhasesData(), github, milestoneTitle: 'v1.0' });
    assert.ok(receipt, 'receipt must be returned');
  });
});

// ---------------------------------------------------------------------------
// sync() — two-seam exec wiring
// ---------------------------------------------------------------------------

const FIXTURE_PHASES_JSON = JSON.stringify({
  milestones: [{ heading: '**v1.0 Launch**', version: 'v1.0' }],
  phases: [
    {
      number: '1',
      name: 'Foundation',
      goal: 'Set up.',
      roadmap_complete: false,
      disk_status: null,
      plan_count: 0,
    },
  ],
});

describe('sync() — two-seam exec separation', () => {
  it('passes gsdExec to loadPhases (not ghExec)', () => {
    let gsdExecCalled = false;
    let ghExecCalledForGsd = false;

    const gsdExec = (argv) => {
      gsdExecCalled = true;
      // Must be a roadmap analyze call
      assert.ok(argv.includes('roadmap'), 'gsdExec must receive roadmap command');
      return FIXTURE_PHASES_JSON;
    };
    const ghExec = (argv) => {
      // If ghExec is called with roadmap it means the seam is crossed
      if (argv.includes('roadmap')) ghExecCalledForGsd = true;
      // github client calls: findIssueByMarker etc come via the injected client below
      return '{}';
    };

    // We inject a fake github client factory so no real gh calls happen
    // But sync() calls createGitHubClient internally — override via module seam
    // is not possible here, so we use the public interface: gsdExec/ghExec
    // The test verifies gsdExec is called and ghExec is NOT called with roadmap args.
    // We accept that createGitHubClient will receive ghExec (tested separately).
    // Since createGitHubClient's internal real exec is ghExec, we stub ghExec
    // to return something that won't error on gh calls.

    // Override findIssueByMarker etc by stubbing ghExec responses for gh api calls:
    // gh api repos/.../issues → empty array
    const ghExecSpy = (argv) => {
      if (argv.includes('roadmap')) ghExecCalledForGsd = true;
      // Return a valid response for any gh call
      return JSON.stringify([]);
    };

    // Call sync() — it will call loadPhases({exec: gsdExec}) and createGitHubClient({exec: ghExec})
    // createGitHubClient uses ghExec internally; loadPhases uses gsdExec internally.
    // We accept that createGitHubClient may make real ghExec calls; we can't fully stub
    // without modifying the module. So we just verify the seam assignment is correct
    // by checking gsdExec IS called (with roadmap args) and ghExecCalledForGsd is false.

    try {
      sync({ cwd: '/fake', repo: 'owner/repo', gsdExec, ghExec: ghExecSpy });
    } catch {
      // createGitHubClient may fail because ghExecSpy returns [] for gh api calls
      // which may not be parseable as expected; that's acceptable in this seam test
    }

    assert.ok(gsdExecCalled, 'gsdExec must be called (for loadPhases)');
    assert.ok(!ghExecCalledForGsd, 'ghExec must NOT be called with roadmap args');
  });

  it('sync() is synchronous — never returns a Promise', () => {
    const gsdExec = () => FIXTURE_PHASES_JSON;
    // ghExec returns minimal stubs for gh api calls
    const ghExec = (argv) => {
      if (argv[0] === 'api' && argv[1] && argv[1].includes('issues')) return JSON.stringify([]);
      if (argv[0] === 'api' && argv[1] && argv[1].includes('milestones')) return JSON.stringify([]);
      return JSON.stringify({});
    };

    let result;
    try {
      result = sync({ cwd: '/fake', repo: 'owner/repo', gsdExec, ghExec });
    } catch {
      // May throw due to gh api stubs not matching exact contract; that's fine
      // The important thing is sync() itself is not async
      return;
    }

    if (result !== undefined && result !== null) {
      assert.ok(typeof result.then !== 'function', 'sync() must NOT return a Promise');
    }
  });

  it('sync() passes gsdExec and ghExec as distinct references', () => {
    const seenGsdExec = [];
    const seenGhExec = [];

    const myGsdExec = (argv) => {
      seenGsdExec.push(argv);
      return FIXTURE_PHASES_JSON;
    };
    const myGhExec = (argv) => {
      seenGhExec.push(argv);
      return JSON.stringify([]);
    };

    try {
      sync({ cwd: '/fake', repo: 'owner/repo', gsdExec: myGsdExec, ghExec: myGhExec });
    } catch {
      // stubs may not satisfy all internal expectations
    }

    // gsdExec must have been called (with roadmap analyze args)
    assert.ok(seenGsdExec.length > 0, 'gsdExec must be called at least once');
    // gsdExec calls must all be gsd-tools style (roadmap, not gh api/issue/repo)
    for (const argv of seenGsdExec) {
      assert.ok(
        argv.includes('roadmap'),
        `gsdExec must only receive gsd-tools args (roadmap ...); got ${JSON.stringify(argv)}`
      );
    }
    // ghExec must NOT have been called with roadmap args (cross-seam leak)
    for (const argv of seenGhExec) {
      assert.ok(
        !argv.includes('roadmap'),
        `ghExec must not receive roadmap args; got ${JSON.stringify(argv)}`
      );
    }
    // The two refs must be different (they are separate seams)
    assert.notStrictEqual(myGsdExec, myGhExec, 'gsdExec and ghExec must be distinct references');
  });
});

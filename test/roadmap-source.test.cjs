'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { loadPhases } = require('../lib/roadmap-source.cjs');

// ---------------------------------------------------------------------------
// Canonical fixture — verbatim from the spec
// ---------------------------------------------------------------------------

const FIXTURE_JSON = JSON.stringify({
  milestones: [{ heading: '🚧 **v1.0 First Release**', version: 'v1.0' }],
  phases: [
    {
      number: '1',
      name: 'Foundation',
      goal: 'Establish the base.',
      mode: null,
      depends_on: null,
      plan_count: 0,
      summary_count: 0,
      has_context: false,
      has_research: false,
      disk_status: 'complete',
      roadmap_complete: true,
    },
    {
      number: '2',
      name: 'Sync Engine',
      goal: 'Build the engine.',
      mode: null,
      depends_on: null,
      plan_count: 0,
      summary_count: 0,
      has_context: false,
      has_research: false,
      disk_status: 'no_directory',
      roadmap_complete: false,
    },
  ],
  phase_count: 2,
  completed_phases: 1,
});

// ---------------------------------------------------------------------------
// Happy-path: fixture → normalized output
// ---------------------------------------------------------------------------

describe('loadPhases — happy path', () => {
  it('returns a milestones array with one entry', async () => {
    const exec = () => FIXTURE_JSON;
    const result = await loadPhases({ cwd: '/fake/dir', exec });
    assert.ok(Array.isArray(result.milestones));
    assert.equal(result.milestones.length, 1);
  });

  it('milestone has heading and version from fixture', async () => {
    const exec = () => FIXTURE_JSON;
    const { milestones } = await loadPhases({ cwd: '/fake/dir', exec });
    assert.equal(milestones[0].heading, '🚧 **v1.0 First Release**');
    assert.equal(milestones[0].version, 'v1.0');
  });

  it('returns a phases array with two entries', async () => {
    const exec = () => FIXTURE_JSON;
    const { phases } = await loadPhases({ cwd: '/fake/dir', exec });
    assert.ok(Array.isArray(phases));
    assert.equal(phases.length, 2);
  });

  it('phase 1: complete===true (from roadmap_complete)', async () => {
    const exec = () => FIXTURE_JSON;
    const { phases } = await loadPhases({ cwd: '/fake/dir', exec });
    assert.equal(phases[0].complete, true);
  });

  it('phase 1: name, goal, number pass through', async () => {
    const exec = () => FIXTURE_JSON;
    const { phases } = await loadPhases({ cwd: '/fake/dir', exec });
    assert.equal(phases[0].number, '1');
    assert.equal(phases[0].name, 'Foundation');
    assert.equal(phases[0].goal, 'Establish the base.');
  });

  it('phase 1: disk_status passes through', async () => {
    const exec = () => FIXTURE_JSON;
    const { phases } = await loadPhases({ cwd: '/fake/dir', exec });
    assert.equal(phases[0].disk_status, 'complete');
  });

  it('phase 2: complete===false', async () => {
    const exec = () => FIXTURE_JSON;
    const { phases } = await loadPhases({ cwd: '/fake/dir', exec });
    assert.equal(phases[1].complete, false);
  });

  it('phase 2: disk_status is no_directory', async () => {
    const exec = () => FIXTURE_JSON;
    const { phases } = await loadPhases({ cwd: '/fake/dir', exec });
    assert.equal(phases[1].disk_status, 'no_directory');
  });

  it('plan_count of 0 passes through (not absent)', async () => {
    const exec = () => FIXTURE_JSON;
    const { phases } = await loadPhases({ cwd: '/fake/dir', exec });
    assert.equal(phases[0].plan_count, 0);
  });

  it('normalized phase objects have exactly the expected keys', async () => {
    const exec = () => FIXTURE_JSON;
    const { phases } = await loadPhases({ cwd: '/fake/dir', exec });
    const keys = Object.keys(phases[0]).sort();
    assert.deepEqual(keys, ['complete', 'disk_status', 'goal', 'name', 'number', 'plan_count']);
  });
});

// ---------------------------------------------------------------------------
// exec call shape: argv must contain required tokens
// ---------------------------------------------------------------------------

describe('loadPhases — exec argv shape', () => {
  it('passes "roadmap" in the argv array', async () => {
    let capturedArgv;
    const exec = (argv) => { capturedArgv = argv; return FIXTURE_JSON; };
    await loadPhases({ cwd: '/my/project', exec });
    assert.ok(capturedArgv.includes('roadmap'), `argv missing "roadmap": ${JSON.stringify(capturedArgv)}`);
  });

  it('passes "analyze" in the argv array', async () => {
    let capturedArgv;
    const exec = (argv) => { capturedArgv = argv; return FIXTURE_JSON; };
    await loadPhases({ cwd: '/my/project', exec });
    assert.ok(capturedArgv.includes('analyze'), `argv missing "analyze": ${JSON.stringify(capturedArgv)}`);
  });

  it('passes "--raw" in the argv array', async () => {
    let capturedArgv;
    const exec = (argv) => { capturedArgv = argv; return FIXTURE_JSON; };
    await loadPhases({ cwd: '/my/project', exec });
    assert.ok(capturedArgv.includes('--raw'), `argv missing "--raw": ${JSON.stringify(capturedArgv)}`);
  });

  it('passes the cwd value in the argv array', async () => {
    let capturedArgv;
    const exec = (argv) => { capturedArgv = argv; return FIXTURE_JSON; };
    await loadPhases({ cwd: '/my/special/dir', exec });
    assert.ok(
      capturedArgv.includes('/my/special/dir'),
      `argv missing cwd "/my/special/dir": ${JSON.stringify(capturedArgv)}`
    );
  });

  it('passes "--cwd" flag before the cwd value', async () => {
    let capturedArgv;
    const exec = (argv) => { capturedArgv = argv; return FIXTURE_JSON; };
    await loadPhases({ cwd: '/my/special/dir', exec });
    const cwdFlagIdx = capturedArgv.indexOf('--cwd');
    assert.ok(cwdFlagIdx !== -1, 'argv missing "--cwd" flag');
    assert.equal(capturedArgv[cwdFlagIdx + 1], '/my/special/dir');
  });
});

// ---------------------------------------------------------------------------
// Defensive validation: bad exec output
// ---------------------------------------------------------------------------

describe('loadPhases — defensive validation', () => {
  it('throws a clear error when exec returns non-JSON', async () => {
    const exec = () => 'not valid json at all !!!';
    assert.throws(
      () => loadPhases({ cwd: '/fake', exec }),
      (err) => {
        assert.ok(err instanceof Error);
        // Must include raw-output prefix so callers can diagnose
        assert.ok(
          err.message.includes('raw output:') || err.message.includes('raw-output:') || err.message.includes('stdout:'),
          `Error message should include a raw-output prefix for diagnostics; got: ${err.message}`
        );
        return true;
      }
    );
  });

  it('throws when exec returns JSON that is not an object', async () => {
    const exec = () => JSON.stringify([1, 2, 3]);
    assert.throws(() => loadPhases({ cwd: '/fake', exec }), Error);
  });

  it('throws when exec returns JSON without a phases key', async () => {
    const exec = () => JSON.stringify({ milestones: [], phase_count: 0 });
    assert.throws(
      () => loadPhases({ cwd: '/fake', exec }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.toLowerCase().includes('phases') || err.message.includes('Array'),
          `Error should mention phases; got: ${err.message}`
        );
        return true;
      }
    );
  });

  it('throws when exec returns JSON where phases is not an array', async () => {
    const exec = () => JSON.stringify({ phases: { not: 'an array' }, milestones: [] });
    assert.throws(() => loadPhases({ cwd: '/fake', exec }), Error);
  });
});

// ---------------------------------------------------------------------------
// Synchronous contract: loadPhases must NOT return a Promise. A capability
// router/engine is dispatched synchronously by gsd-tools (async routers are
// rejected), and sync-engine calls loadPhases without await — so an async
// loadPhases silently yields `phasesData.phases is not iterable`. This guard
// locks the sync contract that the integration dogfood caught.
// ---------------------------------------------------------------------------

describe('loadPhases — synchronous contract', () => {
  it('returns a plain object, never a thenable', () => {
    const exec = () => JSON.stringify({ milestones: [], phases: [] });
    const result = loadPhases({ cwd: '/fake', exec });
    assert.notStrictEqual(result, null);
    assert.strictEqual(typeof result, 'object');
    assert.strictEqual(typeof result.then, 'undefined');
    assert.ok(Array.isArray(result.phases));
  });
});

// ---------------------------------------------------------------------------
// Defensive defaults for missing optional fields
// ---------------------------------------------------------------------------

describe('loadPhases — optional field defaults', () => {
  it('defaults plan_count to 0 when missing from source', async () => {
    const stripped = JSON.stringify({
      milestones: [],
      phases: [{
        number: '3', name: 'X', goal: 'Y',
        disk_status: null, roadmap_complete: false,
        // no plan_count
      }],
    });
    const exec = () => stripped;
    const { phases } = await loadPhases({ cwd: '/fake', exec });
    assert.equal(phases[0].plan_count, 0);
  });

  it('defaults disk_status to null when missing from source', async () => {
    const stripped = JSON.stringify({
      milestones: [],
      phases: [{
        number: '3', name: 'X', goal: 'Y',
        plan_count: 2, roadmap_complete: false,
        // no disk_status
      }],
    });
    const exec = () => stripped;
    const { phases } = await loadPhases({ cwd: '/fake', exec });
    assert.equal(phases[0].disk_status, null);
  });

  it('returns empty milestones array when milestones missing', async () => {
    const noMilestones = JSON.stringify({ phases: [] });
    const exec = () => noMilestones;
    const { milestones } = await loadPhases({ cwd: '/fake', exec });
    assert.ok(Array.isArray(milestones));
    assert.equal(milestones.length, 0);
  });
});

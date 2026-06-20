'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createGitHubClient } = require('../lib/github-client.cjs');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock exec that records every call and returns a canned response.
 * If responses is an array, each call pops from the front (FIFO).
 * If responses is a string/object it is used for every call.
 */
function makeMockExec(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : null;
  const single = Array.isArray(responses) ? null : responses;

  const exec = (argv) => {
    calls.push([...argv]);
    const response = queue ? (queue.length > 0 ? queue.shift() : '') : single;
    return typeof response === 'string' ? response : JSON.stringify(response);
  };

  exec.calls = calls;
  return exec;
}

const REPO = 'acme/my-project';

// ---------------------------------------------------------------------------
// findIssueByMarker
// ---------------------------------------------------------------------------

describe('findIssueByMarker', () => {
  it('calls gh with the repo flag', () => {
    const mockExec = makeMockExec(JSON.stringify([]));
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.findIssueByMarker(1);
    const argv = mockExec.calls[0];
    assert.ok(argv.includes(REPO), `argv should include repo "${REPO}": ${JSON.stringify(argv)}`);
  });

  it('passes the phase marker string in the argv', () => {
    const mockExec = makeMockExec(JSON.stringify([]));
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.findIssueByMarker(3);
    const argv = mockExec.calls[0];
    assert.ok(
      argv.some((a) => a.includes('gsd-phase:3')),
      `argv should include marker text "gsd-phase:3": ${JSON.stringify(argv)}`
    );
  });

  it('passes --json flag with number,state,title,body fields (F5: body required for exact-match)', () => {
    const mockExec = makeMockExec(JSON.stringify([]));
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.findIssueByMarker(1);
    const argv = mockExec.calls[0];
    assert.ok(argv.includes('--json'), `argv should include "--json": ${JSON.stringify(argv)}`);
    const jsonVal = argv[argv.indexOf('--json') + 1];
    assert.ok(jsonVal.includes('body'), `--json value must include "body" field: ${jsonVal}`);
    assert.ok(jsonVal.includes('number'), `--json value must include "number" field: ${jsonVal}`);
    assert.ok(jsonVal.includes('state'), `--json value must include "state" field: ${jsonVal}`);
    assert.ok(jsonVal.includes('title'), `--json value must include "title" field: ${jsonVal}`);
  });

  it('returns null when the result list is empty', () => {
    const mockExec = makeMockExec(JSON.stringify([]));
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    const result = client.findIssueByMarker(1);
    assert.equal(result, null);
  });

  it('F5: returns null when result body does NOT contain the exact marker (false-positive filter)', () => {
    // body contains a different phase marker — should be filtered out
    const issues = [
      { number: 42, state: 'open', title: 'Phase 10: Other', body: '<!-- gsd-phase:10 --> some text' },
    ];
    const mockExec = makeMockExec(JSON.stringify(issues));
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    // searching for phase 1 — body only has phase:10 marker, no exact match
    const result = client.findIssueByMarker(1);
    assert.equal(result, null, 'must return null when body does not contain the exact marker');
  });

  it('F5: returns the exact-match issue when body contains the correct marker', () => {
    const marker = '<!-- gsd-phase:1 -->';
    const issues = [
      { number: 42, state: 'open', title: 'Phase 1: Foundation', body: `some text\n${marker}\nmore text` },
    ];
    const mockExec = makeMockExec(JSON.stringify(issues));
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    const result = client.findIssueByMarker(1);
    assert.ok(result !== null, 'must return an issue when body contains the exact marker');
    assert.equal(result.number, 42);
  });

  it('F5: multiple exact matches → returns lowest issue number (deterministic)', () => {
    const marker = '<!-- gsd-phase:2 -->';
    const issues = [
      { number: 55, state: 'open', title: 'Phase 2 (dup)', body: `${marker}` },
      { number: 33, state: 'open', title: 'Phase 2', body: `text ${marker} text` },
    ];
    const mockExec = makeMockExec(JSON.stringify(issues));
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    const result = client.findIssueByMarker(2);
    assert.equal(result.number, 33, 'must return the issue with the lowest number');
  });

  it('F5: a result whose body is missing the exact marker is ignored even if title matches', () => {
    const issues = [
      // body has gsd-phase:11 not gsd-phase:1; title mentions Phase 1 but body doesn't have the exact marker
      { number: 9, state: 'open', title: 'Phase 1: Foundation', body: '<!-- gsd-phase:11 --> some body' },
    ];
    const mockExec = makeMockExec(JSON.stringify(issues));
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    const result = client.findIssueByMarker(1);
    assert.equal(result, null, 'issue without exact marker in body must be ignored');
  });

  it('returns exactly {number,state,title} — no extra keys', () => {
    const marker = '<!-- gsd-phase:1 -->';
    const issues = [{ number: 7, state: 'closed', title: 'X', body: marker, extraField: 'should not leak' }];
    const mockExec = makeMockExec(JSON.stringify(issues));
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    const result = client.findIssueByMarker(1);
    const keys = Object.keys(result).sort();
    assert.deepEqual(keys, ['number', 'state', 'title']);
  });

  it('phase number 0 is also passed correctly', () => {
    const mockExec = makeMockExec(JSON.stringify([]));
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.findIssueByMarker(0);
    const argv = mockExec.calls[0];
    assert.ok(
      argv.some((a) => a.includes('gsd-phase:0')),
      `argv should include "gsd-phase:0": ${JSON.stringify(argv)}`
    );
  });

  it('F6: returns null (not throw) when exec returns non-JSON', () => {
    const mockExec = makeMockExec('not-json-at-all');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    const result = client.findIssueByMarker(1);
    assert.equal(result, null, 'non-JSON response must return null gracefully');
  });

  it('F6: returns null when exec returns a non-array JSON value', () => {
    const mockExec = makeMockExec(JSON.stringify({ error: 'something went wrong' }));
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    const result = client.findIssueByMarker(1);
    assert.equal(result, null, 'non-array response must be treated as empty results');
  });
});

// ---------------------------------------------------------------------------
// createIssue
// ---------------------------------------------------------------------------

describe('createIssue', () => {
  it('calls gh with the repo flag', () => {
    // gh issue create returns a URL like https://github.com/acme/my-project/issues/99
    const mockExec = makeMockExec('https://github.com/acme/my-project/issues/99\n');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.createIssue({ title: 'Phase 1', body: 'body text', labels: [] });
    const argv = mockExec.calls[0];
    assert.ok(argv.includes(REPO) || argv.some((a) => a === REPO), `expected repo in argv: ${JSON.stringify(argv)}`);
  });

  it('passes --title flag with the title value', () => {
    const mockExec = makeMockExec('https://github.com/acme/my-project/issues/5\n');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.createIssue({ title: 'My Issue Title', body: 'b', labels: [] });
    const argv = mockExec.calls[0];
    assert.ok(argv.includes('--title'), `argv missing --title: ${JSON.stringify(argv)}`);
    const titleIdx = argv.indexOf('--title');
    assert.equal(argv[titleIdx + 1], 'My Issue Title');
  });

  it('passes --body flag with the body value', () => {
    const mockExec = makeMockExec('https://github.com/acme/my-project/issues/5\n');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.createIssue({ title: 'T', body: 'the issue body', labels: [] });
    const argv = mockExec.calls[0];
    assert.ok(argv.includes('--body'), `argv missing --body: ${JSON.stringify(argv)}`);
    const bodyIdx = argv.indexOf('--body');
    assert.equal(argv[bodyIdx + 1], 'the issue body');
  });

  it('passes --label flags when labels are provided', () => {
    const mockExec = makeMockExec('https://github.com/acme/my-project/issues/5\n');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.createIssue({ title: 'T', body: 'b', labels: ['gsd:complete', 'gsd:pending'] });
    const argv = mockExec.calls[0];
    assert.ok(argv.includes('--label'), `argv missing --label: ${JSON.stringify(argv)}`);
  });

  it('returns {number} parsed from the URL', () => {
    const mockExec = makeMockExec('https://github.com/acme/my-project/issues/99\n');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    const result = client.createIssue({ title: 'T', body: 'b', labels: [] });
    assert.equal(result.number, 99);
  });

  it('parses issue number from URL without trailing newline', () => {
    const mockExec = makeMockExec('https://github.com/acme/my-project/issues/1234');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    const result = client.createIssue({ title: 'T', body: 'b', labels: [] });
    assert.equal(result.number, 1234);
  });

  it('does not pass --label when labels array is empty', () => {
    const mockExec = makeMockExec('https://github.com/acme/my-project/issues/5\n');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.createIssue({ title: 'T', body: 'b', labels: [] });
    const argv = mockExec.calls[0];
    assert.ok(!argv.includes('--label'), `argv should NOT include --label for empty labels: ${JSON.stringify(argv)}`);
  });

  it('F3: passes --milestone when milestone is provided', () => {
    const mockExec = makeMockExec('https://github.com/acme/my-project/issues/5\n');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.createIssue({ title: 'T', body: 'b', labels: [], milestone: 'v1.0 Launch' });
    const argv = mockExec.calls[0];
    assert.ok(argv.includes('--milestone'), `argv must include --milestone: ${JSON.stringify(argv)}`);
    const mIdx = argv.indexOf('--milestone');
    assert.equal(argv[mIdx + 1], 'v1.0 Launch');
  });

  it('F3: does not pass --milestone when milestone is not provided', () => {
    const mockExec = makeMockExec('https://github.com/acme/my-project/issues/5\n');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.createIssue({ title: 'T', body: 'b', labels: [] });
    const argv = mockExec.calls[0];
    assert.ok(!argv.includes('--milestone'), `argv must NOT include --milestone when not provided: ${JSON.stringify(argv)}`);
  });

  it('F6: throws a clear error when gh returns an unparseable URL', () => {
    const mockExec = makeMockExec('not-a-url-at-all');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    assert.throws(
      () => client.createIssue({ title: 'T', body: 'b', labels: [] }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('could not parse issue number'), `error message: ${err.message}`);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// updateIssue
// ---------------------------------------------------------------------------

describe('updateIssue', () => {
  it('calls gh issue edit with the issue number', () => {
    const mockExec = makeMockExec('');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.updateIssue(42, { body: 'new body', labels: ['gsd:complete'] });
    const argv = mockExec.calls[0];
    assert.ok(
      argv.includes('42') || argv.includes(42),
      `argv should include issue number 42: ${JSON.stringify(argv)}`
    );
  });

  it('passes --body when body is provided', () => {
    const mockExec = makeMockExec('');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.updateIssue(10, { body: 'updated body', labels: [] });
    const argv = mockExec.calls[0];
    assert.ok(argv.includes('--body'), `argv missing --body: ${JSON.stringify(argv)}`);
    const bodyIdx = argv.indexOf('--body');
    assert.equal(argv[bodyIdx + 1], 'updated body');
  });

  it('F2: uses --add-label (not --label) when labels are provided', () => {
    const mockExec = makeMockExec('');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.updateIssue(10, { body: 'b', labels: ['gsd:in-progress'] });
    const argv = mockExec.calls[0];
    assert.ok(argv.includes('--add-label'), `argv must use --add-label: ${JSON.stringify(argv)}`);
    assert.ok(!argv.includes('--label') || argv.includes('--add-label'),
      `argv must NOT use bare --label (only --add-label / --remove-label): ${JSON.stringify(argv)}`);
    // verify the label value follows --add-label
    const addIdx = argv.indexOf('--add-label');
    assert.equal(argv[addIdx + 1], 'gsd:in-progress');
  });

  it('F2: uses --remove-label for all other GSD status labels when adding one label', () => {
    const mockExec = makeMockExec('');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    // adding gsd:complete — all other GSD status labels must be removed
    client.updateIssue(10, { body: 'b', labels: ['gsd:complete'] });
    const argv = mockExec.calls[0];
    const removeLabels = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--remove-label') removeLabels.push(argv[i + 1]);
    }
    // Must remove the other 4 GSD status labels
    assert.ok(removeLabels.includes('gsd:in-progress'), `must remove gsd:in-progress: ${JSON.stringify(removeLabels)}`);
    assert.ok(removeLabels.includes('gsd:pending'), `must remove gsd:pending: ${JSON.stringify(removeLabels)}`);
    assert.ok(removeLabels.includes('gsd:blocked'), `must remove gsd:blocked: ${JSON.stringify(removeLabels)}`);
    assert.ok(removeLabels.includes('gsd:human-gate'), `must remove gsd:human-gate: ${JSON.stringify(removeLabels)}`);
    // Must NOT remove the label being added
    assert.ok(!removeLabels.includes('gsd:complete'), `must NOT remove gsd:complete: ${JSON.stringify(removeLabels)}`);
  });

  it('F2: does NOT include bare --label in updateIssue argv (gh issue edit rejects --label)', () => {
    const mockExec = makeMockExec('');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.updateIssue(10, { body: 'b', labels: ['gsd:pending'] });
    const argv = mockExec.calls[0];
    // Scan for bare '--label' that is not '--add-label' or '--remove-label'
    const hasBareLabelFlag = argv.some((a, i) => a === '--label');
    assert.ok(!hasBareLabelFlag, `argv must NOT contain bare --label flag: ${JSON.stringify(argv)}`);
  });

  it('passes the repo flag', () => {
    const mockExec = makeMockExec('');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.updateIssue(10, { body: 'b', labels: [] });
    const argv = mockExec.calls[0];
    assert.ok(argv.includes(REPO), `argv should include repo "${REPO}": ${JSON.stringify(argv)}`);
  });

  it('F3: passes --milestone when milestone is provided', () => {
    const mockExec = makeMockExec('');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.updateIssue(10, { body: 'b', labels: [], milestone: 'v1.0 Launch' });
    const argv = mockExec.calls[0];
    assert.ok(argv.includes('--milestone'), `argv must include --milestone: ${JSON.stringify(argv)}`);
    const mIdx = argv.indexOf('--milestone');
    assert.equal(argv[mIdx + 1], 'v1.0 Launch');
  });

  it('F3: does not pass --milestone when milestone is not provided', () => {
    const mockExec = makeMockExec('');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.updateIssue(10, { body: 'b', labels: [] });
    const argv = mockExec.calls[0];
    assert.ok(!argv.includes('--milestone'), `argv must NOT include --milestone when not provided: ${JSON.stringify(argv)}`);
  });

  it('F6: throws when number is undefined', () => {
    const mockExec = makeMockExec('');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    assert.throws(
      () => client.updateIssue(undefined, { body: 'b', labels: [] }),
      (err) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// setIssueState
// ---------------------------------------------------------------------------

describe('setIssueState', () => {
  it('calls gh issue close for state===closed', () => {
    const mockExec = makeMockExec('');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.setIssueState(7, 'closed');
    const argv = mockExec.calls[0];
    assert.ok(argv.includes('close'), `expected "close" in argv for closed state: ${JSON.stringify(argv)}`);
  });

  it('calls gh issue reopen for state===open', () => {
    const mockExec = makeMockExec('');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.setIssueState(7, 'open');
    const argv = mockExec.calls[0];
    assert.ok(argv.includes('reopen'), `expected "reopen" in argv for open state: ${JSON.stringify(argv)}`);
  });

  it('passes the issue number for close', () => {
    const mockExec = makeMockExec('');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.setIssueState(55, 'closed');
    const argv = mockExec.calls[0];
    assert.ok(argv.includes('55') || argv.includes(55), `argv missing issue number 55: ${JSON.stringify(argv)}`);
  });

  it('passes the issue number for reopen', () => {
    const mockExec = makeMockExec('');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.setIssueState(55, 'open');
    const argv = mockExec.calls[0];
    assert.ok(argv.includes('55') || argv.includes(55), `argv missing issue number 55: ${JSON.stringify(argv)}`);
  });

  it('passes the repo flag', () => {
    const mockExec = makeMockExec('');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.setIssueState(7, 'closed');
    const argv = mockExec.calls[0];
    assert.ok(argv.includes(REPO), `argv should include repo "${REPO}": ${JSON.stringify(argv)}`);
  });

  it('throws for unknown state string', () => {
    const mockExec = makeMockExec('');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    assert.throws(
      () => client.setIssueState(7, 'unknown'),
      (err) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );
  });

  it('F6: throws when number is undefined', () => {
    const mockExec = makeMockExec('');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    assert.throws(
      () => client.setIssueState(undefined, 'closed'),
      (err) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// ensureMilestone
// ---------------------------------------------------------------------------

describe('ensureMilestone', () => {
  it('calls gh api to list milestones', () => {
    const milestones = [{ title: 'v1.0', number: 1 }];
    const mockExec = makeMockExec(JSON.stringify(milestones));
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.ensureMilestone('v1.0');
    const argv = mockExec.calls[0];
    assert.ok(
      argv.includes('api') || argv.some((a) => a.includes('milestones')),
      `first call should list milestones via gh api: ${JSON.stringify(argv)}`
    );
  });

  it('returns the existing milestone number when title already exists', () => {
    const milestones = [{ title: 'v1.0', number: 3 }];
    const mockExec = makeMockExec(JSON.stringify(milestones));
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    const num = client.ensureMilestone('v1.0');
    assert.equal(num, 3);
  });

  it('does not create a new milestone when one already exists', () => {
    const milestones = [{ title: 'v1.0', number: 3 }];
    const mockExec = makeMockExec(JSON.stringify(milestones));
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.ensureMilestone('v1.0');
    // Should only make 1 call (list), no create call
    assert.equal(mockExec.calls.length, 1);
  });

  it('creates a milestone when title not found', () => {
    const listResponse = JSON.stringify([{ title: 'v0.9', number: 1 }]);
    const createResponse = JSON.stringify({ number: 4, title: 'v1.0' });
    const mockExec = makeMockExec([listResponse, createResponse]);
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    const num = client.ensureMilestone('v1.0');
    assert.equal(mockExec.calls.length, 2);
    assert.equal(num, 4);
  });

  it('F1: create call uses --raw-field (not --field) to prevent @ file expansion', () => {
    const listResponse = JSON.stringify([]);
    const createResponse = JSON.stringify({ number: 5, title: '@v2.0' });
    const mockExec = makeMockExec([listResponse, createResponse]);
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.ensureMilestone('@v2.0');
    const createArgv = mockExec.calls[1];
    assert.ok(
      createArgv.includes('--raw-field'),
      `create call must use --raw-field (not --field): ${JSON.stringify(createArgv)}`
    );
    assert.ok(
      !createArgv.includes('--field') || createArgv.includes('--raw-field'),
      `create call must NOT use bare --field: ${JSON.stringify(createArgv)}`
    );
    // The --raw-field value must include the title
    const rawFieldVal = createArgv[createArgv.indexOf('--raw-field') + 1];
    assert.ok(rawFieldVal.includes('@v2.0'), `--raw-field value must include title: ${rawFieldVal}`);
  });

  it('create call includes the milestone title', () => {
    const listResponse = JSON.stringify([]);
    const createResponse = JSON.stringify({ number: 5, title: 'v2.0' });
    const mockExec = makeMockExec([listResponse, createResponse]);
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.ensureMilestone('v2.0');
    const createArgv = mockExec.calls[1];
    assert.ok(
      createArgv.some((a) => a.includes('v2.0') || a.includes('title')),
      `create call should include the title "v2.0": ${JSON.stringify(createArgv)}`
    );
  });

  it('list call uses the correct repo path', () => {
    const mockExec = makeMockExec(JSON.stringify([{ title: 'v1.0', number: 1 }]));
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.ensureMilestone('v1.0');
    const listArgv = mockExec.calls[0];
    assert.ok(
      listArgv.some((a) => a.includes(REPO) || a.includes('acme') || a.includes('milestones')),
      `list call should reference the repo: ${JSON.stringify(listArgv)}`
    );
  });

  it('returns a number (not a string)', () => {
    const mockExec = makeMockExec(JSON.stringify([{ title: 'v1.0', number: 7 }]));
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    const num = client.ensureMilestone('v1.0');
    assert.equal(typeof num, 'number');
  });

  it('F6: treats non-array list response as empty (no throw, proceeds to create)', () => {
    const listResponse = JSON.stringify({ error: 'not an array' });
    const createResponse = JSON.stringify({ number: 9, title: 'v3.0' });
    const mockExec = makeMockExec([listResponse, createResponse]);
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    // should not throw, should proceed to create
    const num = client.ensureMilestone('v3.0');
    assert.equal(num, 9, 'should create milestone and return its number');
  });

  it('F6: throws a clear error when create response has no valid number', () => {
    const listResponse = JSON.stringify([]);
    const createResponse = JSON.stringify({ title: 'v4.0' }); // missing number
    const mockExec = makeMockExec([listResponse, createResponse]);
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    assert.throws(
      () => client.ensureMilestone('v4.0'),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('invalid number') || err.message.includes('ensureMilestone'),
          `error message: ${err.message}`);
        return true;
      }
    );
  });

  it('F6: throws a clear error when create response is not valid JSON', () => {
    const listResponse = JSON.stringify([]);
    const mockExec = makeMockExec([listResponse, 'bad json{{{']);
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    assert.throws(
      () => client.ensureMilestone('v5.0'),
      (err) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Factory interface
// ---------------------------------------------------------------------------

describe('createGitHubClient — factory', () => {
  it('returns an object with the expected method names', () => {
    const client = createGitHubClient({ repo: REPO, exec: () => '[]' });
    assert.ok(typeof client.findIssueByMarker === 'function');
    assert.ok(typeof client.createIssue === 'function');
    assert.ok(typeof client.updateIssue === 'function');
    assert.ok(typeof client.setIssueState === 'function');
    assert.ok(typeof client.ensureMilestone === 'function');
  });

  it('different clients with different repos use their own repo', () => {
    const exec1 = makeMockExec(JSON.stringify([]));
    const exec2 = makeMockExec(JSON.stringify([]));
    const client1 = createGitHubClient({ repo: 'org/repo-a', exec: exec1 });
    const client2 = createGitHubClient({ repo: 'org/repo-b', exec: exec2 });
    client1.findIssueByMarker(1);
    client2.findIssueByMarker(1);
    assert.ok(exec1.calls[0].includes('org/repo-a'));
    assert.ok(exec2.calls[0].includes('org/repo-b'));
  });
});

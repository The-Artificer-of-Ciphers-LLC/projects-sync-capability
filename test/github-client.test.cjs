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
    const marker = '<!-- gsd-phase:3 -->';
    assert.ok(
      argv.some((a) => a.includes('gsd-phase:3')),
      `argv should include marker text "gsd-phase:3": ${JSON.stringify(argv)}`
    );
  });

  it('passes --json flag with at least number,state,title fields', () => {
    const mockExec = makeMockExec(JSON.stringify([]));
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.findIssueByMarker(1);
    const argv = mockExec.calls[0];
    const jsonArg = argv.find((a) => a.startsWith('number') || a === 'number,state,title' || a.includes('number'));
    // The --json flag must appear
    assert.ok(argv.includes('--json'), `argv should include "--json": ${JSON.stringify(argv)}`);
  });

  it('returns null when the result list is empty', () => {
    const mockExec = makeMockExec(JSON.stringify([]));
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    const result = client.findIssueByMarker(1);
    assert.equal(result, null);
  });

  it('returns the first issue {number,state,title} when results exist', () => {
    const issues = [
      { number: 42, state: 'open', title: 'Phase 1: Foundation' },
      { number: 43, state: 'closed', title: 'Phase 1 (old)' },
    ];
    const mockExec = makeMockExec(JSON.stringify(issues));
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    const result = client.findIssueByMarker(1);
    assert.equal(result.number, 42);
    assert.equal(result.state, 'open');
    assert.equal(result.title, 'Phase 1: Foundation');
  });

  it('returns exactly {number,state,title} — no extra keys', () => {
    const issues = [{ number: 7, state: 'closed', title: 'X', extraField: 'should not leak' }];
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

  it('passes --label when labels are provided', () => {
    const mockExec = makeMockExec('');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.updateIssue(10, { body: 'b', labels: ['gsd:in-progress'] });
    const argv = mockExec.calls[0];
    assert.ok(argv.includes('--label') || argv.includes('--add-label'), `argv missing label flag: ${JSON.stringify(argv)}`);
  });

  it('passes the repo flag', () => {
    const mockExec = makeMockExec('');
    const client = createGitHubClient({ repo: REPO, exec: mockExec });
    client.updateIssue(10, { body: 'b', labels: [] });
    const argv = mockExec.calls[0];
    assert.ok(argv.includes(REPO), `argv should include repo "${REPO}": ${JSON.stringify(argv)}`);
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

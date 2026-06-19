'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  phaseMarker,
  MARKER_SEARCH_PREFIX,
  LABELS,
  statusForPhase,
} = require('../lib/markers.cjs');

// ---------------------------------------------------------------------------
// phaseMarker
// ---------------------------------------------------------------------------

describe('phaseMarker', () => {
  it('returns the exact HTML-comment string for a number', () => {
    assert.equal(phaseMarker(1), '<!-- gsd-phase:1 -->');
  });

  it('returns the correct string for phase 0', () => {
    assert.equal(phaseMarker(0), '<!-- gsd-phase:0 -->');
  });

  it('coerces numeric strings to their string form', () => {
    assert.equal(phaseMarker('42'), '<!-- gsd-phase:42 -->');
  });

  it('coerces a two-digit number correctly', () => {
    assert.equal(phaseMarker(12), '<!-- gsd-phase:12 -->');
  });

  it('throws TypeError for null', () => {
    assert.throws(() => phaseMarker(null), TypeError);
  });

  it('throws TypeError for undefined', () => {
    assert.throws(() => phaseMarker(undefined), TypeError);
  });

  it('throws TypeError for empty string', () => {
    assert.throws(() => phaseMarker(''), TypeError);
  });
});

// ---------------------------------------------------------------------------
// MARKER_SEARCH_PREFIX
// ---------------------------------------------------------------------------

describe('MARKER_SEARCH_PREFIX', () => {
  it('equals the leading fragment of any phaseMarker output', () => {
    assert.equal(MARKER_SEARCH_PREFIX, '<!-- gsd-phase:');
  });

  it('is a prefix of phaseMarker(1)', () => {
    assert.ok(phaseMarker(1).startsWith(MARKER_SEARCH_PREFIX));
  });

  it('is a prefix of phaseMarker(99)', () => {
    assert.ok(phaseMarker(99).startsWith(MARKER_SEARCH_PREFIX));
  });
});

// ---------------------------------------------------------------------------
// LABELS
// ---------------------------------------------------------------------------

describe('LABELS', () => {
  it('has exactly the expected keys', () => {
    const keys = Object.keys(LABELS).sort();
    assert.deepEqual(keys, ['blocked', 'complete', 'humanGate', 'inProgress', 'pending']);
  });

  it('complete label value is gsd:complete', () => {
    assert.equal(LABELS.complete, 'gsd:complete');
  });

  it('inProgress label value is gsd:in-progress', () => {
    assert.equal(LABELS.inProgress, 'gsd:in-progress');
  });

  it('pending label value is gsd:pending', () => {
    assert.equal(LABELS.pending, 'gsd:pending');
  });

  it('blocked label value is gsd:blocked', () => {
    assert.equal(LABELS.blocked, 'gsd:blocked');
  });

  it('humanGate label value is gsd:human-gate', () => {
    assert.equal(LABELS.humanGate, 'gsd:human-gate');
  });
});

// ---------------------------------------------------------------------------
// statusForPhase
// ---------------------------------------------------------------------------

describe('statusForPhase', () => {
  it('complete===true → closed + gsd:complete', () => {
    const result = statusForPhase({ complete: true, disk_status: null, plan_count: 0 });
    assert.deepEqual(result, { state: 'closed', label: 'gsd:complete' });
  });

  it('complete===true even with in-progress disk_status → still closed', () => {
    const result = statusForPhase({ complete: true, disk_status: 'in_progress', plan_count: 5 });
    assert.deepEqual(result, { state: 'closed', label: 'gsd:complete' });
  });

  it('disk_status===in_progress → open + gsd:in-progress', () => {
    const result = statusForPhase({ complete: false, disk_status: 'in_progress', plan_count: 0 });
    assert.deepEqual(result, { state: 'open', label: 'gsd:in-progress' });
  });

  it('plan_count>0 → open + gsd:in-progress (regardless of disk_status)', () => {
    const result = statusForPhase({ complete: false, disk_status: null, plan_count: 1 });
    assert.deepEqual(result, { state: 'open', label: 'gsd:in-progress' });
  });

  it('plan_count===1 boundary → in-progress', () => {
    const result = statusForPhase({ complete: false, disk_status: null, plan_count: 1 });
    assert.equal(result.label, 'gsd:in-progress');
  });

  it('plan_count===0 boundary → pending (not in-progress)', () => {
    const result = statusForPhase({ complete: false, disk_status: 'no_directory', plan_count: 0 });
    assert.deepEqual(result, { state: 'open', label: 'gsd:pending' });
  });

  it('complete false, disk_status null, plan_count 0 → pending', () => {
    const result = statusForPhase({ complete: false, disk_status: null, plan_count: 0 });
    assert.deepEqual(result, { state: 'open', label: 'gsd:pending' });
  });

  it('complete false, disk_status complete (already done on disk but not marked), plan_count 0 → pending (complete flag wins)', () => {
    // disk_status 'complete' should not short-circuit unless complete===true
    const result = statusForPhase({ complete: false, disk_status: 'complete', plan_count: 0 });
    assert.deepEqual(result, { state: 'open', label: 'gsd:pending' });
  });

  it('disk_status in_progress AND plan_count>0 → in-progress (both signals)', () => {
    const result = statusForPhase({ complete: false, disk_status: 'in_progress', plan_count: 3 });
    assert.deepEqual(result, { state: 'open', label: 'gsd:in-progress' });
  });

  it('returns an object with exactly state and label keys', () => {
    const result = statusForPhase({ complete: false, disk_status: null, plan_count: 0 });
    const keys = Object.keys(result).sort();
    assert.deepEqual(keys, ['label', 'state']);
  });
});

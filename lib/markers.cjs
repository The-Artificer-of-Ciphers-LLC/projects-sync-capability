'use strict';

/**
 * Pure constants and mappers for GSD → GitHub issue synchronisation.
 * No I/O. No side effects.
 */

// ---------------------------------------------------------------------------
// Idempotency markers
// ---------------------------------------------------------------------------

/**
 * Returns the HTML-comment idempotency marker string for a given phase number.
 * Used both in issue bodies and in `gh search issues --match body` queries.
 *
 * @param {number|string} number  Phase number (coerced to string).
 * @returns {string}  e.g. "<!-- gsd-phase:1 -->"
 * @throws {TypeError} if number is null, undefined, or an empty string.
 */
function phaseMarker(number) {
  if (number === null || number === undefined) {
    throw new TypeError('phaseMarker: phase number must not be null or undefined');
  }
  const str = String(number);
  if (str === '') {
    throw new TypeError('phaseMarker: phase number must not be an empty string');
  }
  return `<!-- gsd-phase:${str} -->`;
}

/**
 * The leading fragment of every phaseMarker string.
 * Append the phase number to build a GitHub `in:body` search query.
 *
 * @type {string}
 */
const MARKER_SEARCH_PREFIX = '<!-- gsd-phase:';

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * Canonical GitHub label values used by this capability.
 * @type {{ complete: string, inProgress: string, pending: string, blocked: string, humanGate: string }}
 */
const LABELS = {
  complete: 'gsd:complete',
  inProgress: 'gsd:in-progress',
  pending: 'gsd:pending',
  blocked: 'gsd:blocked',
  humanGate: 'gsd:human-gate',
};

// ---------------------------------------------------------------------------
// Status mapper
// ---------------------------------------------------------------------------

/**
 * Given a normalized phase object (from roadmap-source.cjs), returns the
 * target GitHub issue state and label.
 *
 * Decision table:
 *   complete===true           → { state: 'closed', label: LABELS.complete }
 *   disk_status==='in_progress'
 *     OR plan_count>0         → { state: 'open',   label: LABELS.inProgress }
 *   otherwise                 → { state: 'open',   label: LABELS.pending }
 *
 * NOTE: blocked and human-gate detection are deferred — the `gsd-tools
 * roadmap analyze --raw` JSON does not currently expose a blocked flag or
 * human-gate marker.  Add detection here once roadmap-source surfaces them.
 *
 * @param {{ complete: boolean, disk_status: string|null, plan_count: number }} phase
 * @returns {{ state: 'open'|'closed', label: string }}
 */
function statusForPhase(phase) {
  if (phase.complete === true) {
    return { state: 'closed', label: LABELS.complete };
  }
  if (phase.disk_status === 'in_progress' || phase.plan_count > 0) {
    return { state: 'open', label: LABELS.inProgress };
  }
  return { state: 'open', label: LABELS.pending };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  phaseMarker,
  MARKER_SEARCH_PREFIX,
  LABELS,
  statusForPhase,
};

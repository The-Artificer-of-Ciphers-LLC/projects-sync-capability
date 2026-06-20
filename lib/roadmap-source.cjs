'use strict';

/**
 * roadmap-source.cjs
 *
 * Reads structured phase data from gsd-core's CLI via:
 *   gsd-tools roadmap analyze --cwd <cwd> --raw
 *
 * Does NOT parse ROADMAP.md directly — delegates all parsing to the CLI.
 *
 * The `exec` seam accepts an argv array and returns a stdout string.
 * The default real runner uses node/execFileSync of `gsd-tools`; inject a
 * mock in tests so tests never hit the network or the real CLI.
 */

const { execFileSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Default gsd exec
// ---------------------------------------------------------------------------

/**
 * Default exec for gsd-tools CLI invocations.
 *
 * A capability is require()'d INTO the running gsd-tools process, so we
 * re-invoke that same entry point rather than assuming `gsd-tools` is on PATH.
 * Resolution order:
 *   1. GSD_TOOLS_BIN env var (explicit override, useful in tests and CI)
 *   2. Re-invoke process.argv[1] with the same Node.js binary (runtime default)
 *   3. Last-resort: `gsd-tools` on PATH
 *
 * @param {string[]} argv
 * @returns {string}
 */
function defaultGsdExec(argv) {
  const bin = process.env.GSD_TOOLS_BIN;
  if (bin) {
    return execFileSync(bin, argv, { encoding: 'utf8' });
  }
  if (process.argv && process.argv[1]) {
    return execFileSync(process.execPath, [process.argv[1], ...argv], { encoding: 'utf8' });
  }
  return execFileSync('gsd-tools', argv, { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// loadPhases
// ---------------------------------------------------------------------------

/**
 * Loads and normalizes phase data from the gsd-tools roadmap analyze command.
 *
 * @param {object}   options
 * @param {string}   options.cwd   The project root to pass as --cwd.
 * @param {Function} [options.exec] (argvArray: string[]) => stdoutString
 * @returns {Promise<{
 *   milestones: Array<{heading: string, version: string}>,
 *   phases: Array<{
 *     number: string,
 *     name: string,
 *     goal: string,
 *     complete: boolean,
 *     disk_status: string|null,
 *     plan_count: number
 *   }>
 * }}
 */
function loadPhases({ cwd, exec = defaultGsdExec }) {
  const argv = ['roadmap', 'analyze', '--cwd', cwd, '--raw'];
  const stdout = exec(argv);

  // Parse — wrap failures with a raw-output prefix for diagnostics
  // (per RULESET.TESTS.diagnostics: assert output shape with raw-output-prefix before .map())
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (parseErr) {
    throw new Error(
      `roadmap-source: JSON.parse failed — raw output: ${String(stdout).slice(0, 500)}`
    );
  }

  // Guard: must be a plain object
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `roadmap-source: expected a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed} — raw output: ${String(stdout).slice(0, 500)}`
    );
  }

  // Guard: phases must be an array
  if (!Array.isArray(parsed.phases)) {
    throw new Error(
      `roadmap-source: expected Array.isArray(output.phases) to be true — got ${JSON.stringify(parsed.phases)} — raw output: ${String(stdout).slice(0, 500)}`
    );
  }

  // Normalize milestones
  const milestones = Array.isArray(parsed.milestones)
    ? parsed.milestones.map((m) => ({
        heading: m.heading ?? null,
        version: m.version ?? null,
      }))
    : [];

  // Normalize phases — keep only the fields this capability cares about,
  // apply safe defaults for optional fields
  const phases = parsed.phases.map((p) => ({
    number: p.number,
    name: p.name,
    goal: p.goal,
    complete: Boolean(p.roadmap_complete),       // source field → normalized name
    disk_status: p.disk_status ?? null,           // optional, default null
    plan_count: typeof p.plan_count === 'number' ? p.plan_count : 0, // optional, default 0
  }));

  return { milestones, phases };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { loadPhases };

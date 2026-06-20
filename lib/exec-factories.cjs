'use strict';

/**
 * exec-factories.cjs
 *
 * Factories that produce cwd-bound exec functions for `gh` and `gsd-tools`
 * child processes.  Binding the child process cwd ensures that tool
 * auto-detection (e.g. `gh repo view` inferring the repo from git context)
 * resolves against the GSD project directory rather than whatever directory
 * the Node process happens to be running in.
 *
 * Both factories accept an optional `_execFileSync` parameter so that tests
 * can inject a spy and assert that the {cwd} option is forwarded correctly.
 */

const { execFileSync } = require('node:child_process');

/**
 * Returns a function that runs `gh <argv>` with `cwd` set to the given
 * project directory.
 *
 * @param {string}   cwd              — GSD project root
 * @param {Function} [_execFileSync]  — injectable spy (for tests)
 * @returns {(argv: string[]) => string}
 */
function makeDefaultGhExec(cwd, _execFileSync = execFileSync) {
  return (argv) => _execFileSync('gh', argv, { encoding: 'utf8', cwd });
}

/**
 * Returns a function that runs `gsd-tools <argv>` with `cwd` set to the
 * given project directory.  Re-invokes the running gsd-tools entry point
 * when possible so the capability does not depend on `gsd-tools` being on
 * PATH separately.  Resolution order:
 *   1. GSD_TOOLS_BIN env var (explicit override)
 *   2. Re-invoke process.argv[1] with the same Node.js binary (runtime default)
 *   3. Last-resort: `gsd-tools` on PATH
 *
 * @param {string}   cwd              — GSD project root
 * @param {Function} [_execFileSync]  — injectable spy (for tests)
 * @returns {(argv: string[]) => string}
 */
function makeDefaultGsdExec(cwd, _execFileSync = execFileSync) {
  return (argv) => {
    const bin = process.env.GSD_TOOLS_BIN;
    if (bin) {
      return _execFileSync(bin, argv, { encoding: 'utf8', cwd });
    }
    if (process.argv && process.argv[1]) {
      return _execFileSync(process.execPath, [process.argv[1], ...argv], { encoding: 'utf8', cwd });
    }
    return _execFileSync('gsd-tools', argv, { encoding: 'utf8', cwd });
  };
}

module.exports = { makeDefaultGhExec, makeDefaultGsdExec };

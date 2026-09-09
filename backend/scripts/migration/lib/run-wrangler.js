'use strict';

/**
 * Phase 13 — robust wrangler invocation for the production scripts.
 *
 * Two independent, empirically-confirmed problems rule out reusing the
 * local scripts' `npx wrangler ... --file <path>` + `shell: true`
 * pattern verbatim for production *querying* (import still uses --file,
 * which is fine — see below):
 *
 *   1. `wrangler d1 execute --remote --file <path>` does not return row
 *      results at all — even for a SELECT, it returns an
 *      execution-summary object ({"Total queries executed": N, "Rows
 *      read": N, ...}), not the query's rows. This is a --remote-mode
 *      quirk (--file is oriented at bulk DML), confirmed against the
 *      real production D1 in Phase 12. --command mode returns real rows.
 *   2. But `execFileSync(..., { shell: true })` on Windows re-splits a
 *      multi-word --command argument on whitespace before wrangler ever
 *      sees it (cmd.exe re-tokenizes what should be one quoted arg) —
 *      the exact bug already hit twice in Phase 10 (reset-d1.js,
 *      verify-migration.js's original --file-based workaround). Setting
 *      shell:false avoids the re-splitting, but then `npx.cmd` itself
 *      can't be spawned without a shell on Windows (EINVAL) — confirmed
 *      empirically this phase.
 *
 * The fix: invoke wrangler's own JS entry point directly via
 * `process.execPath` (node.exe) with shell:false — this sidesteps both
 * problems at once (no cmd.exe re-tokenization, no .cmd wrapper). Local
 * scripts are untouched (they don't need --command's real-row behavior
 * for --local execution, which does return real rows via --file, and
 * changing already-regression-tested local tooling isn't necessary).
 */
const path = require('path');
const { execFileSync } = require('child_process');

function wranglerBinPath(backendDir) {
  return path.join(backendDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
}

/** Runs `node wrangler.js <args>` with shell:false, returns stdout. Throws on non-zero exit. */
function runWranglerCapture(backendDir, args) {
  return execFileSync(process.execPath, [wranglerBinPath(backendDir), ...args], {
    cwd: backendDir,
    shell: false,
    encoding: 'utf8',
  });
}

/** Same, but inherits stdio (for long-running batch imports where live progress output matters). */
function runWranglerInherit(backendDir, args) {
  execFileSync(process.execPath, [wranglerBinPath(backendDir), ...args], {
    cwd: backendDir,
    shell: false,
    stdio: 'inherit',
  });
}

module.exports = { wranglerBinPath, runWranglerCapture, runWranglerInherit };

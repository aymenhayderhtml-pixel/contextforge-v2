/**
 * run-e2e-edit-loop.mjs — the runnable edit-loop end-to-end test.
 *
 * ## Why this is a script and not a vitest file
 *
 * D24 records the lesson this file is the answer to: a timing assumption baked
 * into the shared suite makes an unrelated test intermittently red, and *a test
 * that cannot run reliably in the suite should not pretend to*. This loop needs
 * three things a vitest fork worker does not have:
 *
 *   - a real Electron main process with a display,
 *   - a real vite dev server for the game,
 *   - 60–120 seconds of wall clock for three page loads and four file writes.
 *
 * `vitest.config.ts` sets `testTimeout: 30_000` and `pool: 'forks'`, and this
 * file is not allowed to change either. So the loop lives here, owns its own
 * timeout, and reports through a process exit code. `packages/app/test/e2e/`
 * then holds a thin wrapper that runs *this* and asserts on the outcome — so the
 * loop is still covered by `npm test`, but only in the mode that cannot flake.
 *
 * ## Exit codes (asserted by the vitest wrapper, and by hand here)
 *
 *   0  passed   — every check in `runEditLoop` held
 *   1  failed   — a check failed; the reason names the file and the error
 *   2  skipped  — the environment is not the one this loop needs, with a reason
 *   3  could not start at all (missing Electron, missing bundles)
 *
 * ## Running it
 *
 *     npm run verify                                   # suite, wrapper skips loudly
 *     node scripts/run-e2e-edit-loop.mjs               # the real thing
 *
 * The game dev server must be up first:
 *
 *     cd ../kart-dash-3d-v2 && npm run dev
 *
 * Overrides: `CF_PROJECT`, `CF_GAME_URL`, `CF_E2E_REPORT`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CF_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = join(CF_ROOT, 'packages', 'app', 'src', 'electron', 'capture-v3d.mjs');

/** Pass/Fail/Skip, used for the exit code and for the one-line summary. */
const EXIT = { passed: 0, failed: 1, skipped: 2, couldNotStart: 3 };

/**
 * Why a missing prerequisite is a hard start failure rather than a skip.
 *
 * A skip means "this environment is not the one the loop needs" — a stopped dev
 * server, a machine with no display. A missing *bundle* is different: it means
 * the repository was never built, and every developer hits it identically. It
 * therefore exits 3 with an instruction rather than quietly skipping, because a
 * suite that skips forever because nobody ran a build tells you nothing at all.
 */
function preflight() {
  const missing = [];
  if (!existsSync(join(CF_ROOT, 'node_modules', '.bin', 'electron'))) {
    missing.push('node_modules/.bin/electron (run `npm install`)');
  }
  if (!existsSync(HARNESS)) {
    missing.push(`${HARNESS} (the harness itself is missing)`);
  }
  if (!existsSync(join(CF_ROOT, 'packages', 'app', 'dist', 'electron', 'ipcHandlers.js'))) {
    missing.push('packages/app/dist/electron/ipcHandlers.js (run `npm run typecheck`)');
  }
  if (!existsSync(join(CF_ROOT, 'packages', 'app', 'dist', 'renderer', 'index.html'))) {
    missing.push('packages/app/dist/renderer/index.html (run `npm run build:ui -w @contextforge/app`)');
  }
  return missing;
}

function main() {
  const missing = preflight();
  if (missing.length > 0) {
    console.error('[e2e] cannot start the edit-loop harness. Missing:');
    for (const item of missing) console.error(`  - ${item}`);
    return EXIT.couldNotStart;
  }

  console.log('[e2e] driving the real edit loop in Electron: open project → select player_kart →');
  console.log('[e2e] edit position → Save → read the game\'s rendered position → Undo → Save → re-read.');

  // `--no-sandbox` is mandatory, not optional: the bundled `chrome-sandbox` ships
  // without the setuid bit, so without it Electron aborts at startup. The Electron
  // ESM entry point also cannot run top-level `await`; the harness avoids it
  // entirely, and that is why nothing here has to care.
  const result = spawnSync(join(CF_ROOT, 'node_modules', '.bin', 'electron'), ['--no-sandbox', HARNESS], {
    encoding: 'utf8',
    // Generous on purpose, and separate from vitest's 30s: three page loads of a
    // real Three.js game plus four writes to disk have never fitted in that.
    timeout: 15 * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (stdout !== '') process.stdout.write(stdout);
  // Chromium's own GPU chatter is not the harness's; only surface stderr when
  // something actually failed or said so, so a green run stays quiet.
  if (result.status !== EXIT.passed && stderr !== '') process.stderr.write(stderr);

  if (result.error !== undefined && result.error !== null) {
    console.error(`[e2e] the Electron process could not be run: ${result.error.message}`);
    return EXIT.couldNotStart;
  }
  if (result.signal !== null && result.signal !== undefined) {
    console.error(
      `[e2e] the Electron process was killed by ${result.signal} after 15 minutes. That is the loop ` +
        'hanging, not passing — treat it as a failure.',
    );
    return EXIT.failed;
  }

  const status = result.status ?? EXIT.failed;
  if (status === EXIT.passed) console.log('[e2e] PASSED — the game\'s rendered kart matched what the app saved, and followed the undo back.');
  else if (status === EXIT.skipped) console.warn('[e2e] SKIPPED — the environment was not ready; nothing was proven.');
  else if (status === EXIT.failed) console.error('[e2e] FAILED — see the reason above.');
  return status;
}

process.exit(main());
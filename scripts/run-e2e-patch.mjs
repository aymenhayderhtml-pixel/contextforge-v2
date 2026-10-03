/**
 * run-e2e-patch.mjs — the runnable patch end-to-end test.
 *
 * Drives the real ContextForge Electron app through the full patch lifecycle:
 *   1. Opens kart-dash-3d-v2
 *   2. Pastes an EDIT patch, previews, applies, and verifies change on disk
 *   3. Presses Undo and proves the file is back byte-for-byte (sha256)
 *   4. Presses Redo and proves the file is changed again
 *   5. Applies a 2-file patch and undoes it as one step (proving both files back byte-for-byte)
 *   6. Previews and tests a patch with a bad block, proving NOTHING was written to disk
 *   7. Captures screenshots at every step into screenshots/v4b/
 *   8. Always restores the files so kart-dash-3d-v2 remains completely clean
 *
 * ## Exit codes
 *   0  passed   — every step and sha256 check passed
 *   1  failed   — a check failed or threw an error
 *   2  skipped  — environment not ready (missing project files)
 *   3  could not start (missing electron or build artifacts)
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CF_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = join(CF_ROOT, 'packages', 'app', 'src', 'electron', 'patch-harness.mjs');

const EXIT = { passed: 0, failed: 1, skipped: 2, couldNotStart: 3 };

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
    console.error('[e2e-patch] cannot start the patch harness. Missing:');
    for (const item of missing) console.error(`  - ${item}`);
    return EXIT.couldNotStart;
  }

  console.log('[e2e-patch] Driving the real patch lifecycle in Electron:');
  console.log('[e2e-patch] open project → single edit patch → apply → disk verify → undo → redo → 2-file patch → bad block');

  const result = spawnSync(
    join(CF_ROOT, 'node_modules', '.bin', 'electron'),
    ['--no-sandbox', HARNESS],
    {
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    },
  );

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (stdout !== '') process.stdout.write(stdout);
  if (result.status !== EXIT.passed && stderr !== '') process.stderr.write(stderr);

  if (result.error !== undefined && result.error !== null) {
    console.error(`[e2e-patch] the Electron process could not be run: ${result.error.message}`);
    return EXIT.couldNotStart;
  }
  if (result.signal !== null && result.signal !== undefined) {
    console.error(
      `[e2e-patch] the Electron process was killed by ${result.signal}. Treat it as a failure.`,
    );
    return EXIT.failed;
  }

  const status = result.status ?? EXIT.failed;
  if (status === EXIT.passed) {
    console.log('[e2e-patch] PASSED — all patch operations, undos, redos, and sha256 byte-for-byte checks passed.');
  } else if (status === EXIT.skipped) {
    console.warn('[e2e-patch] SKIPPED — the environment was not ready.');
  } else {
    console.error('[e2e-patch] FAILED — see log above.');
  }
  return status;
}

process.exit(main());

/**
 * run-e2e-brief.mjs — runnable Brief end-to-end test script.
 *
 * ## What this script does
 *
 * Drives the real ContextForge app in Electron with kart-dash-3d-v2:
 * 1. Open the Context screen.
 * 2. Press 'New AI context', build a One-shot brief with a task and an Interactive brief.
 * 3. Read .contextforge/brief.md from disk and assert that it contains:
 *    - the stack
 *    - the folder map
 *    - real public signatures
 *    - the scene.json and prefab rules
 *    - the patch format
 * 4. Assert that Interactive tells the AI to reply `NEED: <path>`.
 * 5. Then simulate an AI reply `NEED: src/track.js` and prove the file gets attached.
 * 6. Take screenshots at each step into screenshots/v4b/.
 * 7. Restore original state of .contextforge/brief.md.
 *
 * ## Exit codes
 *
 *   0 passed   — every check held
 *   1 failed   — a check or assertion failed
 *   2 skipped  — environment not ready
 *   3 could not start (missing Electron, missing bundles)
 *
 * ## Running it
 *
 *     node scripts/run-e2e-brief.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CF_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = join(CF_ROOT, 'packages', 'app', 'src', 'electron', 'capture-brief.mjs');

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
  const projectPath = process.env['CF_PROJECT'] ?? join(CF_ROOT, '..', 'kart-dash-3d-v2');
  if (!existsSync(projectPath)) {
    missing.push(`kart-dash-3d-v2 project at ${projectPath}`);
  }
  return missing;
}

function main() {
  const missing = preflight();
  if (missing.length > 0) {
    console.error('[e2e-brief] cannot start the brief loop harness. Missing:');
    for (const item of missing) console.error(`  - ${item}`);
    return EXIT.couldNotStart;
  }

  console.log('[e2e-brief] driving the real Brief loop in Electron:');
  console.log('  1. Open Context screen');
  console.log('  2. Build One-shot brief with task & build Interactive brief');
  console.log('  3. Assert .contextforge/brief.md contents on disk');
  console.log('  4. Assert Interactive tells AI to reply NEED: <path>');
  console.log('  5. Simulate AI reply "NEED: src/track.js" & assert file attachment');
  console.log('  6. Capture screenshots into screenshots/v4b/');
  console.log('  7. Restore .contextforge state');

  const result = spawnSync(join(CF_ROOT, 'node_modules', '.bin', 'electron'), ['--no-sandbox', HARNESS], {
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (stdout !== '') process.stdout.write(stdout);
  if (result.status !== EXIT.passed && stderr !== '') process.stderr.write(stderr);

  if (result.error !== undefined && result.error !== null) {
    console.error(`[e2e-brief] the Electron process could not be run: ${result.error.message}`);
    return EXIT.couldNotStart;
  }
  if (result.signal !== null && result.signal !== undefined) {
    console.error(`[e2e-brief] Electron was killed by ${result.signal}. Loop hung.`);
    return EXIT.failed;
  }

  const status = result.status ?? EXIT.failed;
  if (status === EXIT.passed) console.log('[e2e-brief] PASSED — all brief loop requirements verified successfully.');
  else if (status === EXIT.skipped) console.warn('[e2e-brief] SKIPPED — environment not ready.');
  else console.error('[e2e-brief] FAILED — see output above.');

  return status;
}

process.exit(main());

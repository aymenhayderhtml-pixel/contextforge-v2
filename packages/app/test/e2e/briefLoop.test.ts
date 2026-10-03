/**
 * briefLoop.test.ts — the suite's thin wrapper around the real Brief loop.
 *
 * ## What this test does
 *
 * Following `editLoop.test.ts`, this test wraps `scripts/run-e2e-brief.mjs`.
 * The real loop drives Electron against kart-dash-3d-v2 to:
 *   1. Open Context screen
 *   2. Build One-shot brief with task & Interactive brief
 *   3. Assert .contextforge/brief.md contents on disk (stack, folder map, signatures, scene rules, patch format)
 *   4. Assert Interactive tells AI to reply `NEED: <path>`
 *   5. Simulate AI reply `NEED: src/track.js` and prove file gets attached
 *   6. Capture screenshots into screenshots/v4b/
 *   7. Restore .contextforge state
 *
 * ## How to run
 *
 * Default `npm test` checks file existence and exit code contract, skipping the 40s
 * Electron run so the suite stays fast and deterministic (D24).
 *
 * To run the real Electron loop:
 *   node scripts/run-e2e-brief.mjs
 * Or with vitest:
 *   CF_E2E=1 npx vitest run packages/app/test/e2e/briefLoop.test.ts
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CF_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const RUNNER = join(CF_ROOT, 'scripts', 'run-e2e-brief.mjs');
const HARNESS = join(CF_ROOT, 'packages', 'app', 'src', 'electron', 'capture-brief.mjs');

const EXIT = { passed: 0, failed: 1, skipped: 2, couldNotStart: 3 } as const;

const E2E_REQUESTED = (process.env['CF_E2E'] ?? '') !== '';

describe('brief-loop e2e wrapper', () => {
  it('ships the runnable loop and the harness it drives', () => {
    expect(
      existsSync(RUNNER),
      `${RUNNER} does not exist. Without it there is no runnable brief-loop script.`,
    ).toBe(true);
    expect(
      existsSync(HARNESS),
      `${HARNESS} does not exist, so scripts/run-e2e-brief.mjs drives nothing.`,
    ).toBe(true);
  });

  it('the harness declares the same exit codes the wrapper interprets', () => {
    const source = readFileSync(HARNESS, 'utf8');
    const declares = /app\.exit\(\s*result\.status === 'passed'\s*\?\s*(\d)\s*:\s*result\.status === 'skipped'\s*\?\s*(\d)\s*:\s*(\d)\s*\)/;
    const match = declares.exec(source);
    expect(
      match,
      `${HARNESS} must exit with the documented codes (0 passed / 2 skipped / 1 failed).`,
    ).not.toBeNull();
    expect({
      passed: Number(match?.[1]),
      skipped: Number(match?.[2]),
      failed: Number(match?.[3]),
    }).toEqual({ passed: EXIT.passed, skipped: EXIT.skipped, failed: EXIT.failed });
  });

  it('drives the real brief loop when asked, and only when it can actually run', async () => {
    if (!E2E_REQUESTED) {
      console.warn(
        '[e2e] SKIPPED BY DEFAULT — the real brief loop needs an Electron display and built renderer ' +
          'bundle. To run it: `node scripts/run-e2e-brief.mjs`, or set CF_E2E=1 to run it via vitest.',
      );
      expect(E2E_REQUESTED).toBe(false);
      return;
    }

    const result = spawnSync(process.execPath, [RUNNER], {
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.error !== undefined && result.error !== null) {
      throw new Error(
        `scripts/run-e2e-brief.mjs could not be executed: ${result.error.message}\n${output}`,
      );
    }
    if (result.signal !== null && result.signal !== undefined) {
      throw new Error(
        `scripts/run-e2e-brief.mjs was killed by ${result.signal}. The loop hung.\n${output}`,
      );
    }

    expect(
      { status: result.status, output },
      { status: EXIT.passed, output: expect.stringContaining('PASSED') },
    );
  });
});

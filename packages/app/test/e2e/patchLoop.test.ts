/**
 * patchLoop.test.ts — the suite's thin wrapper around the real patch e2e loop.
 *
 * Follows the pattern of `editLoop.test.ts`:
 * - Verifies the runner script and harness exist.
 * - Asserts the harness's exit codes match the contract (0 passed, 2 skipped, 1 failed).
 * - Runs the real patch loop in Electron when requested (CF_E2E=1 or CF_E2E_PATCH=1),
 *   otherwise skips gracefully by default to avoid flaking in CI without a display.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CF_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const RUNNER = join(CF_ROOT, 'scripts', 'run-e2e-patch.mjs');
const HARNESS = join(CF_ROOT, 'packages', 'app', 'src', 'electron', 'patch-harness.mjs');

const EXIT = { passed: 0, failed: 1, skipped: 2, couldNotStart: 3 } as const;

const E2E_REQUESTED =
  (process.env['CF_E2E'] ?? '') !== '' || (process.env['CF_E2E_PATCH'] ?? '') !== '';

describe('patch-loop e2e wrapper', () => {
  it('ships the runnable patch loop and the harness it drives', () => {
    expect(
      existsSync(RUNNER),
      `${RUNNER} does not exist. Without it there is no runnable patch-loop test at all.`,
    ).toBe(true);
    expect(
      existsSync(HARNESS),
      `${HARNESS} does not exist, so \`scripts/run-e2e-patch.mjs\` drives nothing.`,
    ).toBe(true);
  });

  it('the harness declares the documented exit codes', () => {
    const source = readFileSync(HARNESS, 'utf8');
    const declares =
      /app\.exit\(\s*result\.status === 'passed'\s*\?\s*(\d)\s*:\s*result\.status === 'skipped'\s*\?\s*(\d)\s*:\s*(\d)\s*\)/;
    const match = declares.exec(source);
    expect(
      match,
      `${HARNESS} does not exit with the documented codes (0 passed / 2 skipped / 1 failed).`,
    ).not.toBeNull();
    expect({
      passed: Number(match?.[1]),
      skipped: Number(match?.[2]),
      failed: Number(match?.[3]),
    }).toEqual({ passed: EXIT.passed, skipped: EXIT.skipped, failed: EXIT.failed });
  });

  it('drives the real patch loop when asked', () => {
    if (!E2E_REQUESTED) {
      console.warn(
        '[e2e-patch] SKIPPED BY DEFAULT — the real patch loop runs in Electron. ' +
          'To run it: `node scripts/run-e2e-patch.mjs`, or set CF_E2E=1 or CF_E2E_PATCH=1.',
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
      throw new Error(`scripts/run-e2e-patch.mjs could not be executed: ${result.error.message}\n${output}`);
    }
    if (result.signal !== null && result.signal !== undefined) {
      throw new Error(`scripts/run-e2e-patch.mjs was killed by ${result.signal}.\n${output}`);
    }

    expect(
      { status: result.status, output },
      { status: EXIT.passed, output: expect.stringContaining('"status": "passed"') },
    );
  });
});

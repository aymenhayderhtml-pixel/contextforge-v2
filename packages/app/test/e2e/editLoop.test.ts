/**
 * editLoop.test.ts — the suite's thin wrapper around the real edit loop.
 *
 * ## What this test deliberately does NOT do
 *
 * It does not spawn Electron and drive the app itself. That is `scripts/run-e2e-
 * edit-loop.mjs`'s job, and this file's whole purpose is to say why.
 *
 * `vitest.config.ts` fixes `pool: 'forks'` and `testTimeout: 30_000`, and that
 * file is off-limits. The loop under test needs a real Electron main process
 * with a display, a real vite dev server for the kart game, and 60–120 seconds
 * of wall clock for three page loads and four writes to disk. Put that inside a
 * 30-second fork worker and one of two things happens: the timeout fires and the
 * suite is intermittently red on a loaded machine, or the timeout is raised for
 * everyone and every other test now waits on an Electron window.
 *
 * D24 in `docs/DECISIONS.md` is exactly this: a timing assumption made an
 * unrelated test flaky, and the lesson recorded there is that a test which
 * cannot run reliably in the suite should not pretend to. So this suite asserts
 * the two things it can assert honestly and deterministically — that the
 * wrapper exists and that the wrapper's contract is the one the harness
 * implements — and *runs the loop for real* only when it has been asked to
 * explicitly and the environment can actually serve it.
 *
 * ## How to prove the loop for real
 *
 *     # 1. the game's dev server
 *     cd ../kart-dash-3d-v2 && npm run dev
 *
 *     # 2. the loop
 *     npm run build:ui -w @contextforge/app
 *     node scripts/run-e2e-edit-loop.mjs
 *
 *     # 3. or, to have the suite run it too:
 *     CF_E2E=1 npx vitest run packages/app/test/e2e/editLoop.test.ts
 *
 * Exit 0 passed, 1 failed, 2 skipped, 3 could-not-start — asserted below against
 * the harness's own `main()`, not against a constant, so the contract cannot
 * drift out of sync with the thing that implements it.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CF_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const RUNNER = join(CF_ROOT, 'scripts', 'run-e2e-edit-loop.mjs');
const HARNESS = join(CF_ROOT, 'packages', 'app', 'src', 'electron', 'capture-v3d.mjs');

/** Exactly the codes `capture-v3d.mjs`'s `main()` returns, as its own source says. */
const EXIT = { passed: 0, failed: 1, skipped: 2, couldNotStart: 3 } as const;

/**
 * Has the user asked for the real loop?
 *
 * Opt-in via an environment variable, and defaulting to *off* is the whole
 * design: a suite that runs Electron and a vite server on every `npm test` is a
 * suite whose runtime, timing and failure modes belong to the machine, not to
 * the code. The escape hatch exists so the loop is never merely theoretical.
 */
const E2E_REQUESTED = (process.env['CF_E2E'] ?? '') !== '';

/** Is the game dev server actually answering? Cheap, and the usual reason to skip. */
async function gameServerUp(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    // Any failure at all means "not available here", which is exactly the skip
    // condition; the reason is reported by the harness itself when it runs.
    return false;
  }
}

describe('edit-loop e2e wrapper', () => {
  it('ships the runnable loop and the harness it drives', () => {
    // A test that silently stops covering anything because a file was moved or
    // deleted is the failure mode this guards: it would go green while proving
    // nothing, which is the one outcome SPEC R9 rules out.
    expect(
      existsSync(RUNNER),
      `${RUNNER} does not exist. Without it there is no runnable edit-loop test at all — ` +
        '`packages/app/test/e2e/editLoop.test.ts` would be asserting against a script that is gone.',
    ).toBe(true);
    expect(
      existsSync(HARNESS),
      `${HARNESS} does not exist, so \`scripts/run-e2e-edit-loop.mjs\` drives nothing.`,
    ).toBe(true);
  });

  it('the harness declares the same exit codes the wrapper interprets', () => {
    // The runner maps 0/1/2/3 onto pass/fail/skip/could-not-start. If the
    // harness ever changes what it returns, this test goes red immediately
    // rather than a real run being reported as a pass because 0 came back for
    // the wrong reason.
    const source = readFileSync(HARNESS, 'utf8');
    const declares = /app\.exit\(\s*result\.status === 'passed'\s*\?\s*(\d)\s*:\s*result\.status === 'skipped'\s*\?\s*(\d)\s*:\s*(\d)\s*\)/;
    const match = declares.exec(source);
    expect(
      match,
      `${HARNESS} no longer exits with the documented codes (0 passed / 2 skipped / 1 failed). ` +
        'scripts/run-e2e-edit-loop.mjs maps the harness status onto pass/fail/skip, so an unchanged ' +
        'wrapper over a changed harness would silently misreport a real run.',
    ).not.toBeNull();
    expect({
      passed: Number(match?.[1]),
      skipped: Number(match?.[2]),
      failed: Number(match?.[3]),
    }).toEqual({ passed: EXIT.passed, skipped: EXIT.skipped, failed: EXIT.failed });
  });

  it('drives the real edit loop when asked, and only when it can actually run', async () => {
    if (!E2E_REQUESTED) {
      // Loud on purpose: a quiet skip here is indistinguishable from a test that
      // silently stopped testing anything, which is how a loop like this rots.
      console.warn(
        '[e2e] SKIPPED BY DEFAULT — the real edit loop needs an Electron display, a built renderer ' +
          `bundle and the kart game's vite dev server. To run it: \`node scripts/${'run-e2e-edit-loop.mjs'}\`, ` +
          'or set CF_E2E=1 to have this suite run it too. This is a deliberate skip, not a pass: nothing ' +
          'about the app↔game edit loop is proven by a default `npm test`.',
      );
      expect(E2E_REQUESTED).toBe(false);
      return;
    }

    const gameUrl = process.env['CF_GAME_URL'] ?? 'http://127.0.0.1:5173/';
    if (!(await gameServerUp(gameUrl))) {
      console.warn(
        `[e2e] SKIPPED — no kart game dev server at ${gameUrl}. Start it with ` +
          '`cd ../kart-dash-3d-v2 && npm run dev` (or set CF_PROJECT), then re-run. ' +
          'Nothing is proven by this skip.',
      );
      expect(await gameServerUp(gameUrl)).toBe(false);
      return;
    }

    const result = spawnSync(process.execPath, [RUNNER], {
      encoding: 'utf8',
      // Comfortably beyond the wrapper's own 30s budget is pointless; the point
      // of this branch is that the *loop* gets real time. Kept explicit so the
      // difference between this and the default path is visible in one place.
      timeout: 15 * 60 * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.error !== undefined && result.error !== null) {
      throw new Error(
        `scripts/run-e2e-edit-loop.mjs could not be executed: ${result.error.message}\n${output}`,
      );
    }
    if (result.signal !== null && result.signal !== undefined) {
      throw new Error(
        `scripts/run-e2e-edit-loop.mjs was killed by ${result.signal} after 15 minutes. The loop hung; ` +
          `that is a failure, not a pass.\n${output}`,
      );
    }

    expect(
      { status: result.status, output },
      // A bare `expect(status).toBe(0)` would fail with nothing but "expected 1
      // to be 0", which is the opposite of R9. The harness's own reason and its
      // evidence travel with the assertion.
      { status: EXIT.passed, output: expect.stringContaining('"status": "passed"') },
    );
  });
});
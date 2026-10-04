/**
 * packages/core/test/patch/perf-round-c.test.ts
 *
 * PATCH-5: the diff built an unbounded LCS table and killed the process (D53).
 *
 * `diffLines` filled a full (before × after) table. Measured on main: 639 MB peak
 * RSS at 8,000 lines and 2,216 MB at 16,000, and at 40,000 lines the audit hit
 * `FATAL ERROR: Ineffective mark-compacts near heap limit` — a hard SIGABRT of
 * the V8 isolate, i.e. the Electron *main process*, not a catchable throw.
 *
 * The original header justified LCS with "patches are small", which was about the
 * wrong quantity: an AI's patch is tens of lines, but the file being patched is
 * unbounded. Now bounded by `MAX_DIFF_LINES`, and past the bound it refuses with a
 * sentence rather than crashing.
 */

import { describe, expect, it } from 'vitest';
import {
  DiffTooLargeError,
  MAX_DIFF_LINES,
  formatUnifiedDiff,
  generateFlatDiff,
  generateUnifiedDiff,
} from '../../src/patch/diff.js';

function lines(n: number, mutate?: (i: number) => string): string {
  return (
    Array.from({ length: n }, (_, i) => mutate?.(i) ?? `line ${i}`).join('\n') + '\n'
  );
}

function ms(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe('PATCH-5 — an oversized file is refused, not fatal', () => {
  it('a 40,000-line file is refused rather than exhausting the heap', () => {
    // The audit's exact failure case. It killed the worker process before the fix,
    // which is why it had to be kept in its own test file.
    const before = lines(40_000);
    const after = lines(40_000, (i) => (i % 3 === 0 ? `LINE ${i}` : `line ${i}`));
    expect(() => generateUnifiedDiff(before, after)).toThrow(DiffTooLargeError);
  });

  it('a 200,000-line file is refused in well under a second', () => {
    const before = lines(200_000);
    const after = lines(200_000, (i) => (i % 3 === 0 ? `LINE ${i}` : `line ${i}`));
    const elapsed = ms(() => {
      try {
        generateUnifiedDiff(before, after);
      } catch {
        // The refusal IS the behaviour; the timing is what is under test.
      }
    });
    expect(elapsed).toBeLessThan(1000);
  });

  it('the refusal names the size, the limit, and what to do instead', () => {
    const before = lines(MAX_DIFF_LINES + 500);
    let caught: DiffTooLargeError | undefined;
    try {
      generateUnifiedDiff(before, before);
    } catch (error) {
      caught = error as DiffTooLargeError;
    }

    expect(caught).toBeInstanceOf(DiffTooLargeError);
    expect(caught?.beforeLines).toBe(MAX_DIFF_LINES + 500);
    expect(caught?.afterLines).toBe(MAX_DIFF_LINES + 500);
    expect(caught?.maxLines).toBe(MAX_DIFF_LINES);
    expect(caught?.code).toBe('DIFF_TOO_LARGE');

    // The numbers, so a developer can tell which file and how far over.
    expect(caught?.message).toContain(String(MAX_DIFF_LINES + 500));
    expect(caught?.message).toContain(String(MAX_DIFF_LINES));
    // The consequence, not just the condition.
    expect(caught?.message).toContain('crash');
    // The way out.
    expect(caught?.message).toMatch(/smaller pieces|narrow the EDIT block/);
  });

  it('the refusal is thrown, not returned as an empty diff', () => {
    // An empty diff renders as "No changes to this file" — a confident wrong
    // answer about whether a write is about to happen (D30).
    const big = lines(MAX_DIFF_LINES + 1);
    let returned = false;
    try {
      const result = generateUnifiedDiff(big, `${big}changed\n`);
      returned = Array.isArray(result);
    } catch {
      returned = false;
    }
    expect(returned).toBe(false);
  });

  it('generateFlatDiff refuses too — it is the same code path', () => {
    const big = lines(MAX_DIFF_LINES + 1);
    expect(() => generateFlatDiff(big, `${big}changed\n`)).toThrow(DiffTooLargeError);
  });

  it('formatUnifiedDiff refuses too — it is what the Patch screen calls', () => {
    const big = lines(MAX_DIFF_LINES + 1);
    expect(() => formatUnifiedDiff('big.ts', big, `${big}changed\n`)).toThrow(DiffTooLargeError);
  });

  it('a file exactly at the limit is still diffed', () => {
    // The bound is inclusive. A file of exactly MAX_DIFF_LINES must not be
    // refused, or the limit would be quietly off by one.
    const before = lines(MAX_DIFF_LINES);
    const after = lines(MAX_DIFF_LINES, (i) => (i === 0 ? 'CHANGED' : `line ${i}`));
    const hunks = generateUnifiedDiff(before, after);
    expect(hunks.length).toBeGreaterThan(0);
  });

  it('one oversized side refuses even when the other is tiny', () => {
    // A cell cap would let this through (400,001 × 1 is small); a line cap does
    // not. The asymmetric case is the one worth testing.
    expect(() => generateUnifiedDiff(lines(MAX_DIFF_LINES + 1), 'one line\n')).toThrow(
      DiffTooLargeError,
    );
  });
});

describe('PATCH-5 parity — small diffs are byte-identical to before', () => {
  it('a single changed line still produces the same hunk', () => {
    const hunks = generateUnifiedDiff(
      'line 1\nline 2\nline 3\nline 4',
      'line 1\nline 2 modified\nline 3\nline 4',
    );
    expect(hunks).toHaveLength(1);
    // Written from the real output, not from a guess: a delete is emitted
    // directly against its add, with no extra context line between them.
    expect(hunks[0]?.chunks.map((c) => `${c.type}:${c.line}`)).toEqual([
      'context:line 1',
      'delete:line 2',
      'add:line 2 modified',
      'context:line 3',
      'context:line 4',
    ]);
  });

  it('identical texts still produce no hunks', () => {
    expect(generateUnifiedDiff('a\nb', 'a\nb')).toEqual([]);
    expect(generateFlatDiff('a\nb', 'a\nb')).toEqual([]);
  });

  it('a new file still formats with /dev/null headers', () => {
    const text = formatUnifiedDiff('src/newFile.ts', '', 'one\ntwo\n');
    expect(text).toContain('--- /dev/null');
    expect(text).toContain('+++ b/src/newFile.ts');
    expect(text).toContain('+one');
  });

  it('a 3,900-line diff — just under the bound — is unchanged in shape', () => {
    // The cap must not alter results for anything it allows through.
    const before = lines(3900);
    const after = lines(3900, (i) => (i === 100 ? 'CHANGED' : `line ${i}`));
    const hunks = generateUnifiedDiff(before, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.chunks.some((c) => c.type === 'add' && c.line === 'CHANGED')).toBe(true);
  });

  it('line numbers survive the cap unchanged on a mid-size diff', () => {
    const before = lines(500);
    const after = lines(500, (i) => (i === 250 ? 'CHANGED' : `line ${i}`));
    const hunks = generateUnifiedDiff(before, after);
    const add = hunks[0]?.chunks.find((c) => c.type === 'add');
    expect(add?.afterLine).toBe(251);
    expect(add?.beforeLine).toBeNull();
  });
});
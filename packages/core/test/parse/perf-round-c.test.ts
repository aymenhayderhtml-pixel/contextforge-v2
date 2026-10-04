/**
 * packages/core/test/parse/perf-round-c.test.ts
 *
 * CTX-3: the tree-sitter defect walk was quadratic (D53).
 *
 * `node.children` in the tree-sitter Node binding materialises a fresh array of
 * SyntaxNode objects for the whole subtree on EVERY read. `findFirstDefect` read
 * it twice per node — once for `.length`, once per index — so each node cost was
 * proportional to its own subtree and the total went quadratic.
 *
 * Measured on main before the fix: 80 KB of generated source took 23,583 ms, and
 * doubling the input multiplied the time by 3.09x. After: 172 ms and 1.45x.
 */

import { describe, expect, it } from 'vitest';
import { tryParse } from '../../src/parse/grammars.js';

/** A generated module: many top-level `export const` statements. */
function generatedModule(kb: number): string {
  const statements = Math.floor((kb * 1024) / 20);
  return (
    Array.from({ length: statements }, (_, i) => `export const a${i} = ${i};`).join('\n') + '\n'
  );
}

function ms(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe('CTX-3 — the defect walk is linear, not quadratic', () => {
  it('80 KB of generated source still parses successfully', () => {
    // Correctness, not speed: the fix must not have changed what `tryParse`
    // accepts. Unfixed this cost 23,583 ms; `parser.parse` alone is 5 ms of that.
    const outcome = tryParse(generatedModule(80), 'generated.js');
    expect(outcome.ok).toBe(true);
  });

  it('the 80 KB case finishes in under 2s, measured best-of-3', () => {
    // Best-of-3 rather than a single run. A single timing of a fast operation is
    // dominated by scheduler noise — this failed once under the full suite while
    // passing 5/5 in isolation — and taking the minimum drops that noise.
    //
    // An ABSOLUTE limit, deliberately not a doubling ratio. The gap is 23,583 ms
    // unfixed against 172 ms fixed, a factor of 137, so an absolute bound
    // separates the two decisively where a ratio does not: a ratio test here was
    // measured PASSING on the unfixed code on a fast machine, and making it
    // best-of-3 made it pass on unfixed code every time, because taking a
    // minimum removes precisely the super-linear term a ratio depends on to
    // detect it. Both versions were tried; only this one works.
    const source = generatedModule(80);
    let lowest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      lowest = Math.min(lowest, ms(() => tryParse(source, 'generated.js')));
    }
    expect(lowest).toBeLessThan(2000);
  });

  it('a 40 KB case — over the audited 16 KB failure size — stays under 2s', () => {
    // One size beyond what the audit reported, to show the fix is not tuned to
    // exactly the case that was measured.
    //
    // Deliberately 40 KB and not 160 KB. Reverting the source to confirm these
    // assertions bite showed that an 80 KB unfixed parse alone runs 23 s, so a
    // 160 KB case would put a 90-second test in the suite. A test that proves its
    // point by hanging the runner is a test nobody will keep running. 40 KB is
    // ~5 s unfixed and comfortably over any plausible threshold.
    const source = generatedModule(40);
    let lowest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      lowest = Math.min(lowest, ms(() => tryParse(source, 'generated.js')));
    }
    expect(lowest).toBeLessThan(2000);
  });
});

describe('CTX-3 parity — hoisting `children` did not change which defect is found', () => {
  it('a valid file parses and reports no defect', () => {
    const outcome = tryParse('export const a = 1;\nfunction f() { return a; }\n', 'ok.js');
    expect(outcome.ok).toBe(true);
  });

  it('a MISSING node is still reported, with the token it stands for', () => {
    // Unclosed function: the MISSING node has type '}' and zero width. This is
    // the exact case a type-search walk cannot see, which is why the walk exists.
    const outcome = tryParse('function greet() {\n  const a = 1;\n', 'broken.js');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('}');
  });

  it('the FIRST defect in source order is the one reported', () => {
    // Two defects; the walk is depth-first in source order and returns as soon as
    // it finds one, so the earlier one must win.
    const outcome = tryParse(
      'function a() {\n  const x = ;\n}\nfunction b() {\n  const y = ;\n}\n',
      'two.js',
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // Line 2 is the first broken statement.
      expect(outcome.line).toBe(2);
    }
  });

  it('an ERROR node is reported at the line it occupies', () => {
    const outcome = tryParse('const a = 1;\nconst = ;\n', 'err.js');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.line).toBe(2);
  });
});
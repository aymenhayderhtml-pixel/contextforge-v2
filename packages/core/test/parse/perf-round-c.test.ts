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
  it('80 KB of generated source is defect-checked in well under 2s', () => {
    // Unfixed: 23,583 ms. `parser.parse` alone is 5 ms of that.
    const outcome = tryParse(generatedModule(80), 'generated.js');
    expect(outcome.ok).toBe(true);
  });

  it('the 80 KB case finishes in under 2s', () => {
    const source = generatedModule(80);
    expect(ms(() => tryParse(source, 'generated.js'))).toBeLessThan(2000);
  });

  it('doubling the input does not quadruple the time', () => {
    // Linear is ~2x. Unfixed this was 3.09x at 10->20 KB and 3.6x at 20->40 KB.
    // The threshold is 3x: tight enough to fail the quadratic curve, loose
    // enough to survive a loaded machine.
    const small = ms(() => tryParse(generatedModule(10), 'small.js'));
    const large = ms(() => tryParse(generatedModule(20), 'large.js'));
    expect(large / small).toBeLessThan(3);
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
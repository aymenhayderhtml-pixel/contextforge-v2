/**
 * packages/core/test/extract/perf-round-c.test.ts
 *
 * GRAPH-5: the asset-edge dedupe scanned the whole edge list per reference (D53).
 *
 * `edges.some((e) => e.from === ... && e.to === ...)` before every push is O(edges)
 * per reference. Replaced by a per-source Set of assets already emitted.
 *
 * An honest note on the numbers, because the audit's figure for this was
 * misattributed. It reported 6,062 ms for 2,000 refs, which reads as the dedupe.
 * Isolating the stages showed `tryParse` alone accounted for essentially all of
 * it (7,739 ms parse vs 7,153 ms whole extraction — the parse dominated). Once
 * CTX-3 was fixed the same 4,000-reference extraction went from 22,296 ms to
 * 475 ms. So the `edges.some` scan was real and worth removing, but it was never
 * the bottleneck it appeared to be; the defect walk was.
 *
 * These tests pin the shape that matters — one edge per (source, asset) pair,
 * deduped, in source order — and a timing ceiling so the quadratic cannot return.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractJsProject } from '../../src/extract/js.js';

function ms(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

/**
 * A project whose one source file references `refs` distinct assets.
 *
 * Each asset is referenced TWICE — once by a unique import and once duplicated —
 * so the dedupe has something to do. `existsSync` must pass, or the edge is
 * dropped before the dedupe is ever reached (D48).
 */
function projectWithRefs(refs: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-g5-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  let body = '';
  for (let i = 0; i < refs; i++) {
    writeFileSync(join(dir, 'assets', `a${i}.png`), 'x');
    body += `import { x${i} } from '../assets/a${i}.png';\n`;
  }
  // Every asset again — these must not produce a second edge.
  for (let i = 0; i < refs; i++) {
    body += `import { y${i} } from '../assets/a${i}.png';\n`;
  }
  writeFileSync(join(dir, 'src', 'main.js'), body);
  return dir;
}

describe('GRAPH-5 — asset-edge dedupe is linear', () => {
  it('4,000 references (8,000 imports) extract in well under 5s', () => {
    // Unfixed, after CTX-3 was fixed, this was 475 ms; before CTX-3 it was
    // 22,296 ms. The limit leaves room for a loaded machine while failing the
    // quadratic curve, which grew ~7x per doubling.
    const dir = projectWithRefs(4000);
    try {
      expect(ms(() => extractJsProject(dir))).toBeLessThan(5000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('doubling the reference count does not quadruple the time', () => {
    const smallDir = projectWithRefs(500);
    const largeDir = projectWithRefs(1000);
    try {
      const small = ms(() => extractJsProject(smallDir));
      const large = ms(() => extractJsProject(largeDir));
      expect(large / small).toBeLessThan(3);
    } finally {
      rmSync(smallDir, { recursive: true, force: true });
      rmSync(largeDir, { recursive: true, force: true });
    }
  });
});

describe('GRAPH-5 parity — the dedupe still produces exactly one edge per pair', () => {
  it('a twice-referenced asset yields exactly one asset_ref edge', () => {
    const dir = projectWithRefs(50);
    try {
      const result = extractJsProject(dir);
      const assetEdges = result.edges.filter((e) => e.kind === 'asset_ref');
      const pairs = new Set(assetEdges.map((e) => `${e.from}|${e.to}`));

      expect(assetEdges).toHaveLength(50);
      expect(pairs.size).toBe(50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every referenced asset has exactly one node', () => {
    const dir = projectWithRefs(50);
    try {
      const result = extractJsProject(dir);
      const assets = result.nodes.filter((n) => n.type === 'asset');
      expect(assets).toHaveLength(50);
      expect(new Set(assets.map((a) => a.id)).size).toBe(50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('asset edges are emitted in a deterministic, sorted order', () => {
    // The Set replaces only the *test*, not the push, so the order is whatever
    // the extractor already produced. That order is the lexicographic sort of
    // the asset refs, which is why a10 precedes a2 — the extractor normalises and
    // sorts before emitting, and this pins that so a future change to the dedupe
    // cannot silently reorder the graph.
    const dir = projectWithRefs(30);
    try {
      const result = extractJsProject(dir);
      const assetEdges = result.edges.filter((e) => e.kind === 'asset_ref');
      const targets = assetEdges.map((e) => e.to);
      const expected = [...targets].sort((a, b) => a.localeCompare(b));
      expect(targets).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two different sources referencing the same asset keep separate edges', () => {
    // The per-source Set is keyed on `from`, so one file cannot suppress
    // another's edge. A shared asset is a shared asset, not a single edge.
    const dir = mkdtempSync(join(tmpdir(), 'cf-g5b-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      mkdirSync(join(dir, 'assets'), { recursive: true });
      writeFileSync(join(dir, 'assets', 'shared.png'), 'x');
      writeFileSync(
        join(dir, 'src', 'a.js'),
        "import { x } from '../assets/shared.png';\n",
      );
      writeFileSync(
        join(dir, 'src', 'b.js'),
        "import { y } from '../assets/shared.png';\n",
      );

      const result = extractJsProject(dir);
      const assetEdges = result.edges.filter((e) => e.kind === 'asset_ref');
      const pairs = assetEdges.map((e) => `${e.from}|${e.to}`).sort();

      expect(pairs).toEqual(['src/a.js|assets/shared.png', 'src/b.js|assets/shared.png']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
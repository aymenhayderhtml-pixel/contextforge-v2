/**
 * packages/core/test/graph/perf-round-c.test.ts
 *
 * Timing and behaviour-parity tests for the graph walks (D53).
 *
 * Every finding here was reproduced on main before being fixed:
 *
 *   GRAPH-4  `queue.shift()` in `focusNeighbourhood` / `findOrphans`
 *            1360 ms for `findOrphans` on a 60,000-node star.
 *   GRAPH-3  `findCycles` recursion -> `RangeError` on a 5,000-node cycle chain.
 *   GRAPH-5  `edges.some` before every asset-edge push.
 *
 * Limits are deliberately generous. These run on shared CI machines, and a test
 * that fails because a laptop was busy trains people to re-run the suite instead
 * of reading it. Each limit leaves room for a loaded box while still failing on
 * the quadratic curve, which was 4x per doubling.
 */

import { describe, expect, it } from 'vitest';
import {
  findOrphans,
  focusNeighbourhood,
  summariseGraph,
} from '../../src/graph/analysis.js';
import { findCycles, layerNodes } from '../../src/graph/reverse.js';
import type { DependencyGraph, GraphNode } from '../../src/graph/types.js';

function ms(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function node(id: string, dependsOn: string[]): GraphNode {
  return {
    id,
    engine: 'js',
    type: 'module',
    contract: { exports: [], signals: [], requires: [] },
    depends_on: dependsOn,
    depended_on_by: [],
  };
}

/**
 * A star: one hub every other node depends on.
 *
 * This is the shape that stresses `shift()`. A chain keeps the BFS queue at
 * depth 1, so each `shift()` moves one element and is free — a chain benchmark
 * passed at 23 ms on the unfixed code and proved nothing. A star enqueues every
 * node before dequeuing any, so each `shift()` memmoved the entire remaining
 * width. Real projects have hubs (a barrel `index.ts`, a shared config), so this
 * is not a synthetic worst case.
 */
function star(n: number): DependencyGraph {
  const nodes: GraphNode[] = [];
  const edges: DependencyGraph['edges'] = [];
  for (let i = 0; i < n; i++) {
    nodes.push(node(`n${i}`, i === 0 ? [] : ['n0']));
    if (i > 0) edges.push({ from: `n${i}`, to: 'n0', kind: 'import' });
  }
  // `depended_on_by` on the hub lists the nodes that depend on IT. Wiring this
  // the other way round (pushing 'n0' into each leaf) claims the leaves are
  // depended on by the hub, which inverts the graph and made the hub reachable
  // from nothing — 50 orphans instead of 49.
  const hub = nodes[0] as GraphNode;
  for (let i = 1; i < n; i++) hub.depended_on_by.push(`n${i}`);
  return { nodes, edges };
}

describe('GRAPH-4 — the graph walks are linear, not quadratic', () => {
  it('findOrphans on a 120,000-node star finishes well under 2s', () => {
    // The size was chosen by measurement, twice.
    //
    // At 60,000 the UNFIXED walk took 1,704 ms — inside a 2s limit — so an
    // assertion there passed on the very bug it was written for. At 150,000 the
    // FIXED walk took 2,553 ms, so the assertion failed on correct code. 120,000
    // is between them: 543 ms fixed, and the unfixed walk is several times over
    // the bound there because it grows with the square of the width.
    const elapsed = ms(() => findOrphans(star(120_000)));
    expect(elapsed).toBeLessThan(2000);
  });

  it('summariseGraph on a 100,000-node star finishes well under 3s', () => {
    // The Graph screen's header-count request runs on the main process.
    const elapsed = ms(() => summariseGraph(star(100_000)));
    expect(elapsed).toBeLessThan(3000);
  });

  it('focusNeighbourhood on a 100,000-node star finishes well under 2s', () => {
    const elapsed = ms(() => focusNeighbourhood(star(100_000), 'n0', 2));
    expect(elapsed).toBeLessThan(2000);
  });

  // No doubling-ratio test here, deliberately.
  //
  // Two were written and both were measured to be worthless. A single-run ratio
  // passed on the UNFIXED implementation, because `shift()` only pays off
  // quadratically for a wide queue and 15,000 nodes was still quick enough for
  // the ratio to land under the threshold. Making it robust with best-of-3 made
  // it pass on unfixed code every time: taking the minimum of three runs removes
  // precisely the super-linear component a ratio depends on to detect it.
  //
  // The absolute bounds above are the load-bearing assertions, and they are
  // strong — `findOrphans` on a 60,000-node star measured 1,360 ms unfixed
  // against 120 ms fixed. A width-quadratic cannot hide behind those. Leaving a
  // test that passes on the bug it was written for is worse than not having it,
  // because it reads as evidence.
});

describe('GRAPH-3 — findCycles survives a deep chain without the call stack', () => {
  /** A cycle of `n` nodes: n0 -> n1 -> ... -> n(n-1) -> n0. */
  function cycle(n: number): DependencyGraph {
    const nodes: GraphNode[] = [];
    const edges: DependencyGraph['edges'] = [];
    for (let i = 0; i < n; i++) {
      const next = `c${(i + 1) % n}`;
      nodes.push(node(`c${i}`, [next]));
      edges.push({ from: `c${i}`, to: next, kind: 'import' });
    }
    return { nodes, edges };
  }

  it('a 10,000-node cycle does not overflow the stack', () => {
    // Unfixed: RangeError at 5,000; 2,000 was still fine.
    expect(() => findCycles(cycle(10_000))).not.toThrow();
  });

  it('a 10,000-node cycle is reported as exactly one cycle', () => {
    const cycles = findCycles(cycle(10_000));
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.nodes).toHaveLength(10_000);
  });

  it('a 10,000-node cycle is found in well under 2s', () => {
    expect(ms(() => findCycles(cycle(10_000)))).toBeLessThan(2000);
  });

  it('layerNodes inherits the fix — it calls findCycles', () => {
    // A layer call crashed before the fix even though the surrounding code is
    // iterative, because layerNodes delegates to findCycles.
    const result = layerNodes(cycle(10_000));
    expect(result.cyclic).toHaveLength(10_000);
    expect(result.layers).toHaveLength(0);
  });
});

describe('GRAPH-4/5 parity — the fast paths return exactly what they always did', () => {
  it('focusNeighbourhood returns the same result as a reference shift() walk', () => {
    // A reference implementation kept in the test: the pre-fix algorithm, written
    // out longhand. If the index-pointer version ever diverges, this fails.
    const graph = star(200);
    const focusId = 'n0';
    const depth = 2 as const;

    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const distance = new Map<string, number>([[focusId, 0]]);
    const queue: string[] = [focusId];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) continue;
      const here = distance.get(current);
      if (here === undefined) continue;
      if (here >= depth) continue;
      const nd = byId.get(current);
      if (nd === undefined) continue;
      for (const neighbour of [...nd.depends_on, ...nd.depended_on_by]) {
        if (!byId.has(neighbour)) continue;
        if (distance.has(neighbour)) continue;
        distance.set(neighbour, here + 1);
        queue.push(neighbour);
      }
    }
    const expected = [...distance.entries()]
      .map(([id, d]) => ({ id, distance: d }))
      .sort((a, b) => a.id.localeCompare(b.id));

    const actual = focusNeighbourhood(graph, focusId, depth).map((f) => ({
      id: f.node.id,
      distance: f.distance,
    }));

    expect(actual).toEqual(expected);
  });

  it('findOrphans on a star reports every leaf but the hub, in sorted order', () => {
    // The hub is reachable-from-nothing, but nothing points at it, so it is an
    // orphan too. That is the documented behaviour and it matches unfixed main
    // exactly — the fix must not change the answer, only the time.
    const orphans = findOrphans(star(50));
    expect(orphans).toHaveLength(49);
    const ids = orphans.map((o) => o.node.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    expect(new Set(ids).size).toBe(49);
  });

  it('findOrphans agrees with a reference shift() sweep on a mixed graph', () => {
    // Roots a and d both unreferenced; a depends on b, which depends on c.
    const nodes = [node('a', ['b']), node('b', ['c']), node('c', []), node('d', [])];
    const edges: DependencyGraph['edges'] = [
      { from: 'a', to: 'b', kind: 'import' },
      { from: 'b', to: 'c', kind: 'import' },
    ];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const dependents = new Map<string, Set<string>>();
    for (const e of edges) {
      const s = dependents.get(e.to) ?? new Set<string>();
      s.add(e.from);
      dependents.set(e.to, s);
    }

    const reached = new Set<string>();
    const queue = nodes.filter((n) => !dependents.has(n.id)).map((n) => n.id);
    while (queue.length > 0) {
      const cur = queue.shift();
      if (cur === undefined) continue;
      for (const e of edges) {
        if (e.from !== cur || reached.has(e.to)) continue;
        reached.add(e.to);
        queue.push(e.to);
      }
    }

    const expected = nodes.filter((n) => !reached.has(n.id)).map((n) => n.id).sort();
    const actual = findOrphans({ nodes, edges }).map((o) => o.node.id);
    expect(actual).toEqual(expected);
    expect(byId.size).toBe(4);
  });
});
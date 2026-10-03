/**
 * packages/core/test/graph/analysis.test.ts
 *
 * Depth-bounded focus, neighbourhood edges, orphan detection and the summary
 * counts. Every one of these is pure arithmetic over a graph, so they are
 * tested here headlessly rather than through the DOM: the renderer turns the
 * result into a Cytoscape layout and does no counting of its own (D44).
 */

import { describe, expect, it } from 'vitest';
import {
  edgesWithin,
  findOrphans,
  focusNeighbourhood,
  summariseGraph,
  type OrphanReason,
} from '../../src/graph/analysis.js';
import type { DependencyGraph, GraphNode } from '../../src/graph/types.js';

/**
 * Build a graph from an adjacency shorthand, wiring `depended_on_by` the way
 * `withDependedOnBy` does, so these tests exercise the same shape the extractor
 * produces rather than a hand-written approximation of it.
 */
function graphOf(spec: Record<string, string[]>): DependencyGraph {
  const nodes: GraphNode[] = Object.keys(spec).map((id) => ({
    id,
    engine: 'js',
    type: 'module',
    contract: { exports: [], signals: [], requires: [] },
    depends_on: spec[id] ?? [],
    depended_on_by: [],
  }));

  for (const node of nodes) {
    for (const dep of node.depends_on) {
      const target = nodes.find((n) => n.id === dep);
      // A dependency on a path that is not in the graph is real: it is a
      // reference to a file the extractor did not resolve. It is kept on
      // `depends_on` and contributes no edge, which is the behaviour the focus
      // tests below pin.
      if (target) target.depended_on_by.push(node.id);
    }
  }

  const ids = new Set(nodes.map((n) => n.id));
  const edges = nodes.flatMap((n) =>
    n.depends_on
      .filter((d) => ids.has(d))
      .map((d) => ({ from: n.id, to: d, kind: 'import' as const })),
  );

  return { nodes, edges };
}

describe('focusNeighbourhood', () => {
  //  a → b → c → d
  const chain = graphOf({ a: ['b'], b: ['c'], c: ['d'], d: [] });

  it('includes the focus itself at distance 0', () => {
    // `depth` is `1 | 2` by type, so the smallest legal neighbourhood is the
    // focus plus its direct neighbours; there is no depth-0 mode. Results are
    // sorted by id for determinism, so the focus is looked up rather than
    // assumed to be first.
    const result = focusNeighbourhood(chain, 'b', 1);
    expect(result.find((r) => r.node.id === 'b')?.distance).toBe(0);
    expect(result).toHaveLength(3);
  });

  it('depth 1 is the focus and its direct neighbours, both directions', () => {
    const result = focusNeighbourhood(chain, 'b', 1);
    expect(result.map((r) => r.node.id)).toEqual(['a', 'b', 'c']);
    expect(Object.fromEntries(result.map((r) => [r.node.id, r.distance]))).toEqual({
      a: 1,
      b: 0,
      c: 1,
    });
  });

  it('depth 2 reaches one hop further', () => {
    const result = focusNeighbourhood(chain, 'b', 2);
    // `d` is two from `b` via `c`; `a` is already at 1 and stays there.
    expect(result.map((r) => r.node.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.find((r) => r.node.id === 'd')?.distance).toBe(2);
  });

  it('does not stop at the depth boundary', () => {
    // Depth 1 from `a` must not leak `c`, which is two hops away.
    expect(focusNeighbourhood(chain, 'a', 1).map((r) => r.node.id)).toEqual(['a', 'b']);
  });

  it('keeps the smallest distance when a node is reachable twice', () => {
    // b → c directly, and b → d → a → c. `c` is reachable at distance 1 and 3,
    // and must report 1: the breadth-first walk reaches it first on the direct
    // edge and never overwrites a distance it already has.
    const diamond = graphOf({ a: ['c'], b: ['c', 'd'], c: [], d: ['a'] });
    const result = focusNeighbourhood(diamond, 'b', 2);
    expect(result.find((r) => r.node.id === 'c')?.distance).toBe(1);
    // `a` is only reachable through `d`, so it lands at the depth-2 boundary.
    expect(result.find((r) => r.node.id === 'a')?.distance).toBe(2);
    expect(result.map((r) => r.node.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('survives a cycle without looping forever', () => {
    const cyclic = graphOf({ a: ['b'], b: ['c'], c: ['a'] });
    expect(focusNeighbourhood(cyclic, 'a', 2).map((r) => r.node.id)).toEqual(['a', 'b', 'c']);
  });

  it('ignores a dependency that resolves to no node', () => {
    // `b` imports `ghost`, which the extractor found referenced but not present.
    // It has no position on screen, so counting it would inflate the badge.
    const dangling = graphOf({ a: ['ghost'], b: [] });
    expect(focusNeighbourhood(dangling, 'a', 2).map((r) => r.node.id)).toEqual(['a']);
  });

  it('returns nothing for an id that is not in the graph', () => {
    expect(focusNeighbourhood(chain, 'nope', 2)).toEqual([]);
  });

  it('is deterministic across runs', () => {
    const first = focusNeighbourhood(chain, 'b', 2).map((r) => r.node.id);
    const second = focusNeighbourhood(chain, 'b', 2).map((r) => r.node.id);
    expect(first).toEqual(second);
  });

  it('returns only the focus for an isolated node', () => {
    const alone = graphOf({ solo: [], other: [] });
    expect(focusNeighbourhood(alone, 'solo', 2).map((r) => r.node.id)).toEqual(['solo']);
  });
});

describe('edgesWithin', () => {
  const chain = graphOf({ a: ['b'], b: ['c'], c: ['d'], d: [] });

  it('drops any edge leaving the neighbourhood', () => {
    // Depth 1 around `b` is {a,b,c}. The edge c→d leaves it and must not draw,
    // or it points at a node that is not on screen.
    const ids = new Set(['a', 'b', 'c']);
    const edges = edgesWithin(chain, ids);
    expect(edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(['a->b', 'b->c']);
  });

  it('returns nothing when only one endpoint is present', () => {
    expect(edgesWithin(chain, new Set(['a']))).toEqual([]);
  });
});

describe('findOrphans', () => {
  it('flags a file nothing imports', () => {
    const g = graphOf({ used: ['leaf'], leaf: [] });
    const orphans = findOrphans(g);
    expect(orphans.map((o) => o.node.id)).toEqual(['used']);
    // It is an entry point: it imports something, which usually means a
    // top-level file the extractor cannot see an importer for.
    expect(orphans[0]?.reason).toBe<OrphanReason>('entry_point');
    expect(orphans[0]?.dependsOn).toEqual(['leaf']);
  });

  it('does not flag a file something imports', () => {
    const g = graphOf({ a: ['b'], b: ['c'], c: [] });
    expect(findOrphans(g).map((o) => o.node.id)).toEqual(['a']);
  });

  it('distinguishes a dead leaf from an entry point', () => {
    // `leaf` imports nothing and nothing imports it: genuinely dead.
    const g = graphOf({ a: ['b'], b: [], dead: [] });
    const byId = new Map(findOrphans(g).map((o) => [o.node.id, o]));
    expect(byId.get('dead')?.reason).toBe<OrphanReason>('unreferenced');
    expect(byId.get('a')?.reason).toBe<OrphanReason>('entry_point');
  });

  it('calls an unreferenced asset out as an asset, not dead code', () => {
    const g: DependencyGraph = {
      nodes: [
        {
          id: 'main.ts',
          engine: 'js',
          type: 'module',
          contract: { exports: [], signals: [], requires: [] },
          depends_on: [],
          depended_on_by: [],
        },
        {
          id: 'hero.glb',
          engine: 'js',
          type: 'asset',
          contract: { exports: [], signals: [], requires: [] },
          depends_on: [],
          depended_on_by: [],
        },
      ],
      edges: [],
    };
    const [orphan] = findOrphans(g);
    // Sorted by id, so the GLB comes first. It gets its own reason so the
    // drawer can say what kind of thing it is rather than just "orphan".
    expect(orphan?.node.id).toBe('hero.glb');
    expect(orphan?.reason).toBe<OrphanReason>('unreferenced_asset');

    // main.ts imports nothing and nothing imports it: an entry point, not dead
    // code.
    expect(findOrphans(g).map((o) => o.node.id)).toEqual(['hero.glb', 'main.ts']);
    expect(findOrphans(g).find((o) => o.node.id === 'main.ts')?.reason).toBe<OrphanReason>(
      'unreferenced',
    );
  });

  it('treats a cycle of orphans as orphans', () => {
    // Every member has a dependent, so a naive `depended_on_by.length === 0`
    // check would report none of them. Nothing outside references the cycle.
    const g = graphOf({ a: ['b'], b: ['a'] });
    expect(findOrphans(g).map((o) => o.node.id)).toEqual(['a', 'b']);
  });

  it('does not flag a node reachable from a referenced node', () => {
    // a → b → c, and `main` → a. `c` has a dependent, and `b` does too.
    const g = graphOf({ main: ['a'], a: ['b'], b: ['c'], c: [] });
    expect(findOrphans(g).map((o) => o.node.id)).toEqual(['main']);
  });

  it('is deterministic and returns nothing for an empty graph', () => {
    expect(findOrphans({ nodes: [], edges: [] })).toEqual([]);
    const g = graphOf({ z: [], a: [], m: ['x'], x: [] });
    const first = findOrphans(g).map((o) => o.node.id);
    const second = findOrphans(g).map((o) => o.node.id);
    expect(first).toEqual(second);
    expect(first).toEqual(['a', 'm', 'z']);
  });
});

describe('summariseGraph', () => {
  it('counts nodes, edges and orphans, and never derives a rival count', () => {
    const g = graphOf({ main: ['a'], a: ['b'], b: [], orphan: [] });
    const s = summariseGraph(g);
    expect(s.nodes).toBe(4);
    expect(s.edges).toBe(2);
    // `main` and `orphan` are unreferenced; `a` and `b` are reached.
    expect(s.orphans).toBe(2);
    expect(s.byType['module']).toBe(4);
    expect(s.byEdgeKind['import']).toBe(2);
  });

  it('is defined for an empty graph rather than throwing', () => {
    const s = summariseGraph({ nodes: [], edges: [] });
    expect(s).toEqual({ nodes: 0, edges: 0, orphans: 0, byType: {}, byEdgeKind: {} });
  });
});

describe('a 1000-file graph stays fast enough to draw', () => {
  // Phase 5e. Extraction is the slow part, but focus and orphan detection run on
  // every selection, so they must not be quadratic. The threshold is loose on
  // purpose — it is there to catch an accidental O(n^2), not to benchmark.
  function bigChain(count: number): DependencyGraph {
    const spec: Record<string, string[]> = {};
    for (let i = 0; i < count; i++) {
      spec[`f${i}.ts`] = i + 1 < count ? [`f${i + 1}.ts`] : [];
    }
    return graphOf(spec);
  }

  it('focuses on a 1000-node graph in well under a second', () => {
    const g = bigChain(1000);
    const started = process.hrtime.bigint();
    const result = focusNeighbourhood(g, 'f500.ts', 2);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    expect(result).toHaveLength(5); // focus + 2 each way
    expect(ms, `focus took ${ms.toFixed(1)}ms`).toBeLessThan(1000);
  });

  it('finds orphans in a 1000-node graph in well under a second', () => {
    const g = bigChain(1000);
    const started = process.hrtime.bigint();
    const orphans = findOrphans(g);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    // Only the head of the chain is unreferenced; the tail is reachable from it.
    expect(orphans.map((o) => o.node.id)).toEqual(['f0.ts']);
    expect(ms, `findOrphans took ${ms.toFixed(1)}ms`).toBeLessThan(1000);
  });
});
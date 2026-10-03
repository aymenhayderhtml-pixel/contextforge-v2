import { describe, expect, it } from 'vitest';
import {
  danglingEdges,
  dependentsOf,
  findCycles,
  layerNodes,
  normalizeDeps,
  reachableFrom,
  sortGraph,
  withDependedOnBy,
} from '../../src/graph/reverse.js';
import type { DependencyGraph, GraphEdge, GraphNode } from '../../src/graph/types.js';

const node = (id: string, dependsOn: string[] = []): GraphNode => ({
  id,
  engine: 'js',
  type: 'module',
  contract: { exports: [], signals: [], requires: [] },
  depends_on: dependsOn,
  depended_on_by: [],
});

const graphOf = (nodes: GraphNode[]): DependencyGraph => {
  const edges: GraphEdge[] = nodes.flatMap((n) =>
    n.depends_on.map((to) => ({ from: n.id, to, kind: 'import' as const })),
  );
  return sortGraph(withDependedOnBy({ nodes, edges }));
};

describe('normalizeDeps', () => {
  it('deduplicates and sorts', () => {
    expect(normalizeDeps(['b', 'a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('withDependedOnBy', () => {
  it('fills the reverse edges from the edge set', () => {
    const graph = graphOf([node('a'), node('b', ['a'])]);
    expect(graph.nodes.find((n) => n.id === 'a')?.depended_on_by).toEqual(['b']);
    expect(graph.nodes.find((n) => n.id === 'b')?.depended_on_by).toEqual([]);
  });

  it('ignores an edge to a node that is not in the graph', () => {
    const graph = withDependedOnBy({
      nodes: [node('a')],
      edges: [{ from: 'a', to: 'ghost', kind: 'import' }],
    });
    expect(graph.nodes[0]?.depended_on_by).toEqual([]);
  });
});

describe('danglingEdges', () => {
  it('reports an edge whose endpoint is not a node', () => {
    const graph: DependencyGraph = {
      nodes: [node('a')],
      edges: [{ from: 'a', to: 'ghost', kind: 'import' }],
    };
    expect(danglingEdges(graph)).toEqual([
      { from: 'a', to: 'ghost', kind: 'import' },
    ]);
  });

  it('returns nothing when every edge resolves', () => {
    expect(danglingEdges(graphOf([node('a'), node('b', ['a'])]))).toEqual([]);
  });
});

describe('reachableFrom / dependentsOf', () => {
  const graph = graphOf([
    node('main', ['mid', 'leaf']),
    node('mid', ['leaf']),
    node('leaf'),
  ]);

  it('walks dependencies transitively', () => {
    expect([...reachableFrom(graph, 'main')].sort()).toEqual(['leaf', 'main', 'mid']);
  });

  it('walks dependents transitively and excludes the node itself', () => {
    expect([...dependentsOf(graph, 'leaf')].sort()).toEqual(['main', 'mid']);
  });

  it('does not loop forever on a cycle', () => {
    const cyclic = graphOf([node('a', ['b']), node('b', ['a'])]);
    expect([...reachableFrom(cyclic, 'a')].sort()).toEqual(['a', 'b']);
    expect([...dependentsOf(cyclic, 'a')].sort()).toEqual(['b']);
  });
});

describe('findCycles', () => {
  it('finds a two-node cycle', () => {
    const cycles = findCycles(graphOf([node('a', ['b']), node('b', ['a'])]));
    expect(cycles).toHaveLength(1);
    expect([...cycles[0]!.nodes].sort()).toEqual(['a', 'b']);
  });

  it('reports each cycle once, not once per member', () => {
    const cycles = findCycles(
      graphOf([node('a', ['b']), node('b', ['c']), node('c', ['a'])]),
    );
    expect(cycles).toHaveLength(1);
  });

  it('finds nothing in an acyclic graph', () => {
    expect(findCycles(graphOf([node('a', ['b']), node('b')]))).toEqual([]);
  });

  it('does not loop forever on a self-import', () => {
    const cycles = findCycles(graphOf([node('a', ['a'])]));
    expect(cycles).toHaveLength(1);
  });
});

describe('layerNodes', () => {
  it('puts a leaf in layer 0 and its dependents above it', () => {
    const { layers, cyclic } = layerNodes(
      graphOf([node('main', ['mid']), node('mid', ['leaf']), node('leaf')]),
    );
    expect(cyclic).toEqual([]);
    expect(layers).toEqual([['leaf'], ['mid'], ['main']]);
  });

  it('places independent nodes in the same layer', () => {
    const { layers } = layerNodes(graphOf([node('a'), node('b'), node('c', ['a'])]));
    expect(layers).toEqual([['a', 'b'], ['c']]);
  });

  it('reports cycle members as cyclic rather than dropping them', () => {
    const graph = graphOf([node('a', ['b']), node('b', ['a']), node('c')]);
    const { layers, cyclic } = layerNodes(graph);

    expect(layers.flat()).toEqual(['c']);
    expect(cyclic.sort()).toEqual(['a', 'b']);
  });

  it('reports everything downstream of a cycle as cyclic too', () => {
    // Nothing below a cycle can be ordered, so `c` must not be silently placed.
    const graph = graphOf([node('a', ['b']), node('b', ['a']), node('c', ['a'])]);
    const { layers, cyclic } = layerNodes(graph);

    expect(layers.flat()).toEqual([]);
    expect(cyclic.sort()).toEqual(['a', 'b', 'c']);
  });

  it('never loses a node: layered + cyclic always equals the node count', () => {
    const graphs: DependencyGraph[] = [
      graphOf([node('a', ['b']), node('b', ['a']), node('c', ['a']), node('d')]),
      graphOf([node('a', ['a']), node('b')]),
      graphOf([node('a'), node('b', ['a'])]),
      graphOf([]),
    ];

    for (const graph of graphs) {
      const { layers, cyclic } = layerNodes(graph);
      expect(layers.flat().length + cyclic.length, JSON.stringify(graph.nodes.map((n) => n.id)))
        .toBe(graph.nodes.length);
    }
  });

  it('ignores a dependency on a node outside the graph when layering', () => {
    const graph: DependencyGraph = {
      nodes: [node('a', ['ghost'])],
      edges: [{ from: 'a', to: 'ghost', kind: 'import' }],
    };
    const { layers, cyclic } = layerNodes(graph);
    expect(layers).toEqual([['a']]);
    expect(cyclic).toEqual([]);
  });
});

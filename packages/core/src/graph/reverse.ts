/**
 * graph/reverse.ts — Derived graph properties.
 *
 * `depended_on_by` is the reason this file exists: a parser can see what a file
 * imports but never what imports it. Those reverse edges must be computed from
 * the complete edge set, and they are what lets the context compiler warn an AI
 * "changing this will affect these six files".
 */

import type { DependencyGraph, GraphEdge, GraphNode } from './types.js';

/** Sort nodes and edges into the canonical deterministic order (SPEC R8). */
export function sortGraph(graph: DependencyGraph): DependencyGraph {
  const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...graph.edges].sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      a.kind.localeCompare(b.kind),
  );
  return { nodes, edges };
}

/** Deduplicate and sort a dependency id list. */
export function normalizeDeps(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/**
 * Fill in `depended_on_by` on every node from the edge list.
 *
 * Accepts nodes that have not set the field (extractors never do — see
 * types.ts) and fills it in. Unknown edge endpoints are ignored rather than
 * throwing, because an asset edge may point at a file that was deleted since the
 * last extraction; a graph with a dangling edge is still useful, and the missing
 * target is reported by `danglingEdges` instead.
 */
export function withDependedOnBy(graph: DependencyGraph): DependencyGraph {
  const reverse = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const set = reverse.get(edge.to) ?? new Set<string>();
    set.add(edge.from);
    reverse.set(edge.to, set);
  }

  const nodes: GraphNode[] = graph.nodes.map((node) => ({
    ...node,
    depended_on_by: normalizeDeps(reverse.get(node.id) ?? []),
  }));

  return sortGraph({ nodes, edges: graph.edges });
}

/**
 * Edges whose endpoints are not nodes in the graph.
 *
 * Returned rather than thrown: it is diagnostic output for the Project screen,
 * and a project mid-edit legitimately has a dangling reference.
 */
export function danglingEdges(graph: DependencyGraph): GraphEdge[] {
  const ids = new Set(graph.nodes.map((n) => n.id));
  return graph.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
}

/** Node ids reachable from `startId` by following dependency edges. */
export function reachableFrom(graph: DependencyGraph, startId: string): Set<string> {
  const byId = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const queue = [startId];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const node = byId.get(current);
    if (!node) continue;
    for (const dep of node.depends_on) {
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return seen;
}

/** Node ids that can reach `targetId` by following dependency edges. */
export function dependentsOf(graph: DependencyGraph, targetId: string): Set<string> {
  const byId = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const queue = [targetId];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const node = byId.get(current);
    if (!node) continue;
    for (const dependent of node.depended_on_by) {
      if (!seen.has(dependent)) queue.push(dependent);
    }
  }
  seen.delete(targetId);
  return seen;
}

/** A dependency cycle, as node ids in traversal order. */
export interface DependencyCycle {
  nodes: string[];
}

/**
 * Find every dependency cycle in the graph.
 *
 * A cycle in an import graph is a hard error in every runtime, and an AI that
 * is handed a cyclic graph will happily "fix" it by creating another one. This
 * is reported rather than silently tolerated.
 */
export function findCycles(graph: DependencyGraph): DependencyCycle[] {
  const byId = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
  const cycles: DependencyCycle[] = [];
  const seenCycleKeys = new Set<string>();
  const done = new Set<string>();
  const path: string[] = [];
  const onPath = new Set<string>();

  /**
   * One explicit stack frame per level of recursion.
   *
   * This used to be a recursive `visit`, which meant the JS call stack WAS the
   * path stack: a 5,000-node cycle chain threw `RangeError: Maximum call stack
   * size exceeded` while 2,000 was fine, and `layerNodes` calls `findCycles`, so
   * it inherited the crash. SPEC R9 wants a loud refusal, not a stack overflow
   * (D53).
   *
   * The frame carries the node's dependencies and how far through them the walk
   * is, so the loop resumes exactly where the recursive call would have. Visit
   * order is therefore IDENTICAL to the recursive version — same depth-first,
   * same left-to-right within a node, same `path` contents when a back edge is
   * found — which is what keeps the emitted `nodes` arrays byte-identical.
   */
  interface Frame {
    id: string;
    deps: readonly string[];
    index: number;
  }

  for (const node of graph.nodes) {
    if (done.has(node.id)) continue;

    path.push(node.id);
    onPath.add(node.id);
    const stack: Frame[] = [{ id: node.id, deps: byId.get(node.id)?.depends_on ?? [], index: 0 }];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;

      if (frame.index >= frame.deps.length) {
        // This node's dependencies are exhausted: pop it, exactly as the
        // recursive version did on return.
        stack.pop();
        path.pop();
        onPath.delete(frame.id);
        done.add(frame.id);
        continue;
      }

      const dep = frame.deps[frame.index++] as string;
      if (onPath.has(dep)) {
        const start = path.indexOf(dep);
        const cycle = path.slice(start);
        const key = [...cycle].sort().join('|');
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          cycles.push({ nodes: cycle });
        }
      } else if (!done.has(dep)) {
        path.push(dep);
        onPath.add(dep);
        stack.push({ id: dep, deps: byId.get(dep)?.depends_on ?? [], index: 0 });
      }
    }
  }

  return cycles;
}

/**
 * Group nodes into dependency layers.
 *
 * Layer 0 has no dependencies; layer N depends only on nodes in layers < N.
 *
 * A node that is part of a cycle has no honest layer, and a node that depends on
 * one inherits that problem transitively — nothing downstream of a cycle can be
 * ordered either. Both are reported in `cyclic` rather than dropped, so
 * `layers.flat().length + cyclic.length` always equals the node count. Losing a
 * node here would silently hide it from the build order the Context screen shows.
 */
export function layerNodes(graph: DependencyGraph): {
  layers: string[][];
  cyclic: string[];
} {
  const { nodes } = graph;
  const byId = new Map<string, GraphNode>(nodes.map((n) => [n.id, n]));

  // Nodes on a cycle, plus everything that transitively depends on them.
  const blocked = new Set<string>(findCycles(graph).flatMap((c) => c.nodes));

  const layerOf = new Map<string, number>();
  let changed = true;
  // Bounded by the node count: each round either places at least one node or
  // the remainder are all blocked, so the loop cannot run away.
  let guard = 0;

  while (changed && guard <= nodes.length) {
    changed = false;
    guard += 1;

    for (const node of nodes) {
      if (layerOf.has(node.id) || blocked.has(node.id)) continue;

      const deps = node.depends_on.filter((d) => byId.has(d));

      if (deps.some((d) => blocked.has(d))) {
        blocked.add(node.id);
        changed = true;
        continue;
      }

      if (deps.every((d) => layerOf.has(d))) {
        const layer = deps.reduce((max, d) => Math.max(max, layerOf.get(d) ?? 0), -1) + 1;
        layerOf.set(node.id, layer);
        changed = true;
      }
    }
  }

  // Anything neither placed nor blocked (an unexpected terminal state) is
  // reported rather than dropped.
  for (const node of nodes) {
    if (!layerOf.has(node.id)) blocked.add(node.id);
  }

  const maxLayer = layerOf.size === 0 ? -1 : Math.max(...layerOf.values());
  const layers: string[][] =
    maxLayer < 0 ? [] : Array.from({ length: maxLayer + 1 }, () => []);

  for (const [id, layer] of layerOf) {
    layers[layer]?.push(id);
  }
  for (const layer of layers) layer.sort((a, b) => a.localeCompare(b));

  return {
    layers,
    cyclic: [...blocked].sort((a, b) => a.localeCompare(b)),
  };
}

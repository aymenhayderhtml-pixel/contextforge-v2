/**
 * graph/analysis.ts — Depth-bounded neighbourhood and orphan detection.
 *
 * This is the analysis the Graph screen draws. It lives in core rather than in
 * the screen because it is pure arithmetic over a `DependencyGraph`: it needs no
 * DOM, no layout engine and no Cytoscape, so it can be tested headlessly. The
 * renderer turns the result into nodes, edges and a layout, and does no counting
 * of its own — a count computed in two places is the defect D44 just removed
 * from the Problems panel, and the same rule applies here.
 *
 * `reverse.ts` already provides unbounded `reachableFrom` and `dependentsOf`.
 * Neither can answer "and what does *that* depend on, to depth 2", so the
 * depth-bounded walk lives here rather than as a third variant beside them.
 */

import type { DependencyGraph, GraphNode } from './types.js';

/** How far from the focused node to walk. */
export type FocusDepth = 1 | 2;

/** One node in a neighbourhood, with how far from the focus it sits. */
export interface FocusedNode {
  node: GraphNode;
  /** 0 for the focus itself, 1 for its neighbours, 2 for theirs. */
  distance: number;
}

/**
 * Every node within `depth` of `focusId`, following edges in **both**
 * directions, with its distance.
 *
 * Both directions, not just dependencies: "what does this file touch" is a
 * question about a neighbourhood, and a developer editing `kart.ts` needs to
 * see both the thing it imports and the two karts that import it. A
 * dependency-only walk would answer a different question than the one asked.
 *
 * The focus itself is included at distance 0 so a caller can render the whole
 * neighbourhood without special-casing it.
 *
 * A node reachable by more than one path keeps the *smallest* distance. A file
 * two hops away that is also a direct neighbour is a direct neighbour, and
 * reporting it as distance 2 would push it a ring further out for no reason.
 */
export function focusNeighbourhood(
  graph: DependencyGraph,
  focusId: string,
  depth: FocusDepth,
): FocusedNode[] {
  const byId = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
  const focus = byId.get(focusId);
  if (focus === undefined) return [];

  const distance = new Map<string, number>([[focusId, 0]]);
  // A plain FIFO queue: breadth-first, so the first time a node is reached it
  // has been reached by the shortest path and never needs revisiting.
  const queue: string[] = [focusId];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    const here = distance.get(current);
    if (here === undefined) continue;
    // A node at the boundary is *kept* but not *expanded*. Dropping the
    // expansion is what stops the walk at `depth`; keeping the node is what
    // makes depth 1 mean "the focus and its neighbours" rather than "the focus".
    if (here >= depth) continue;

    const node = byId.get(current);
    if (node === undefined) continue;

    for (const neighbour of [...node.depends_on, ...node.depended_on_by]) {
      // Only real nodes. `depends_on` is parsed from source and may name a path
      // that resolves to nothing; an edge to a node that does not exist has no
      // position on screen and must not inflate the count.
      if (!byId.has(neighbour)) continue;
      if (distance.has(neighbour)) continue;
      distance.set(neighbour, here + 1);
      queue.push(neighbour);
    }
  }

  return [...distance.entries()]
    .map(([id, d]) => ({ node: byId.get(id)!, distance: d }))
    // Sorted by id so the result is deterministic. Two runs over the same graph
    // must produce the same array, or the render test cannot compare it.
    .sort((a, b) => a.node.id.localeCompare(b.node.id));
}

/**
 * The edges entirely inside a neighbourhood.
 *
 * Only edges whose *both* endpoints are present are returned. An edge leaving
 * the neighbourhood would point at a node that is not drawn, which renders as a
 * line into empty space and reads as a bug in the graph.
 */
export function edgesWithin(
  graph: DependencyGraph,
  nodeIds: ReadonlySet<string>,
): { from: string; to: string; kind: string }[] {
  return graph.edges
    .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
    .map((e) => ({ from: e.from, to: e.to, kind: e.kind }));
}

/** Why a file is an orphan. */
export type OrphanReason =
  /** Nothing imports it and it imports nothing. */
  | 'unreferenced'
  /**
   * Nothing imports it, but it imports something — so it may be an entry point
   * the extractor simply cannot see (`main.ts`, a test, a CLI).
   */
  | 'entry_point'
  /** The project declares it, but no source file references it. */
  | 'unreferenced_asset';

/** One orphan, with the reason it was flagged. */
export interface Orphan {
  node: GraphNode;
  reason: OrphanReason;
  /** The ids it depends on, for `entry_point`. Empty for the others. */
  dependsOn: string[];
}

/**
 * Files nothing depends on.
 *
 * The reason matters more than the list. "Orphan" invites the reading "this is
 * dead code, delete it", which is wrong often enough to be dangerous: a game's
 * `main.ts` and `index.html` are unreferenced by anything *inside* the project
 * and are the two most important files in it. So every orphan states which of
 * the three situations it is in, and `entry_point` is reported separately from
 * the two that actually suggest dead code.
 *
 * A node also qualifies when it is only reachable from an orphan — but a cycle
 * of mutually-referencing orphans is entirely unreferenced, and its members
 * each have a dependent, so `depended_on_by` alone would miss it. `unreferenced`
 * therefore means "no dependent and no path from anything that has one".
 */
export function findOrphans(graph: DependencyGraph): Orphan[] {
  const byId = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));

  /**
   * Nodes something else points at, where the something else is itself
   * referenced. A plain "has a dependent" test would report a cycle of orphans
   * as referenced — each member is depended on by its cycle partner, but
   * nothing outside the cycle points into it, so no member is reachable from
   * anything real.
   *
   * Computed as a reachability sweep from the nodes with no resolvable
   * dependent, walking backwards. A node is an orphan exactly when that sweep
   * never reaches it.
   */
  const dependentsByNode = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.from === edge.to || !byId.has(edge.from)) continue;
    const set = dependentsByNode.get(edge.to) ?? new Set<string>();
    set.add(edge.from);
    dependentsByNode.set(edge.to, set);
  }
  // `depended_on_by` carries references that carry no edge, and ids that do not
  // resolve to a node are dropped: a reference from outside the graph cannot be
  // walked, and counting it would mark the target referenced for a reason the
  // developer can never see.
  for (const node of graph.nodes) {
    const set = dependentsByNode.get(node.id) ?? new Set<string>();
    for (const dependent of node.depended_on_by) {
      if (dependent !== node.id && byId.has(dependent)) set.add(dependent);
    }
    dependentsByNode.set(node.id, set);
  }

  /**
   * The same relation, inverted: for each node, the nodes it depends on. This is
   * what makes the sweep below linear. Iterating the map per popped node, which
   * is the obvious way to write it, is quadratic — 1,000 files means 1,000,000
   * set probes on every selection in the Graph screen.
   */
  const dependenciesByNode = new Map<string, Set<string>>();
  for (const [target, dependents] of dependentsByNode) {
    for (const dependent of dependents) {
      const set = dependenciesByNode.get(dependent) ?? new Set<string>();
      set.add(target);
      dependenciesByNode.set(dependent, set);
    }
  }

  /**
   * Roots: the files nothing else points at. Everything *they* import is
   * referenced, transitively; a file no root reaches is an orphan.
   *
   * The subtlety is that a root is itself a candidate orphan. `used.ts` that
   * imports `leaf.ts` and is imported by nothing is unreferenced — it is dead
   * code — even though it is also a root and seeds the sweep below. The two
   * facts are not in conflict: "nothing points at this" and "this points at
   * something" are different questions, and the second does not answer the
   * first.
   *
   * So the sweep is only used to decide reachability for *non-root* nodes. A
   * node with no incoming reference is never marked reached by this loop, and is
   * therefore always an orphan unless something else references it — which, by
   * definition, it has not.
   *
   * The direction is the other easy thing to get wrong. A leaf like `leaf.ts` is
   * imported by `used.ts` and depends on nothing; if roots were seeded from "no
   * dependencies" the sweep would run backwards and report every leaf's
   * *dependencies* as orphans instead of the leaves themselves.
   */
  const reached = new Set<string>();
  const queue: string[] = [];
  for (const node of graph.nodes) {
    const dependents = dependentsByNode.get(node.id);
    if (dependents !== undefined && dependents.size > 0) continue;
    // A root with no dependencies at all is an isolated file; it is still an
    // orphan, and the sweep starts from it only to mark what it reaches.
    queue.push(node.id);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    for (const target of dependenciesByNode.get(current) ?? []) {
      if (reached.has(target)) continue;
      reached.add(target);
      queue.push(target);
    }
  }

  const orphans: Orphan[] = [];
  for (const node of graph.nodes) {
    if (reached.has(node.id)) continue;
    const reason: OrphanReason =
      node.depends_on.length > 0
        ? 'entry_point'
        : node.type === 'asset'
          ? 'unreferenced_asset'
          : 'unreferenced';
    orphans.push({ node, reason, dependsOn: [...node.depends_on].sort() });
  }

  return orphans.sort((a, b) => a.node.id.localeCompare(b.node.id));
}

/** Counts the Graph screen's header shows, so it never derives its own. */
export interface GraphSummary {
  nodes: number;
  edges: number;
  orphans: number;
  /** Files per `type`, for the legend. */
  byType: Record<string, number>;
  /** Edges per `kind`, so an `asset_ref` can be told from an `import`. */
  byEdgeKind: Record<string, number>;
}

export function summariseGraph(graph: DependencyGraph): GraphSummary {
  const byType: Record<string, number> = {};
  for (const node of graph.nodes) {
    byType[node.type] = (byType[node.type] ?? 0) + 1;
  }
  const byEdgeKind: Record<string, number> = {};
  for (const edge of graph.edges) {
    byEdgeKind[edge.kind] = (byEdgeKind[edge.kind] ?? 0) + 1;
  }
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    orphans: findOrphans(graph).length,
    byType,
    byEdgeKind,
  };
}
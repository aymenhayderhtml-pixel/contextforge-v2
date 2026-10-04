/**
 * packages/app/src/renderer/graph/labels.ts
 *
 * The renderer's copy of core's label rule.
 *
 * ## Why there is a copy at all
 *
 * `@contextforge/core` is `external` in the Vite renderer build (see
 * `vite.config.ts`) because core imports `node:fs`, `node:path` and
 * tree-sitter, none of which exist in the renderer sandbox. Every other renderer
 * use of core is `import type`, erased at build time. A *value* import compiles
 * fine and then fails at runtime — that is how the whole app crashed the first
 * time the Graph screen landed, because the type imports had been assumed to be
 * the only kind.
 *
 * The established precedent for a mirrored function is
 * `renderer/viewport/rng.ts`. Duplicating a function is normally the thing this
 * repo refuses to do, so `packages/app/test/renderer/labels.test.ts` imports both
 * this file and core's and asserts they agree on every input — a change to one
 * that is not mirrored fails the suite.
 *
 * ## Why it is its own file rather than inside the Svelte component
 *
 * Because a `.svelte` file cannot be imported by a unit test: there is no jsdom
 * and no Svelte loader in the test run. The earlier version of this mirror lived
 * in `GraphScreen.svelte` and the test had to extract the function bodies as text
 * and strip their TypeScript annotations by hand — a stripper that was itself
 * three regexes and broke the moment the signature grew an inline object type.
 * A plain `.ts` file is importable, so the test needs no extraction at all.
 *
 * Nothing here touches runes or component state. It is a pure function over plain
 * data, which is what makes that possible.
 */

/**
 * Which vertical offset a label sits at.
 *
 * `0` is the normal position, `1` is the stagger below it. Only a *singled-out*
 * label ignores its lane, because it is on its own and staggering it next to a
 * neighbour would be meaningless.
 */
export type LabelLane = 0 | 1;

/**
 * Headroom a label needs beyond its own width before it is drawn beside a
 * neighbour: 1.25x. Mirrors core's `SAFETY`; see that file for the measurement
 * that set it.
 */
const SAFETY = 1.25;

export type LabelReason =
  | 'focus'
  | 'selection'
  | 'hover'
  | 'room'
  | 'staggered'
  | 'crowded';

export interface GraphLabel {
  nodeId: string;
  text: string;
  show: boolean;
  reason: LabelReason;
  lane: LabelLane;
}

export interface LabelInputs {
  /** Every node currently in the graph, in the order drawn. */
  nodes: readonly { id: string }[];
  /** `canvas width / nodes in the widest row`, in CSS pixels. */
  pixelsPerSlot: number;
  /**
   * Rendered width of **each node's own** basename, in CSS pixels.
   *
   * Per node rather than one width for the graph: see `core/src/graph/labels.ts`,
   * where a single widest-name measurement produced a graph with no labels on it
   * at all.
   */
  labelWidthPx: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
  focusId: string | null;
  selectedId: string | null;
  hoverId: string | null;
  /**
   * Each node's index within its own row.
   *
   * **Lanes come from this, not from the order labels are drawn in.** A drawn-order
   * counter desynchronises from the geometry as soon as any label is hidden, and a
   * row meant to alternate came out with 14 of 18 labels in lane 0 — every one of
   * them stacked. See `core/src/graph/labels.ts` for the full account.
   */
  rowIndex?: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
}

/**
 * The last path segment: `src/a/b.ts` -> `b.ts`.
 *
 * Not a trim-to-width heuristic. A truncated label is ambiguous — `src/kart.ts`
 * and `src/enemy/kart.ts` both truncate to something alike — where a basename
 * collides far more rarely and visibly.
 */
export function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/**
 * Read a per-node width, treating an unmeasured node as zero-width.
 *
 * A `Map` is accepted as well as a record because a `Map` is what a caller
 * naturally builds when measuring node by node, and a caller that has to convert
 * one into the other is a caller that gets it wrong. The two are told apart with
 * a `get` check rather than `instanceof`, because `ReadonlyMap` is not
 * `instanceof`-narrowable here and the union would not narrow.
 */
function widthFor(
  widths: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
  nodeId: string,
): number {
  const asMap = widths as ReadonlyMap<string, number>;
  if (typeof asMap.get === 'function') return asMap.get(nodeId) ?? 0;
  const asRecord = widths as Readonly<Record<string, number>>;
  return asRecord[nodeId] ?? 0;
}

/** Read a node's index within its row, from either accepted shape. */
function indexIn(
  rowIndex: LabelInputs['rowIndex'],
  nodeId: string,
): number | undefined {
  // `undefined` is a real case, not an error: the caller has no geometry and the
  // caller falls back to node order.
  if (rowIndex === undefined) return undefined;
  if (typeof (rowIndex as ReadonlyMap<string, number>).get === 'function') {
    return (rowIndex as ReadonlyMap<string, number>).get(nodeId);
  }
  return (rowIndex as Readonly<Record<string, number>>)[nodeId];
}

/** Whether a reason means "this node was singled out". */
export function isSingled(reason: LabelReason | undefined): boolean {
  return reason === 'focus' || reason === 'selection' || reason === 'hover';
}

/**
 * Decide every label in one pass.
 *
 * The rule, in priority order: a singled-out node is always labelled at its full
 * path in lane 0; otherwise the label is drawn at the basename if it fits, drawn
 * staggered if half of it fits, and not drawn at all if not even that fits.
 *
 * Mirrors `core/src/graph/labels.ts`. See that file for why each step is where
 * it is; the short version is that staggering before hiding is what keeps a
 * crowded graph legible, and that the singled-out case is unconditional because a
 * click on a node is a question about that node.
 */
export function decideGraphLabels(input: LabelInputs): GraphLabel[] {
  const haveRoom = input.pixelsPerSlot > 0;

  const singledOut = new Set(
    [input.focusId, input.selectedId, input.hoverId].filter(
      (id): id is string => id !== null && id !== undefined,
    ),
  );

  const out: GraphLabel[] = [];

  for (const [position, node] of input.nodes.entries()) {
    if (singledOut.has(node.id)) {
      // Full path, lane 0, and deliberately not counted in `drawn`: it is as wide
      // as several lanes, so it neither takes a turn nor shifts what follows it
      // out of phase.
      const reason: LabelReason =
        input.focusId === node.id
          ? 'focus'
          : input.selectedId === node.id
            ? 'selection'
            : 'hover';
      out.push({ nodeId: node.id, text: node.id, show: true, reason, lane: 0 });
      continue;
    }

    // SAFETY and the per-node width are documented in `core/src/graph/labels.ts`.
    // Both copies must change together;
    // `packages/app/test/renderer/labels.test.ts` fails if they do not.
    const need = widthFor(input.labelWidthPx, node.id) * SAFETY;
    const fitsPlainly = haveRoom && input.pixelsPerSlot >= need;
    const fitsStaggered = haveRoom && input.pixelsPerSlot * 2 >= need;

    if (!fitsPlainly && !fitsStaggered) {
      // Empty text as well as `show: false`, so a caller that passes `text`
      // straight to the renderer cannot draw a blank by forgetting the check.
      out.push({ nodeId: node.id, text: '', show: false, reason: 'crowded', lane: 0 });
      continue;
    }

    out.push({
      nodeId: node.id,
      text: basename(node.id),
      show: true,
      // Stagger only when it does work; with room to spare it is noise.
      reason: fitsPlainly ? 'room' : 'staggered',
      // `rowIndex` when supplied, node position otherwise. Mirrors core exactly;
      // an earlier version forced lane 0 whenever `rowIndex` was absent, which
      // silently unstaggered every caller that did not pass geometry — and the
      // drift test caught it on 3,271 inputs.
      lane: fitsPlainly
        ? 0
        : (((indexIn(input.rowIndex, node.id) ?? position) % 2) as LabelLane),
    });
  }

  return dropCollisions(out, (id) => widthFor(input.labelWidthPx, id), input.pixelsPerSlot);
}

/**
 * Drop labels that would still collide after staggering.
 *
 * Two labels in the same lane share the space between them, so two that each pass
 * a 108px test can still collide in the 108px they sit inside — that is how
 * `presentation.js` (81px) and `scene-manager.js` (86px) ended up fused in the
 * screenshot. This pass accumulates widths along each lane and drops a label that
 * does not fit.
 *
 * The first label in a lane is always kept: nothing precedes it. Dropping, not
 * shifting — with only two lanes a displaced label has nowhere to go that is not
 * another collision, and a missing label is recoverable by hover while an
 * overlapping one is not.
 *
 * The full reasoning is in `core/src/graph/labels.ts`; both copies must change
 * together, and `packages/app/test/renderer/labels.test.ts` fails if they do not.
 */
function dropCollisions(
  labels: GraphLabel[],
  widthOf: (nodeId: string) => number,
  pixelsPerSlot: number,
): GraphLabel[] {
  if (pixelsPerSlot <= 0) return labels;

  const lanes = new Map<LabelLane, GraphLabel[]>();
  for (const label of labels) {
    if (!label.show || label.reason !== 'staggered') continue;
    const group = lanes.get(label.lane) ?? [];
    group.push(label);
    lanes.set(label.lane, group);
  }
  if (lanes.size === 0) return labels;

    const dropped = new Set<string>();
  const gap = pixelsPerSlot * 2;
  for (const group of lanes.values()) {
    // Pairwise against the same-lane predecessor, not a running sum along the
    // lane: each label has its own `gap` ahead of it. The running-sum version
    // dropped 14 of 18 labels on the real graph.
    for (let i = 1; i < group.length; i += 1) {
      const previous = group[i - 1] as GraphLabel;
      const current = group[i] as GraphLabel;
      const used = widthOf(previous.nodeId) + widthOf(current.nodeId);
      if (used > gap * SAFETY) dropped.add(current.nodeId);
    }
  }

  if (dropped.size === 0) return labels;
  return labels.map((label) =>
    dropped.has(label.nodeId)
      ? { ...label, show: false, text: '', reason: 'crowded' as LabelReason }
      : label,
  );
}

/** The labels the screen should actually draw, in node order. */
export function visibleLabels(input: LabelInputs): GraphLabel[] {
  return decideGraphLabels(input).filter((label) => label.show);
}

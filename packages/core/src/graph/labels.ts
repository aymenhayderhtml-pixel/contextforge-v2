/**
 * packages/core/src/graph/labels.ts
 *
 * Which node labels the Graph screen may draw, what text they use, and which
 * vertical lane they sit in.
 *
 * ## Why this exists
 *
 * The first real layout of the full graph was a legibility failure, not a
 * correctness one. `src/main.js` fans out to 17 siblings; `breadthfirst` lays
 * them in one horizontal row, and 17 labels of a full path at font-size 9 under
 * 16px circles do not fit in the width of the canvas. The screenshot read
 * `src/browserscenebundler.js` and `src/resources.js` as one smear. Correct
 * graph, unusable screen.
 *
 * Measured on the real project at 1× CSS pixels: a 919px canvas with a 17-wide
 * row gives **54px per slot**, and the longest basename (`scene-manager.js`,
 * 16 characters at 9px) needs about **86px**. So every label in that row
 * overlaps both of its neighbours. Nothing fits at that size.
 *
 * ## The rule
 *
 * In priority order, per node:
 *
 * 1. **Focused, selected or hovered** — always drawn, at the full path, never
 *    staggered. Unconditional, and it is the load-bearing half: clicking a node
 *    is how a developer asks what it is called, and a screen that shows nothing
 *    on click has failed at the one job the click was for.
 * 2. **Room** — drawn at the basename, lane 0.
 * 3. **Half the room** — drawn at the basename, lane 1, alternating with its
 *    neighbours. Two labels in a lane are two slots apart, so staggering halves
 *    the density that has to fit: at 54px per slot this needs 108px per
 *    same-lane neighbour, and 86px does fit. This is why the real project is
 *    legible at all.
 * 4. **Neither** — not drawn.
 *
 * Staggering before hiding, in that order, because the alternative is a default
 * view that is a field of unlabelled dots: correct, and useless for the question
 * the screen was opened to answer.
 *
 * ## Why it is in core
 *
 * Because the rule is a *rule*, and a rule that lives only inside a Svelte file
 * is a rule nothing can assert. Same reasoning as D44: the analysis is pure and
 * headless, and the component stays thin. There is no jsdom in this repo, so a
 * test cannot mount the component; it can call this function.
 *
 * ## What it does NOT do
 *
 * It does not lay nodes out and it does not measure pixels. Measurement belongs
 * to the screen, which has a canvas; it arrives here as two numbers. That keeps
 * the decision testable and the arithmetic where the pixels are.
 */

import type { GraphNode } from './types.js';

/**
 * Which vertical offset a label sits at.
 *
 * `0` is the normal position, `1` is the stagger below it. Only the *singled-out*
 * label ignores its lane, because it is on its own and staggering it next to a
 * neighbour would be meaningless.
 */
export type LabelLane = 0 | 1;

/**
 * Headroom a label needs beyond its own width before it is drawn beside a
 * neighbour: 1.25x, so a label occupies at most 80% of the space it is given.
 *
 * Sized from the one real case there is rather than picked: the tightest pair in
 * `kart-dash-3d-v2` is 108px of spacing against a 108px label, and at 1.0 they
 * touched. At 1.25 that label needs 135px and does not fit, so it drops to hidden
 * and hover reveals it — where `scene-manager.js` (86px, needing 108px) still
 * fits exactly, so the graph keeps almost all its labels instead of going dark.
 */
const SAFETY = 1.25;

/**
 * The lane to put the `index`-th *drawn* label in.
 *
 * Alternating over draw order rather than over node position, and the difference
 * matters. Node position would put a hidden node's parity on the node after it,
 * so a lone hovered label in the middle of a crowded graph would leave its
 * immediate neighbours sharing a lane — the exact overlap staggering was meant to
 * prevent. Counting only drawn labels means the thing on screen is always
 * adjacent to the thing it alternates with, which is the only guarantee that
 * matters.
 */
function laneFor(index: number): LabelLane {
  return (index % 2) as LabelLane;
}

/** Read a node's index within its row, from either accepted shape. */
function indexIn(
  rowIndex: NonNullable<LabelInputs['rowIndex']>,
  nodeId: string,
): number | undefined {
  if (typeof (rowIndex as ReadonlyMap<string, number>).get === 'function') {
    return (rowIndex as ReadonlyMap<string, number>).get(nodeId);
  }
  return (rowIndex as Readonly<Record<string, number>>)[nodeId];
}

/** Why a label is being drawn. Useful in a test and in a tooltip. */
export type LabelReason =
  /** The node the user clicked, or the centre of the focused neighbourhood. */
  | 'focus'
  /** The node the user selected. */
  | 'selection'
  /** The node under the pointer. */
  | 'hover'
  /** Every label fits, so no staggering is needed. */
  | 'room'
  /** Every label would fit only if neighbours took turns between two lanes. */
  | 'staggered'
  /** Not enough room even staggered. Deliberately not drawn. */
  | 'crowded';

export interface GraphLabel {
  /** The node this label belongs to. */
  nodeId: string;
  /**
   * The text to draw. Short in a crowd, full when the node is singled out.
   *
   * Empty when `show` is false, so a caller can pass `text` to the renderer
   * without checking `show` first and getting a blank drawn.
   */
  text: string;
  /** False means "do not draw anything". */
  show: boolean;
  reason: LabelReason;
  /** Vertical offset, as an index into the screen's lane offsets. */
  lane: LabelLane;
}

export interface LabelInputs {
  /** Every node currently in the graph, in the order drawn. */
  nodes: readonly GraphNode[];
  /**
   * Horizontal room per node slot, in pixels, as measured by the screen.
   *
   * `canvas width / nodes in the widest row`. Only the widest row can collide,
   * so the graph as a whole is crowded when that one row is — which is why this
   * is one number for the whole graph and not a per-row value.
   */
  pixelsPerSlot: number;
  /**
   * Rendered width of **each node's own** basename, in pixels, keyed by node id.
   *
   * **Per node, not one width for the whole graph, and that is the design.**
   *
   * The first version measured only the widest basename in the project — 108px for
   * `playerSceneLoader.js` — and judged every label against it. On the real graph
   * that is 54px per slot and 108px across two staggered slots, so
   * `108 * 1.25 = 135 > 108` and *no label was drawn at all*: a field of bare
   * circles, worse than the smear it was written to fix. Two names 48px apart
   * (`main.js` at 38px, `scene-manager.js` at 86px) were being measured with the
   * same yardstick, and the yardstick was the longest one.
   *
   * Per-node width means a short name is drawn even in a row too narrow for the
   * long one beside it, which is what makes the picture readable: a crowded row is
   * mostly short names with a few long ones, and hiding all of them because of two
   * is the wrong trade. A node with no measurement is treated as zero-width and so
   * always drawn — the direction that errs toward showing something.
   */
  labelWidthPx: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
  /** The focused node, if focus mode is on. Its label is always drawn. */
  focusId?: string | null;
  /** The selected node, if any. Its label is always drawn. */
  selectedId?: string | null;
  /** The node under the pointer. Its label is drawn. */
  hoverId?: string | null;
  /**
   * Each node's index within its own row, keyed by node id. The caller reads it
   * off the laid-out `y` positions; it is absent for nodes the caller could not
   * place, and those fall back to their order in `nodes`.
   *
   * **Lanes come from this, not from the order labels are drawn in.** That
   * distinction is the whole reason it is a parameter, and the capture screenshot
   * is what proved it. Lanes were assigned by a counter that advanced only for
   * *drawn* labels, so once `dropCollisions` removed any, the counter stopped
   * matching the geometry: a row meant to alternate 0,1,0,1 came out with 14 of
   * its 18 labels in lane 0, each 48px from its neighbour instead of 96px. Every
   * label that survived was still stacked — the stagger silently stopped working
   * on exactly the graphs that needed it, while every test passed, because the
   * tests feed a single row with nothing dropped.
   *
   * Index-within-row is stable under labels being hidden, which draw order is not.
   */
  rowIndex?: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
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

/**
 * Decide every label in one pass.
 *
 * See the module comment for the rule. The order there is the order here:
 * singled-out first, then room, then staggered, then hidden.
 */
export function decideGraphLabels(inputs: LabelInputs): GraphLabel[] {
  const { nodes, pixelsPerSlot, labelWidthPx, focusId, selectedId, hoverId, rowIndex } = inputs;

  // A non-positive slot width means the caller could not measure, which happens
  // on the first paint before the canvas has a size. Treating that as "room"
  // would draw every label overlapping, so it falls through to the same answer
  // as "no room": only a singled-out node is labelled, and the screen re-runs
  // this after layout and on resize.
  const haveRoom = pixelsPerSlot > 0;

  const singledOut = new Set(
    [focusId, selectedId, hoverId].filter((id): id is string => id !== null && id !== undefined),
  );

  const out: GraphLabel[] = [];

  for (const [position, node] of nodes.entries()) {
    if (singledOut.has(node.id)) {
      // Inserted in node order but *not* counted in `drawn`. A singled-out label
      // is full-path and can be as wide as several lanes, so it neither takes a
      // turn nor shifts what follows it; counting it would push its neighbours
      // out of phase and re-create the overlap the stagger exists to prevent.
      out.push({
        nodeId: node.id,
        text: node.id,
        show: true,
        reason: reasonFor(node.id, { focusId, selectedId, hoverId }),
        lane: 0,
      });
      continue;
    }

    // This node's own width, with the safety margin. The margin is why a label
    // flush against its neighbour is never drawn: overlapping labels are worse
    // than absent ones, and hover reveals an absent one on demand.
    const need = widthFor(labelWidthPx, node.id) * SAFETY;
    const fitsPlainly = haveRoom && pixelsPerSlot >= need;
    const fitsStaggered = haveRoom && pixelsPerSlot * 2 >= need;

    if (!fitsPlainly && !fitsStaggered) {
      out.push({
        nodeId: node.id,
        // Empty so a caller that passes `text` straight to the renderer cannot
        // draw a blank by forgetting to check `show`.
        text: '',
        show: false,
        reason: 'crowded',
        lane: 0,
      });
      continue;
    }

    out.push({
      nodeId: node.id,
      text: basename(node.id),
      show: true,
      // Staggering only when it is doing work. With room to spare, alternating
      // lanes would push half the labels down for nothing.
      reason: fitsPlainly ? 'room' : 'staggered',
      // `rowIndex` when the caller supplied it, so the lane tracks the geometry.
      // `position` otherwise, which is correct for a single row and is the reason
      // the unit tests pass: they have one row and nothing dropped.
      lane: fitsPlainly ? 0 : laneFor(rowIndex === undefined ? position : (indexIn(rowIndex, node.id) ?? position)),
    });
  }

  return dropCollisions(out, (id) => widthFor(labelWidthPx, id), pixelsPerSlot);
}

/**
 * Drop labels that would still collide after staggering.
 *
 * `decideGraphLabels` judges each label against a whole slot, which is necessary
 * but not sufficient: two labels in the *same* lane share the space between them,
 * so two labels that each pass a 108px test can still collide in the 108px they
 * sit inside. The per-node check passed them both, and the screenshot showed
 * `presentation.js` (81px) and `scene-manager.js` (86px) fused — 167px of label
 * in 108px of space.
 *
 * So this second pass groups the drawn, staggered labels by lane and, within each
 * lane, adds up consecutive widths. A label that will not fit alongside the
 * labels already placed before it is dropped.
 *
 * **The running sum, not just the immediate predecessor.** Three labels of 60px in
 * a 108px lane each pass a pairwise test against one neighbour but not against
 * two, and this row does contain a run of long names. Accumulating is the only
 * form of the test that is correct for any number of them.
 *
 * The *first* label in a lane is kept regardless: there is nothing before it to
 * collide with, and dropping it would leave a hole where a name used to be for no
 * reason.
 *
 * **Dropping, not shifting.** There are only two lanes, so a displaced label has
 * nowhere to go except the other lane, where it would collide with a different
 * neighbour instead. A missing label is recoverable by hover; an overlapping one is
 * not.
 *
 * Only the staggered case is swept. When every label fits its own slot there is no
 * crowding to relieve, and dropping there would hide labels for nothing.
 *
 * @param widthOf the same per-node measurement the first pass used
 * @param pixelsPerSlot the slot width, doubled for same-lane spacing
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

  const gap = pixelsPerSlot * 2;
  const dropped = new Set<string>();
  for (const group of lanes.values()) {
    // Pairwise against the same-lane predecessor, not a running sum along the
    // lane: each label has its own `gap` ahead of it, so three 49px labels in a
    // 108px lane are three pairs of 98px, not one run of 147px. The running-sum
    // version dropped 14 of 18 labels on the real graph.
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

/**
 * The last path segment: `src/prefabs/kart.ts` -> `kart.ts`.
 *
 * Not a trim-to-width heuristic on purpose. A truncated label is ambiguous —
 * `src/kart/` and `src/enemy/kart` both truncate to something alike, so a
 * developer comparing two nodes cannot tell them apart. The basename collides in
 * the same way, but far more rarely, and a collision between siblings is visible
 * while a truncated one is not.
 */
export function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

function reasonFor(
  nodeId: string,
  ids: {
    focusId?: string | null | undefined;
    selectedId?: string | null | undefined;
    hoverId?: string | null | undefined;
  },
): LabelReason {
  // Focus first: it is the strongest statement about what the screen is about,
  // and a node can be focused, selected and hovered at once.
  if (ids.focusId === nodeId) return 'focus';
  if (ids.selectedId === nodeId) return 'selection';
  return 'hover';
}

/** The labels the screen should actually draw, in node order. */
export function visibleLabels(inputs: LabelInputs): GraphLabel[] {
  return decideGraphLabels(inputs).filter((label) => label.show);
}

/**
 * packages/core/test/graph/labels.test.ts
 *
 * The label rule, stated once here and once in the source, so a change to either
 * that is not mirrored fails.
 *
 * ## The rule
 *
 * In priority order, per node:
 *
 * 1. Focused, selected or hovered — always drawn, at the full path, lane 0.
 * 2. Room for the label — drawn at the basename, lane 0.
 * 3. Room for half the label — drawn at the basename, lane 1 (staggered).
 * 4. Neither — not drawn.
 *
 * ## Why rule 1 is unconditional
 *
 * Hiding every label in a crowded graph is a common, defensible decluttering
 * move. It is wrong here because clicking a node is how a developer asks what it
 * is called, and a screen that shows nothing on click has failed at the one job
 * the click was for.
 */

import { describe, expect, it } from 'vitest';
import { basename, decideGraphLabels, visibleLabels } from '../../src/graph/labels.js';
import type { LabelInputs } from '../../src/graph/labels.js';
import type { GraphNode } from '../../src/graph/types.js';

function node(id: string): GraphNode {
  return { id, type: 'source', depends_on: [], depends_on_by: [], contract: null } as GraphNode;
}

/**
 * The shape of `kart-dash-3d-v2`'s full graph: one hub fanning out to a row of
 * 17 siblings. That row is the whole problem — `breadthfirst` puts it on one
 * line, and 17 labels do not fit.
 */
function crowd(count: number): GraphNode[] {
  return [node('src/main.js'), ...Array.from({ length: count }, (_, i) => node(`src/mod${i}.js`))];
}

const nodes = crowd(17);

/**
 * The measurements the real screen makes, not invented ones.
 *
 * The widths are read off the rendered screenshot. The spread is the point: a 27px
 * `ai.js` and an 86px `scene-manager.js` in the same row, judged independently.
 * Using one width for the whole graph — which was tried — hid every label,
 * because the longest name set the threshold for all of them.
 */
/**
 * The real row's measured spacing: 48px.
 *
 * **Measured from the laid-out positions, not computed.** The screen originally
 * divided the canvas width by the node count and got 54px for a row whose nodes
 * are actually 48px apart, so every label believed it had 6px more room than it
 * did and two of them touched. The test uses the real number so that error cannot
 * come back unnoticed.
 */
const REAL_SLOT = 48;

/**
 * The real project's basenames and their measured widths in CSS pixels.
 *
 * Taken from the rendered screenshot rather than estimated, and the spread is the
 * point: `main.js` at 38px against `playerSceneLoader.js` at 108px is a 3x
 * difference, which is exactly what a single widest-name figure threw away.
 */
const REAL_WIDTHS: Record<string, number> = Object.fromEntries([
  // `src/main.js` is the hub at 38px; the 17 siblings are 49px. Built from the
  // fixture rather than typed out, so adding a node to `crowd()` cannot silently
  // leave it measuring zero-width — which would make it always draw and hide the
  // effect under test.
  ['src/main.js', 38],
  ...Array.from({ length: 17 }, (_, i) => [`src/mod${i}.js`, 49]),
]);

/** `86 x 1.25 = 107.5`, against `2 x 54 = 108` of same-lane spacing. */
const SCENE_MANAGER = 86;
/** `108 x 1.25 = 135`, which does not fit in `2 x 54 = 108`. */
const PLAYER_SCENE_LOADER = 108;

function real(overrides: Record<string, number> = {}): LabelInputs {
  return {
    nodes,
    pixelsPerSlot: REAL_SLOT,
    labelWidthPx: { ...REAL_WIDTHS, ...overrides },
    focusId: null,
    selectedId: null,
    hoverId: null,
  };
}

/**
 * The decision for one node id.
 *
 * By id, never by index: the labels come back in node order, and an index
 * assertion reads as though it named a node while actually picking whichever one
 * happens to sit there. That is how three of these tests came to disagree with the
 * code for a while.
 */
function reasonFor(input: LabelInputs, id: string): string | undefined {
  return decideGraphLabels(input).find((l) => l.nodeId === id)?.reason;
}

/** The real project: staggered, because neither plain room nor full room. */
const REAL = real();

describe('the real kart-dash-3d-v2 layout', () => {
  it('is staggered, not hidden', () => {
    // 49px does not fit in a 54px slot with margin, but two same-lane neighbours
    // are two slots apart at 108px, and it does fit there. Hiding everything would
    // leave a default view that is a field of unlabelled dots.
    //
    // All 18 are drawn: the 38px hub fits its own slot outright (`room`, lane 0)
    // and the 17 siblings stagger.
    expect(decideGraphLabels(REAL).filter((l) => l.reason === 'staggered')).toHaveLength(17);
    expect(decideGraphLabels(REAL).filter((l) => l.reason === 'room')).toHaveLength(1);
    expect(visibleLabels(REAL)).toHaveLength(18);
  });

  it('alternates lanes so neighbours never share one', () => {
    // The whole mechanism. Same-lane neighbours must be at least two slots
    // apart, or staggering achieved nothing.
    const lanes = visibleLabels(REAL).map((l) => l.lane);
    for (let i = 1; i < lanes.length; i += 1) {
      expect(lanes[i]).not.toBe(lanes[i - 1] as LabelLane);
    }
  });

  it('labels at the basename, not the full path', () => {
    expect(visibleLabels(REAL).find((l) => l.nodeId === 'src/mod3.js')?.text).toBe('mod3.js');
  });
});

// The second element is the *reason string*, which is what the screen and any
// future tooltip read; it is not always the name of the input that set it.
describe.each([
  ['focused', 'focusId', 'focus'],
  ['selected', 'selectedId', 'selection'],
  ['hovered', 'hoverId', 'hover'],
] as const)('the %s node', (_name, key, reason) => {
  const crowded = {
    nodes,
    pixelsPerSlot: 0,
    labelWidthPx: 0,
    focusId: null,
    selectedId: null,
    hoverId: null,
  };

  it('is drawn even when no label at all would fit', () => {
    expect(visibleLabels({ ...crowded, [key]: 'src/mod3.js' })).toEqual([
      { nodeId: 'src/mod3.js', text: 'src/mod3.js', show: true, reason, lane: 0 },
    ]);
  });

  it('is drawn at the full path, not the basename', () => {
    // The developer singled this node out and is reading it; truncating it is the
    // one thing that would make the gesture not worth making.
    expect(visibleLabels({ ...crowded, [key]: 'src/mod3.js' })[0]?.text).toBe('src/mod3.js');
  });

  it('stays in lane 0, so it does not jump because of its index parity', () => {
    // The other labels are staggered around it; a singled-out label that also
    // took a lane would sit somewhere arbitrary in the middle of them.
    expect(visibleLabels({ ...crowded, [key]: 'src/mod3.js' })[0]?.lane).toBe(0);
  });

  it('does not un-hide a neighbour that was hidden', () => {
    // Singling out one node is not a licence to reveal the whole crowd.
    const labels = visibleLabels({ ...crowded, [key]: 'src/mod3.js' });
    expect(labels).toHaveLength(1);
  });
});

describe('a crowded node that is not singled out', () => {
// A 20px slot against the shortest label in the graph (the 38px hub): it needs
  // 47.5px, and two lanes give 40px, so even the label with the most room here
  // cannot be drawn. Nothing fits at this size.
  const tightInput: LabelInputs = { ...REAL, pixelsPerSlot: 20 };

  it('is not drawn', () => {
    // Even the 38px hub: 47.5 needed, 20 available, 40 across two lanes.
    expect(visibleLabels(tightInput)).toEqual([]);
  });

  it('is reported as crowded rather than omitted', () => {
    // A node absent from the result would be indistinguishable from a node that
    // was never in the graph.
    expect(decideGraphLabels(tightInput)).toHaveLength(nodes.length);
    expect(decideGraphLabels(tightInput).every((l) => l.reason === 'crowded')).toBe(true);
  });

  it('carries empty text, so a caller cannot draw a blank by accident', () => {
    expect(decideGraphLabels(tightInput).every((l) => l.text === '')).toBe(true);
  });
});

describe('room for every label', () => {
  const roomy = { ...REAL, pixelsPerSlot: 200 };

  it('draws them all in lane 0', () => {
    const labels = visibleLabels(roomy);
    expect(labels).toHaveLength(nodes.length);
    expect(labels.every((l) => l.lane === 0)).toBe(true);
    expect(labels.every((l) => l.reason === 'room')).toBe(true);
  });

  it('does not stagger when staggering would do nothing', () => {
    // Alternating lanes with room to spare pushes half the labels down for no
    // reason, which is a worse picture than one where nothing collides.
    expect(visibleLabels(roomy).every((l) => l.lane === 0)).toBe(true);
  });
});

describe('the row index the lanes follow', () => {
  /**
   * Lanes must come from the node's position in its row, not from the order
   * labels happen to be drawn in.
   *
   * The capture screenshot is what proved this. Lanes were assigned by a counter
   * that advanced only for *drawn* labels, so as soon as `dropCollisions` removed
   * one, the counter stopped matching the geometry and a row meant to alternate
   * came out with 14 of its 18 labels in lane 0 — each 48px from its neighbour
   * instead of 96px. Every surviving label was still stacked, and every test
   * passed, because the tests have a single row with nothing dropped.
   */
  const laidOut = [
    { id: 'src/a.js', width: 40 },
    { id: 'src/veryLongNameHere.js', width: 140 }, // too long: gets dropped
    { id: 'src/c.js', width: 40 },
    { id: 'src/d.js', width: 40 },
  ];
  const input: LabelInputs = {
    nodes: laidOut.map((n) => ({ id: n.id })),
    pixelsPerSlot: 48,
    labelWidthPx: Object.fromEntries(laidOut.map((n) => [n.id, n.width])),
    // Geometry, not draw order: b is the second node in the row.
    rowIndex: { 'src/a.js': 0, 'src/veryLongNameHere.js': 1, 'src/c.js': 2, 'src/d.js': 3 },
    focusId: null,
    selectedId: null,
    hoverId: null,
  };

  it('keeps the surviving labels on alternating lanes', () => {
    const shown = visibleLabels(input).map((l) => l.nodeId);
    const lanes = decideGraphLabels(input)
      .filter((l) => shown.includes(l.nodeId))
      .map((l) => l.lane);
    // Without geometry-driven lanes, dropping `b` would shift everything after it
    // by one and put `c` and `d` in the same lane.
    expect(lanes).toEqual([0, 0, 1]);
  });

  it('drops the label that does not fit, without shifting its neighbours', () => {
    const byId = new Map(decideGraphLabels(input).map((l) => [l.nodeId, l]));
    expect(byId.get('src/veryLongNameHere.js')?.show).toBe(false);
    // `c` is index 2 -> lane 0, and `d` is index 3 -> lane 1. Neither moved.
    expect(byId.get('src/c.js')?.lane).toBe(0);
    expect(byId.get('src/d.js')?.lane).toBe(1);
  });

  it('falls back to node order when the caller supplies no geometry', () => {
    const withoutRows: LabelInputs = { ...input, rowIndex: undefined };
    expect(decideGraphLabels(withoutRows).map((l) => l.nodeId)).toEqual(
      decideGraphLabels(input).map((l) => l.nodeId),
    );
  });
});

describe('the safety margin', () => {
  // A label is drawn only when it fits with 25% headroom, because a label flush
  // against its neighbour is not readable. These are the boundaries that margin
  // creates, and they are the reason `playerSceneLoader.js` is hidden on the real
  // project while `scene-manager.js` is not.
  it('needs 1.25x a label\'s own width in a single slot, not 1x', () => {
    // 86px of label needs 107.5px of slot. At 86 it would touch its neighbour.
    const wide = real({ 'src/mod0.js': SCENE_MANAGER });
    expect(reasonFor({ ...wide, pixelsPerSlot: 86 }, 'src/mod0.js')).toBe('staggered');
    expect(reasonFor({ ...wide, pixelsPerSlot: 107 }, 'src/mod0.js')).toBe('staggered');
    expect(reasonFor({ ...wide, pixelsPerSlot: 108 }, 'src/mod0.js')).toBe('room');
  });

  it('drops a label that is too long even staggered', () => {
    // The real case: `playerSceneLoader.js` at 108px against 2 x 54 = 108px of
    // same-lane spacing. 108 x 1.25 = 135, which does not fit in 108, so it is
    // dropped rather than drawn touching its neighbour.
    const wide = real({ 'src/mod0.js': PLAYER_SCENE_LOADER });
    expect(reasonFor({ ...wide, pixelsPerSlot: 54 }, 'src/mod0.js')).toBe('crowded');
    expect(reasonFor({ ...wide, pixelsPerSlot: 67 }, 'src/mod0.js')).toBe('crowded');
    expect(reasonFor({ ...wide, pixelsPerSlot: 68 }, 'src/mod0.js')).toBe('staggered');
  });

  it('drops scene-manager.js on the real project, and that is correct', () => {
    // 86px of label needs 107.5px. The real row gives 2 x 48 = 96px of same-lane
    // spacing, which is not enough, so it is hidden and hover reveals it.
    //
    // An earlier revision of this test asserted `staggered` and passed — because
    // `pixelsPerSlot` was computed as `canvasWidth / nodeCount` = 54 rather than
    // measured, and 2 x 54 = 108 happens to clear 107.5. The screenshot showed the
    // two labels touching, the measurement was corrected to the real 48px, and
    // this expectation changed with it. A test that agrees with a wrong number is
    // not evidence.
    expect(reasonFor(real({ 'src/mod0.js': SCENE_MANAGER }), 'src/mod0.js')).toBe('crowded');
  });

  it('still draws the short names in the same row', () => {
    // The point of per-node widths: dropping `scene-manager.js` must not take
    // `runtime.js` and `ai.js` with it. 38 x 1.25 = 48 fits a 48px slot outright.
    expect(reasonFor(real(), 'src/main.js')).toBe('room');
    expect(reasonFor(real(), 'src/mod1.js')).toBe('staggered');
  });

  it('judges each label by its own width, not the widest in the graph', () => {
    // THE regression test for this design. With one width for the whole graph, the
    // 108px name forced every label past its threshold and the screenshot came
    // back with no labels on it at all — worse than the original overlap. A short
    // name beside a long one must still be drawn.
    const mixed = real({ 'src/mod0.js': PLAYER_SCENE_LOADER });
    const labels = decideGraphLabels(mixed);
    const byId = new Map(labels.map((l) => [l.nodeId, l]));

    expect(byId.get('src/mod0.js')?.reason).toBe('crowded'); // the long one, 135 > 108
    expect(byId.get('src/main.js')?.reason).toBe('room'); // 38 x 1.25 = 48 <= 54
    expect(byId.get('src/mod1.js')?.reason).toBe('staggered'); // 49 x 1.25 = 62 <= 108
  });
});

describe('an unmeasured canvas', () => {
  it('treats zero as no room rather than as room', () => {
    // A canvas reports 0 before it is laid out. Reading that as "room" is the
    // bug this test exists to prevent: every label drawn, all overlapping.
    expect(visibleLabels({ ...REAL, pixelsPerSlot: 0 })).toEqual([]);
  });

  it('treats a negative measurement the same way', () => {
    expect(visibleLabels({ ...REAL, pixelsPerSlot: -40 })).toEqual([]);
  });

  it('still labels a singled-out node with no measurement at all', () => {
    // Otherwise the first paint after a click is blank, which is the one moment
    // a label must appear.
    expect(visibleLabels({ ...REAL, pixelsPerSlot: 0, hoverId: 'src/mod3.js' })).toHaveLength(1);
  });
});

describe('a focused node not present in the graph', () => {
  it('changes nothing rather than inventing a label', () => {
    // `focusId` comes from a click on a node, so this should not happen — but if
    // it did, a label for a node that is not drawn is a claim about nothing.
    expect(visibleLabels({ ...REAL, focusId: 'src/ghost.js' })).toHaveLength(18);
    expect(visibleLabels({ ...REAL, focusId: 'src/ghost.js', pixelsPerSlot: 20 })).toEqual([]);
  });
});

describe('a node that is both focused and hovered', () => {
  it('is reported as focus, the stronger claim', () => {
    const labels = decideGraphLabels({ ...REAL, focusId: 'src/mod3.js', hoverId: 'src/mod3.js' });
    expect(labels.find((l) => l.nodeId === 'src/mod3.js')?.reason).toBe('focus');
  });
});

describe('basename', () => {
  it('takes the last segment', () => {
    expect(basename('src/prefabs/kart.ts')).toBe('kart.ts');
  });

  it('returns a root-level file unchanged', () => {
    expect(basename('index.html')).toBe('index.html');
  });

  it('does not truncate — a truncated label cannot be told from another', () => {
    // The alternative is an ellipsis at some width, and `src/kart/` and
    // `src/enemy/kart` both truncate to something alike. A basename collides
    // too, but far more rarely and visibly.
    expect(basename('src/enemy/kart-prefab.ts')).toBe('kart-prefab.ts');
  });
});

type LabelLane = 0 | 1;

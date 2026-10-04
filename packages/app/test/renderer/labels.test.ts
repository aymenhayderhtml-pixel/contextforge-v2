/**
 * packages/app/test/renderer/labels.test.ts
 *
 * The renderer mirrors core's label rule, and this is what makes that duplication
 * safe.
 *
 * ## Why there is a mirror at all
 *
 * `@contextforge/core` is `external` in the Vite renderer build, because core
 * imports `node:fs`, `node:path` and tree-sitter and the renderer sandbox has none
 * of them. Every renderer use of core is `import type`, which is erased at build
 * time. A *value* import compiles and then fails at runtime — that is how the
 * whole app crashed when the Graph screen first landed.
 *
 * The precedent is `renderer/viewport/rng.ts`. Duplicating a function is normally
 * the thing this repo refuses to do, so this file imports *both* copies and
 * asserts they agree. A change to one that is not mirrored fails here rather than
 * showing up as a wrong label on screen.
 *
 * ## Why both are importable
 *
 * The mirror is `renderer/graph/labels.ts`, a plain module, not code inside the
 * Svelte component. It was originally written inline in `GraphScreen.svelte` and
 * this test had to extract the function bodies as text and strip their TypeScript
 * annotations with hand-written regexes — which broke the moment the signature
 * grew an inline object type. A plain module needs no extraction.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  basename as mirrorBasename,
  decideGraphLabels as mirrorDecide,
  isSingled as mirrorIsSingled,
} from '../../src/renderer/graph/labels.js';
import { basename as coreBasename, decideGraphLabels as coreDecide } from '@contextforge/core';

const MIRROR_SOURCE = fileURLToPath(
  new URL('../../src/renderer/graph/labels.ts', import.meta.url),
);

/**
 * Every combination that could differ between the two implementations.
 *
 * Enumerated rather than sampled: the rule has two numeric boundaries
 * (`pixelsPerSlot >= labelWidthPx` and `pixelsPerSlot * 2 >= labelWidthPx`) and
 * three ids, and the values below straddle both boundaries including the exact
 * equalities where an off-by-one would live.
 */
const SLOTS = [0, -40, 1, 20, 30, 42, 43, 54, 85, 86, 87, 200];

/**
 * Per-node widths, so the drift check covers the shape the rule actually uses.
 *
 * A spread from 0 to 108, which is the real range in `kart-dash-3d-v2` (a 38px
 * `main.js` to a 108px `playerSceneLoader.js`). The 108px entry is the one that
 * matters: it is the value that made the first single-width version hide every
 * label in the graph.
 */
const WIDTHS = [0, -1, 38, 43, 49, 86, 108];

// Five nodes, wide enough that some are dropped at small slot widths — a drop is
// when the two implementations are most likely to disagree about lane assignment.
const NODES = [
  { id: 'src/main.js' },
  { id: 'src/mod0.js' },
  { id: 'src/mod1.js' },
  { id: 'src/mod2.js' },
  { id: 'index.html' },
];

const IDS: (string | null)[] = [null, 'src/main.js', 'src/mod1.js', 'src/mod2.js', 'src/ghost.js'];

describe('the renderer mirror is a pure function', () => {
  it('does not touch runes, Cytoscape, the DOM, or node builtins', () => {
    // If it grew any of these it would no longer be callable from a test, and the
    // drift check below would be silently comparing nothing. `document` is the one
    // that matters most: the mirror runs in the renderer, where a `document`
    // lookup would work in the app and not here, so a test comparing them would
    // pass while the app behaved differently.
    //
    // Comments and doc comments are blanked first. This file's own header explains
    // that core imports `node:fs` and tree-sitter, so checking the raw text for
    // those strings would fail on the explanation of the problem rather than on
    // the problem.
    const code = readFileSync(MIRROR_SOURCE, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    for (const forbidden of [
      '$state',
      '$derived',
      '$effect',
      'cy.',
      'node:fs',
      'node:path',
      'document.',
      'window.',
    ]) {
      expect(code, `mirror must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('core and the renderer mirror agree', () => {
  for (const pixelsPerSlot of SLOTS) {
    for (const labelWidthPx of WIDTHS) {
      /**
       * A different width per node, so the check is not accidentally a
       * single-width comparison with the value varied.
       */
      const widthFor = (i: number): number =>
        WIDTHS[(i + pixelsPerSlot + labelWidthPx) % WIDTHS.length] ?? 0;

      it(`at ${pixelsPerSlot}px per slot, widths varying through ${WIDTHS.join('/')}`, () => {
        for (const focusId of IDS) {
          for (const selectedId of IDS) {
            for (const hoverId of IDS) {
              const widths = Object.fromEntries(NODES.map((n, i) => [n.id, widthFor(i)]));
              const base = { nodes: NODES, pixelsPerSlot, focusId, selectedId, hoverId };

              // Row geometry, and the same input *without* it, because `rowIndex`
              // changes which lane a label lands in and a drift check that only
              // ever omits it cannot see a disagreement about lanes.
              const rows = Object.fromEntries(NODES.map((n, i) => [n.id, i]));
              const reversed = Object.fromEntries(NODES.map((n, i) => [n.id, NODES.length - 1 - i]));
              for (const rowIndex of [rows, reversed, undefined]) {
                expect(mirrorDecide({ ...base, labelWidthPx: widths, rowIndex })).toEqual(
                  coreDecide({ ...base, labelWidthPx: widths, rowIndex }),
                );
              }

              // Both accepted shapes, since the type allows either and a caller
              // using a Map must not silently diverge.
              expect(mirrorDecide({ ...base, labelWidthPx: widths })).toEqual(
                coreDecide({ ...base, labelWidthPx: widths }),
              );
              expect(
                mirrorDecide({ ...base, labelWidthPx: new Map(Object.entries(widths)) }),
              ).toEqual(coreDecide({ ...base, labelWidthPx: new Map(Object.entries(widths)) }));
            }
          }
        }
      });
    }
  }
});

describe('basename agrees', () => {
  it.each([
    'src/main.js',
    'src/prefabs/hazardCrate.ts',
    'index.html',
    '',
    'a/b/c/d/e.js',
    'no-slash.ts',
    'trailing/',
    '/leading-slash.js',
    'double//slash.js',
  ])('on %j', (path) => {
    expect(mirrorBasename(path)).toBe(coreBasename(path));
  });
});

describe('isSingled', () => {
  it.each(['focus', 'selection', 'hover'])('is true for %s', (reason) => {
    expect(mirrorIsSingled(reason as 'focus')).toBe(true);
  });

  it.each(['room', 'staggered', 'crowded', undefined])('is false for %s', (reason) => {
    expect(mirrorIsSingled(reason as 'room' | undefined)).toBe(false);
  });
});

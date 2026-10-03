/**
 * test/viewport/realPrefabs.test.ts — real prefabs in the ContextForge viewport.
 *
 * Two things are established here, and they are different in kind:
 *
 *  1. **A bad prefab is a row, not a crash** — it becomes a labelled placeholder
 *     plus an `AppError`, and never a silent fallback mesh. These tests predate
 *     the parity work below and are kept unchanged.
 *
 *  2. **The viewer's kart is the v1 kart** — compared, combination by
 *     combination, against the *original* `buildMesh()` / `buildDriver()` output
 *     of `src/kart.js` in the untouched v1 project.
 *
 * Why this is not the tautology it replaced: the old kart test called
 * `kartPrefab.create(...)` and then compared that same call's output to what the
 * viewer built from the same prefab, so it could only ever prove that
 * `buildSceneGraph` copied an object it was handed. It passed against a prefab
 * that was wrong. Here the reference side comes from a **different file in a
 * different project** — v1's own `Kart` class, bundled and executed — and v1's
 * own `characters.js` supplies the colours. If the viewer stopped producing the
 * v1 tree, these tests fail; nothing here can pass by comparing a thing to
 * itself.
 *
 * ## Loading v1 at all
 *
 * v1 has no `node_modules` of its own that Node can use for a bare `three`
 * import, so its `kart.js` is **bundled with esbuild** (three inlined from
 * whatever v1 resolves) and the result is written to a temp `.mjs` and
 * imported. The import URL carries a `?v=<n>` suffix for the same reason
 * `prefabLoader.ts` uses one: Node caches ESM by URL forever, so without it a
 * second import silently returns the first and a test can pass on stale code.
 *
 * v1's `createTexture` needs a real `<canvas>` 2D context. The stub below is
 * installed before the module is imported and records every call v1 makes, which
 * turns "the stub was good enough" into something the suite actually checks:
 * the exhaust-glow test asserts the exact draw-call sequence v1 performed, so a
 * stub that silently no-op'd would fail instead of hiding a difference.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import * as THREE from 'three';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import type { PrefabDefinition } from '@contextforge/core';
import type { AppError } from '../../src/errors.js';
import { bundlePrefabsForBrowser } from '../../src/electron/prefabLoader.js';
import {
  buildSceneGraph,
  indexPrefabDefinitions,
  assembleScene,
  Viewport,
  loadPrefabBundle,
  clearRegisteredPrefabs,
  MARKER_COLOR,
  isErrorMarker,
} from '../../src/renderer/viewport/index.js';
import { sceneFile } from './fixtures.js';

/** The scene-file instance every matrix combination is built as. */
const INSTANCE_ID = 'player_kart';
/** The name `buildSceneGraph` gives that instance's root. */
const INSTANCE_NAME = 'PlayerKart';

/** The v2 game project whose `prefabs/` the viewer loads. */
const KART_PROJECT_DIR =
  process.env['CF_PROJECT'] ??
  resolve(import.meta.dirname, '..', '..', '..', '..', '..', 'kart-dash-3d-v2');

/** The original, untouched v1 game. Read-only reference; never written to. */
const V1_PROJECT_DIR =
  process.env['CF_V1_PROJECT'] ??
  resolve(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'class trash',
    'test oen',
    'kart-dash-3d',
  );
const V1_KART_ENTRY = resolve(V1_PROJECT_DIR, 'src/kart.js');
const V1_CHARACTERS_ENTRY = resolve(V1_PROJECT_DIR, 'src/characters.js');

/**
 * CF2's `node_modules`, used as esbuild's fallback resolution root.
 *
 * v1's own `node_modules` is found by esbuild's ordinary nearest-first walk from
 * the entry file, so v1 keeps the Three.js it shipped with; this root is what
 * makes the reference loadable if that folder ever goes away, rather than the
 * comparison silently having nothing to compare against.
 */
const HOST_NODE_MODULES = resolve(import.meta.dirname, '../../../node_modules');

// ── The canvas DOM v1's `createTexture` needs ───────────────────────────────

/** One recorded 2D-context call, as `[method, ...args]`. */
type CanvasCall = readonly [method: string, ...args: unknown[]];

/** The 2D context surface v1's exhaust-glow draw callback touches. */
interface Context2DStub {
  fillStyle: unknown;
  clearRect(x: number, y: number, w: number, h: number): void;
  createRadialGradient(
    x0: number, y0: number, r0: number, x1: number, y1: number, r1: number,
  ): { addColorStop(offset: number, color: string): void };
  fillRect(x: number, y: number, w: number, h: number): void;
}

/** Every canvas call made so far, in order, by whichever builder made it. */
const canvasDrawLog: CanvasCall[] = [];

/**
 * The first batch of canvas draws one builder caused, or `null` if it has not
 * painted yet.
 *
 * Both v1 and the prefab cache their exhaust-glow texture in a module-level
 * variable, so each draws **exactly once per process** — whichever test happens
 * to run first is the only one that sees it. Capturing the first batch at the
 * point of creation makes the glow comparison independent of the order vitest
 * runs this file's tests in, rather than betting on one.
 */
interface FirstDraws {
  current: CanvasCall[] | null;
}

const firstV1Draws: FirstDraws = { current: null };
const firstPrefabDraws: FirstDraws = { current: null };

/**
 * Record the calls logged since `before` as this builder's first batch.
 *
 * `before` is the shared log's length taken immediately before the build, so the
 * batch contains one builder's calls and not whatever the other one logged
 * earlier in the run.
 */
function captureFirstDraws(slot: FirstDraws, before: number): void {
  if (slot.current === null) slot.current = canvasDrawLog.slice(before);
}

/** True once `globalThis.document` has been replaced by the stub. */
let canvasStubInstalled = false;

/**
 * A `getContext('2d')` implementation that records what was asked of it.
 *
 * Records into `log` on *every* call, before doing anything else, so a draw
 * callback v1 supplied is captured as it arrives — that is what lets the glow
 * test compare two sides' instructions rather than comparing two copies of
 * hand-written drawing code.
 */
function recordingContext(log: CanvasCall[]): Context2DStub {
  return {
    fillStyle: null,
    clearRect(x, y, w, h): void {
      log.push(['clearRect', x, y, w, h]);
    },
    createRadialGradient(x0, y0, r0, x1, y1, r1) {
      log.push(['createRadialGradient', x0, y0, r0, x1, y1, r1]);
      return {
        addColorStop(offset: number, color: string): void {
          log.push(['addColorStop', offset, color]);
        },
      };
    },
    fillRect(x, y, w, h): void {
      log.push(['fillRect', x, y, w, h]);
    },
  };
}

/** A canvas-shaped object whose `2d` context records into `log`. */
function recordingCanvas(log: CanvasCall[], width = 0, height = 0): object {
  const context = recordingContext(log);
  return { width, height, getContext: (kind: string) => (kind === '2d' ? context : null) };
}

/**
 * Install the minimal `document` v1's `createTexture` needs.
 *
 * Only `canvas` with a `2d` context is provided, because that is all v1's
 * `utils.js` uses; anything else is refused by name rather than returning
 * `undefined` and failing later with a message that does not say what happened.
 *
 * Electron is not needed for this: nothing in `buildMesh`/`buildDriver` reads
 * pixels back, `Box3.setFromObject` only needs the geometry the geometry classes
 * produce in Node, and the one texture is compared by its *draw instructions*
 * rather than by pixels. `drawOnStubCanvas` is v1's record — the stub is only
 * trustworthy because the draw sequence it captured is asserted against the
 * prefab's own, so a no-op stub cannot pass.
 */
function installCanvasDomStub(): void {
  if (canvasStubInstalled) return;
  canvasStubInstalled = true;

  const globals = globalThis as unknown as { document?: unknown };
  globals.document = {
    createElement(tagName: string): unknown {
      if (tagName !== 'canvas') {
        throw new Error(
          `The v1 canvas stub only knows how to make a <canvas>; v1 asked for <${tagName}>. ` +
            'Extending the stub is required before this comparison can be trusted.',
        );
      }
      return recordingCanvas(canvasDrawLog);
    },
  };
}

// ── The v1 reference ────────────────────────────────────────────────────────

/** The parts of a v1 `CHARACTERS` entry this comparison reads. */
interface V1Character {
  readonly id: string;
  readonly name: string;
  readonly headgear: string;
  readonly colors: Readonly<Record<string, number>>;
}

/** v1's `Kart` instance, plus the mesh its constructor built. */
interface V1Kart {
  readonly mesh: THREE.Object3D;
  /** The handles v1's `update()` animates, which the prefab must also expose. */
  readonly animatedHandleNames: readonly string[];
}

/** The loaded v1 reference side. */
interface V1Reference {
  /** v1's own `characters.js` roster. */
  readonly characters: readonly V1Character[];
  /**
   * v1's `buildMesh` output for one character/headgear pair.
   *
   * The **real** `Kart` constructor is used rather than a hand-rolled object
   * carrying the handful of fields `buildMesh` reads. `buildMesh` reads
   * `isPlayer`, `aiIndex` and `character` and assigns to `exhaustGlows`,
   * `steeringWheel`, `wheels` and `starRing`, so calling it on a synthetic
   * `this` would mean *asserting my own reimplementation of those assignments*
   * — and the animated-handle check below would compare that fiction to the
   * prefab. Constructing `Kart` also exercises `scene.add`, which a stub scene
   * absorbs.
   *
   * `headgear` is overridden on a *copy* of the character object because that is
   * the only way v1 can be asked for a headgear its roster entry does not
   * carry — the object it reads in `buildDriver` is the same one it switches
   * on, so a copy is the honest way to express the override without editing
   * v1's data.
   */
  buildKart(characterId: string, headgear: string): V1Kart;
}

/** The one loaded v1 reference, kept across the tests in this file. */
let reference: V1Reference | null = null;

/**
 * Bundle one v1 module and load the result.
 *
 * `format: 'cjs'` is not a stylistic choice: Node's ESM loader is async, and
 * this reference has to be available inside a hook *and* inside synchronous
 * tests without a cache-busting dance or an async table. Emitting CommonJS makes
 * a plain `require` load it, which is the only synchronous path there is.
 *
 * **Three.js is bundled, not left external, and that is the point.** esbuild
 * resolves `three` from v1's own nearest-first `node_modules` walk — v1 ships
 * 0.160.1 while the viewer runs 0.180.0 — so the reference side really is v1's
 * own Three.js, and nothing is imported through CF2's module graph. That version
 * gap is also why the bounding-box tolerance is not zero.
 */
function loadBundledModule(entry: string): Record<string, unknown> {
  const result = buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
    nodePaths: [HOST_NODE_MODULES],
  });
  const output = result.outputFiles[0];
  if (output === undefined) {
    throw new Error(`esbuild produced no output for the v1 reference module ${entry}`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'contextforge-v1-reference-'));
  try {
    const file = join(dir, 'v1.cjs');
    writeFileSync(file, output.text, 'utf-8');
    // `createRequire` from the temp path rather than this file's own path: the
    // bundled Three.js must resolve from *v1's* tree, which esbuild already
    // inlined, so nothing here depends on the loader's location.
    return createRequire(file)(file) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Load v1's real kart module and roster.
 *
 * Requires the canvas DOM stub to be installed first — see `installCanvasDomStub`
 * — and refuses to return anything incomplete, so a v1 that cannot be loaded
 * fails loudly instead of leaving a comparison that quietly has no reference.
 */
function buildV1Reference(): V1Reference {
  const kartModule = loadBundledModule(V1_KART_ENTRY);
  const charactersModule = loadBundledModule(V1_CHARACTERS_ENTRY);

  const KartCtor = kartModule['Kart'];
  const roster = charactersModule['CHARACTERS'];
  if (typeof KartCtor !== 'function') {
    throw new Error(
      `${V1_KART_ENTRY} exports no \`Kart\` class (saw: ${Object.keys(kartModule).join(', ')}). ` +
        'The parity comparison cannot be made, and refusing here is the point: an absent reference ' +
        'must never look like a matching one.',
    );
  }
  if (!Array.isArray(roster)) {
    throw new Error(
      `${V1_CHARACTERS_ENTRY} exports no \`CHARACTERS\` array (saw: ` +
        `${Object.keys(charactersModule).join(', ')}). Without v1's roster the comparison would ` +
        'be against colours this test made up.',
    );
  }

  const characters = roster as readonly V1Character[];

  /** A scene that can only be added to; v1's constructor calls `scene.add`. */
  const discardScene = { add: (): void => undefined };

  return {
    characters,
    buildKart(characterId: string, headgear: string): V1Kart {
      const base = characters.find((c) => c.id === characterId);
      if (base === undefined) {
        throw new Error(
          `v1 has no character "${characterId}" (it has: ` +
            `${characters.map((c) => c.id).join(', ')}). The combination under test does not ` +
            'exist in v1, so there is nothing to compare the viewer against.',
        );
      }
      const character: V1Character = { ...base, headgear };
      const loggedBefore = canvasDrawLog.length;

      // `new` over an `unknown` ctor: the module is third-party JavaScript with
      // no declaration, and R1 forbids reaching for `any` to say so.
      const Kart = KartCtor as unknown as new (
        scene: unknown,
        track: unknown,
        options: { character: V1Character; isPlayer: boolean; aiIndex: number },
      ) => {
        mesh: THREE.Object3D;
        exhaustGlows: unknown[];
        steeringWheel: THREE.Object3D;
        wheels: unknown[];
        starRing: THREE.Object3D;
      };

      // `track` is null because `buildMesh` never reads it: passing a real track
      // would add a second thing that can throw without adding any coverage of
      // the geometry under test.
      //
      // The log index is taken *before* the build, not after. `captureFirstDraws`
      // slices the shared log from this index, so reading it afterwards would
      // slice from `undefined` — which returns the whole log, including whatever
      // the other builder painted earlier, and yields a 14-entry record compared
      // against a 7-entry one. That is the harness lying, not a parity difference.
      const drawsBeforeV1 = canvasDrawLog.length;
      const kart = new Kart(discardScene, null, { character, isPlayer: false, aiIndex: 0 });

      // The first v1 build is the one that paints the glow (v1 caches it in a
      // module-level variable), so this is the moment to record what it drew.
      captureFirstDraws(firstV1Draws, drawsBeforeV1);

      return {
        mesh: kart.mesh,
        animatedHandleNames: [
          ...kart.wheels.map((wheel) => (wheel as { pivot: THREE.Object3D }).pivot.name),
          kart.steeringWheel.name,
          ...kart.exhaustGlows.map((glow) => (glow as THREE.Object3D).name),
          kart.starRing.name,
        ],
      };
    },
  };
}

// ── Tree capture and comparison ─────────────────────────────────────────────

/** One node of a kart tree, captured as plain data. */
interface TreeNode {
  /** Slash-joined names from the kart root, e.g. `Kart_Driver/Driver_Torso`. */
  readonly path: string;
  readonly name: string;
  readonly type: string;
  readonly children: number;
  readonly boxMin: readonly [number, number, number];
  readonly boxMax: readonly [number, number, number];
}

/**
 * How far two bounding boxes may differ before it is called a difference.
 *
 * The measured difference across the whole matrix is **exactly zero** — all six
 * box coordinates match bit for bit, at every level of every tree — so this is
 * not an allowance for known drift. It exists for one honest reason: the v1 side
 * runs the Three.js v1 shipped (0.160.1) and the viewer runs the app's (0.180.0),
 * and `Box3.setFromObject` accumulates its corners through that version's own
 * float arithmetic.
 *
 * 1e-6 world units is ~1 micrometre at kart scale: five orders of magnitude
 * below the kart's smallest feature (the 0.028-radius helmet rim tube) and
 * ~2.2 million times finer than the 2.242-unit kart half-width. No change a
 * player could see can hide inside it, so anything larger than this is a real
 * geometry difference and is reported with its path and both values.
 */
const BBOX_EPSILON = 1e-6;

/**
 * Capture a kart tree as flat data, depth first.
 *
 * The root's own `name` is deliberately left out of `path`: the viewer renames an
 * instance root to the scene-file instance id (`buildSceneGraph` does this, and
 * must — the outliner keys on it), so including it would report a difference
 * that is the viewer's contract rather than a defect. The root's `name` is
 * still captured in `name`, and the caller asserts it separately.
 */
function captureTree(root: THREE.Object3D): TreeNode[] {
  const nodes: TreeNode[] = [];
  root.updateMatrixWorld(true);

  const walk = (node: THREE.Object3D, path: string): void => {
    const box = new THREE.Box3().setFromObject(node);
    nodes.push({
      path,
      name: node.name,
      type: node.type,
      children: node.children.length,
      boxMin: [box.min.x, box.min.y, box.min.z],
      boxMax: [box.max.x, box.max.y, box.max.z],
    });
    node.children.forEach((child, index) => {
      // The index keeps paths unique if two siblings ever share a name; without
      // it, a duplicated name would collapse two real nodes into one path.
      const label = child.name === '' ? `#${index}` : child.name;
      walk(child, path === '' ? label : `${path}/${label}`);
    });
  };

  walk(root, '');
  return nodes;
}

/** Every node in the subtree, root included. */
function nodeCount(root: THREE.Object3D): number {
  let count = 0;
  root.traverse(() => {
    count += 1;
  });
  return count;
}

/**
 * Describe every way `viewer` differs from `v1`, as one sentence per
 * difference, each naming the node path, the property, and both values.
 *
 * Returns an empty array when the trees agree. Names are compared against the
 * **v1 side's** paths, because that is the side being treated as the answer; a
 * renamed or missing viewer node therefore reads as "v1's `X` is missing from
 * the viewer", which is the actionable sentence.
 *
 * The root row (`path === ''`) is skipped by name comparison only. Its child
 * count and its bounding box are still compared: the viewer must enclose exactly
 * the same volume, at the same scale, as v1 does.
 */
function diffTrees(v1: readonly TreeNode[], viewer: readonly TreeNode[]): string[] {
  const differences: string[] = [];
  const at = (index: number, node: TreeNode | undefined): string =>
    node === undefined ? '(no such node)' : (node.path === '' ? '(kart root)' : node.path);

  if (v1.length !== viewer.length) {
    differences.push(
      `whole tree: v1 has ${v1.length} objects, the viewer has ${viewer.length} ` +
        `(difference of ${viewer.length - v1.length})`,
    );
  }

  const count = Math.max(v1.length, viewer.length);
  for (let index = 0; index < count; index += 1) {
    const reference = v1[index];
    const actual = viewer[index];
    if (reference === undefined || actual === undefined) {
      differences.push(
        `index ${index}: v1 has ${at(index, reference)}, the viewer has ${at(index, actual)}`,
      );
      continue;
    }

    const where = (node: TreeNode): string => (node.path === '' ? '(kart root)' : node.path);

    if (reference.path !== actual.path) {
      differences.push(
        `${where(reference)}: v1's tree path is "${reference.path}", the viewer's is "${actual.path}"`,
      );
    }
    if (reference.path !== '' && reference.name !== actual.name) {
      differences.push(
        `${where(reference)}: name is "${reference.name}" in v1, "${actual.name}" in the viewer`,
      );
    }
    if (reference.type !== actual.type) {
      differences.push(
        `${where(reference)}: object type is ${reference.type} in v1, ${actual.type} in the viewer`,
      );
    }
    if (reference.children !== actual.children) {
      differences.push(
        `${where(reference)}: child count is ${reference.children} in v1, ${actual.children} in the viewer`,
      );
    }

    const axes = ['x', 'y', 'z'] as const;
    for (const side of ['boxMin', 'boxMax'] as const) {
      for (const [index2, axis] of axes.entries()) {
        const expected = reference[side][index2];
        const got = actual[side][index2];
        if (Math.abs(expected - got) > BBOX_EPSILON) {
          differences.push(
            `${where(reference)}: bounding box ${side}.${axis} is ${expected} in v1, ${got} in the ` +
              `viewer (Δ ${got - expected}, tolerance ${BBOX_EPSILON})`,
          );
        }
      }
    }
  }

  return differences;
}

// ── The matrix ──────────────────────────────────────────────────────────────

/**
 * The four combinations compared.
 *
 * Chosen so that every distinct branch of v1's `buildDriver` is reached and so
 * that neither axis varies alone:
 *
 *  - `dash` / `helmet` — dash is both the default character and dash's own
 *    headgear, so this is also what a caller gets by naming only
 *    `character: 'dash'`. Takes the `hairCoversHead` branch with
 *    `buildHelmet` (3 objects, no `Driver_Hair`).
 *  - `dash` / `cap` — the *same character* with different headgear, so a change
 *    between these two can only have come from the headgear parameter.
 *  - `luna` / `cap` — a second character whose colours are unrelated to dash's,
 *    with `hairCoversHead` false (`Driver_Hair`) and the per-character
 *    `Driver_Ponytail` branch that `id === 'luna'` adds.
 *  - `rex` / `helmet-full` — the other full-headgear branch
 *    (`buildFullHelmet`), reached from a third character and a third headgear
 *    colour, so `buildFullHelmet` is covered from both sides rather than only
 *    as the same code with different numbers.
 */
const MATRIX: ReadonlyArray<{ character: string; headgear: string }> = [
  { character: 'dash', headgear: 'helmet' },
  { character: 'dash', headgear: 'cap' },
  { character: 'luna', headgear: 'cap' },
  { character: 'rex', headgear: 'helmet-full' },
];

describe('Real Prefabs — bundling, loading, and tree fidelity', () => {
  it('bundles prefabs/ with esbuild to a browser ES module and loads real executable prefabs', async () => {
    const bundle = await bundlePrefabsForBrowser(KART_PROJECT_DIR);
    try {
      expect(bundle.code).toBeDefined();
      expect(bundle.code.length).toBeGreaterThan(1000);

      // Load into the renderer viewport registry
      const prefabs = await loadPrefabBundle(bundle.code);
      expect(prefabs.length).toBeGreaterThanOrEqual(3);

      const prefabNames = prefabs.map((p) => p.name).sort();
      expect(prefabNames).toContain('kart');
      expect(prefabNames).toContain('trackSegment');
      expect(prefabNames).toContain('hazardCrate');

      // Ensure executable functions exist
      const kart = prefabs.find((p) => p.name === 'kart');
      expect(typeof kart?.create).toBe('function');
    } finally {
      bundle.handle.dispose();
    }
  });

  describe('kart parity against the v1 game’s own buildMesh / buildDriver', () => {
    /** The prefab bundle, loaded once and shared by the whole matrix. */
    let kartPrefab!: PrefabDefinition;
    /** v1's real `buildMesh` output for `dash`/`helmet`, reused by the helper tests. */
    let dashKart!: THREE.Object3D;

    beforeAll(async () => {
      const bundle = await bundlePrefabsForBrowser(KART_PROJECT_DIR);
      try {
        const prefabs = await loadPrefabBundle(bundle.code);
        const found = prefabs.find((p) => p.name === 'kart');
        if (found === undefined) {
          throw new Error(
            `The browser bundle for ${KART_PROJECT_DIR} contains no "kart" prefab ` +
              `(saw: ${prefabs.map((p) => p.name).join(', ')}). There is nothing to compare.`,
          );
        }
        kartPrefab = found;
      } finally {
        bundle.handle.dispose();
      }

      // v1 is loaded here rather than at module scope, because its module needs
      // the canvas stub installed before it can build a kart. If this throws,
      // every test below fails with this reason instead of quietly not running.
      dashKart = v1().buildKart('dash', 'helmet').mesh;
      if (dashKart.children.length === 0) {
        throw new Error(
          `v1's buildMesh returned a kart root with no children, so there is no tree to compare ` +
            'against. A comparison that cannot be made must fail, not pass.',
        );
      }
    });

    /**
     * v1's loaded reference, loaded on first use and then reused.
     *
     * v1's `kart.js` is bundled and executed here rather than statically
     * imported, because there is no resolvable `three` for a bare import from
     * that folder. The DOM stub is installed immediately before the import so
     * it is in place for the very first `buildMesh`.
     */
    function v1(): V1Reference {
      if (reference === null) {
        installCanvasDomStub();
        reference = buildV1Reference();
      }
      return reference;
    }

    /**
     * What the viewer builds for one combination, through its own code path:
     * scene file → `buildSceneGraph` → prefab `create` → object.
     */
    function buildInViewer(character: string, headgear: string): THREE.Object3D {
      // The prefab's own output first, because two things the viewer does need
      // values from it, and one of them would otherwise be guessed:
      //
      //  - `create` must be callable outside the viewer, or a prefab that only
      //    works when the viewer calls it cannot be compared at all;
      //  - the **root scale**. `buildSceneGraph` overwrites an instance's whole
      //    transform from the scene file, and v1's kart sets its own
      //    `KART_SCALE` on that root. So the scene file has to restate it, or
      //    the viewer would draw a kart at the scene file's scale and the
      //    comparison would report a bounding box that is off by exactly that
      //    ratio — which would be the test's artefact, not a defect.
      // Taken before `create`, for the same reason as v1's: slicing from
      // `undefined` would return the whole shared log and compare two records
      // that both contain the other side's draws.
      const drawsBeforePrefab = canvasDrawLog.length;
      const prefabOutput = kartPrefab.create(THREE, { character, headgear }, seededRng());
      const prefabRoot = prefabOutput.object as THREE.Object3D;
      const rootScale = prefabRoot.scale.toArray() as [number, number, number];

      // The first prefab build is the one that paints the glow (the prefab
      // caches it in a module-level variable), so this is the moment to record
      // what it drew — for the same reason v1's first build records its own.
      captureFirstDraws(firstPrefabDraws, drawsBeforePrefab);

      const scene = sceneFile({
        seed: 4242,
        instances: [
          {
            id: INSTANCE_ID,
            prefab: 'kart',
            name: INSTANCE_NAME,
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: rootScale },
            params: { character, headgear },
          },
        ],
      });

      const registry = indexPrefabDefinitions([kartPrefab]).index;
      const build = buildSceneGraph(scene, registry);
      expect(build.failures).toHaveLength(0);
      expect(build.errors).toHaveLength(0);

      const node = build.byId.get(INSTANCE_ID);
      if (node === undefined) {
        throw new Error('buildSceneGraph produced no node for the instance it was just given');
      }
      // A fallback mesh would satisfy any count the prefab happens to have, so
      // this is asserted before the tree is compared, not after.
      expect(node.placeholder).toBe(false);
      expect(isErrorMarker(node.object)).toBe(false);

      return node.object;
    }

    /** A deterministic rng for the direct prefab call; the kart uses none of it. */
    function seededRng(): () => number {
      let state = 0x2f6b79f5;
      return () => {
        state = (Math.imul(state ^ (state >>> 15), 1 | state) + 0x6d2b79f5) >>> 0;
        return (state >>> 8) / 0x1000000;
      };
    }

    it.each(MATRIX)(
      'matches v1 buildMesh/buildDriver for character=$character headgear=$headgear',
      ({ character, headgear }) => {
        const v1Kart = v1().buildKart(character, headgear);
        const viewerKart = buildInViewer(character, headgear);

        // The reference and the subject are built from different files in
        // different projects; if they were the same tree the comparison below
        // would be vacuous, so the provenance is asserted too.
        expect(V1_KART_ENTRY).not.toBe(resolve(KART_PROJECT_DIR, 'prefabs/kart.ts'));

        const v1Tree = captureTree(v1Kart.mesh);
        const viewerTree = captureTree(viewerKart);

        // The viewer's contract: the root is renamed to the scene file's
        // instance name so the outliner can key on it. Asserted rather than
        // ignored, and checked against what the scene file asked for, so it is
        // clear this is a naming policy and not a hidden difference.
        expect(viewerKart.name).toBe(INSTANCE_NAME);
        expect(v1Kart.mesh.name).toBe('Kart_AI_0');

        // v1's root child count, read from v1 and used for the viewer's, so no
        // magic number can rot into the test and a prefab change cannot be
        // rubber-stamped by a hard-coded total.
        expect(viewerKart.children.length).toBe(v1Kart.mesh.children.length);

        // Anti-fallback: a single box would pass any name comparison that only
        // looked at the root, so the total node count is compared too.
        expect(nodeCount(viewerKart)).toBe(nodeCount(v1Kart.mesh));

        const differences = diffTrees(v1Tree, viewerTree);
        expect(
          differences,
          `viewer kart (character=${character}, headgear=${headgear}) differs from v1's buildMesh` +
            `${differences.length === 0 ? '' : `:\n  ${differences.join('\n  ')}`}`,
        ).toEqual([]);

        // The v1 build is genuinely nested — kart → driver → mesh — and this
        // comparison is not a single object. A reference that regressed to one
        // flat group would satisfy every count above while comparing nothing
        // below the root, so the depth is checked directly, by name.
        const v1NodePaths = v1Tree.map((node) => node.path);
        const viewerNodePaths = captureTree(viewerKart).map((node) => node.path);
        expect(v1NodePaths.filter((path) => path === '')).toHaveLength(1);
        expect(viewerNodePaths).toEqual(v1NodePaths);
        expect(
          v1NodePaths.some((path) => path === 'Kart_Driver/Driver_Torso'),
          `v1's kart has no "Kart_Driver/Driver_Torso" (it built: ` +
            `${v1NodePaths.filter((path) => path !== '').join(', ')}), so the reference is not ` +
            'the real buildMesh and this comparison would be meaningless.',
        ).toBe(true);
      },
    );

    it('exposes the same animated handles the game animates', () => {
      // v1's `update()` moves `wheels[].pivot`, `steeringWheel`, `exhaustGlows`
      // and `starRing`. The prefab has to hand the viewer the same handles, or
      // a viewer that animates from `parts` would drive nothing while the trees
      // still matched perfectly — a parity check on geometry alone cannot see it.
      const direct = kartPrefab.create(THREE, { character: 'dash', headgear: 'helmet' }, seededRng());
      // The expected order is JavaScript's own, not a hand-written one:
      // `sort()` orders `'starRing'` before `'steeringWheel'`, and asserting the
      // sorted list of the *actual* keys is what states "the prefab exposes
      // these four, and nothing else" without a hand-written ordering to
      // misremember.
      expect(Object.keys(direct.parts).toSorted()).toEqual(
        Object.keys({ exhaustGlows: 0, steeringWheel: 0, starRing: 0, wheels: 0 }).toSorted(),
      );

      const viewerKart = buildInViewer('dash', 'helmet');
      const viewerNames = new Set(captureTree(viewerKart).map((node) => node.name));

      const v1HandleNames = v1().buildKart('dash', 'helmet').animatedHandleNames;
      // Derived from v1's own `buildMesh`, not from the prefab: v1 animates four
      // wheel pivots, one steering wheel, two exhaust glows and one star ring,
      // and this states that set so a change in v1 is caught here instead of
      // being quietly satisfied by whatever the prefab happens to expose.
      // Same trap as the `parts` keys above: `Kart_StarRing` sorts before
      // `Kart_SteeringWheel`, so the expected list is sorted by JavaScript's own
      // comparator rather than by eye.
      expect(v1HandleNames.toSorted()).toEqual(
        [
          'Kart_ExhaustGlow_0',
          'Kart_ExhaustGlow_1',
          'Kart_SteeringWheel',
          'Kart_StarRing',
          'Kart_WheelPivot_0',
          'Kart_WheelPivot_1',
          'Kart_WheelPivot_2',
          'Kart_WheelPivot_3',
        ].toSorted(),
      );
      for (const handleName of v1HandleNames) {
        expect(
          viewerNames.has(handleName),
          `v1 animates "${handleName}" but the viewer's kart has no node with that name, ` +
            'so the animation handles the game relies on cannot address it.',
        ).toBe(true);
      }
    });

    it('paints the exhaust glow with exactly the instructions v1 painted it with', () => {
      // The glow is the kart's only texture, and it is the one thing in the
      // build that geometry comparisons cannot reach — which makes it the one
      // place a canvas stub could quietly turn a difference into a pass. So the
      // stub *records* every call, and the reference is v1's own record rather
      // than a copy of its drawing code: nothing in the expectation comes from
      // the prefab, and nothing is hand-written from reading either side. A stub
      // that silently no-op'd would leave both records empty and be caught by
      // the two non-empty assertions below.
      const v1Record = firstV1Draws.current;
      const prefabRecord = firstPrefabDraws.current;

      expect(
        v1Record,
        'v1 never drew on the stubbed canvas, so its exhaust glow was not built and there is ' +
          'no texture to compare the viewer against.',
      ).not.toBeNull();
      expect(
        prefabRecord,
        'the prefab never drew on the stubbed canvas, which means it did not build its exhaust ' +
          'glow texture at all. The viewer would draw an untextured additive sprite where v1 ' +
          'draws a glowing one.',
      ).not.toBeNull();

      expect(prefabRecord).toEqual(v1Record);
    });

    it('gives the exhaust glow the same material the game used', () => {
      // Deliberately about the *material*, not the texture: the prefab's
      // browser texture factory leaves `wrapS`/`wrapT`/`anisotropy`/`colorSpace`
      // at their Three.js defaults where v1's `createTexture` sets
      // `RepeatWrapping`/`4`/`SRGBColorSpace`. Those four are texture-sampling
      // state and are NOT asserted as parity here (they are a real, reported
      // difference — see the module header); everything that decides whether
      // the glow composites at all is asserted.
      const viewerKart = buildInViewer('dash', 'helmet');
      const v1Kart = v1().buildKart('dash', 'helmet').mesh;

      for (const glowName of ['Kart_ExhaustGlow_0', 'Kart_ExhaustGlow_1']) {
        const viewerGlow = viewerKart.getObjectByName(glowName) as THREE.Sprite | undefined;
        const v1Glow = v1Kart.getObjectByName(glowName) as THREE.Sprite | undefined;
        if (viewerGlow === undefined || v1Glow === undefined) {
          throw new Error(`Both trees were expected to contain "${glowName}"`);
        }

        const viewerMaterial = viewerGlow.material as THREE.SpriteMaterial;
        const v1Material = v1Glow.material as THREE.SpriteMaterial;

        expect(viewerGlow.type).toBe(v1Glow.type);
        expect(viewerMaterial.type).toBe(v1Material.type);
        expect(viewerMaterial.blending).toBe(v1Material.blending);
        expect(viewerMaterial.transparent).toBe(v1Material.transparent);
        expect(viewerMaterial.depthWrite).toBe(v1Material.depthWrite);
        expect(viewerMaterial.fog).toBe(v1Material.fog);
        expect(viewerGlow.scale.toArray()).toEqual(v1Glow.scale.toArray());
        expect(viewerGlow.visible).toBe(v1Glow.visible);
      }
    });

    it('reports the path and both values when a tree differs', () => {
      // A differ that always returned "no differences" would make the four
      // tests above pass for the wrong reason, so it is exercised against
      // three deliberate breakages of the viewer's own tree. Each breakage is
      // then *undone* and the reference re-compared, because a differ that
      // reports a difference for a matching tree is just as wrong.
      const reference = captureTree(dashKart);

      const renamed = buildInViewer('dash', 'helmet').clone(true);
      const firstChild = renamed.children[0];
      if (firstChild === undefined) {
        throw new Error('The viewer kart had no children to rename, so nothing could be tested');
      }
      firstChild.name = 'Kart_Chassis_TYPO';
      // Two differences, and both must be reported: the object's path is now
      // wrong, and so is its name. Reporting only one of them would leave a
      // reader with a half-truth about what changed.
      const nameDiffs = diffTrees(reference, captureTree(renamed));
      expect(nameDiffs).toHaveLength(2);
      expect(
        nameDiffs.some(
          (line) => line.includes('Kart_Chassis') && line.includes('Kart_Chassis_TYPO'),
        ),
      ).toBe(true);
      expect(
        nameDiffs.some((line) => line.includes('name is "Kart_Chassis" in v1') && line.includes('"Kart_Chassis_TYPO" in the viewer')),
      ).toBe(true);

      // The *last* child, because removing anything earlier would shift every
      // later sibling and drown the one missing node in a wall of path diffs.
      // What is being tested here is the report about a vanished node.
      const missingChild = buildInViewer('dash', 'helmet').clone(true);
      const removed = missingChild.children.at(-1);
      if (removed === undefined) {
        throw new Error('The viewer kart had no children to remove, so nothing could be tested');
      }
      const removedName = removed.name;
      missingChild.remove(removed);
      const childDiffs = diffTrees(reference, captureTree(missingChild));
      expect(
        childDiffs.some((line) => line.includes('(kart root)') && line.includes('child count')),
      ).toBe(true);
      expect(childDiffs.some((line) => line.startsWith('whole tree:'))).toBe(true);
      // The node that was removed is named, so the report says what is missing
      // and not merely that some count changed.
      expect(
        childDiffs.some(
          (line) => line.includes(removedName) && line.includes('the viewer has (no such node)'),
        ),
      ).toBe(true);

      const moved = buildInViewer('dash', 'helmet').clone(true);
      const chassis = moved.children[0];
      if (chassis === undefined) {
        throw new Error('The viewer kart had no chassis to move, so nothing could be tested');
      }
      chassis.position.y += 0.5;
      const boxDiffs = diffTrees(reference, captureTree(moved));
      expect(boxDiffs.length).toBeGreaterThan(0);
      expect(boxDiffs.every((line) => line.includes('bounding box') || line.includes('whole tree'))).toBe(
        true,
      );
      expect(boxDiffs.some((line) => line.includes('bounding box boxMax.y'))).toBe(true);

      // Undo each breakage: the viewer tree the prefab really produces must
      // report zero differences against v1, which is what proves the differ is
      // discriminating rather than merely noisy.
      firstChild.name = 'Kart_Chassis';
      missingChild.add(removed);
      chassis.position.y -= 0.5;
      expect(diffTrees(reference, captureTree(renamed))).toEqual([]);
      expect(diffTrees(reference, captureTree(missingChild))).toEqual([]);
      expect(diffTrees(reference, captureTree(moved))).toEqual([]);
    });

    it('uses the same character colours v1 uses', () => {
      // The tree comparison cannot see colour: every material colour comes from
      // the roster, so a prefab fed the wrong roster would still produce the
      // right names and the right bounding box.
      for (const { character, headgear } of MATRIX) {
        const loaded = v1();
        const rosterEntry = loaded.characters.find((c) => c.id === character);
        if (rosterEntry === undefined) {
          throw new Error(`v1 has no character "${character}" to read colours from`);
        }

        const viewerKart = buildInViewer(character, headgear);
        const v1Kart = loaded.buildKart(character, headgear).mesh;

        const viewerColours = new Map<string, string>();
        viewerKart.traverse((node) => {
          const material = node.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(material) || material === undefined) return;
          const colour = (material as THREE.MeshStandardMaterial).color;
          if (colour === undefined) return;
          viewerColours.set(node.name, `#${colour.getHexString()}`);
        });

        const v1Colours = new Map<string, string>();
        v1Kart.traverse((node) => {
          const material = node.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(material) || material === undefined) return;
          const colour = (material as THREE.MeshStandardMaterial).color;
          if (colour === undefined) return;
          v1Colours.set(node.name, `#${colour.getHexString()}`);
        });

        expect([...viewerColours.keys()].sort()).toEqual([...v1Colours.keys()].sort());
        for (const [nodeName, hex] of v1Colours) {
          expect(
            viewerColours.get(nodeName),
            `material colour of "${nodeName}" is ${hex} in v1 for ` +
              `character=${character}, headgear=${headgear}`,
          ).toBe(hex);
        }

        // And the colours really are the roster's, so a prefab that shipped its
        // own palette would be caught even if v1's and its own happened to agree
        // on a node's material by accident.
        expect(new Set(v1Colours.values())).toContain(
          `#${new THREE.Color(rosterEntry.colors['kartBody'] ?? 0).getHexString()}`,
        );
      }
    });
  });

  it('a prefab that throws shows the red placeholder box and emits an AppError', async () => {
    const bundle = await bundlePrefabsForBrowser(KART_PROJECT_DIR);
    try {
      const prefabs = await loadPrefabBundle(bundle.code);
      const hazardCrate = prefabs.find((p) => p.name === 'hazardCrate')!;
      expect(hazardCrate).toBeDefined();

      const instanceId = 'hazard_crate_1';
      const scene = sceneFile({
        instances: [
          {
            id: instanceId,
            prefab: 'hazardCrate',
            params: { explosive: true },
          },
        ],
      });

      const registry = indexPrefabDefinitions([hazardCrate]).index;
      const build = buildSceneGraph(scene, registry);

      // 1. Shows red placeholder box
      const node = build.byId.get(instanceId);
      expect(node).toBeDefined();
      expect(node?.placeholder).toBe(true);
      expect(isErrorMarker(node!.object)).toBe(true);

      const markerMesh = node!.object as THREE.Mesh;
      const material = markerMesh.material as THREE.MeshBasicMaterial;
      expect(material.color.getHex()).toBe(MARKER_COLOR); // 0xff3b30 (red)

      // 2. Emits an AppError
      expect(build.errors).toHaveLength(1);
      const appErr = build.errors[0] as AppError;
      expect(appErr).toBeDefined();
      expect(appErr.scope).toBe('instance');
      expect(appErr.instanceId).toBe(instanceId);
      expect(appErr.short).toContain('hazardCrate');
      expect(appErr.short).toContain('Corrupted GLTF buffer');
      expect(appErr.details).toContain('failed to decode geometry');

      // Failure record also contains the AppError
      expect(build.failures).toHaveLength(1);
      expect(build.failures[0]?.appError).toEqual(appErr);

      // Marker userData contains the AppError
      expect(node!.object.userData['appError']).toEqual(appErr);
    } finally {
      bundle.handle.dispose();
    }
  });

  it('emits AppError through assembleScene and problem list when a prefab throws', () => {
    const throwingPrefab: PrefabDefinition = {
      name: 'kaboom',
      description: 'Throws inside create',
      paramsSchema: {} as any,
      create() {
        throw new Error('Exploded during mesh construction');
      },
    };

    const scene = sceneFile({
      instances: [{ id: 'kaboom_inst', prefab: 'kaboom' }],
    });

    const assembled = assembleScene(scene, indexPrefabDefinitions([throwingPrefab]).index);

    expect(assembled.placeholderCount).toBe(1);
    expect(assembled.errors).toHaveLength(1);
    expect(assembled.problems).toHaveLength(1);

    const error = assembled.errors[0]!;
    expect(error.scope).toBe('instance');
    expect(error.instanceId).toBe('kaboom_inst');
    expect(error.short).toContain('Exploded during mesh construction');

    const problem = assembled.problems[0]!;
    expect(problem.level).toBe('error');
    expect(problem.appError).toBe(error);
  });

  it('wires Viewport.onError and callbacks.onError subscription correctly', () => {
    const vp = Object.create(Viewport.prototype) as any;
    vp.callbacks = {
      onError: (err: AppError) => callbackErrors.push(err),
    };
    vp.errorListeners = [];

    const callbackErrors: AppError[] = [];
    const listenerErrors: AppError[] = [];

    const unsubscribe = vp.onError((err: AppError) => {
      listenerErrors.push(err);
    });

    const testError: AppError = {
      id: 'err:123',
      scope: 'instance',
      instanceId: 'kart_inst',
      short: 'Test instance error',
    };

    vp.emitError(testError);

    expect(callbackErrors).toHaveLength(1);
    expect(callbackErrors[0]).toBe(testError);
    expect(listenerErrors).toHaveLength(1);
    expect(listenerErrors[0]).toBe(testError);

    unsubscribe();
    vp.emitError(testError);
    expect(listenerErrors).toHaveLength(1); // not called after unsubscribe
  });

  it('refuses fallback mesh creation when prefab definition has no create function', () => {
    clearRegisteredPrefabs();
    // A prefab definition without a create function must NOT generate fallback geometry
    const invalidPrefab = {
      name: 'kart',
      description: 'Fake kart without create function',
      paramsSchema: {} as any,
    } as unknown as PrefabDefinition;

    const scene = sceneFile({
      instances: [{ id: 'kart_no_create', prefab: 'kart' }],
    });

    const registry = indexPrefabDefinitions([invalidPrefab]).index;
    const build = buildSceneGraph(scene, registry);

    const node = build.byId.get('kart_no_create');
    expect(node).toBeDefined();
    // Must be a placeholder, not a fallback mesh!
    expect(node?.placeholder).toBe(true);
    expect(isErrorMarker(node!.object)).toBe(true);

    // AppError emitted
    expect(build.errors).toHaveLength(1);
    expect(build.errors[0]?.short).toContain('has no create() function');
  });

  it('asserts kart instances render real child meshes (no isErrorMarker), and only hazardCrate is a placeholder', async () => {
    const bundle = await bundlePrefabsForBrowser(KART_PROJECT_DIR);
    try {
      await loadPrefabBundle(bundle.code);

      const scene = sceneFile({
        instances: [
          {
            id: 'track',
            prefab: 'trackSegment',
            params: { width: 16, length: 50, color: '#24262b' },
          },
          {
            id: 'player_kart',
            prefab: 'kart',
            params: { character: 'dash', headgear: 'helmet' },
          },
          {
            id: 'rival_luna',
            prefab: 'kart',
            params: { character: 'luna', headgear: 'cap' },
          },
          {
            id: 'rival_rex',
            prefab: 'kart',
            params: { character: 'rex' },
          },
          {
            id: 'hazard_crate',
            prefab: 'hazardCrate',
            params: {},
          },
        ],
      });

      const build = buildSceneGraph(scene, new Map());

      // Kart instances must render real Three.js child meshes, NOT error markers
      for (const kartId of ['player_kart', 'rival_luna', 'rival_rex']) {
        const kartNode = build.byId.get(kartId);
        expect(kartNode, `${kartId} must be in scene graph`).toBeDefined();
        expect(kartNode?.placeholder, `${kartId} must not be a placeholder`).toBe(false);
        expect(isErrorMarker(kartNode!.object), `${kartId} must not be an error marker`).toBe(false);
        // Real child meshes (wheels, chassis, spoiler, driver, helmet)
        expect(kartNode!.object.children.length, `${kartId} must have child meshes`).toBeGreaterThan(0);
      }

      // Track segment with valid params is also a real mesh
      const trackNode = build.byId.get('track');
      expect(trackNode).toBeDefined();
      expect(trackNode?.placeholder).toBe(false);
      expect(isErrorMarker(trackNode!.object)).toBe(false);

      // Hazard crate deliberately throws corrupted GLTF buffer, so it is a placeholder
      const hazardNode = build.byId.get('hazard_crate');
      expect(hazardNode).toBeDefined();
      expect(hazardNode?.placeholder).toBe(true);
      expect(isErrorMarker(hazardNode!.object)).toBe(true);

      // Only hazardCrate is a placeholder in this scene
      const placeholders = [...build.byId.values()].filter((n) => n.placeholder);
      expect(placeholders.map((p) => p.id)).toEqual(['hazard_crate']);
    } finally {
      bundle.handle.dispose();
    }
  });
});
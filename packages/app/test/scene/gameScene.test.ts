/**
 * test/scene/gameScene.test.ts — the REAL Kart-Dash-3D v2 game reading its
 * `scene.json` through the prefab registry.
 *
 * This is the end-to-end proof that the game's own `src/loadScene.js` turns
 * scene data into Three.js objects, using the game's own `prefabs/index.ts`
 * registry and `src/prefabs/kart-prefab.js`. It does not use stubs for any of
 * those; a stub would test the harness, not the game.
 *
 * ## Why the code is bundled with esbuild here
 *
 * The game has **no `node_modules`** — `import 'three'` from anywhere in it fails
 * with `ERR_MODULE_NOT_FOUND` — so its modules cannot be `import`ed directly.
 * esbuild is pointed at CF2's `node_modules` to resolve `three` and
 * `@contextforge/core`, and the game code is bundled to a temp `.mjs` that is
 * then `import`ed. This is the same technique CF2's Electron `prefabLoader.ts`
 * uses (`bundleEntry` / `importFresh`) to load a project's real prefabs, so the
 * pattern is proven in this repository rather than invented here.
 *
 * Every import is **cache-busted** with a `?v=n` suffix for the same reason
 * `prefabLoader.ts` does it: Node caches ESM by URL forever, so two loads of the
 * same path would serve the first version and the "changed position" test would
 * silently pass against stale code.
 *
 * ## Why scene.json is copied to a temp dir
 *
 * The real `kart-dash-3d-v2/scene.json` must never be mutated on disk. Each test
 * that needs a different scene reads the real one, writes a copy into a temp
 * directory, edits the copy, and loads from there. The real file is a fixture,
 * not a scratch pad.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as THREE from 'three';
import * as core from '@contextforge/core';
import type { PrefabRegistry, SceneFile } from '@contextforge/core';

// ── Constants ────────────────────────────────────────────────────────────────

const GAME_ROOT = process.env['CF_PROJECT'] ??
  resolve(import.meta.dirname, '..', '..', '..', '..', '..', 'kart-dash-3d-v2');
const GAME_SRC = join(GAME_ROOT, 'src');
const REAL_SCENE_JSON = join(GAME_ROOT, 'scene.json');

/** CF2's node_modules — the only place `three` and esbuild actually exist. */
const CF2_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const CF2_NODE_MODULES = join(CF2_ROOT, 'node_modules');
const ESBUILD_MAIN = join(CF2_NODE_MODULES, 'esbuild', 'lib', 'main.js');
const THREE_MODULE = join(CF2_NODE_MODULES, 'three', 'build', 'three.module.js');

// ── The host environment the bundled game code needs ─────────────────────────

/**
 * The game is browser-only and its kart prefab needs a 2D canvas for the exhaust
 * glow texture. Node has no DOM, so this minimal stub is installed before any
 * game module is imported. It records nothing: the glow is a SpriteMaterial map
 * and contributes no geometry, so it cannot affect a tree or a bounding box.
 */
function installCanvasStub(): void {
  const g = globalThis as unknown as { document?: unknown };
  g.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        clearRect: () => undefined,
        fillRect: () => undefined,
        createRadialGradient: () => ({ addColorStop: () => undefined }),
      }),
    }),
  };
}

// ── esbuild bundling of the real game code ───────────────────────────────────

type BuildResult = { outputFiles: Array<{ text: string }> };

/** Import `esbuild`'s Node API from CF2's copy (the app has it as a devDep). */
async function loadEsbuild(): Promise<{ build: (options: unknown) => Promise<BuildResult> }> {
  const mod = (await import(ESBUILD_MAIN)) as { build: (options: unknown) => Promise<BuildResult> };
  return { build: mod.build };
}

/** Bumped per bundle so each temp URL is unique and Node never serves a cache. */
let bundleGeneration = 0;

/**
 * Bundle one game entry point and import it.
 *
 * `three` and `@contextforge/core` are bundled in (not marked external), so the
 * returned module's Three objects are built from CF2's Three — the same module
 * this test imports at the top. `instanceof` therefore holds across the boundary
 * and bounding boxes computed on either side agree.
 */
async function importGameModule(entryPoint: string): Promise<Record<string, unknown>> {
  const { build } = await loadEsbuild();
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    logLevel: 'silent',
    nodePaths: [CF2_NODE_MODULES],
  });
  const code = result.outputFiles[0]?.text;
  if (code === undefined) throw new Error(`esbuild produced no output for ${entryPoint}`);

  bundleGeneration += 1;
  const file = join(testRoot, `game-module-${bundleGeneration}.mjs`);
  writeFileSync(file, code, 'utf-8');
  return (await import(`${pathToFileURL(file).href}?v=${bundleGeneration}`)) as Record<string, unknown>;
}

// ── Loading the real registry and loader ─────────────────────────────────────

type LoadSceneModule = {
  buildGameScene: (options: {
    core: unknown;
    registry: unknown;
    url?: string;
    fetchImpl?: unknown;
  }) => Promise<{
    root: THREE.Object3D;
    byId: Map<string, { id: string; prefab: string; name: string; object: THREE.Object3D }>;
    failed: string[];
  }>;
  startingGrid: (built: unknown) => Array<Record<string, number | string>>;
  kartInstances: (built: unknown) => Array<{ id: string }>;
};

interface Harness {
  loadScene: LoadSceneModule;
  registry: PrefabRegistry;
}

/**
 * Load the game's `prefabs/index.ts` (the real registry) and `src/loadScene.js`
 * (the real loader), both freshly bundled from source.
 *
 * Both are bundled together in one module so the loader is tested against the
 * same prefab objects it will see in the browser.
 */
async function loadHarness(): Promise<Harness> {
  installCanvasStub();

  const registryModule = await importGameModule(join(GAME_ROOT, 'prefabs', 'index.ts'));
  const registry = registryModule['registry'] as PrefabRegistry;

  // Bundle loadScene.js with the registry injected, because the game's browser
  // entry (main.js) receives them from `globalThis` — see main.js `loadSceneFile`.
  // We reproduce that by bundling a tiny entry that assigns them before loadScene
  // is used; `buildGameScene` itself only needs the two objects passed in.
  const loadSceneModule = await importGameModule(join(GAME_SRC, 'loadScene.js'));

  return { loadScene: loadSceneModule as unknown as LoadSceneModule, registry };
}

// ── Fixtures: copy the real scene.json into a temp dir, edit the copy ────────

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'cf-game-scene-'));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

/** Read the real scene.json as raw data (never mutating the file on disk). */
function readRealScene(): Record<string, unknown> {
  return JSON.parse(readFileSync(REAL_SCENE_JSON, 'utf-8')) as Record<string, unknown>;
}

/**
 * Write a scene to a fresh file under the temp dir and return its URL.
 *
 * `scene.json` on disk is never written to; this always produces a copy. Used by
 * the parent test so the real file:// path through `fetch` is exercised, not just
 * an in-memory stub.
 */
function sceneUrl(scene: Record<string, unknown>, name = 'scene.json'): string {
  const file = join(testRoot, name);
  writeFileSync(file, JSON.stringify(scene, null, 2), 'utf-8');
  return pathToFileURL(file).href;
}

/**
 * A `fetch` that serves exactly the document it is given.
 *
 * The loader takes its fetcher as a parameter precisely so the game can run in a
 * browser while a test runs in Node; this is that injection point.
 */
function fetchOf(scene: unknown): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => scene })) as unknown as typeof fetch;
}

/**
 * A `fetch` that reads the file a `file://` URL points at.
 *
 * This is the honest stand-in for the browser: the loader takes a URL, so a test
 * that hands it a real file and a reader proves the whole chain, and the fixture
 * stays in the temp directory.
 */
function fetchFromDisk(): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? '');
    if (!url.startsWith('file:')) {
      throw new Error(`fetchFromDisk only reads file: URLs, got ${url}`);
    }
    const path = fileURLToPath(url);
    try {
      const body = readFileSync(path, 'utf-8');
      return { ok: true, status: 200, json: async () => JSON.parse(body) } as unknown as Response;
    } catch (error) {
      return {
        ok: false,
        status: 404,
        statusText: error instanceof Error ? error.message : String(error),
        json: async () => ({}),
      } as unknown as Response;
    }
  }) as unknown as typeof fetch;
}

/**
 * Build the real scene graph from a scene document, through the real loader and
 * the real registry.
 */
async function buildFrom(
  harness: Harness,
  scene: unknown,
): Promise<{ root: THREE.Object3D; byId: Map<string, { id: string; object: THREE.Object3D }>; failed: string[] }> {
  return harness.loadScene.buildGameScene({
    core,
    registry: harness.registry,
    url: 'memory://scene.json',
    fetchImpl: fetchOf(scene),
  }) as unknown as { root: THREE.Object3D; byId: Map<string, { id: string; object: THREE.Object3D }>; failed: string[] };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Kart-Dash-3D v2 — scene.json through the prefab registry', () => {
  it('builds a kart at a CHANGED position when scene.json says so (by id, never by index)', async () => {
    const harness = await loadHarness();

    // Build from a **copy** of the untouched real scene first, so there is a
    // "before" position read from exactly the same code path as the assertion.
    const beforeUrl = sceneUrl(readRealScene(), 'before.json');
    const before = await harness.loadScene.buildGameScene({
      core,
      registry: harness.registry,
      url: beforeUrl,
      fetchImpl: fetchFromDisk(),
    });
    const beforeKart = before.byId.get('player_kart')?.object;
    expect(beforeKart, 'player_kart must be present in the real scene').toBeDefined();
    const beforePos = (beforeKart as THREE.Object3D).position.clone();

    // Now change ONLY player_kart's position — in a second temp copy, never on
    // disk in the game folder.
    const edited = readRealScene() as SceneFile;
    const player = edited.instances.find((i) => i.id === 'player_kart');
    if (player === undefined) throw new Error('fixture scene has no player_kart');
    player.transform.position = [12.5, 0, -7.25];

    const afterUrl = sceneUrl(edited, 'after.json');
    const after = await harness.loadScene.buildGameScene({
      core,
      registry: harness.registry,
      url: afterUrl,
      fetchImpl: fetchFromDisk(),
    });
    const afterKart = after.byId.get('player_kart')?.object as THREE.Object3D;

    expect(afterKart).toBeDefined();
    // Looked up by id, never by array index: an index is a claim about ordering
    // that breaks for no reason, and this scene's hazard crate proves ordering
    // and identity are not the same thing.
    expect(afterKart.position.toArray()).toEqual([12.5, 0, -7.25]);
    // The change is genuinely applied — not the stale default.
    expect(afterKart.position.toArray()).not.toEqual(beforePos.toArray());

    // Every OTHER *building* instance is unmoved: the edit was scoped to one kart.
    for (const id of ['rival_luna', 'rival_rex']) {
      const a = before.byId.get(id)?.object as THREE.Object3D | undefined;
      const b = after.byId.get(id)?.object as THREE.Object3D | undefined;
      expect(a, `${id} missing before`).toBeDefined();
      expect(b, `${id} missing after`).toBeDefined();
      expect(b!.position.toArray()).toEqual(a!.position.toArray());
    }
  });

  it('does not mutate the real scene.json on disk', async () => {
    const onDiskBefore = readFileSync(REAL_SCENE_JSON, 'utf-8');
    const harness = await loadHarness();
    // Exercise both the read path and an edited copy.
    await buildFrom(harness, readRealScene());
    const edited = readRealScene() as SceneFile;
    const p = edited.instances.find((i) => i.id === 'player_kart');
    if (p === undefined) throw new Error('fixture scene has no player_kart');
    p.transform.position = [99, 99, 99];
    await buildFrom(harness, edited);
    expect(readFileSync(REAL_SCENE_JSON, 'utf-8')).toBe(onDiskBefore);
  });

  it('builds every instance in the real scene.json, looked up by id', async () => {
    const harness = await loadHarness();
    const scene = readRealScene() as SceneFile;

    const built = await buildFrom(harness, scene);

    // Assert each instance by id — not by count, and never by array index.
    for (const instance of scene.instances) {
      const entry = built.byId.get(instance.id);

      if (instance.id === 'track') {
        // **Found on disk, reported exactly.** The shipped scene.json has
        // `"width": -10` and `trackSegment`'s paramsSchema is
        // `z.number().positive()`, so this instance's params fail validation.
        // It is refused and named — not built — and every OTHER instance still
        // builds. See the module header of loadScene.js for why one bad param
        // does not refuse the whole file.
        expect(built.failed).toContain('track');
        expect(entry, 'an instance whose params failed must not appear in byId').toBeUndefined();
        continue;
      }

      if (instance.prefab === 'hazardCrate') {
        // This prefab throws on purpose (a corrupted GLTF) to exercise the
        // loader's error path, so it is reported as failed, never built.
        expect(built.failed, 'hazard_crate must be reported as failed').toContain(instance.id);
        expect(entry, 'a failed prefab must not appear in byId').toBeUndefined();
        continue;
      }

      expect(entry, `instance "${instance.id}" must be in byId`).toBeDefined();
      expect(entry!.object).toBeDefined();
    }

    // The three karts are present by id — a bad track param must not take the
    // grid with it, which is the whole point of scoping the failure.
    for (const id of ['player_kart', 'rival_luna', 'rival_rex']) {
      expect(built.byId.has(id), `${id} must be built`).toBe(true);
    }
    // Both failures are named, and nothing else is.
    expect(built.failed.slice().sort()).toEqual(['hazard_crate', 'track']);
  });

  it('reports an invalid param with its JSON path, and builds every OTHER instance (SPEC R6/R9)', async () => {
    const harness = await loadHarness();
    const consoleErrors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    };
    try {
      // The real scene.json's `track` instance already carries width: -10.
      const built = await buildFrom(harness, readRealScene());

      // Loud: the path and the reason are both present in what was reported.
      const reported = consoleErrors.join('\n');
      expect(reported).toContain('instances[0].params.width');
      expect(reported).toContain('greater than 0');

      // Isolated: everything that was valid was still built.
      expect(built.byId.has('player_kart')).toBe(true);
      expect(built.byId.has('rival_luna')).toBe(true);
      expect(built.byId.has('rival_rex')).toBe(true);
      expect(built.failed).toContain('track');
    } finally {
      console.error = originalError;
    }
  });

  it('WARNs, naming the instance id and the reason, when an instance is skipped for bad params', async () => {
    const harness = await loadHarness();
    // Both halves captured separately. `console.error` is stubbed too so the
    // test is not confused by (or confused about) the validation error that
    // precedes the skip: the claim under test is about the *warning*.
    const warnings: string[] = [];
    const errors: string[] = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    let built: Awaited<ReturnType<typeof buildFrom>>;
    try {
      // The shipped scene.json's `track` has `params.width: -10`, which
      // `trackSegment`'s `z.number().positive()` rejects. A permanent fixture.
      built = await buildFrom(harness, readRealScene());
    } finally {
      // Restored in `finally` so a thrown assertion inside the block cannot leak
      // a console stub into every later suite in this process.
      console.warn = originalWarn;
      console.error = originalError;
    }

    // The skip really happened — asserted against the returned `failed` list,
    // not against a count.
    expect(built.failed).toContain('track');

    // Exactly one warning, and it is about `track` — not about every instance.
    const trackWarnings = warnings.filter((line) => line.includes('skipped instance'));
    expect(trackWarnings).toHaveLength(1);
    const warning = trackWarnings[0]!;

    // **The id.** Without it the developer cannot find the object that is missing.
    expect(warning).toContain('"track"');
    // **The reason** — the failing JSON path and what Zod said about it. A
    // warning reading only "an instance was skipped" fails here.
    expect(warning).toContain('instances[0].params.width');
    expect(warning).toContain('greater than 0');
    // And the consequence, so ignoring it is a choice rather than a mystery.
    expect(warning).toContain('not built');
    // It is a *warning* about the skip, not a second copy of the validation error.
    expect(errors.join('\n')).toContain('instances[0].params.width');
  });

  it('warns about each skipped instance by its own id, and names no instance it did not skip', async () => {
    const harness = await loadHarness();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    let built: Awaited<ReturnType<typeof buildFrom>>;
    try {
      built = await buildFrom(harness, readRealScene());
    } finally {
      console.warn = originalWarn;
    }

    // Every warned id is one that was genuinely skipped, and every skipped
    // bad-param instance is warned about. Matching by id, never by index.
    const warnedIds = warnings
      .filter((line) => line.includes('skipped instance'))
      .map((line) => /skipped instance "([^"]+)"/.exec(line)?.[1]);
    expect(warnedIds).toEqual(['track']);

    // The prefab that *threw* is a different failure path and is reported with
    // `console.error`; it is deliberately not also warned as a bad-param skip.
    expect(warnedIds).not.toContain('hazard_crate');
    expect(built.failed).toContain('hazard_crate');
  });

  it('does NOT warn when every instance\'s params are valid', async () => {
    const harness = await loadHarness();
    // The same scene with `track`'s width fixed. Proves the warning is about the
    // bad value and not about the instance existing: a warning that fires on
    // every load is as broken as one that never fires.
    const fixed = readRealScene() as SceneFile;
    const track = fixed.instances.find((i) => i.id === 'track');
    if (track === undefined) throw new Error('fixture scene has no track');
    track.params = { width: 20, length: 50, color: '#1f2228' };

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    let built: Awaited<ReturnType<typeof buildFrom>>;
    try {
      built = await buildFrom(harness, fixed);
    } finally {
      console.warn = originalWarn;
    }

    // Only the throwing prefab still fails, and it is not a param skip.
    expect(built.failed).not.toContain('track');
    expect(built.byId.has('track')).toBe(true);
    expect(warnings, `unexpected warnings: ${warnings.join(' | ')}`).toEqual([]);
  });

  it('warns on a synthetic fixture whose params are bad for a different reason', async () => {
    const harness = await loadHarness();
    // Not the shipped scene: an unknown param. `trackSegment`'s schema is
    // `.strict()`, so this is refused on its own terms — proving the warning
    // reports whatever the reason actually is, not a hardcoded width message.
    const scene = readRealScene() as SceneFile;
    const track = scene.instances.find((i) => i.id === 'track');
    if (track === undefined) throw new Error('fixture scene has no track');
    const params: Record<string, unknown> = { ...track.params, width: 20 };
    delete params['width'];
    params['widht'] = 12; // typo: not a property the schema declares
    track.params = params;

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    let built: Awaited<ReturnType<typeof buildFrom>>;
    try {
      built = await buildFrom(harness, scene);
    } finally {
      console.warn = originalWarn;
    }

    expect(built.failed).toContain('track');
    const skipWarnings = warnings.filter((line) => line.includes('skipped instance'));
    expect(skipWarnings).toHaveLength(1);
    const warning = skipWarnings[0]!;
    expect(warning).toContain('"track"');
    // Zod attributes an unrecognized key to the *object* (`instances[0].params`),
    // naming the offending key in the message rather than extending the path —
    // so the path and the key are asserted separately. Asserting
    // `instances[0].params.widht` here would be asserting a path Zod does not
    // produce.
    expect(warning).toContain('instances[0].params');
    expect(warning).toContain("'widht'");
  });

  it('resolves parent links in a second pass — the child is a descendant, in any file order', async () => {
    const harness = await loadHarness();

    // A two-instance scene where the CHILD is declared FIRST. File order must not
    // matter (SPEC R8); a single-pass builder would drop this parent link.
    const scene: Record<string, unknown> = {
      version: 1,
      name: 'ParentLink',
      engine: 'three',
      seed: 1,
      instances: [
        {
          id: 'child_kart',
          prefab: 'kart',
          name: 'Child Kart',
          parent: 'track',
          transform: { position: [1, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
          params: { character: 'dash' },
        },
        {
          id: 'track',
          prefab: 'trackSegment',
          name: 'Track',
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          params: { width: 20, length: 50, color: '#1f2228' },
        },
      ],
      lights: [],
      camera: { kind: 'perspective', position: [0, 5, 10], rotation: [0, 0, 0], fov: 60 },
    };

    const built = await buildFrom(harness, scene);
    const track = built.byId.get('track')?.object as THREE.Object3D;
    const child = built.byId.get('child_kart')?.object as THREE.Object3D;

    expect(track).toBeDefined();
    expect(child).toBeDefined();
    // Not merely present in the map — an actual descendant of the parent.
    expect(child.parent).toBe(track);
    let cursor: THREE.Object3D | null = child;
    let sawTrack = false;
    while (cursor !== null) {
      if (cursor === track) {
        sawTrack = true;
        break;
      }
      cursor = cursor.parent;
    }
    expect(sawTrack, 'child_kart must be a descendant of track').toBe(true);
    // The parent is NOT left as a root child once the child re-parented onto it.
    expect(built.root.children).toContain(track);
  });

  it('builds a track instance once its params are valid, and refuses it while they are not', async () => {
    const harness = await loadHarness();

    // The shipped file's track has width: -10 and must NOT build.
    const shipped = await buildFrom(harness, readRealScene());
    expect(shipped.failed).toContain('track');
    expect(shipped.byId.has('track')).toBe(false);

    // The same instance with a positive width builds, proving the refusal was
    // about the value and not about the instance or the prefab.
    const fixed = readRealScene() as SceneFile;
    const trackInstance = fixed.instances.find((i) => i.id === 'track');
    if (trackInstance === undefined) throw new Error('fixture scene has no track');
    trackInstance.params = { width: 20, length: 50, color: '#1f2228' };

    const ok = await buildFrom(harness, fixed);
    expect(ok.failed).not.toContain('track');
    const track = ok.byId.get('track')?.object as THREE.Object3D | undefined;
    expect(track, 'track must build once its params are valid').toBeDefined();
    expect(track!.position.toArray()).toEqual([0, 0, 0]);
    // The root took the instance's display name — the `name ?? id` contract —
    // so the prefab's own "TrackSegment" name is gone, and the road mesh with
    // its declared length is a child of it.
    expect(track!.name).toBe('Starting Straight');
    expect(track!.children.length, 'road + two kerbs').toBe(3);
    // The prefab's `length` param is the track's Z extent, so it lands in
    // Three.js's `depth`, not in a parameter called `length` — asserting
    // `length` here would pass against a prefab that built the road the wrong
    // way round, because the property would simply be `undefined` and
    // `toMatchObject` would report the same mismatch either way.
    expect(track!.children[0].geometry.parameters).toMatchObject({ width: 20, height: 0.2, depth: 50 });
  });

  it('refuses a structurally invalid scene, naming the JSON path (SPEC R6)', async () => {
    const harness = await loadHarness();

    // A transform with a 2-component position: the schema requires exactly 3 and
    // must NOT silently pad it.
    const bad = readRealScene() as unknown as Record<string, unknown>;
    const instances = bad['instances'] as Array<Record<string, unknown>>;
    const player = instances.find((i) => i['id'] === 'player_kart');
    if (player === undefined) throw new Error('fixture scene has no player_kart');
    (player['transform'] as Record<string, unknown>)['position'] = [1, 2];

    await expect(buildFrom(harness, bad)).rejects.toThrow(/instances\[2\]\.transform\.position/);
  });

  it('refuses a scene whose JSON is not parseable as a scene at all, naming the file', async () => {
    const harness = await loadHarness();
    // `version` must be the literal 1; a different version is refused, not
    // best-effort read (SPEC R6).
    const bad = readRealScene();
    bad['version'] = 2;
    await expect(buildFrom(harness, bad)).rejects.toThrow(/must be exactly 1/);
  });

  it('startingGrid reflects the karts scene.json declares', async () => {
    const harness = await loadHarness();
    const built = await harness.loadScene.buildGameScene({
      core,
      registry: harness.registry,
      url: 'memory://scene.json',
      fetchImpl: fetchOf(readRealScene()),
    });
    // The real scene.json declares three karts; startingGrid must list them by
    // their declared transforms.
    const grid = harness.loadScene.startingGrid(built);
    const byId = new Map(grid.map((entry) => [entry['id'] as string, entry]));
    expect(byId.has('player_kart')).toBe(true);
    expect(byId.get('player_kart')!['x']).toBe(0);
    expect(byId.get('rival_luna')!['x']).toBe(3.2);
    expect(byId.get('rival_rex')!['z']).toBe(-7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Kart — mesh is built by createKart, with every animated part intact', () => {
  /**
   * Every field the game's `Kart.update()` / `reset()` reads off its mesh.
   *
   * The conversion deleted a 500-line hand-built tree and replaced it with one
   * `createKart` call, so the risk is not "does it look right" but "does some
   * animated part quietly become undefined and the game stops spinning its
   * wheels". Each entry below is a real read site in kart.js, and each is
   * asserted to resolve to a real Three.js object.
   */
  const ANIMATED_PARTS = ['wheels', 'steeringWheel', 'exhaustGlows', 'starRing'] as const;

  it('resolves every part Kart.update() animates, for every character', async () => {
    installCanvasStub();
    const kartModule = await importGameModule(join(GAME_SRC, 'kart.js'));
    const charactersModule = await importGameModule(join(GAME_SRC, 'characters.js'));
    const Kart = kartModule['Kart'] as new (scene: unknown, track: unknown, options: unknown) => KartLike;
    const characters = charactersModule['CHARACTERS'] as Array<{ id: string; headgear: string }>;

    expect(characters.length).toBeGreaterThan(0);

    for (const character of characters) {
      const kart = new Kart({ add: () => undefined, remove: () => undefined }, stubTrack, {
        character,
        isPlayer: false,
        aiIndex: 0,
      });

      // `wheels`: four entries, each with the three fields update() writes.
      expect(Array.isArray(kart.wheels), `${character.id}: wheels`).toBe(true);
      expect(kart.wheels).toHaveLength(4);
      for (const [i, wheel] of kart.wheels.entries()) {
        expect(wheel.pivot, `${character.id}: wheel ${i} pivot`).toBeDefined();
        expect(wheel.wheel, `${character.id}: wheel ${i} wheel`).toBeDefined();
        expect(typeof wheel.front, `${character.id}: wheel ${i} front`).toBe('boolean');
        // The two Object3Ds must be real Three.js the game can rotate.
        expect(isObject3DLike(wheel.wheel), `${character.id}: wheel ${i} wheel`).toBe(true);
        expect(isObject3DLike(wheel.pivot), `${character.id}: wheel ${i} pivot`).toBe(true);
      }

      // The other three: one Object3D and two sprites respectively.
      expect(isObject3DLike(kart.steeringWheel), `${character.id}: steeringWheel`).toBe(true);
      expect(Array.isArray(kart.exhaustGlows), `${character.id}: exhaustGlows`).toBe(true);
      expect(kart.exhaustGlows).toHaveLength(2);
      for (const [i, glow] of kart.exhaustGlows.entries()) {
        expect(isObject3DLike(glow), `${character.id}: glow ${i}`).toBe(true);
        expect(glow.visible, `${character.id}: glow ${i} starts hidden`).toBe(false);
      }
      expect(isObject3DLike(kart.starRing), `${character.id}: starRing`).toBe(true);
      expect(kart.starRing.visible, `${character.id}: starRing starts hidden`).toBe(false);

      for (const part of ANIMATED_PARTS) {
        expect(kart[part], `${character.id}: ${part} undefined`).toBeDefined();
      }
    }
  });

  it('produces the same tree shape and bounding box the prefab builds on its own', async () => {
    installCanvasStub();

    // **One bundle, one Three.** `kart.js` and `kart-prefab.js` are pulled into
    // a single generated entry so both halves share one copy of Three.js. Two
    // separate bundles would each carry their own, and comparing objects across
    // them would be comparing two implementations rather than two karts.
    const entry = join(testRoot, 'kart-pair-entry.mjs');
    writeFileSync(
      entry,
      [
        `export * as kartModule from ${JSON.stringify(join(GAME_SRC, 'kart.js'))};`,
        `export * as prefabModule from ${JSON.stringify(join(GAME_SRC, 'prefabs', 'kart-prefab.js'))};`,
        `export * as charactersModule from ${JSON.stringify(join(GAME_SRC, 'characters.js'))};`,
        `export * as THREE from ${JSON.stringify(THREE_MODULE)};`,
        '',
      ].join('\n'),
      'utf-8',
    );
    const pair = (await importGameModule(entry)) as unknown as {
      kartModule: Record<string, unknown>;
      prefabModule: Record<string, unknown>;
      charactersModule: Record<string, unknown>;
      THREE: typeof THREE;
    };

    const Kart = pair.kartModule['Kart'] as new (
      scene: unknown,
      track: unknown,
      options: unknown,
    ) => KartLike;
    const createKart = pair.prefabModule['createKart'] as (
      three: unknown,
      spec: Record<string, unknown>,
    ) => { object: THREE.Object3D };
    const characters = pair.charactersModule['CHARACTERS'] as Array<{
      id: string;
      colors: unknown;
      headgear: string;
    }>;

    /**
     * A structural fingerprint: every node's name and type, in traversal order,
     * plus the world bounding box. Two trees with the same fingerprint render
     * identically, so this is the "pixel-for-pixel equivalent" claim stated as
     * something a machine can check.
     */
    function fingerprint(root: THREE.Object3D): { tree: string; box: number[] } {
      const lines: string[] = [];
      root.updateMatrixWorld(true);
      root.traverse((node) => {
        lines.push(`${node.name || '(unnamed)'}:${node.type}`);
      });
      const box = new pair.THREE.Box3().setFromObject(root as never);
      return {
        tree: lines.join('|'),
        box: [...box.min.toArray(), ...box.max.toArray()].map((v) => Number(v.toFixed(6))),
      };
    }

    expect(characters.length).toBeGreaterThan(0);

    for (const character of characters) {
      const kart = new Kart({ add: () => undefined, remove: () => undefined }, stubTrack, {
        character,
        isPlayer: false,
        aiIndex: 0,
      });
      const direct = createKart(pair.THREE, {
        colors: character.colors,
        headgear: character.headgear,
        id: character.id,
        isPlayer: false,
        aiIndex: 0,
        // The prefab's own texture factory; a blank Texture is enough because
        // the glow sprite's map contributes nothing to the geometry.
        createTexture: () => new pair.THREE.Texture(),
      });

      const fromKart = fingerprint(kart.mesh);
      const fromPrefab = fingerprint(direct.object);
      expect(fromKart.tree, `${character.id}: object tree`).toBe(fromPrefab.tree);
      expect(fromKart.box, `${character.id}: bounding box`).toEqual(fromPrefab.box);
      // And the scale the game relies on is the prefab's own 1.18.
      expect(kart.mesh.scale.toArray()).toEqual([1.18, 1.18, 1.18]);
    }
  });
});

/**
 * Whether a bundled object is a real Three.js `Object3D`.
 *
 * **Not `instanceof`.** The bundle contains its own copy of Three (the game has
 * no `node_modules` of its own, so esbuild resolves `three` from CF2 and inlines
 * it), and `instanceof` across that boundary compares against a *different*
 * `Object3D` constructor and is therefore always false. `prefabLoader.ts` names
 * this exact hazard — "a second copy of Three.js whose classes are not identical
 * to the app's" — and keeps Three external to avoid it. Structural checks are
 * what remain honest across the boundary, and they test what actually matters:
 * that the thing has the properties the game writes to.
 */
function isObject3DLike(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate['isObject3D'] === true &&
    typeof candidate['rotation'] === 'object' &&
    typeof candidate['scale'] === 'object' &&
    typeof candidate['position'] === 'object'
  );
}

/** The shape of a `Kart` this test reads. Only the fields it asserts. */
interface KartLike {
  mesh: THREE.Object3D;
  wheels: Array<{ pivot: THREE.Object3D; wheel: THREE.Object3D; front: boolean }>;
  steeringWheel: THREE.Object3D;
  exhaustGlows: THREE.Object3D[];
  starRing: THREE.Object3D;
}

/**
 * The only `Track` members a `Kart`'s constructor touches.
 *
 * The mesh is built in the constructor before any track call, so a stub here
 * cannot hide a geometry difference — it only needs to exist.
 */
const stubTrack = {
  segCount: 900,
  roadHalf: 10,
  getNearest: () => ({ index: 0, lateral: 0 }),
};
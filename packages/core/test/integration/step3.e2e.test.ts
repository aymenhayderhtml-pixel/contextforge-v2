/**
 * step3.e2e.test.ts — the Step 3 done-when test: the whole modelling journey.
 *
 * **Done when (SPEC §5, Step 3):** a headless test opens a fixture
 * `scene.json`, produces a render containing the expected object count, edits an
 * object's transform, and saving re-validates against the Zod schema.
 *
 * Step 2's integration test already proved that generate → edit → save → reload
 * composes. This file deliberately goes past it in four directions:
 *
 *  1. **Every edit operation, each reloaded from disk.** Step 2's undo test ran
 *     five edits in a row from a cached scene. Here each edit reads
 *     `scene.json` fresh first, so an edit can never accidentally be applied on
 *     top of state the editor never had.
 *  2. **The generated project is actually built and run.** Not just written and
 *     validated: its own `loadScene.ts` is transpiled and executed against real
 *     Three.js, so "the template produces a project that builds" is asserted
 *     rather than assumed. This is the headless stand-in for the renderer's
 *     object count — Three.js runs fine under Node with no GPU.
 *  3. **A prefab that throws.** The survivable case, in the exact data shape
 *     `ipc.ts` promises the renderer. Nothing else in the repository asserts it.
 *  4. **The external-rewrite (file-watcher) scenario**, including an *invalid*
 *     rewrite, where the previous valid state must be retained rather than the
 *     editor dying.
 *
 * Everything runs headless in Node. No Electron, no DOM, no GPU, and no
 * dependency on the renderer's own files (SPEC R2/R3).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  applySceneEdit,
  clearHistory,
  generateProject,
  indexPrefabs,
  loadScene,
  redoSceneEdit,
  rngFor,
  saveScene,
  sceneHistoryStatus,
  serializeScene,
  undoSceneEdit,
  validateScene,
  validateScenePrefabs,
  type JsonValue,
  type PrefabDefinition,
  type PrefabRegistry,
  type SceneEdit,
  type SceneFile,
  type ThreeModule,
} from '@contextforge/core';

// ── The IPC contract, reproduced ──────────────────────────────────────────────

/**
 * Structural copies of the two types this test asserts against.
 *
 * These are **duplicated from `packages/app/src/ipc.ts` rather than imported
 * from it.** Two reasons, and the second is the important one:
 *
 *  - `packages/core` may not import from `packages/app` (SPEC R4), and the
 *    boundary checker enforces it mechanically. So the import is impossible
 *    regardless of intent;
 *  - more usefully, a test that imports the contract cannot fail when the
 *    contract is wrong. If `PrefabFailure` gained or lost a field, an
 *    imported type would follow along and stay green. Pinning the shape here
 *    means the two ends can drift apart and *something fails*.
 *
 * Every use is an explicit `satisfies`, so a change to either side is a
 * compile error at this file rather than a silent divergence. See the report
 * note on re-pointing these at `ipc.ts` once core is allowed to depend on app.
 */
interface PrefabFailureContract {
  /** The prefab's declared name, or the file it was declared in. */
  name: string;
  /** Source file, so the developer can go and look at it. */
  file: string;
  /** The thrown error, including its stack's first frames. */
  reason: string;
}

interface PrefabSummaryContract {
  name: string;
  description: string;
  paramsJsonSchema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
}

interface PrefabRegistryResultContract {
  prefabs: PrefabSummaryContract[];
  failed: PrefabFailureContract[];
}

interface SceneChangedOnDiskContract {
  valid: boolean;
  problems: string[];
}

/**
 * A `Result` exactly as `ipc.ts` defines it, structurally re-declared.
 *
 * Pinned because it is the convention every failure in this file follows: a
 * refusal carries a complete sentence in `reason`, never a bare boolean, so the
 * UI can show it verbatim (SPEC R9).
 */
type ResultContract<T> = { ok: true; value: T } | { ok: false; reason: string };

/** One refusal, in the shape `ipc.ts` requires of every failing request. */
function refusal<T>(reason: string): ResultContract<T> {
  return { ok: false, reason };
}

/**
 * A test-only stand-in for the Three.js module.
 *
 * `ThreeModule` names four constructors as required, so the stub declares
 * exactly those four and nothing else. Every prefab reached in this file is
 * either the generated `cube` (which needs `BoxGeometry` and
 * `MeshStandardMaterial`) or the throwing `boom`, which needs neither — so this
 * object is *sufficient*, not merely permissive. If a prefab grew a
 * dependency the stub does not model, the call would fail here loudly rather
 * than quietly returning `undefined` geometry.
 */
const stubThree: ThreeModule = {
  Object3D: class {},
  Mesh: class {},
  MeshStandardMaterial: class {},
  BoxGeometry: class {},
  // Present but unused by these prefabs; declared because the contract names
  // them and a stub that silently omits a required field is not a stub of it.
  MeshBasicMaterial: class {},
  SphereGeometry: class {},
  CylinderGeometry: class {},
  PlaneGeometry: class {},
  Group: class {},
};

const stubParams: Record<string, JsonValue> = {};

interface StubPrefab extends PrefabDefinition {
  /** The exact file it came from, for the failure message. */
  sourceFile: string;
}

// ── Harness ──────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
/** Kept inside the repo so Node resolves `zod`/`three` by walking up. */
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const requireFromRepo = createRequire(join(REPO_ROOT, 'package.json'));

/** `esbuild` strips the types the generated project's prefabs import. */
const { transformSync } = requireFromRepo('esbuild') as {
  transformSync: (
    source: string,
    options: { loader: 'ts'; format: 'esm'; target: string },
  ) => { code: string };
};

const BRIEF = {
  name: 'orbital-drifter',
  idea: 'The player drifts a salvage tug between tumbling ship hulks, cutting loose cargo free before the hulls drift apart.',
  seed: 90210,
};

/** Where the generated project is written. Relative to the repo, on purpose. */
const SCENE_PATH = 'scene.json';

let workDir: string;
let projectRoot: string;

beforeEach(() => {
  workDir = mkdtempSync(join(REPO_ROOT, '.e2e-work-'));
  projectRoot = join(workDir, 'project');
  generateProject(projectRoot, BRIEF);
  clearHistory(projectRoot);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  clearHistory(projectRoot);
});

/** The scene, read fresh from disk every time — never a cached value. */
function onDisk(): SceneFile {
  const scene = loadScene(join(projectRoot, SCENE_PATH));
  if (scene === null) throw new Error(`${SCENE_PATH} is missing`);
  return scene;
}

/** The scene file's bytes, read fresh from disk. */
function sceneBytes(): string {
  return readFileSync(join(projectRoot, SCENE_PATH), 'utf-8');
}

/** Apply an edit and assert it was accepted. */
function edit(next: SceneEdit): void {
  const result = applySceneEdit(projectRoot, SCENE_PATH, onDisk(), next, { now: 1_700_000_000_000 });
  if (!result.ok) throw new Error(`edit refused: ${result.error ?? 'unknown reason'}`);
  // Every accepted edit leaves a scene that would load — asserted on each step
  // rather than only at the end, so a bad intermediate state is named as soon
  // as it happens instead of five steps later.
  const check = validateScene(onDisk());
  if (!check.valid) {
    throw new Error(`edit ${next.op} left an invalid scene: ${JSON.stringify(check.errors)}`);
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/**
 * A stub prefab loader, standing in for `electron/prefabLoader.ts`.
 *
 * Prefab *bundling* belongs to another agent and is not written yet, so this
 * exercises the contract rather than the bundle: transpile each
 * `prefabs/*.ts` with esbuild (types stripped, nothing imported), then
 * `import()` it. A prefab that throws at import time therefore throws here,
 * and the test can assert that the throw is *caught and reported* rather than
 * escaping and taking the registry down with it.
 */
async function loadPrefabModules(root: string): Promise<{
  registry: PrefabRegistryResultContract;
  summaries: StubPrefab[];
}> {
  const prefabDir = join(root, 'prefabs');
  const compiledDir = join(workDir, 'compiled-prefabs');
  mkdirSync(compiledDir, { recursive: true });

  const summaries: StubPrefab[] = [];
  const failed: PrefabFailureContract[] = [];

  const files = walk(prefabDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => relative(prefabDir, f).replaceAll('\\', '/'))
    .filter((f) => f !== 'index.ts')
    .sort();

  for (const file of files) {
    const declared = `prefabs/${file}`;
    try {
      const source = readFileSync(join(root, declared), 'utf-8');
      const compiled = transformSync(source, { loader: 'ts', format: 'esm', target: 'node22' }).code;
      const dest = join(compiledDir, file.replaceAll('/', '__').replace(/\.ts$/, '.mjs'));
      writeFileSync(dest, compiled, 'utf-8');
      const module = (await import(pathToFileURL(dest).href)) as Record<string, unknown>;
      const prefab = findPrefab(module);
      if (prefab === undefined) {
        failed.push({
          name: `prefabs/${file.replace(/\.ts$/, '')}`,
          file: declared,
          reason: `${declared} exports no PrefabDefinition — nothing in the module has a "name" and a "create"`,
        });
        continue;
      }
      summaries.push({ ...prefab, sourceFile: declared });
    } catch (error) {
      // The whole point: this is a catch, not a rethrow. One broken prefab in
      // a directory of twelve is the normal state of a project an AI is
      // editing, and the developer must still be able to open the scene.
      failed.push({
        name: `prefabs/${file.replace(/\.ts$/, '')}`,
        file: declared,
        reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  }

  const prefabs: PrefabSummaryContract[] = summaries.map((prefab) => ({
    name: prefab.name,
    description: prefab.description ?? '',
    paramsJsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  }));

  const registry: PrefabRegistryResultContract = { prefabs, failed };
  return { registry, summaries };
}

/** Find the `PrefabDefinition` a prefab module exports, by shape not by name. */
function findPrefab(module: Record<string, unknown>): StubPrefab | undefined {
  for (const value of Object.values(module)) {
    if (isRecord(value) && typeof value['name'] === 'string' && typeof value['create'] === 'function') {
      return value as unknown as StubPrefab;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reload `scene.json` the way the main process does on a watcher event.
 *
 * Returns the `scene:changedOnDisk` payload together with the state the editor
 * may adopt. On a problem the payload is a **refusal** — `ok: false` with a
 * `reason` the UI shows verbatim — and `retained` stays `null`, so the caller
 * keeps the last valid scene rather than adopting a broken one. The editor does
 * not die and the AI's file is not overwritten.
 */
function watchScene(
  root: string,
  problemsOut: string[],
): { event: ResultContract<SceneChangedOnDiskContract>; retained: SceneFile | null } {
  let retained: SceneFile | null = null;
  try {
    const raw = readFileSync(join(root, SCENE_PATH), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const result = validateScene(parsed);

    if (!result.valid || result.data === undefined) {
      problemsOut.push(...result.errors.map((e) => `${e.path}: ${e.message}`));
      return { event: refusal(`${problemsOut.length} problem(s) in scene.json`), retained };
    }

    retained = result.data;
    return { event: { ok: true, value: { valid: true, problems: [] } }, retained };
  } catch (error) {
    problemsOut.push(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return { event: refusal(`scene.json could not be read as JSON`), retained };
  }
}

/** Unwrap a watcher result, failing the test if it was a refusal. */
function adopt(event: ResultContract<SceneChangedOnDiskContract>): SceneChangedOnDiskContract {
  if (!event.ok) throw new Error(`expected a valid reload, got refusal: ${event.reason}`);
  return event.value;
}

// ── 1. The main journey ──────────────────────────────────────────────────────

describe('step 3 done-when: generate, open, select, change, undo, save, reload', () => {
  it('walks the whole journey and returns byte-identical results', () => {
    // ── Open ────────────────────────────────────────────────────────────────
    // The generated file loads, validates, and is exactly what the generator
    // serialised — no rewriting by the load path (SPEC R8).
    const generatedBytes = sceneBytes();
    const opened = onDisk();
    expect(validateScene(opened).valid).toBe(true);
    expect(serializeScene(opened)).toBe(generatedBytes);
    expect(opened.instances.map((i) => i.id)).toEqual(['floor', 'marker']);

    // ── Select ──────────────────────────────────────────────────────────────
    // Selection is `Selection` in `ipc.ts`: an id, or nothing. Both states are
    // exercised, and the selected instance is the one the edit then changes.
    type Selection = { kind: 'instance'; id: string } | { kind: 'none' };
    let selection: Selection = { kind: 'none' };
    expect(selection.kind).toBe('none');
    selection = { kind: 'instance', id: 'marker' };
    expect(selection.kind === 'instance' && selection.id).toBe('marker');
    const selected = opened.instances.find((i) => i.id === 'marker');
    expect(selected).toBeDefined();
    expect(selected?.name).toBe('Marker');

    // ── Change: every operation, each reloaded from disk first ──────────────
    const edits: SceneEdit[] = [
      { op: 'setTransform', instanceId: 'marker', patch: { position: [2, 4, -1] } },
      { op: 'swapModel', instanceId: 'marker', model: 'models/buoy.glb' },
      {
        op: 'addInstance',
        input: {
          id: 'crate',
          prefab: 'cube',
          parent: 'marker',
          name: 'Crate',
          transform: { position: [0, 1, 0] },
          params: { size: 1, colour: '#ff8800' },
        },
      },
      { op: 'setParams', instanceId: 'crate', params: { colour: '#00ff88' } },
      { op: 'removeInstance', instanceId: 'floor' },
    ];

    // One operation per test-level step, each starting from what is actually
    // stored rather than from an in-memory scene carried forward.
    for (const next of edits) edit(next);

    const afterTransform = onDisk();
    expect(afterTransform.instances.find((i) => i.id === 'marker')?.transform.position).toEqual([2, 4, -1]);
    expect(afterTransform.instances.find((i) => i.id === 'marker')?.model).toBe('models/buoy.glb');

    // The added instance is parented, and its params merged rather than replaced.
    const crate = afterTransform.instances.find((i) => i.id === 'crate');
    expect(crate?.parent).toBe('marker');
    expect(crate?.params).toEqual({ size: 1, colour: '#00ff88' });

    // Removing the floor leaves the rest of the tree valid — no dangling parent.
    expect(afterTransform.instances.map((i) => i.id)).toEqual(['marker', 'crate']);
    expect(validateScene(afterTransform).valid).toBe(true);
    expect(sceneHistoryStatus(projectRoot).undoCount).toBe(edits.length);

    const editedBytes = sceneBytes();

    // ── Undo: every edit, back to the generated bytes ───────────────────────
    for (let i = 0; i < edits.length; i++) {
      const undone = undoSceneEdit(projectRoot);
      expect(undone.success, `undo ${i} should succeed`).toBe(true);
      expect(undone.paths).toEqual([SCENE_PATH]);
      // Still a loadable scene at every intermediate undo.
      expect(validateScene(onDisk()).valid).toBe(true);
    }

    // Byte-identical to what the generator wrote — not merely equivalent.
    expect(sceneBytes()).toBe(generatedBytes);
    const status = sceneHistoryStatus(projectRoot);
    expect(status.canUndo).toBe(false);
    expect(status.canRedo).toBe(true);
    expect(status.redoCount).toBe(edits.length);

    // ── Redo: the edited state returns exactly ──────────────────────────────
    for (let i = 0; i < edits.length; i++) {
      expect(redoSceneEdit(projectRoot).success).toBe(true);
    }
    expect(sceneBytes()).toBe(editedBytes);

    // ── Save, reload, identical ─────────────────────────────────────────────
    saveScene(join(projectRoot, SCENE_PATH), onDisk());
    const afterSave = sceneBytes();
    expect(afterSave).toBe(editedBytes);
    expect(loadScene(join(projectRoot, SCENE_PATH))).toEqual(onDisk());

    // A second save is a byte-for-byte no-op (SPEC R8).
    saveScene(join(projectRoot, SCENE_PATH), loadScene(join(projectRoot, SCENE_PATH)) as SceneFile);
    expect(sceneBytes()).toBe(afterSave);

    // Undo back to the generated state, then save it: saving what undo
    // restored reproduces exactly what the generator wrote, so undo and save
    // agree about the canonical bytes rather than merely about the data.
    for (let i = 0; i < edits.length; i++) undoSceneEdit(projectRoot);
    expect(sceneBytes()).toBe(generatedBytes);
    saveScene(join(projectRoot, SCENE_PATH), onDisk());
    expect(sceneBytes()).toBe(generatedBytes);

    for (let i = 0; i < edits.length; i++) redoSceneEdit(projectRoot);
    expect(sceneBytes()).toBe(editedBytes);
  });

  it('builds the generated project for real and gets the expected object count', async () => {
    // The generator writes a whole project, not just a scene file. This builds
    // it the way a developer would — transpile its own TypeScript, then run
    // its own `loadScene.ts` against real Three.js — and asserts the object
    // count the viewer would show. Three.js needs no GPU or window for this.
    const built = await buildGeneratedProject(projectRoot, workDir);

    expect(built.count).toBe(onDisk().instances.length);
    expect(built.rootCount).toBe(built.count);
    expect(built.ids).toEqual(['floor', 'marker']);
    // The default transform is identity: an object with no transform in the
    // scene file would land at the origin, which is exactly the failure R7's
    // seeded/absolute placement rules exist to prevent.
    expect(built.firstPosition).toEqual([0, -0.5, 0]);
    expect(built.parentLinks).toEqual([]);

    // Editing a transform and rebuilding moves the object — the viewer is
    // showing scene.json, not anything cached.
    edit({ op: 'setTransform', instanceId: 'marker', patch: { position: [9, 9, 9] } });
    const rebuilt = await buildGeneratedProject(projectRoot, workDir);
    expect(rebuilt.count).toBe(2);
    expect(rebuilt.positions.get('marker')).toEqual([9, 9, 9]);

    // And a parent added as data becomes a real parent link in the graph. The
    // new instance carries the cube's required params, because the generated
    // loader validates every instance before it builds anything.
    edit({
      op: 'addInstance',
      input: {
        id: 'child',
        prefab: 'cube',
        parent: 'floor',
        params: { size: 0.5, colour: '#ffffff' },
      },
    });
    const withChild = await buildGeneratedProject(projectRoot, workDir);
    expect(withChild.count).toBe(3);
    // The child moved off the root and onto its parent, so the root's own
    // child count drops by one while the total object count does not.
    expect(withChild.rootCount).toBe(2);
    expect(withChild.parentLinks).toEqual([['floor', 'child']]);
  });
});

// ── 2. A prefab that throws ─────────────────────────────────────────────────

describe('a prefab that throws', () => {
  /** Add a prefab that throws at import time — the harshest case. */
  function writeThrowingPrefab(): void {
    writeFileSync(
      join(projectRoot, 'prefabs', 'broken.ts'),
      [
        "throw new Error('broken.ts: this prefab throws the moment it is imported');",
        '',
        'export const nothing = 1;',
        '',
      ].join('\n'),
      'utf-8',
    );
  }

  /** Add a prefab that loads fine but throws inside `create`. */
  function writeCreateThrowingPrefab(): void {
    writeFileSync(
      join(projectRoot, 'prefabs', 'boom.ts'),
      [
        "import { z } from 'zod';",
        "import type { PrefabDefinition, PrefabParams, Rng, ThreeModule } from '@contextforge/core';",
        '',
        'export const paramsSchema = z.object({}).strict();',
        '',
        'export function create(',
        '  _three: ThreeModule,',
        '  _params: PrefabParams,',
        '  _rng: Rng,',
        '): { object: unknown; parts: Record<string, unknown> } {',
        "  throw new Error('boom.ts: create() cannot build this prefab');",
        '}',
        '',
        "export const boom: PrefabDefinition = {",
        "  name: 'boom',",
        "  description: 'A prefab whose create() always throws.',",
        '  paramsSchema,',
        '  create,',
        '};',
        '',
      ].join('\n'),
      'utf-8',
    );
  }

  it('is reported with its file and message, and the good prefabs still load', async () => {
    writeThrowingPrefab();
    writeCreateThrowingPrefab();

    // Loading the scene and reading the prefab list must not throw — this is
    // the assertion the whole scenario exists for.
    const scene = onDisk();
    expect(validateScene(scene).valid).toBe(true);

    const { registry } = await loadPrefabModules(projectRoot);

    // ── The failure is reported in `ipc.ts`'s `PrefabFailure` shape ────────
    // Exactly one prefab failed *to load*. `boom.ts` is deliberately in the
    // other bucket — see below — so `failed` names load failures only.
    expect(registry.failed.length).toBe(1);
    const thrownAtImport = registry.failed.find((f) => f.file === 'prefabs/broken.ts');
    expect(thrownAtImport).toBeDefined();
    expect(Object.keys(thrownAtImport ?? {}).sort()).toEqual(['file', 'name', 'reason']);
    expect(thrownAtImport?.name).toBe('prefabs/broken');
    expect(thrownAtImport?.reason).toContain('broken.ts: this prefab throws');
    expect(thrownAtImport?.reason).toMatch(/^Error: /);

    const fileShape = thrownAtImport as PrefabFailureContract;
    expect(typeof fileShape.name).toBe('string');
    expect(typeof fileShape.file).toBe('string');
    expect(typeof fileShape.reason).toBe('string');
    expect(fileShape.file).toBe('prefabs/broken.ts');

    // ── A prefab whose create() throws loads, and is caught on use ─────────
    // Importing it does not throw, so it is not in `failed`; the throw happens
    // when the scene instantiates it, which is a different place to report.
    const boom = registry.failed.find((f) => f.file === 'prefabs/boom.ts');
    expect(boom).toBeUndefined();
    expect(registry.prefabs.map((p) => p.name)).toContain('boom');

    // ── The good prefabs still load, and the scene still builds ────────────
    expect(registry.prefabs.map((p) => p.name).sort()).toEqual(['boom', 'cube']);
    expect(registry.prefabs.every((p) => p.name !== '' && p.description !== undefined)).toBe(true);
  });

  it('keeps the rest of the scene intact so a placeholder can be substituted', async () => {
    writeCreateThrowingPrefab();
    // A scene that places the broken prefab alongside two good ones. Written
    // through `saveScene`, so the file is valid by construction — an AI's
    // broken prefab is a *code* problem, not a scene-data problem.
    const withBroken: SceneFile = {
      ...onDisk(),
      instances: [
        ...onDisk().instances,
        {
          id: 'broken-one',
          prefab: 'boom',
          transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
          params: {},
        },
      ],
    };
    saveScene(join(projectRoot, SCENE_PATH), withBroken);

    const { summaries } = await loadPrefabModules(projectRoot);
    const byName = new Map(summaries.map((s) => [s.name, s]));

    // ── The data contract the viewer depends on: a placeholder per failure ─
    // The viewer cannot build the broken instance, but it can still build
    // every other one, and it knows exactly which one failed and where to look.
    // A placeholder is substituted in its place; the scene is not discarded.
    const placeholders: Array<{ instanceId: string; failedFile: string | null }> = [];
    const built: string[] = [];

    for (const instance of withBroken.instances) {
      const prefab = byName.get(instance.prefab);
      if (prefab === undefined) {
        placeholders.push({ instanceId: instance.id, failedFile: null });
        continue;
      }
      try {
        prefab.create(stubThree, instance.params, rngFor(withBroken.seed, instance.id));
        built.push(instance.id);
      } catch (error) {
        // Reported, not fatal: the thrown message names the file, exactly as a
        // `PrefabFailure` would after the viewer caught it at instantiation.
        placeholders.push({
          instanceId: instance.id,
          failedFile: error instanceof Error ? prefab.sourceFile : null,
        });
      }
    }

    expect(built).toEqual(['floor', 'marker']);
    expect(placeholders).toEqual([{ instanceId: 'broken-one', failedFile: 'prefabs/boom.ts' }]);

    // Everything that could be built was built: one placeholder out of three
    // instances, not a dead scene.
    expect(built.length + placeholders.length).toBe(withBroken.instances.length);
    expect(withBroken.instances.length).toBe(3);

    // And the throw carried the message, so the report is actionable.
    let message = '';
    try {
      byName.get('boom')?.create(stubThree, stubParams, rngFor(1, 'x'));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('boom.ts: create() cannot build this prefab');
  });

  it('refuses params for a prefab it could not build rather than guessing', async () => {
    writeCreateThrowingPrefab();
    const { summaries } = await loadPrefabModules(projectRoot);
    const registry: PrefabRegistry = { prefabs: summaries };

    // The registry is indexable despite the failure: the good prefabs are
    // addressable by name, which is what "a placeholder can be substituted"
    // means in practice.
    const index = indexPrefabs(registry);
    expect([...index.keys()].sort()).toEqual(['boom', 'cube']);

    // Params are still validated against the prefab's own schema — loading a
    // prefab is what makes its contract known, and it is known for the good
    // ones. A bad param is reported against its JSON path.
    const badParams: SceneFile = {
      ...onDisk(),
      instances: [
        { ...onDisk().instances[0]!, params: { size: -1, colour: 'not-a-colour' } },
        onDisk().instances[1]!,
      ],
    };
    const errors = validateScenePrefabs(badParams, registry);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map((e) => e.path)).toContain('instances[0].params.size');
    expect(errors.map((e) => e.path)).toContain('instances[0].params.colour');

    // A valid scene is still clean, so a broken prefab in the directory does
    // not manufacture phantom scene errors.
    expect(validateScenePrefabs(onDisk(), registry)).toEqual([]);
  });
});

// ── 3. The file-watcher scenario ─────────────────────────────────────────────

describe('an AI rewrites scene.json underneath an open editor', () => {
  it('reloads a valid rewrite', () => {
    const before = sceneBytes();
    const open: SceneFile = onDisk();
    const problems: string[] = [];

    // The AI adds a platform and repositions the marker.
    const rewritten: SceneFile = {
      ...open,
      instances: [
        ...open.instances.map((i) =>
          i.id === 'marker' ? { ...i, transform: { ...i.transform, position: [7, 0, 0] as [number, number, number] } } : i,
        ),
        {
          id: 'platform',
          prefab: 'cube',
          transform: { position: [4, 0, 0], rotation: [0, 0, 0], scale: [4, 1, 4] },
          params: { size: 1, colour: '#333333' },
        },
      ],
    };
    writeFileSync(join(projectRoot, SCENE_PATH), serializeScene(rewritten), 'utf-8');

    const { event, retained } = watchScene(projectRoot, problems);
    const contract = adopt(event);
    expect(contract.valid).toBe(true);
    expect(contract.problems).toEqual([]);
    expect(retained?.instances.map((i) => i.id)).toEqual(['floor', 'marker', 'platform']);
    expect(retained?.instances.find((i) => i.id === 'marker')?.transform.position).toEqual([7, 0, 0]);

    // The editor's reload sees exactly what is on disk, and the rewrite is a
    // real change rather than a reformat.
    expect(sceneBytes()).not.toBe(before);
    expect(validateScene(onDisk()).valid).toBe(true);
  });

  it('reports an invalid rewrite with JSON paths and retains the previous state', () => {
    // The editor is open on a valid scene.
    const open = onDisk();
    const lastGood = serializeScene(open);

    // ── 3a. Structural: a 2-component position, a typo'd key, a bad version ──
    const problems: string[] = [];
    const broken = JSON.parse(lastGood) as {
      instances: Array<Record<string, unknown>>;
    };
    broken.instances[1]!['transform'] = { position: [1, 2], rotation: [0, 0, 0], scale: [1, 1, 1] };
    broken.instances[0]!['postion'] = [1, 2, 3];
    writeFileSync(join(projectRoot, SCENE_PATH), `${JSON.stringify(broken, null, 2)}\n`, 'utf-8');

    const structural = watchScene(projectRoot, problems);
    // A refusal, not a payload: the editor is told what is wrong and keeps what
    // it had. The problems live in `problems`, each naming a JSON path.
    expect(structural.event.ok).toBe(false);
    if (structural.event.ok) throw new Error('unreachable');
    expect(structural.event.reason).toContain('scene.json');
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems.join('\n')).toContain('instances[1].transform.position');
    expect(problems.join('\n')).toContain('exactly 3 components');
    // Zod reports an unrecognised key at the object, naming the key in the
    // message — the path plus the message together are what R9 asks for.
    expect(problems.join('\n')).toContain('instances[0]');
    expect(problems.join('\n')).toContain('postion');
    // Nothing was adopted: the editor still holds the last good scene.
    expect(structural.retained).toBeNull();

    // The developer's last valid state is recoverable by putting it back.
    writeFileSync(join(projectRoot, SCENE_PATH), lastGood, 'utf-8');
    expect(serializeScene(onDisk())).toBe(lastGood);

    // ── 3b. A wrong `version` — refused loudly, not best-effort read ───────
    const versionProblems: string[] = [];
    const wrongVersion = JSON.parse(lastGood) as Record<string, unknown>;
    wrongVersion['version'] = 2;
    writeFileSync(join(projectRoot, SCENE_PATH), JSON.stringify(wrongVersion, null, 2), 'utf-8');
    watchScene(projectRoot, versionProblems);
    expect(versionProblems.join('\n')).toContain('version');
    expect(versionProblems.join('\n')).toContain('must be exactly 1');

    // ── 3c. Not JSON at all — an AI that truncated its write ───────────────
    const truncatedProblems: string[] = [];
    writeFileSync(join(projectRoot, SCENE_PATH), '{"version": 1, "instances": [\n', 'utf-8');
    const truncated = watchScene(projectRoot, truncatedProblems);
    expect(truncated.event.ok).toBe(false);
    expect(truncatedProblems.join('\n')).toContain('not valid JSON');
    expect(truncated.retained).toBeNull();

    // ── 3d. Every one of those left the previous valid state retrievable ───
    writeFileSync(join(projectRoot, SCENE_PATH), lastGood, 'utf-8');
    const recovered = watchScene(projectRoot, []);
    expect(recovered.event.ok).toBe(true);
    expect(recovered.retained).toEqual(open);
  });

  it('refuses to clobber the file when an edit is attempted against a broken rewrite', () => {
    const lastGood = sceneBytes();

    // An AI wrote something invalid.
    const broken = JSON.parse(lastGood) as { version: unknown };
    broken.version = 7;
    writeFileSync(join(projectRoot, SCENE_PATH), JSON.stringify(broken, null, 2), 'utf-8');
    const brokenBytes = sceneBytes();

    // The editor refuses to load it, so there is no in-memory scene to apply an
    // edit to — and it must not quietly resurrect the old one over the AI's.
    let refusedBecauseUnreadable = false;
    try {
      const scene = loadScene(join(projectRoot, SCENE_PATH));
      if (scene === null) refusedBecauseUnreadable = true;
    } catch {
      refusedBecauseUnreadable = true;
    }
    expect(refusedBecauseUnreadable).toBe(true);

    // The AI's bytes are still there, untouched.
    expect(sceneBytes()).toBe(brokenBytes);
    // And the last good state is one write away for the developer to restore.
    writeFileSync(join(projectRoot, SCENE_PATH), lastGood, 'utf-8');
    expect(validateScene(onDisk()).valid).toBe(true);
  });
});

// ── 4. Determinism ───────────────────────────────────────────────────────────

describe('determinism', () => {
  it('generates byte-identical files from the same brief', () => {
    const other = mkdtempSync(join(REPO_ROOT, '.e2e-brief-'));
    try {
      const second = generateProject(other, BRIEF);
      const first = walk(projectRoot).map((f) => relative(projectRoot, f).replaceAll('\\', '/')).sort();
      expect(second.files.slice().sort()).toEqual(first);

      for (const file of first) {
        expect(readFileSync(join(other, file), 'utf-8'), `${file} must be byte-identical`).toBe(
          readFileSync(join(projectRoot, file), 'utf-8'),
        );
      }

      // And a brief differing only in seed produces a different scene, so the
      // equality above is a real comparison rather than a constant.
      const third = mkdtempSync(join(REPO_ROOT, '.e2e-brief-'));
      try {
        generateProject(third, { ...BRIEF, seed: BRIEF.seed + 1 });
        expect(readFileSync(join(third, SCENE_PATH), 'utf-8')).not.toBe(
          readFileSync(join(projectRoot, SCENE_PATH), 'utf-8'),
        );
      } finally {
        rmSync(third, { recursive: true, force: true });
      }
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('produces deep-equal data from two loads of one scene', () => {
    const a = onDisk();
    const b = loadScene(join(projectRoot, SCENE_PATH)) as SceneFile;
    const c = loadScene(join(projectRoot, SCENE_PATH)) as SceneFile;

    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // Deep-equal *and* independent objects: mutating one must not affect the
    // next load, or "reload" would be a lie.
    expect(b).not.toBe(a);
    expect(b.instances).not.toBe(a.instances);
    b.instances[0]!.transform.position[0] = 1234;
    expect(onDisk().instances[0]!.transform.position[0]).toBe(0);

    // A save of a freshly loaded scene is a no-op on disk.
    const bytes = sceneBytes();
    saveScene(join(projectRoot, SCENE_PATH), onDisk());
    expect(sceneBytes()).toBe(bytes);
  });

  it('builds the same object graph twice from the same scene', async () => {
    const first = await buildGeneratedProject(projectRoot, workDir);
    const second = await buildGeneratedProject(projectRoot, workDir);
    expect(second.positions).toEqual(first.positions);
    expect(second.count).toBe(first.count);
    expect(second.parentLinks).toEqual(first.parentLinks);
  });
});

// ── 5. Refused edits write nothing ───────────────────────────────────────────

describe('a refused edit', () => {
  it('writes nothing for a duplicate id', () => {
    const before = sceneBytes();
    const result = applySceneEdit(projectRoot, SCENE_PATH, onDisk(), {
      op: 'addInstance',
      input: { id: 'floor', prefab: 'cube' },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('already used');
    // The scene handed back is the one that was passed in, unmodified.
    expect(result.scene).toEqual(onDisk());
    expect(sceneBytes()).toBe(before);
    expect(sceneHistoryStatus(projectRoot).undoCount).toBe(0);
    expect(sceneHistoryStatus(projectRoot).canUndo).toBe(false);

    // No undo step means no dead button: pressing undo says so rather than
    // appearing to do nothing.
    expect(undoSceneEdit(projectRoot).success).toBe(false);
  });

  it('writes nothing for an edit that breaks an invariant', () => {
    const before = sceneBytes();

    // A parent that does not exist: passes every local check in `addInstance`,
    // and is caught by validation on the way to disk (SPEC D15).
    const dangling = applySceneEdit(projectRoot, SCENE_PATH, onDisk(), {
      op: 'addInstance',
      input: { id: 'floating', prefab: 'cube', parent: 'nowhere' },
    });
    expect(dangling.ok).toBe(false);
    expect(dangling.error).toContain('instances[2].parent');
    expect(dangling.error).toContain('does not exist');
    expect(sceneBytes()).toBe(before);
    expect(sceneHistoryStatus(projectRoot).undoCount).toBe(0);

    // An empty id is refused by the schema, naming its path.
    const noId = applySceneEdit(projectRoot, SCENE_PATH, onDisk(), {
      op: 'addInstance',
      input: { id: '', prefab: 'cube' },
    });
    expect(noId.ok).toBe(false);
    expect(noId.error).toContain('instances[2].id');
    expect(sceneBytes()).toBe(before);

    // A 2-component position cannot be produced by any edit operation, so the
    // cycle and shape invariants below are asserted at the boundary they are
    // actually enforced at: `validateScene`, which `saveScene` calls before
    // every write. This is the guard behind D15 — an invariant that is only
    // checked when the value is written is still checked before the write.
    const open = onDisk();

    const cyclic: SceneFile = {
      ...open,
      instances: [
        ...open.instances,
        { id: 'a', prefab: 'cube', transform: { ...open.instances[0]!.transform }, params: {}, parent: 'c' },
        { id: 'b', prefab: 'cube', transform: { ...open.instances[0]!.transform }, params: {}, parent: 'a' },
        { id: 'c', prefab: 'cube', transform: { ...open.instances[0]!.transform }, params: {}, parent: 'b' },
      ],
    };
    const cycleCheck = validateScene(cyclic);
    expect(cycleCheck.valid).toBe(false);
    expect(cycleCheck.errors.map((e) => e.message).join('\n')).toContain('cycle');
    expect(cycleCheck.errors.map((e) => e.path)).toContain('instances[4].parent');

    const shortPosition: SceneFile = {
      ...open,
      instances: open.instances.map((i, index) =>
        index === 1 ? { ...i, transform: { ...i.transform, position: [1, 2] as unknown as [number, number, number] } } : i,
      ),
    };
    expect(validateScene(shortPosition).errors.map((e) => e.path)).toContain(
      'instances[1].transform.position',
    );

    // Nothing above touched the disk, and no history was recorded for any of
    // them — a refused change must not leave an undo step that does nothing.
    expect(sceneBytes()).toBe(before);
    expect(sceneHistoryStatus(projectRoot).undoCount).toBe(0);
  });

  it('writes nothing for an edit naming an instance that is not there', () => {
    const before = sceneBytes();
    for (const edit of [
      { op: 'setTransform', instanceId: 'ghost', patch: { position: [1, 1, 1] } },
      { op: 'swapModel', instanceId: 'ghost', model: 'models/x.glb' },
      { op: 'setParams', instanceId: 'ghost', params: { size: 1 } },
      { op: 'removeInstance', instanceId: 'ghost' },
    ] satisfies SceneEdit[]) {
      const result = applySceneEdit(projectRoot, SCENE_PATH, onDisk(), edit);
      expect(result.ok, `${edit.op} should be refused`).toBe(false);
      expect(result.error).toContain('no instance with id "ghost"');
    }

    expect(sceneBytes()).toBe(before);
    expect(sceneHistoryStatus(projectRoot).undoCount).toBe(0);
  });

  it('writes nothing when a slot validator rejects the swap, and nothing when it throws', () => {
    const before = sceneBytes();
    const rejecting: SlotValidatorShape = (model) => ({
      ok: false,
      model,
      rejections: [
        {
          kind: 'missing_rig',
          expectation: 'rigged model',
          reason: `"${model}" is an unrigged mesh — the slot "character" requires a rigged model`,
        },
      ],
      reason: `"${model}" is an unrigged mesh — the slot "character" requires a rigged model`,
    });

    const refused = applySceneEdit(projectRoot, SCENE_PATH, onDisk(), {
      op: 'swapModel',
      instanceId: 'marker',
      model: 'models/buoy.glb',
      validator: rejecting,
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('unrigged mesh');
    expect(sceneBytes()).toBe(before);

    // A validator that throws is a refusal too — an unreadable asset must not
    // crash the Modelling screen.
    const thrown = applySceneEdit(projectRoot, SCENE_PATH, onDisk(), {
      op: 'swapModel',
      instanceId: 'marker',
      model: 'models/buoy.glb',
      validator: (): never => {
        throw new Error('asset server unreachable');
      },
    });
    expect(thrown.ok).toBe(false);
    expect(thrown.error).toContain('asset server unreachable');
    expect(sceneBytes()).toBe(before);
    expect(sceneHistoryStatus(projectRoot).undoCount).toBe(0);
  });

  it('records no history for an edit that changes nothing', () => {
    const before = sceneBytes();
    // Setting the marker's position to what it already is is a no-op edit.
    const result = applySceneEdit(projectRoot, SCENE_PATH, onDisk(), {
      op: 'setTransform',
      instanceId: 'marker',
      patch: { position: [0, 0.5, 0] },
    });
    expect(result.ok).toBe(true);
    expect(result.patchId).toBeUndefined();
    expect(sceneBytes()).toBe(before);
    expect(sceneHistoryStatus(projectRoot).undoCount).toBe(0);
  });
});

// ── Helpers needing the built project ───────────────────────────────────────

interface BuiltProject {
  /** Total objects built — every instance, parented or not. */
  count: number;
  /** Objects still directly on the scene root (i.e. unparented). */
  rootCount: number;
  ids: string[];
  positions: Map<string, number[]>;
  /** `[parentId, childId]` for every instance that has a parent. */
  parentLinks: Array<[string, string]>;
  firstPosition: number[];
}

/**
 * Build the generated project, with `node:fs`/`node:path` redirected to a refusal.
 *
 * The generated `loadScene.ts` is transpiled and executed against real
 * Three.js. Building it into a directory *inside the repo* means Node resolves
 * `three` and `@contextforge/core` by walking up from there, so what runs is
 * genuinely the code the generator emitted.
 *
 * The generated `loadScene.ts` **runs in a browser** — that is the whole point of
 * it fetching `scene.json` rather than calling core's `loadScene()` — so it
 * imports `@contextforge/core/dist/scene/…`, and that module's top-level
 * `import … from 'node:fs'` must resolve or the generated project cannot start.
 *
 * **It is redirected to a module whose exports throw, never to a stub.** A
 * bundler that aliased these to `undefined` would make `loadScene()` report "no
 * scene at <path>" for a perfectly valid project — a wrong answer that looks
 * like a right one (SPEC R9). This is the same aliasing the game's own
 * `vite.config.js` performs, reproduced here because this harness does not go
 * through Vite.
 */
function redirectNodeBuiltins(code: string): string {
  return code.replace(/(['"])node:(fs|path)\1/g, JSON.stringify(join(__dirname, 'node-builtin-refusal.mjs')));
}

/**
 * A `fetch` that reads a `file:` URL off this filesystem.
 *
 * Node's `fetch` has no `file:` scheme, and the generated loader takes its
 * fetcher as a parameter precisely so it can be exercised headlessly. This is
 * that injection point — the loader is unchanged by it.
 */
const fetchFromDisk: typeof fetch = (async (input: unknown) => {
  const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? '');
  if (!url.startsWith('file:')) throw new Error(`fetchFromDisk only reads file: URLs, got ${url}`);
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

async function buildGeneratedProject(root: string, work: string): Promise<BuiltProject> {
  const out = join(work, `build-${Math.random().toString(36).slice(2)}`);
  for (const file of walk(root)) {
    const rel = relative(root, file);
    const dest = join(out, rel.replace(/\.ts$/, '.js'));
    mkdirSync(dirname(dest), { recursive: true });
    if (file.endsWith('.ts')) {
      const { code } = transformSync(readFileSync(file, 'utf-8'), {
        loader: 'ts',
        format: 'esm',
        target: 'node22',
      });
      writeFileSync(dest, redirectNodeBuiltins(code), 'utf-8');
    } else {
      cpSync(file, dest);
    }
  }
  writeFileSync(join(out, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');

  const module = (await import(pathToFileURL(join(out, 'loadScene.js')).href)) as {
    buildScene(
      path?: string,
      options?: { fetchImpl?: typeof fetch },
    ): Promise<{
      root: {
        name: string;
        children: Array<{ name: string; position: { toArray(): number[] }; parent: { name: string } | null }>;
      };
      byId: Map<string, { object: { position: { toArray(): number[] } } }>;
      scene: SceneFile;
    }>;
  };

  // Awaited, and given the fetcher: the generated loader is a browser module, so
  // `buildScene` is async. `fetchFromDisk` is the same injection point the game's
  // own loader exposes — the loader is exercised unchanged.
  const built = await module.buildScene(join(out, 'scene.json'), { fetchImpl: fetchFromDisk });
  const positions = new Map<string, number[]>();
  for (const [id, instance] of built.byId) {
    positions.set(id, instance.object.position.toArray());
  }

  // `root.children` counts only what is *directly* on the root. A parented
  // instance is re-attached to its parent, so the renderer's object count is
  // `byId.size` (every instance the prefabs produced) and the root count is
  // separate. Both are asserted, because getting this wrong is exactly the bug
  // that makes a viewer appear to lose an object.
  const parentLinks: Array<[string, string]> = [];
  for (const instance of built.scene.instances) {
    if (instance.parent !== undefined) parentLinks.push([instance.parent, instance.id]);
  }
  for (const link of parentLinks) {
    expect(positions.has(link[0]), `parent "${link[0]}" must have been built`).toBe(true);
    expect(positions.has(link[1]), `child "${link[1]}" must have been built`).toBe(true);
  }

  const ids = [...built.byId.keys()];
  return {
    count: built.byId.size,
    rootCount: built.root.children.length,
    ids,
    positions,
    parentLinks,
    firstPosition: positions.get(ids[0] ?? '') ?? [],
  };
}

/**
 * The validator `swapModel` accepts, structurally declared.
 *
 * `SlotValidator` lives in `scene/slots.ts` and is **not** exported from core's
 * `index.ts` — another agent owns that module and it is still in flight — so the
 * shape is pinned here rather than imported from a file that may change or may
 * not exist. `SlotRejectionKind` is spelled out rather than widened to `string`
 * so a new rejection kind is a compile error here instead of silently
 * mismatching `swapModel`'s parameter.
 */
type SlotValidatorShape = (modelPath: string) => {
  ok: boolean;
  model: string;
  rejections: Array<{
    kind: 'file_not_found' | 'wrong_slot_type' | 'missing_rig' | 'missing_animation' | 'exceeds_max_size';
    expectation: string;
    reason: string;
  }>;
  reason: string;
};
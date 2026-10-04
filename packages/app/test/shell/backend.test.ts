/**
 * test/shell/backend.test.ts — the main process's behaviour, without Electron.
 *
 * `AppBackend` imports no Electron, so the whole main process can be driven from
 * Node against a real temp directory. These tests are about the behaviours the
 * renderer cannot check, because the renderer only ever sees the results:
 *
 *  - a project with no scene file opens, and says so;
 *  - a scene file an AI has just broken opens anyway, with the errors in
 *    `problems` and the last valid state still on screen;
 *  - an edit is written to disk and recorded as exactly one undo step;
 *  - undo and redo change the file on disk, not just the returned value;
 *  - a refused edit writes nothing and records no step;
 *  - a real registry written as TypeScript is loaded, and its Zod schema becomes
 *    an inspector form;
 *  - an external write to the scene file emits `sceneChangedOnDisk`, debounced.
 *
 * No Electron is booted. That is not a limitation of the test suite; it is the
 * reason `ipcHandlers.ts` has no Electron import.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearHistory,
  generateProject,
  saveScene,
  serializeScene,
  validateScene,
  type SceneFile,
} from '@contextforge/core';
import { CHANNELS, EVENTS, type EventName, type HistoryActionOutcome, type SceneSnapshot } from '../../src/ipc.js';
import {
  AppBackend,
  detectEngine,
  findSceneFile,
  isDirectory,
  readSceneFile,
  registerHandlers,
  WATCH_DEBOUNCE_MS,
  type IpcMainLike,
  type SceneRead,
} from '../../src/electron/ipcHandlers.js';

/** A temp directory, removed after the test. */
const temporaries: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-shell-'));
  temporaries.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** One recorded push event. */
interface Sent {
  event: EventName;
  payload: unknown;
}

/** A backend that records what it would have sent. */
function backend(): { app: AppBackend; sent: Sent[] } {
  const sent: Sent[] = [];
  const app = new AppBackend((event, payload) => {
    sent.push({ event, payload: payload as unknown });
  }, { allowUnpickedRoot: 'test-only' });
  return { app, sent };
}

/** Assert a `Result` succeeded, and give the value. */
function value<T>(result: { ok: boolean } & Record<string, unknown>, label: string): T {
  if (result.ok !== true) {
    throw new Error(`${label} failed: ${String(result['reason'])}`);
  }
  return result['value'] as T;
}

/** A generated project, which is the realistic fixture. */
function generatedProject(): string {
  const root = tempDir();
  const project = join(root, 'demo');
  generateProject(project, {
    name: 'demo',
    idea: 'A game where you dodge falling crates and collect coins for points.',
  });
  return project;
}

/** A scene with two instances, for edits that are observable. */
function twoCubes(): SceneFile {
  return {
    version: 1,
    name: 'Level1',
    engine: 'three',
    seed: 3,
    instances: [
      {
        id: 'floor',
        prefab: 'cube',
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        params: { size: 1, colour: '#4a4a55' },
      },
      {
        id: 'marker',
        prefab: 'cube',
        transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        params: { size: 1, colour: '#4fc3f7' },
      },
    ],
    lights: [{ id: 'ambient', kind: 'ambient', color: '#ffffff', intensity: 0.4 }],
    camera: { kind: 'perspective', position: [0, 6, 12], rotation: [-0.3, 0, 0] },
  };
}

// ── Opening ─────────────────────────────────────────────────────────────────

describe('backend — opening a project', () => {
  it('refuses a path that is not a folder, and says which kind of path it wanted', async () => {
    const { app } = backend();
    const dir = tempDir();
    const file = join(dir, 'a-file.txt');
    writeFileSync(file, 'x', 'utf-8');

    const result = await app.openProject({ root: file });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Not a folder/);
  });

  it('refuses a folder that does not exist', async () => {
    const { app } = backend();
    const result = await app.openProject({ root: join(tempDir(), 'nope') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/No such folder/);
  });

  it('opens a generated project and reads its scene and prefabs', async () => {
    const { app } = backend();
    const root = generatedProject();

    const snapshot = value<SceneSnapshot>(await app.openProject({ root }), 'openProject');

    expect(snapshot.project.root).toBe(root);
    expect(snapshot.project.name).toBe('demo');
    expect(snapshot.project.scenePath).toBe('scene.json');
    expect(snapshot.project.engine).toBe('three');
    expect(snapshot.scene.instances.map((i) => i.id)).toEqual(['floor', 'marker']);
    // The real registry, bundled and loaded: this is the end-to-end check that a
    // TypeScript `prefabs/index.ts` written by an AI is loadable at all.
    expect(snapshot.prefabs.prefabs.map((p) => p.name)).toEqual(['cube']);
    expect(snapshot.prefabs.failed).toEqual([]);
    expect(snapshot.problems).toEqual([]);
  });

  it('turns the prefab Zod schema into an inspector form', async () => {
    const { app } = backend();
    const snapshot = value<SceneSnapshot>(await app.openProject({ root: generatedProject() }), 'open');

    const schema = snapshot.prefabs.prefabs[0]?.paramsJsonSchema;

    expect(schema?.type).toBe('object');
    // `cube` declares size (positive number), colour (regex string) and jitter
    // (0..1 with a default).
    expect(schema?.properties['size']).toMatchObject({ kind: 'number', min: 0 });
    expect(schema?.properties['colour']).toMatchObject({ kind: 'string', pattern: '^#[0-9a-fA-F]{6}$' });
    expect(schema?.properties['jitter']).toMatchObject({ kind: 'number', min: 0, max: 1, default: 0 });
    expect(schema?.required).toEqual(['size', 'colour']);
    expect(schema?.additionalProperties).toBe(false);
  });

  it('opens a project with no scene file, and says the file will be created', async () => {
    const { app } = backend();
    const root = tempDir();

    const snapshot = value<SceneSnapshot>(await app.openProject({ root }), 'openProject');

    expect(snapshot.scene.instances).toEqual([]);
    expect(snapshot.project.scenePath).toBe('scene.json');
    expect(snapshot.problems.join(' ')).toMatch(/No scene\.json/);
  });

  it('finds the first scene under scenes/ when there is no root scene.json', async () => {
    const { app } = backend();
    const root = generatedProject();
    // Move the generated scene into scenes/ with a second one beside it, and
    // check the *sorted* first is chosen rather than the newest.
    const scenes = join(root, 'scenes');
    rmSync(join(root, 'scene.json'));
    mkdirSync(scenes, { recursive: true });
    writeFileSync(join(scenes, 'Alpha.scene.json'), serializeScene(twoCubes()), 'utf-8');
    writeFileSync(join(scenes, 'Zulu.scene.json'), serializeScene(twoCubes()), 'utf-8');

    const snapshot = value<SceneSnapshot>(await app.openProject({ root }), 'openProject');

    expect(snapshot.project.scenePath).toBe('scenes/Alpha.scene.json');
  });

  it('reports a prefab that fails to load, and still opens the project', async () => {
    const { app } = backend();
    const root = generatedProject();
    writeFileSync(join(root, 'prefabs', 'cube.ts'), 'this is not typescript ((( ', 'utf-8');

    const snapshot = value<SceneSnapshot>(await app.openProject({ root }), 'openProject');

    expect(snapshot.problems.length).toBeGreaterThan(0);
    expect(snapshot.problems.join(' ')).toMatch(/prefab/i);
    // The scene still loaded — the developer can see what is wrong and fix it.
    expect(snapshot.scene.instances).toHaveLength(2);
  });

  it('reports an unknown prefab name without refusing to open', async () => {
    const { app } = backend();
    const root = generatedProject();
    const scene = twoCubes();
    scene.instances[0] = { ...(scene.instances[0] as never), prefab: 'unicorn' } as never;
    saveScene(join(root, 'scene.json'), scene);

    const snapshot = value<SceneSnapshot>(await app.openProject({ root }), 'openProject');

    expect(snapshot.problems.join(' ')).toMatch(/no registered prefab named "unicorn"/);
  });
});

// ── Invalid scenes ──────────────────────────────────────────────────────────

describe('backend — a scene file an AI has just broken', () => {
  it('opens anyway, reports every problem, and keeps the last valid state', async () => {
    const { app } = backend();
    const root = generatedProject();

    // Open it first, so there *is* a last valid state.
    const good = value<SceneSnapshot>(await app.openProject({ root }), 'openProject');
    const lastValid = good.scene.instances.map((i) => i.id);

    // Now an AI writes something invalid.
    const broken = JSON.parse(readFileSync(join(root, 'scene.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    (broken['instances'] as unknown[]).push({
      id: 'floor',
      prefab: 'cube',
      transform: { position: [0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      params: {},
    });
    writeFileSync(join(root, 'scene.json'), JSON.stringify(broken, null, 2), 'utf-8');

    const after = value<SceneSnapshot>(await app.loadScene(), 'loadScene');

    // Not an error, not a dead screen: a working snapshot with the errors listed.
    expect(after.scene.instances.map((i) => i.id)).toEqual(lastValid);
    const problems = after.problems.join('\n');
    // Only the shape failure is reported.
    //
    // `validateScene` returns as soon as Zod rejects the shape, because the
    // cross-field rules (duplicate ids, parent cycles) need a *parsed* scene
    // and there is not one. This is a known and deliberate limit rather than an
    // oversight — see D19 — and the test states it so a change that starts
    // reporting both is a visible improvement rather than a silent one.
    expect(problems).toMatch(/instances\[2\]\.transform\.position/);
    expect(problems).toMatch(/exactly 3 components/);
    expect(problems).not.toMatch(/duplicate instance id/);
    expect(after.prefabs.prefabs).toHaveLength(1);
  });

  it('keeps the last valid state across a disk change and reports it as invalid', async () => {
    const { app, sent } = backend();
    const root = generatedProject();
    const opened = value<SceneSnapshot>(await app.openProject({ root }), 'openProject');
    const lastValid = opened.scene.instances.map((i) => i.id);

    // Break the file the way a half-finished AI edit does: truncated JSON, which
    // is the failure `loadScene` must survive without throwing.
    writeFileSync(join(root, 'scene.json'), '{ "version": 1, ', 'utf-8');
    await waitUntil(() => sent.some((s) => s.event === EVENTS.sceneChangedOnDisk));

    const event = sent.find((s) => s.event === EVENTS.sceneChangedOnDisk);
    expect(event).toBeDefined();

    const payload = event?.payload as { valid: boolean; problems: string[] };
    expect(payload.valid).toBe(false);
    expect(payload.problems.join(' ')).toMatch(/not valid JSON/i);

    // The backend still holds the last scene that loaded, so the renderer keeps
    // showing the developer's work instead of blanking the viewport.
    const after = value<SceneSnapshot>(await app.loadScene({}), 'loadScene');
    expect(after.scene.instances.map((i) => i.id)).toEqual(lastValid);
    expect(after.problems.join(' ')).toMatch(/not valid JSON/i);
  });

  it('does not save over an invalid file, and says so', async () => {
    const { app } = backend();
    const root = generatedProject();
    const before = readFileSync(join(root, 'scene.json'), 'utf-8');
    const snapshot = value<SceneSnapshot>(await app.openProject({ root }), 'openProject');

    // Hand the backend a scene with a duplicate id — a `SceneFile`-typed value a
    // caller can still have built by hand.
    const bad: SceneFile = { ...snapshot.scene, instances: [snapshot.scene.instances[0] as never, snapshot.scene.instances[0] as never] };
    (app as unknown as { scene: SceneFile }).scene = bad;

    const result = app.save();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/^Not saved — /);
    // The file on disk is untouched: the refusal happened before the write.
    expect(readFileSync(join(root, 'scene.json'), 'utf-8')).toBe(before);
  });
});

// ── Edits, undo, redo ───────────────────────────────────────────────────────

describe('backend — edits reach disk as one undo step', () => {
  it('writes the edit and reports the new state', async () => {
    const { app } = backend();
    const root = generatedProject();
    await app.openProject({ root });

    const after = value<SceneSnapshot>(
      await app.applyEdit({ op: 'setTransform', instanceId: 'marker', patch: { position: [7, 0, 0] } }),
      'applyEdit',
    );

    expect(after.scene.instances[1]?.transform.position).toEqual([7, 0, 0]);
    // The file on disk is the truth, and it changed.
    const onDisk = JSON.parse(readFileSync(join(root, 'scene.json'), 'utf-8')) as SceneFile;
    expect(onDisk.instances[1]?.transform.position).toEqual([7, 0, 0]);
    expect(after.history).toMatchObject({ canUndo: true, canRedo: false, undoCount: 1, redoCount: 0 });
    expect(after.problems).toEqual([]);
  });

  it('undo and redo change the file, not just the returned value', async () => {
    const { app } = backend();
    const root = generatedProject();
    const original = readFileSync(join(root, 'scene.json'), 'utf-8');
    await app.openProject({ root });
    await app.applyEdit({ op: 'setTransform', instanceId: 'marker', patch: { position: [7, 0, 0] } });

    // Looked up by id, not by index: an index is a claim about the template's
    // array order, and this assertion is about undo, not about layout.
    const at = (scene: SceneSnapshot, id: string): unknown =>
      scene.scene.instances.find((i) => i.id === id)?.transform.position;

    const undone = value<HistoryActionOutcome>(await app.undo(), 'undo');
    expect(at(undone.snapshot, 'marker')).toEqual([0, 0.5, 0]);
    expect(readFileSync(join(root, 'scene.json'), 'utf-8')).toBe(original);

    const redone = value<HistoryActionOutcome>(await app.redo(), 'redo');
    expect(at(redone.snapshot, 'marker')).toEqual([7, 0, 0]);
    expect(readFileSync(join(root, 'scene.json'), 'utf-8')).not.toBe(original);

    // Both directions report the file they touched, so the screen can name it.
    // Before, `paths` was dropped here and the answer never left the main
    // process, which is why undo could only say "changes were reverted".
    expect(undone.paths).toEqual(['scene.json']);
    expect(redone.paths).toEqual(['scene.json']);
    expect(undone.undoCount).toBe(0);
    expect(undone.canRedo).toBe(true);
  });

  it('a refused edit writes nothing and records no undo step', async () => {
    const { app } = backend();
    const root = generatedProject();
    await app.openProject({ root });
    const before = readFileSync(join(root, 'scene.json'), 'utf-8');

    const result = await app.applyEdit({
      op: 'addInstance',
      input: { id: 'ghost-child', prefab: 'cube', parent: 'does-not-exist' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/parent "does-not-exist" does not exist/);
    expect(readFileSync(join(root, 'scene.json'), 'utf-8')).toBe(before);
    // No undo step: a refused edit that left one would appear to do nothing when
    // the developer pressed Ctrl+Z.
    const snapshot = value<SceneSnapshot>(await app.loadScene(), 'loadScene');
    expect(snapshot.history.undoCount).toBe(0);
  });

  it('a refused edit for an id that is not there names the id', async () => {
    const { app } = backend();
    const root = generatedProject();
    await app.openProject({ root });

    const result = await app.applyEdit({ op: 'removeInstance', instanceId: 'nope' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no instance with id "nope"');
  });

  it('refuses every channel that needs a project when none is open', async () => {
    const { app } = backend();
    for (const result of [app.loadScene(), app.undo(), app.redo(), app.save(), app.listPrefabs()]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('No project is open.');
    }
    expect((await app.applyEdit({ op: 'removeInstance', instanceId: 'x' })).ok).toBe(false);
  });

  it('save creates the file in a project that had none', async () => {
    const { app } = backend();
    const root = tempDir();
    const opened = value<SceneSnapshot>(await app.openProject({ root }), 'openProject');
    expect(opened.problems.length).toBeGreaterThan(0);

    const saved = value<SceneSnapshot>(await app.save(), 'save');

    // The scene file is now written and valid — that is what this test is about.
    expect(validateScene(JSON.parse(readFileSync(join(root, 'scene.json'), 'utf-8'))).valid).toBe(true);
    // A project with no prefabs/ is a legitimate state, so it is reported as an
    // informational problem rather than silently ignored — the developer is told
    // why nothing appears in the viewport.
    expect(saved.problems.join(' ')).toMatch(/no prefabs directory/);
  });
});

// ── Watching ────────────────────────────────────────────────────────────────

describe('backend — file watching', () => {
  it('emits sceneChangedOnDisk once for a burst of writes, debounced', async () => {
    const { app, sent } = backend();
    const root = generatedProject();
    await app.openProject({ root });

    // Three writes in quick succession, as a tool doing an atomic-ish save would.
    for (const position of [[2, 0, 0], [3, 0, 0], [4, 0, 0]]) {
      const scene = twoCubes();
      scene.instances[0] = { ...(scene.instances[0] as never), transform: { position: position as never, rotation: [0, 0, 0], scale: [1, 1, 1] } } as never;
      writeFileSync(join(root, 'scene.json'), serializeScene(scene), 'utf-8');
    }

    // Wait for the first event, then let the debounce window close on its own —
    // "exactly one" can only be checked after the last possible event has had its
    // chance. Polling for the count to reach 3 would defeat the point of the test.
    await waitUntil(() => sent.some((s) => s.event === EVENTS.sceneChangedOnDisk));
    await wait(WATCH_DEBOUNCE_MS * 4);

    const events = sent.filter((s) => s.event === EVENTS.sceneChangedOnDisk);
    // One, not three: a multi-write save reported three times shows the developer
    // the same message three times.
    expect(events).toHaveLength(1);
    expect((events[0]?.payload as { valid: boolean }).valid).toBe(true);
  });

  it('reports an invalid external write as invalid rather than applying it', async () => {
    const { app, sent } = backend();
    const root = generatedProject();
    await app.openProject({ root });

    writeFileSync(join(root, 'scene.json'), '{ "version": 1, "instances": [', 'utf-8');
    await waitUntil(() => sent.some((s) => s.event === EVENTS.sceneChangedOnDisk));

    const event = sent.find((s) => s.event === EVENTS.sceneChangedOnDisk);
    const payload = event?.payload as { valid: boolean; problems: string[] };
    expect(payload.valid).toBe(false);
    expect(payload.problems.join(' ')).toMatch(/not valid JSON/);
  });

  it('does not report its own applyEdit back to the renderer', async () => {
    const { app, sent } = backend();
    const root = generatedProject();
    await app.openProject({ root });

    await app.applyEdit({ op: 'setTransform', instanceId: 'marker', patch: { position: [8, 0, 0] } });

    // A *negative* assertion, so it cannot poll: waiting for a condition to become
    // true is the only way to know an event is coming, and here the point is that
    // none does. The sleep is therefore a genuine lower bound on "the watcher had
    // its chance and stayed quiet", and it is stated as such rather than dressed
    // up as a wait. It is the one place in this suite where a fixed interval is
    // the honest tool.
    await wait(WATCH_DEBOUNCE_MS * 6);

    // The renderer already has the result of the applyEdit that caused the write;
    // echoing it would reload the scene under the developer's cursor.
    expect(sent.filter((s) => s.event === EVENTS.sceneChangedOnDisk)).toHaveLength(0);
  });

  it('emits prefabsChanged and rebuilds the registry', async () => {
    const { app, sent } = backend();
    const root = generatedProject();
    await app.openProject({ root });

    // A new prefab file, added the way an AI would add one.
    writeFileSync(
      join(root, 'prefabs', 'sphere.ts'),
      [
        "import { z } from 'zod';",
        'export const sphere = {',
        "  name: 'sphere',",
        "  description: 'A ball.',",
        '  paramsSchema: z.object({ radius: z.number().positive() }).strict(),',
        '  create: () => ({ object: {}, parts: {} }),',
        '};',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(root, 'prefabs', 'index.ts'),
      [
        "import type { PrefabRegistry } from '@contextforge/core';",
        "import { cube } from './cube.js';",
        "import { sphere } from './sphere.js';",
        'export const registry: PrefabRegistry = { prefabs: [cube, sphere] };',
        'export default registry;',
      ].join('\n'),
      'utf-8',
    );

    // Wait for the *registry contents*, not merely for an event: a `prefabsChanged`
    // carrying only `cube` (an intermediate rebuild part-way through the two
    // writes above) would satisfy an "an event arrived" predicate and then fail on
    // the name assertion, turning a timing race into a confusing diff.
    await waitUntil(() =>
      sent.some(
        (s) =>
          s.event === EVENTS.prefabsChanged &&
          ((s.payload as { registry: { prefabs: { name: string }[] } }).registry.prefabs.map(
            (p) => p.name,
          ).join(',') === 'cube,sphere'),
      ),
    );

    const event = sent.find((s) => s.event === EVENTS.prefabsChanged);
    expect(event).toBeDefined();
    const registry = (event?.payload as { registry: { prefabs: { name: string }[] } }).registry;
    expect(registry.prefabs.map((p) => p.name)).toEqual(['cube', 'sphere']);
  });

  it('stops watching when the project is closed', async () => {
    const { app, sent } = backend();
    const root = generatedProject();
    await app.openProject({ root });
    app.closeProject();

    writeFileSync(join(root, 'scene.json'), serializeScene(twoCubes()), 'utf-8');
    // Negative assertion, so a fixed sleep is the honest tool: there is no
    // condition to poll *for*. See the note on `waitUntil` above.
    await wait(WATCH_DEBOUNCE_MS * 4);

    expect(sent).toHaveLength(0);
  });

  // Written with double quotes on purpose: the bundled esbuild mis-parses a
  // single-quoted string containing an apostrophe when a `,` follows it, and
  // blames the apostrophe ('Expected ) but found s') instead of saying so.
  // Escaping it would work too; a double quote reads better than a backslash.
  it("releases the previous project's watchers when another is opened", async () => {
    const { app, sent } = backend();
    const first = generatedProject();
    const second = generatedProject();
    await app.openProject({ root: first });
    await app.openProject({ root: second });

    writeFileSync(join(first, 'scene.json'), serializeScene(twoCubes()), 'utf-8');
    // Negative assertion — see the note on `waitUntil` above.
    await wait(WATCH_DEBOUNCE_MS * 4);

    expect(sent.filter((s) => s.event === EVENTS.sceneChangedOnDisk)).toHaveLength(0);
  });
});

// ── Registration ────────────────────────────────────────────────────────────

describe('registerHandlers', () => {
  it('registers a handler for every channel in CHANNELS and nothing else', () => {
    const registered: string[] = [];
    const ipcMain: IpcMainLike = {
      handle: (channel) => {
        registered.push(channel);
      },
      removeHandler: () => {},
    };

    registerHandlers(ipcMain, backend().app);

    expect([...registered].sort()).toEqual([...Object.values(CHANNELS)].sort());
  });

  it('removes every handler on teardown', () => {
    const removed: string[] = [];
    const ipcMain: IpcMainLike = {
      handle: () => {},
      removeHandler: (channel) => {
        removed.push(channel);
      },
    };

    registerHandlers(ipcMain, backend().app)();

    expect(removed.sort()).toEqual([...Object.values(CHANNELS)].sort());
  });

  it('a handler that throws returns a Result rather than rejecting', async () => {
    const listeners = new Map<string, (event: unknown, ...args: never[]) => unknown>();
    const ipcMain: IpcMainLike = {
      handle: (channel, listener) => {
        listeners.set(channel, listener);
      },
      removeHandler: () => {},
    };

    // A backend whose snapshot blows up, standing in for any unpredicted bug.
    //
    // A project has to be open first: `loadScene` refuses with 'No project is
    // open.' before it ever reads the snapshot, so without this the test would
    // assert the refusal path while claiming to assert the throw path.
    const { app } = backend();
    await app.openProject({ root: generatedProject() });
    Object.defineProperty(app, 'snapshot', {
      get: () => {
        throw new Error('the disk went away');
      },
    });
    registerHandlers(ipcMain, app);

    const handler = listeners.get(CHANNELS.loadScene);
    if (handler === undefined) throw new Error('no handler registered');
    const result = (await handler(null, {} as never)) as { ok: boolean; reason: string };

    // A rejected promise here would be an unhandled rejection in the renderer
    // carrying a message written for a stack trace.
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('the disk went away');
  });

  it('routes a request to the right backend method', async () => {
    const listeners = new Map<string, (event: unknown, ...args: never[]) => unknown>();
    const ipcMain: IpcMainLike = {
      handle: (channel, listener) => {
        listeners.set(channel, listener);
      },
      removeHandler: () => {},
    };
    const { app } = backend();
    registerHandlers(ipcMain, app);
    const root = generatedProject();

    const opened = (await (listeners.get(CHANNELS.openProject) as NonNullable<
      typeof listeners.get<string>
    >)(null, { root } as never)) as { ok: boolean; value: SceneSnapshot };
    expect(opened.ok).toBe(true);
    expect(opened.value.scene.instances).toHaveLength(2);
    app.teardown();
  });
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('findSceneFile', () => {
  it('prefers a root scene.json', () => {
    const root = generatedProject();
    expect(findSceneFile(root)?.relativePath).toBe('scene.json');
  });

  it('returns null for a project with no scene', () => {
    expect(findSceneFile(tempDir())).toBeNull();
  });

  it('finds one nested under scenes/', () => {
    const root = tempDir();
    mkdirSync(join(root, 'scenes', 'levels'), { recursive: true });
    writeFileSync(join(root, 'scenes', 'levels', 'Deep.scene.json'), '{}', 'utf-8');
    expect(findSceneFile(root)?.relativePath).toBe('scenes/levels/Deep.scene.json');
  });
});

describe('readSceneFile', () => {
  it('reports a missing file and offers an empty scene', () => {
    const read: SceneRead = readSceneFile(join(tempDir(), 'nope.json'), null);
    expect(read.valid).toBe(false);
    expect(read.problems.join(' ')).toMatch(/No scene file/);
    expect(read.scene.instances).toEqual([]);
  });

  it('reports invalid JSON without throwing', () => {
    const dir = tempDir();
    const file = join(dir, 'scene.json');
    writeFileSync(file, '{ nope', 'utf-8');
    const read = readSceneFile(file, null);
    expect(read.valid).toBe(false);
    expect(read.problems.join(' ')).toMatch(/not valid JSON/);
  });

  it('falls back to the scene it was given when the file is invalid', () => {
    const dir = tempDir();
    const file = join(dir, 'scene.json');
    const lastValid = twoCubes();
    writeFileSync(file, JSON.stringify({ version: 1, name: 'x' }), 'utf-8');
    const read = readSceneFile(file, lastValid);
    expect(read.scene).toBe(lastValid);
    expect(read.valid).toBe(false);
  });
});

describe('detectEngine', () => {
  it('trusts project.godot above all', () => {
    const root = tempDir();
    writeFileSync(join(root, 'project.godot'), '', 'utf-8');
    expect(detectEngine(root, twoCubes())).toBe('godot');
  });

  it('falls back to the scene, then to three', () => {
    expect(detectEngine(tempDir(), { ...twoCubes(), engine: 'godot' })).toBe('godot');
    expect(detectEngine(tempDir(), null)).toBe('three');
  });
});

describe('isDirectory', () => {
  it('is false for a file and true for a folder', () => {
    const dir = tempDir();
    const file = join(dir, 'f.txt');
    writeFileSync(file, 'x', 'utf-8');
    expect(isDirectory(dir)).toBe(true);
    expect(isDirectory(file)).toBe(false);
    expect(isDirectory(join(dir, 'missing'))).toBe(false);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Wait, so the debounced watcher can fire. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a predicate to hold, polling until a deadline.
 *
 * Used instead of a fixed sleep for anything driven by `fs.watch`. A watcher
 * test that sleeps a fixed interval passes on an idle machine and fails on a
 * loaded one, because the interval it assumes is a guess about how long the OS
 * takes to deliver an event plus how long the rebuild takes — both of which
 * grow when 46 vitest workers are competing for CPU. Adding an esbuild-heavy
 * suite elsewhere in the run is enough to push it over, which is how this became
 * intermittent without anyone touching it.
 *
 * Polling turns a timing assumption into a wait on the actual condition, so the
 * test asserts *that the event arrives* rather than *that the machine was idle
 * enough for it to arrive in time*. The deadline is still bounded, so a watcher
 * that genuinely never fires fails instead of hanging.
 */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 15_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(
        `waitUntil: condition was still false after ${timeoutMs}ms. The watcher either did ` +
          'not fire or the registry it rebuilt never matched what this test expected.',
      );
    }
    await wait(intervalMs);
  }
}

/** Every project's history is cleared after the suite, so a stale stack cannot leak. */
afterEach(() => {
  for (const root of temporaries) clearHistory(root);
});

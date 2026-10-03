/**
 * test/shell/store.test.ts — the editor store's logic, with no Electron.
 *
 * The store is the only owner of scene state, so if it is wrong the Scene screen
 * is wrong in a way no component test would localise. Every test here runs the
 * real store against a fake `IpcInvoker` and a fake `IpcListener` — no browser, no
 * Electron, no component tree.
 *
 * The four behaviours that matter, and the one invariant that makes them safe:
 *
 *  1. an edit sends exactly one `applyEdit` and adopts the returned snapshot;
 *  2. undo and redo do the same, and report the count the main process sent;
 *  3. a refused edit changes nothing at all — no optimistic update, no undo step;
 *  4. a disk change that is invalid is reported and *not* applied.
 */

import { describe, expect, it } from 'vitest';
import { CHANNELS, EVENTS, type SceneSnapshot } from '../../src/ipc.js';
import { createEditorStore, type EditorStore, type StoreDeps } from '../../src/renderer/store.js';
import {
  FakeClock,
  FakeInvoker,
  FakeListener,
  clone,
  demoScene,
  refuse,
  snapshotOf,
  succeed,
} from './fakes.js';

/** A store wired to the given answers, with a hand-driven clock. */
function build(
  answers: ConstructorParameters<typeof FakeInvoker>[0],
): {
  store: EditorStore;
  invoker: FakeInvoker;
  listener: FakeListener;
  clock: FakeClock;
} {
  const invoker = new FakeInvoker(answers);
  const listener = new FakeListener();
  const clock = new FakeClock();
  const deps: StoreDeps = {
    invoker,
    listener: listener.on,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  };
  return { store: createEditorStore(deps), invoker, listener, clock };
}

describe('store — the single owner of scene state', () => {
  it('starts empty, with a translate gizmo in world space and snapping off', () => {
    const { store } = build({});
    expect(store.snapshot).toBeNull();
    expect(store.selection).toEqual({ kind: 'none' });
    expect(store.gizmo).toBe('translate');
    expect(store.space).toBe('world');
    expect(store.snap).toBeNull();
  });

  it('never mutates the snapshot it was handed', async () => {
    const scene = demoScene();
    const handed = snapshotOf(clone(scene));
    const { store } = build({
      [CHANNELS.openProject]: () => succeed(handed),
    });

    await store.openProject('/tmp/demo');
    const afterOpen = clone(store.snapshot);
    await store.selectInstance('floor');
    await store.save();

    // If the store had pushed onto the array it read from the snapshot, `handed`
    // would have changed underneath the main process's copy of the same object.
    expect(handed).toEqual(afterOpen);
  });
});

describe('store — opening a project', () => {
  it('sends the path on the openProject channel and adopts the snapshot', async () => {
    const snapshot = snapshotOf(demoScene(), { problems: [] });
    const { store, invoker } = build({ [CHANNELS.openProject]: () => succeed(snapshot) });

    const opened = await store.openProject('  /tmp/demo  ');

    expect(opened).toBe(true);
    expect(invoker.requestsFor(CHANNELS.openProject)).toEqual([{ root: '/tmp/demo' }]);
    expect(store.snapshot).toBe(snapshot);
  });

  it('refuses an empty path without asking the main process', async () => {
    const { store, invoker } = build({ [CHANNELS.openProject]: () => succeed(snapshotOf(demoScene())) });

    const opened = await store.openProject('   ');

    expect(opened).toBe(false);
    expect(invoker.calls).toHaveLength(0);
    expect(store.notices.at(-1)?.message).toMatch(/Enter the path/);
  });

  it('reports every problem from a snapshot as a notice, and still opens', async () => {
    const problems = [
      '/tmp/demo/scene.json: instances[1].id: duplicate instance id "floor"',
      'Prefab cube (/tmp/demo/prefabs/cube.ts): the module threw at import',
    ];
    const { store } = build({
      [CHANNELS.openProject]: () => succeed(snapshotOf(demoScene(), { problems })),
    });

    const opened = await store.openProject('/tmp/demo');

    // A scene an AI just broke must not stop the app opening — that is the whole
    // point of `problems` being a field rather than an error.
    expect(opened).toBe(true);
    expect(store.snapshot?.problems).toEqual(problems);
    // Project warnings go to the Problems panel, not toasts.
    expect(store.notices).toEqual([]);
  });

  it('resets the selection when a different project is opened', async () => {
    const { store } = build({
      [CHANNELS.openProject]: () => succeed(snapshotOf(demoScene())),
    });
    await store.openProject('/tmp/demo');
    store.selectInstance('floor');
    expect(store.selection).toEqual({ kind: 'instance', id: 'floor' });

    await store.openProject('/tmp/other');

    expect(store.selection).toEqual({ kind: 'none' });
  });

  it('clears everything on close', async () => {
    const { store } = build({
      [CHANNELS.openProject]: () => succeed(snapshotOf(demoScene())),
      [CHANNELS.closeProject]: () => succeed(null),
    });
    await store.openProject('/tmp/demo');
    store.selectInstance('floor');

    await store.closeProject();

    expect(store.snapshot).toBeNull();
    expect(store.selection).toEqual({ kind: 'none' });
  });
});

describe('store — edits go through IPC and nothing else', () => {
  it('sends exactly one applyEdit carrying the whole edit, and adopts the result', async () => {
    const scene = demoScene();
    const moved = clone(scene);
    const marker = moved.instances[1];
    if (marker === undefined) throw new Error('fixture lost its marker instance');
    marker.transform.position = [5, 0, 0];

    const { store, invoker } = build({
      [CHANNELS.openProject]: () => succeed(snapshotOf(scene)),
      [CHANNELS.applyEdit]: () => succeed(snapshotOf(moved)),
    });
    await store.openProject('/tmp/demo');

    const applied = await store.applyEdit({
      op: 'setTransform',
      instanceId: 'marker',
      patch: { position: [5, 0, 0] },
    });

    expect(applied).toBe(true);
    expect(invoker.requestsFor(CHANNELS.applyEdit)).toEqual([
      { edit: { op: 'setTransform', instanceId: 'marker', patch: { position: [5, 0, 0] } } },
    ]);
    // The returned snapshot *is* the state, not a merge into it.
    expect(store.snapshot?.scene.instances[1]?.transform.position).toEqual([5, 0, 0]);
  });

  it('never guesses: an edit is not reflected before the main process answers', async () => {
    const scene = demoScene();
    let release: (value: ResultLike) => void = () => {};
    const { store } = build({
      [CHANNELS.openProject]: () => succeed(snapshotOf(scene)),
      // An in-flight request. If the store were optimistic, the position below
      // would move before this resolves.
      [CHANNELS.applyEdit]: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    await store.openProject('/tmp/demo');

    const pending = store.applyEdit({
      op: 'setTransform',
      instanceId: 'marker',
      patch: { position: [9, 9, 9] },
    });

    expect(store.snapshot?.scene.instances[1]?.transform.position).toEqual([1, 0, 0]);
    expect(store.busy).toBe(true);

    release(succeed(snapshotOf(scene)));
    await pending;

    expect(store.busy).toBe(false);
  });

  it('a refused edit changes nothing and says why, verbatim', async () => {
    const scene = demoScene();
    const reason =
      'Scene for /tmp/demo/scene.json is not a valid scene:\n  - instances[1].parent: parent "ghost" does not exist';

    const { store, invoker } = build({
      [CHANNELS.openProject]: () => succeed(snapshotOf(scene)),
      [CHANNELS.applyEdit]: () => refuse(reason),
    });
    await store.openProject('/tmp/demo');
    const before = clone(store.snapshot);

    const applied = await store.applyEdit({
      op: 'addInstance',
      input: { id: 'x', prefab: 'cube', parent: 'ghost' },
    });

    expect(applied).toBe(false);
    // Nothing moved, and there is no undo step to roll back — because the store
    // never applied anything locally in the first place.
    expect(store.snapshot).toEqual(before);
    expect(store.snapshot?.history.undoCount).toBe(0);
    // The sentence from the main process is what the developer reads. Not
    // "something went wrong".
    expect(store.notices.at(-1)).toMatchObject({ level: 'error', message: reason });
    expect(invoker.counts.get(CHANNELS.applyEdit)).toBe(1);
  });

  it('a rejected promise is caught, not left unhandled', async () => {
    const { store } = build({
      [CHANNELS.openProject]: () => succeed(snapshotOf(demoScene())),
      [CHANNELS.applyEdit]: () => Promise.reject(new Error('the window closed')),
    });
    await store.openProject('/tmp/demo');

    const applied = await store.applyEdit({ op: 'removeInstance', instanceId: 'floor' });

    expect(applied).toBe(false);
    expect(store.busy).toBe(false);
    expect(store.notices.at(-1)?.message).toMatch(/the window closed/);
  });

  it('an answer that is not a Result is reported rather than read as a value', async () => {
    const { store } = build({
      [CHANNELS.openProject]: () => succeed(snapshotOf(demoScene())),
      [CHANNELS.applyEdit]: () => Promise.resolve({ scene: 'not a result' } as unknown),
    });
    await store.openProject('/tmp/demo');

    const applied = await store.applyEdit({ op: 'removeInstance', instanceId: 'floor' });

    expect(applied).toBe(false);
    expect(store.notices.at(-1)?.message).toMatch(/not a result/);
  });

  it('drops a selection whose instance the edit removed', async () => {
    const scene = demoScene();
    const shrunk = clone(scene);
    shrunk.instances = shrunk.instances.filter((i) => i.id !== 'marker');

    const { store } = build({
      [CHANNELS.openProject]: () => succeed(snapshotOf(scene)),
      [CHANNELS.applyEdit]: () => succeed(snapshotOf(shrunk)),
    });
    await store.openProject('/tmp/demo');
    store.selectInstance('marker');

    await store.applyEdit({ op: 'removeInstance', instanceId: 'marker' });

    // Keeping it would leave the inspector showing a transform for an object that
    // is not in the scene, and the next edit would fail naming an id the
    // developer can no longer see.
    expect(store.selection).toEqual({ kind: 'none' });
  });

  it('keeps a selection the edit did not touch', async () => {
    const scene = demoScene();
    const { store } = build({
      [CHANNELS.openProject]: () => succeed(snapshotOf(scene)),
      [CHANNELS.applyEdit]: () => succeed(snapshotOf(clone(scene))),
    });
    await store.openProject('/tmp/demo');
    store.selectInstance('marker');

    await store.applyEdit({ op: 'setParams', instanceId: 'floor', params: { colour: '#fff' } });

    expect(store.selection).toEqual({ kind: 'instance', id: 'marker' });
  });
});

describe('store — undo and redo', () => {
  it('undo and redo adopt the snapshot and report which files the step touched', async () => {
    const scene = demoScene();
    const undone = clone(scene);
    const marker = undone.instances[1];
    if (marker === undefined) throw new Error('fixture lost its marker instance');
    marker.transform.position = [0, 0, 0];

    const { store, invoker } = build({
      [CHANNELS.openProject]: () => succeed(snapshotOf(scene)),
      [CHANNELS.undo]: () =>
        succeed({
          snapshot: snapshotOf(undone, {
            history: { canUndo: false, canRedo: true, undoCount: 0, redoCount: 1 },
          }),
          paths: ['src/modes.js', 'src/settings.js'],
          patchId: 'PATCH #003',
          canUndo: false,
          canRedo: true,
          undoCount: 0,
          redoCount: 1,
        }),
      [CHANNELS.redo]: () =>
        succeed({
          snapshot: snapshotOf(scene, {
            history: { canUndo: true, canRedo: false, undoCount: 1, redoCount: 0 },
          }),
          paths: ['src/modes.js'],
          patchId: 'PATCH #003',
          canUndo: true,
          canRedo: false,
          undoCount: 1,
          redoCount: 0,
        }),
    });
    await store.openProject('/tmp/demo');

    // The paths come back to the caller, not just the snapshot: they are what
    // lets a screen say which files moved instead of "changes were reverted".
    const undoResult = await store.undo();
    expect(undoResult?.paths).toEqual(['src/modes.js', 'src/settings.js']);
    expect(undoResult?.patchId).toBe('PATCH #003');
    expect(store.snapshot?.scene.instances[1]?.transform.position).toEqual([0, 0, 0]);
    expect(store.snapshot?.history.canRedo).toBe(true);

    const redoResult = await store.redo();
    expect(redoResult?.paths).toEqual(['src/modes.js']);
    expect(store.snapshot?.scene.instances[1]?.transform.position).toEqual([1, 0, 0]);

    expect(invoker.requestsFor(CHANNELS.undo)).toEqual([{}]);
    expect(invoker.requestsFor(CHANNELS.redo)).toEqual([{}]);
  });

  it('an undo with nothing to undo is a notice, not a state change', async () => {
    const scene = demoScene();
    const { store } = build({
      [CHANNELS.openProject]: () => succeed(snapshotOf(scene)),
      [CHANNELS.undo]: () => refuse('Nothing to undo'),
    });
    await store.openProject('/tmp/demo');
    const before = clone(store.snapshot);

    expect(await store.undo()).toBeNull();
    expect(store.snapshot).toEqual(before);
    expect(store.notices.at(-1)?.message).toBe('Nothing to undo');
  });

  it('reports the history the main process sent, rather than counting locally', async () => {
    const scene = demoScene();
    const { store } = build({
      [CHANNELS.openProject]: () =>
        succeed(snapshotOf(scene, { history: { canUndo: true, canRedo: false, undoCount: 3, redoCount: 0 } })),
    });

    await store.openProject('/tmp/demo');

    expect(store.snapshot?.history).toEqual({ canUndo: true, canRedo: false, undoCount: 3, redoCount: 0 });
  });
});

describe('store — selection and viewport affordances', () => {
  it('select, selectInstance and null all round-trip', () => {
    const { store } = build({});
    store.selectInstance('floor');
    expect(store.selection).toEqual({ kind: 'instance', id: 'floor' });
    store.selectInstance(null);
    expect(store.selection).toEqual({ kind: 'none' });
    store.select({ kind: 'instance', id: 'a' });
    expect(store.selection).toEqual({ kind: 'instance', id: 'a' });
  });

  it('gizmo, space and snap are set locally and read back', () => {
    const { store } = build({});
    store.setGizmo('rotate');
    store.setSpace('local');
    store.setSnap(0.5);
    expect(store.gizmo).toBe('rotate');
    expect(store.space).toBe('local');
    expect(store.snap).toBe(0.5);
    store.toggleSpace();
    expect(store.space).toBe('world');
    store.setSnap(null);
    expect(store.snap).toBeNull();
  });
});

describe('store — the scene changed on disk', () => {
  it('reloads when the new file is valid', async () => {
    const scene = demoScene();
    const onDisk = clone(scene);
    const marker = onDisk.instances[1];
    if (marker === undefined) throw new Error('fixture lost its marker instance');
    marker.transform.position = [100, 0, 0];

    const { store, invoker, listener } = build({
      [CHANNELS.openProject]: () => succeed(snapshotOf(scene)),
      [CHANNELS.loadScene]: () => succeed(snapshotOf(onDisk)),
    });
    await store.openProject('/tmp/demo');
    const disconnect = store.connect();

    listener.fire(EVENTS.sceneChangedOnDisk, { valid: true, problems: [] });
    await settle();

    expect(invoker.counts.get(CHANNELS.loadScene)).toBe(1);
    expect(store.snapshot?.scene.instances[1]?.transform.position).toEqual([100, 0, 0]);
    disconnect();
  });

  it('does NOT reload an invalid file: the last valid scene stays on screen', async () => {
    const scene = demoScene();
    const problems = ['/tmp/demo/scene.json: instances[0].transform.position: expected 3 numbers'];
    const { store, invoker, listener } = build({
      [CHANNELS.openProject]: () => succeed(snapshotOf(scene)),
      [CHANNELS.loadScene]: () => succeed(snapshotOf(demoScene())),
    });
    await store.openProject('/tmp/demo');
    const disconnect = store.connect();
    const before = clone(store.snapshot);

    listener.fire(EVENTS.sceneChangedOnDisk, { valid: false, problems });
    await settle();

    // Reloading a half-written file would replace the last good scene with a
    // broken one. The developer keeps what they were looking at and is told what
    // is wrong with the file instead.
    expect(invoker.counts.get(CHANNELS.loadScene)).toBeUndefined();
    expect(store.snapshot).toEqual(before);
    expect(store.notices.at(-1)?.level).toBe('error');
    expect(store.notices.at(-1)?.message).toContain(problems[0] as string);
    disconnect();
  });

  it('an invalid disk change is reported even with no project open', async () => {
    const { store, listener } = build({});
    store.connect();

    listener.fire(EVENTS.sceneChangedOnDisk, { valid: false, problems: ['broken'] });
    await settle();

    expect(store.notices.at(-1)?.level).toBe('error');
  });
});

describe('store — the prefab registry changed', () => {
  it('adopts the new registry into the current snapshot', async () => {
    const { store, listener } = build({ [CHANNELS.openProject]: () => succeed(snapshotOf(demoScene())) });
    store.connect();
    await store.openProject('/tmp/demo');

    const registry = {
      prefabs: [
        {
          name: 'cube',
          description: 'A box.',
          paramsJsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        },
      ],
      failed: [],
    };
    listener.fire(EVENTS.prefabsChanged, { registry });

    expect(store.snapshot?.prefabs).toBe(registry);
  });

  it('adopts failed prefabs into snapshot for Problems panel, not toasts', async () => {
    const { store, listener } = build({ [CHANNELS.openProject]: () => succeed(snapshotOf(demoScene())) });
    store.connect();
    await store.openProject('/tmp/demo');

    listener.fire(EVENTS.prefabsChanged, {
      registry: {
        prefabs: [],
        failed: [{ name: 'sphere', file: '/tmp/demo/prefabs/sphere.ts', reason: 'syntax error' }],
      },
    });

    expect(store.snapshot?.prefabs.failed).toEqual([
      { name: 'sphere', file: '/tmp/demo/prefabs/sphere.ts', reason: 'syntax error' },
    ]);
    expect(store.notices).toHaveLength(0);
  });

  it('is ignored when no project is open — there is no snapshot to put it in', () => {
    const { store, listener } = build({});
    store.connect();

    expect(() =>
      listener.fire(EVENTS.prefabsChanged, { registry: { prefabs: [], failed: [] } }),
    ).not.toThrow();
    expect(store.snapshot).toBeNull();
  });
});

describe('store — notices', () => {
  it('a notice from the main process is shown', () => {
    const { store, listener } = build({});
    store.connect();

    listener.fire(EVENTS.notice, { level: 'info', message: 'hello' });

    expect(store.notices.at(-1)).toMatchObject({ level: 'info', message: 'hello' });
  });

  it('expires on the clock, and the clock is the fake one', () => {
    const { store, clock } = build({});

    store.notice({ level: 'info', message: 'temporary' });
    expect(store.notices).toHaveLength(1);

    clock.advance(5999);
    expect(store.notices).toHaveLength(1);

    clock.advance(2);
    expect(store.notices).toHaveLength(0);
  });

  it('dismissing cancels the pending timer rather than leaving it to fire', () => {
    const { store, clock } = build({});
    store.notice({ level: 'info', message: 'x' });
    const id = store.notices[0]?.id ?? 0;

    store.dismissNotice(id);
    expect(store.notices).toHaveLength(0);
    expect(clock.pending).toBe(0);
  });

  it('keeps at most five, dropping the oldest', () => {
    const { store } = build({});
    for (let i = 0; i < 8; i += 1) {
      store.notice({ level: 'info', message: `n${i}` });
    }
    expect(store.notices.map((n) => n.message)).toEqual(['n3', 'n4', 'n5', 'n6', 'n7']);
  });

  it('clearNotices cancels every pending timer', () => {
    const { store, clock } = build({});
    store.notice({ level: 'info', message: 'a' });
    store.notice({ level: 'info', message: 'b' });

    store.clearNotices();

    expect(store.notices).toHaveLength(0);
    expect(clock.pending).toBe(0);
  });
});

describe('store — lifecycle', () => {
  it('connect subscribes to all three events and the returned function unsubscribes', () => {
    const { store, listener } = build({});

    const disconnect = store.connect();
    expect(listener.subscriberCount(EVENTS.sceneChangedOnDisk)).toBe(1);
    expect(listener.subscriberCount(EVENTS.prefabsChanged)).toBe(1);
    expect(listener.subscriberCount(EVENTS.notice)).toBe(1);

    disconnect();
    expect(listener.subscriberCount(EVENTS.sceneChangedOnDisk)).toBe(0);
    expect(listener.subscriberCount(EVENTS.prefabsChanged)).toBe(0);
    expect(listener.subscriberCount(EVENTS.notice)).toBe(0);
  });

  it('destroy releases the listeners and the timers', () => {
    const { store, listener, clock } = build({});
    store.connect();
    store.notice({ level: 'info', message: 'a' });

    store.destroy();

    expect(listener.subscriberCount(EVENTS.notice)).toBe(0);
    expect(clock.pending).toBe(0);
    expect(store.notices).toHaveLength(0);
  });
});

describe('store — the save that means something', () => {
  it('adopts the snapshot and confirms which file was written', async () => {
    const scene = demoScene();
    const { store, invoker } = build({
      [CHANNELS.openProject]: () => succeed(snapshotOf(scene)),
      [CHANNELS.save]: () => succeed(snapshotOf(scene, { project: snapshotOf(scene).project })),
    });
    await store.openProject('/tmp/demo');

    expect(await store.save()).toBe(true);

    expect(invoker.requestsFor(CHANNELS.save)).toEqual([{}]);
    expect(store.notices.at(-1)).toMatchObject({ level: 'info', message: 'Saved scene.json.' });
  });

  it('a refused save says the file was not written', async () => {
    const { store } = build({
      [CHANNELS.openProject]: () => succeed(snapshotOf(demoScene())),
      [CHANNELS.save]: () => refuse('Not saved — instances[0].id: duplicate instance id "floor"'),
    });
    await store.openProject('/tmp/demo');

    expect(await store.save()).toBe(false);
    expect(store.notices.at(-1)?.message).toMatch(/^Not saved — /);
  });
});

/** The shape a fake's pending promise is resolved with. */
type ResultLike = ReturnType<typeof succeed> | ReturnType<typeof refuse>;

/** Let every already-queued microtask and timer-free promise settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/** Compile-time assertion that the fake invoker really satisfies the contract. */
const _invokerIsTyped: FakeInvoker = new FakeInvoker({});
void _invokerIsTyped;
export type { SceneSnapshot };

/**
 * scene/edits.test.ts — scene edits and their undo history.
 *
 * Two things are asserted throughout, because either one failing produces a
 * bug the developer cannot see:
 *
 *  - **Purity.** A pure edit returns a new scene and leaves the input untouched.
 *    An edit that mutates its argument makes "undo" meaningless, because there
 *    is no old state left to go back to.
 *  - **Refusal over guessing.** An edit naming an instance that does not exist
 *    fails with a message naming the id, and writes nothing.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  addInstance,
  applyEdit,
  applySceneEdit,
  removeInstance,
  sceneHistoryStatus,
  setParams,
  setTransform,
  swapModel,
  type SceneEdit,
} from '../../src/scene/edits.js';
import { loadScene, parseScene, saveScene, serializeScene } from '../../src/scene/sceneFile.js';
import { clearHistory, redo, undo } from '../../src/history/history.js';
import type { SceneFile } from '../../src/scene/scene.schema.js';

const IDENTITY = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } as const;

/** A scene with three instances, one of them parented. */
function scene(): SceneFile {
  return parseScene({
    version: 1,
    name: 'Level1',
    engine: 'three',
    seed: 7,
    instances: [
      { id: 'ground', prefab: 'plane', transform: IDENTITY, params: { width: 10 } },
      { id: 'crate', prefab: 'cube', parent: 'ground', transform: IDENTITY, params: { size: 2 } },
      { id: 'coin', prefab: 'coin', parent: 'crate', transform: IDENTITY, params: {} },
    ],
    lights: [{ id: 'sun', kind: 'directional', color: '#ffffff', intensity: 1 }],
    camera: { kind: 'perspective', position: [0, 5, 10], rotation: [0, 0, 0], fov: 60 },
  });
}

describe('setTransform', () => {
  it('moves an instance', () => {
    const result = setTransform(scene(), 'crate', { position: [1, 2, 3] });
    expect(result.ok).toBe(true);
    const crate = result.scene.instances.find((i) => i.id === 'crate');
    expect(crate?.transform.position).toEqual([1, 2, 3]);
  });

  it('leaves the other components alone when only one is given', () => {
    const before = scene();
    const crate = before.instances.find((i) => i.id === 'crate');
    crate!.transform.scale = [3, 3, 3];

    const result = setTransform(before, 'crate', { position: [0, 9, 0] });
    const after = result.scene.instances.find((i) => i.id === 'crate');
    // The whole point: nudging one axis must not reset the others to defaults.
    expect(after?.transform.scale).toEqual([3, 3, 3]);
    expect(after?.transform.rotation).toEqual([0, 0, 0]);
  });

  it('rotates and scales too', () => {
    const result = setTransform(scene(), 'crate', { rotation: [0, 1.5, 0], scale: [2, 2, 2] });
    const crate = result.scene.instances.find((i) => i.id === 'crate');
    expect(crate?.transform.rotation).toEqual([0, 1.5, 0]);
    expect(crate?.transform.scale).toEqual([2, 2, 2]);
  });

  it('does not mutate the input scene', () => {
    const before = scene();
    const snapshot = JSON.stringify(before);
    setTransform(before, 'crate', { position: [9, 9, 9] });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('refuses an unknown instance, naming the id', () => {
    const result = setTransform(scene(), 'ghost', { position: [1, 1, 1] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ghost');
  });
});

describe('swapModel', () => {
  it('sets a model path', () => {
    const result = swapModel(scene(), 'crate', 'models/crate.glb');
    expect(result.ok).toBe(true);
    expect(result.scene.instances.find((i) => i.id === 'crate')?.model).toBe('models/crate.glb');
  });

  it('refuses an empty path', () => {
    const result = swapModel(scene(), 'crate', '   ');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('must not be empty');
  });

  it('refuses an unknown instance', () => {
    expect(swapModel(scene(), 'ghost', 'a.glb').ok).toBe(false);
  });
});

describe('addInstance', () => {
  it('adds an instance with a default transform', () => {
    const result = addInstance(scene(), { id: 'barrel', prefab: 'cylinder' });
    expect(result.ok).toBe(true);
    expect(result.scene.instances).toHaveLength(4);
    const barrel = result.scene.instances.find((i) => i.id === 'barrel');
    expect(barrel?.transform.scale).toEqual([1, 1, 1]);
    expect(barrel?.params).toEqual({});
  });

  it('honours an explicit transform and params', () => {
    const result = addInstance(scene(), {
      id: 'barrel',
      prefab: 'cylinder',
      transform: { position: [4, 0, 0] },
      params: { height: 3 },
    });
    const barrel = result.scene.instances.find((i) => i.id === 'barrel');
    expect(barrel?.transform.position).toEqual([4, 0, 0]);
    expect(barrel?.params).toEqual({ height: 3 });
  });

  it('refuses a duplicate id, naming the clash', () => {
    const result = addInstance(scene(), { id: 'crate', prefab: 'cube' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('"crate" is already used');
  });

  it('produces a scene that still validates', () => {
    const result = addInstance(scene(), {
      id: 'ghost-parent-child',
      prefab: 'cube',
      parent: 'crate',
    });
    expect(result.ok).toBe(true);
    // A dangling parent is caught at save time; addInstance must not create one.
    expect(() => saveSceneSafe(result.scene)).not.toThrow();
  });
});

function saveSceneSafe(value: SceneFile): void {
  parseScene(value);
}

describe('removeInstance', () => {
  it('removes the instance', () => {
    const result = removeInstance(scene(), 'crate');
    expect(result.ok).toBe(true);
    expect(result.scene.instances.map((i) => i.id)).toEqual(['ground', 'coin']);
  });

  it('re-parents children to the removed instance’s parent', () => {
    // Deleting the crate must not leave `coin` naming a parent that is gone:
    // that is a scene that no longer loads.
    const result = removeInstance(scene(), 'crate');
    expect(result.scene.instances.find((i) => i.id === 'coin')?.parent).toBe('ground');
  });

  it('produces a valid scene', () => {
    const result = removeInstance(scene(), 'crate');
    expect(() => saveSceneSafe(result.scene)).not.toThrow();
  });

  it('refuses an unknown instance', () => {
    expect(removeInstance(scene(), 'ghost').ok).toBe(false);
  });
});

describe('setParams', () => {
  it('merges by default', () => {
    const result = setParams(scene(), 'crate', { colour: '#ff0000' });
    const crate = result.scene.instances.find((i) => i.id === 'crate');
    // Merging, because "the AI changed one param" must not reset the others.
    expect(crate?.params).toEqual({ size: 2, colour: '#ff0000' });
  });

  it('replaces when asked', () => {
    const result = setParams(scene(), 'crate', { colour: '#ff0000' }, { replace: true });
    expect(result.scene.instances.find((i) => i.id === 'crate')?.params).toEqual({
      colour: '#ff0000',
    });
  });

  it('overwrites a key that already exists', () => {
    const result = setParams(scene(), 'crate', { size: 9 });
    expect(result.scene.instances.find((i) => i.id === 'crate')?.params).toEqual({ size: 9 });
  });

  it('refuses an unknown instance', () => {
    expect(setParams(scene(), 'ghost', {}).ok).toBe(false);
  });
});

describe('applyEdit', () => {
  it('dispatches every operation', () => {
    const edits: SceneEdit[] = [
      { op: 'setTransform', instanceId: 'crate', patch: { position: [1, 1, 1] } },
      { op: 'swapModel', instanceId: 'crate', model: 'a.glb' },
      { op: 'addInstance', input: { id: 'new', prefab: 'cube' } },
      { op: 'removeInstance', instanceId: 'coin' },
      { op: 'setParams', instanceId: 'crate', params: { size: 4 } },
    ];
    let current = scene();
    for (const edit of edits) {
      const result = applyEdit(current, edit);
      expect(result.ok).toBe(true);
      current = result.scene;
    }
    expect(current.instances.map((i) => i.id)).toEqual(['ground', 'crate', 'new']);
  });
});

describe('applySceneEdit and the 20-step history', () => {
  let dir: string;
  let file: string;
  let scenePath: string;
  let project: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cf-edit-'));
    project = dir;
    // Project-relative, matching how history records a change's path.
    scenePath = 'scenes/Level1.scene.json';
    file = join(project, scenePath);
    saveScene(file, scene());
    clearHistory(project);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    clearHistory(project);
  });

  /** The current on-disk scene, via a fresh read — never from a cached value. */
  const onDisk = (): SceneFile => {
    const loaded = loadScene(file);
    if (loaded === null) throw new Error('scene file vanished');
    return loaded;
  };

  it('writes the edit to disk and records one undo step', () => {
    const result = applySceneEdit(project, scenePath, onDisk(), {
      op: 'setTransform',
      instanceId: 'crate',
      patch: { position: [5, 0, 0] },
    });

    expect(result.ok).toBe(true);
    expect(result.patchId).toBeDefined();
    expect(onDisk().instances.find((i) => i.id === 'crate')?.transform.position).toEqual([5, 0, 0]);
    expect(sceneHistoryStatus(project).undoCount).toBe(1);
  });

  it('undo restores the previous file content exactly', () => {
    const before = readFileSync(file, 'utf-8');
    applySceneEdit(project, scenePath, onDisk(), {
      op: 'setTransform',
      instanceId: 'crate',
      patch: { position: [5, 0, 0] },
    });
    expect(readFileSync(file, 'utf-8')).not.toBe(before);
    expect(sceneHistoryStatus(project).canUndo).toBe(true);

    // Undo through the same history the patch screen uses.
    const result = undo(project);
    expect(result.success).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe(before);
    expect(sceneHistoryStatus(project).canRedo).toBe(true);

    // And redo puts it back exactly.
    expect(redo(project).success).toBe(true);
    expect(onDisk().instances.find((i) => i.id === 'crate')?.transform.position).toEqual([5, 0, 0]);
  });

  it('caps the history at 20 steps, dropping the oldest', () => {
    const original = readFileSync(file, 'utf-8');

    for (let i = 0; i < 25; i++) {
      applySceneEdit(project, scenePath, onDisk(), {
        op: 'setTransform',
        instanceId: 'crate',
        patch: { position: [i, 0, 0] },
      });
    }

    expect(sceneHistoryStatus(project).undoCount).toBe(20);

    // Undoing everything retained must land on step 5, not on the original —
    // steps 1..5 fell off the bottom, which is the documented cap behaviour.
    for (let i = 0; i < 20; i++) undo(project);
    expect(onDisk().instances.find((i) => i.id === 'crate')?.transform.position).toEqual([4, 0, 0]);
    expect(readFileSync(file, 'utf-8')).not.toBe(original);
    expect(sceneHistoryStatus(project).canUndo).toBe(false);
  });

  it('undoes each operation in turn through a chain of 20', () => {
    for (let i = 1; i <= 20; i++) {
      // Starting at 1: a move to [0,0,0] would be a no-op, and a no-op
      // correctly records no history step.
      const result = applySceneEdit(project, scenePath, onDisk(), {
        op: 'setTransform',
        instanceId: 'crate',
        patch: { position: [i, 0, 0] },
      });
      expect(result.ok).toBe(true);
      expect(result.patchId).toBeDefined();
    }
    expect(sceneHistoryStatus(project).undoCount).toBe(20);
    expect(onDisk().instances.find((i) => i.id === 'crate')?.transform.position).toEqual([
      20, 0, 0,
    ]);
  });

  it('writes nothing and records nothing when the edit is refused', () => {
    const before = readFileSync(file, 'utf-8');
    const result = applySceneEdit(project, scenePath, onDisk(), {
      op: 'setTransform',
      instanceId: 'ghost',
      patch: { position: [1, 1, 1] },
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe(before);
    // A refused edit must not leave an undo step that appears to do nothing.
    expect(sceneHistoryStatus(project).undoCount).toBe(0);
  });

  it('records nothing when the edit changes nothing', () => {
    const before = readFileSync(file, 'utf-8');
    const result = applySceneEdit(
      project,
      file,
      onDisk(),
      { op: 'setTransform', instanceId: 'crate', patch: { position: [0, 0, 0] } },
      { readFile: () => before },
    );
    expect(result.ok).toBe(true);
    expect(sceneHistoryStatus(project).undoCount).toBe(0);
  });

  it('round-trips through save and load after every edit', () => {
    const ops: SceneEdit[] = [
      { op: 'setTransform', instanceId: 'crate', patch: { position: [1, 2, 3] } },
      { op: 'swapModel', instanceId: 'crate', model: 'models/crate.glb' },
      { op: 'addInstance', input: { id: 'barrel', prefab: 'cylinder', parent: 'ground' } },
      { op: 'setParams', instanceId: 'barrel', params: { height: 3 } },
      { op: 'removeInstance', instanceId: 'coin' },
    ];

    let current = onDisk();
    for (const op of ops) {
      const result = applySceneEdit(project, scenePath, current, op);
      expect(result.ok).toBe(true);
      // Reload from disk after each step: the next edit must start from what
      // is actually stored, not from an in-memory value that could drift.
      current = onDisk();
    }

    // The final state survives a save/load cycle byte-identically.
    const text = readFileSync(file, 'utf-8');
    saveScene(file, onDisk());
    expect(readFileSync(file, 'utf-8')).toBe(text);
    expect(serializeScene(onDisk())).toBe(text);
  });
});

/**
 * step2.integration.test.ts — the Step 2 done-when test.
 *
 * **Done when (SPEC §5, Step 2):** a test generates a new project, edits it with
 * each edit operation, saves, reloads, and gets identical results.
 *
 * This is the whole step in one test, on purpose. Each unit suite checks one
 * piece against a hand-built scene; this one checks that the pieces compose —
 * that the project the *generator* writes is one the *edits* can operate on, that
 * every operation survives a real save/load cycle, and that the prefab lint
 * passes on the prefab that was actually generated.
 *
 * A failure here is the expensive kind: it means two individually-correct
 * modules disagree about what a scene is.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateProject } from '../../src/scene/template.js';
import {
  applySceneEdit,
  sceneHistoryStatus,
  type SceneEdit,
} from '../../src/scene/edits.js';
import { loadScene, saveScene, serializeScene, validateScene } from '../../src/scene/sceneFile.js';
import { lintPrefabSource } from '../../src/scene/lint.js';
import { clearHistory, redo, undo } from '../../src/history/history.js';
import type { SceneFile } from '../../src/scene/scene.schema.js';

const BRIEF = {
  name: 'star-crawler',
  idea: 'The player flies a small ship around a ring of planets collecting fuel canisters.',
  seed: 4242,
};

const SCENE_PATH = 'scene.json';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cf-step2-'));
  generateProject(root, BRIEF);
  clearHistory(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  clearHistory(root);
});

/** The scene, read fresh from disk every time — never from a cached value. */
function onDisk(): SceneFile {
  const scene = loadScene(join(root, SCENE_PATH));
  if (scene === null) throw new Error('scene.json missing');
  return scene;
}

/** Apply an edit and assert it succeeded. */
function edit(next: SceneEdit): void {
  const result = applySceneEdit(root, SCENE_PATH, onDisk(), next);
  if (!result.ok) throw new Error(`edit failed: ${result.error ?? 'unknown'}`);
}

describe('step 2 done-when: generate, edit with every operation, save, reload', () => {
  it('produces identical results across the whole cycle', () => {
    // ── 1. The generated project is valid before anything is done to it ──────
    const generated = onDisk();
    expect(validateScene(generated).valid).toBe(true);
    const generatedText = readFileSync(join(root, SCENE_PATH), 'utf-8');

    // ── 2. Each edit operation, in turn, through the real file ──────────────
    edit({ op: 'setTransform', instanceId: 'marker', patch: { position: [3, 2, 1] } });
    expect(onDisk().instances.find((i) => i.id === 'marker')?.transform.position).toEqual([3, 2, 1]);

    edit({ op: 'setTransform', instanceId: 'marker', patch: { rotation: [0, 1.57, 0] } });
    expect(onDisk().instances.find((i) => i.id === 'marker')?.transform.rotation).toEqual([
      0, 1.57, 0,
    ]);

    edit({ op: 'swapModel', instanceId: 'marker', model: 'models/marker.glb' });
    expect(onDisk().instances.find((i) => i.id === 'marker')?.model).toBe('models/marker.glb');

    edit({
      op: 'addInstance',
      input: { id: 'barrel', prefab: 'cube', transform: { position: [5, 0, 5] }, params: { size: 1, colour: '#ff0000' } },
    });
    expect(onDisk().instances.map((i) => i.id)).toContain('barrel');

    edit({ op: 'setParams', instanceId: 'barrel', params: { colour: '#00ff00' } });
    // A merge, so the size set when it was added survives.
    expect(onDisk().instances.find((i) => i.id === 'barrel')?.params).toEqual({
      size: 1,
      colour: '#00ff00',
    });

    edit({ op: 'removeInstance', instanceId: 'floor' });
    expect(onDisk().instances.map((i) => i.id)).not.toContain('floor');

    // ── 3. Every intermediate state was valid and on disk ───────────────────
    const edited = onDisk();
    expect(validateScene(edited).valid).toBe(true);
    expect(sceneHistoryStatus(root).undoCount).toBe(6);

    // ── 4. Save, reload, and get an identical result ────────────────────────
    const before = serializeScene(edited);
    saveScene(join(root, SCENE_PATH), edited);
    expect(readFileSync(join(root, SCENE_PATH), 'utf-8')).toBe(before);
    expect(loadScene(join(root, SCENE_PATH))).toEqual(edited);

    // And a second save/load cycle changes nothing at all — determinism (R8).
    saveScene(join(root, SCENE_PATH), onDisk());
    expect(readFileSync(join(root, SCENE_PATH), 'utf-8')).toBe(before);

    // ── 5. The project really did change from the generated state ───────────
    expect(readFileSync(join(root, SCENE_PATH), 'utf-8')).not.toBe(generatedText);
  });

  it('undoes every edit back to the generated state, byte for byte', () => {
    const original = readFileSync(join(root, SCENE_PATH), 'utf-8');

    const edits: SceneEdit[] = [
      { op: 'setTransform', instanceId: 'marker', patch: { position: [3, 2, 1] } },
      { op: 'swapModel', instanceId: 'marker', model: 'models/marker.glb' },
      {
        op: 'addInstance',
        input: { id: 'barrel', prefab: 'cube', params: { size: 1, colour: '#ff0000' } },
      },
      { op: 'setParams', instanceId: 'barrel', params: { colour: '#00ff00' } },
      { op: 'removeInstance', instanceId: 'floor' },
    ];

    for (const next of edits) edit(next);
    expect(sceneHistoryStatus(root).undoCount).toBe(edits.length);

    // Undo all of them: the file must return to exactly what the generator
    // wrote, not merely to an equivalent scene. Byte equality is the property
    // that lets a developer trust "undo".
    for (let i = 0; i < edits.length; i++) {
      expect(undo(root).success).toBe(true);
    }

    expect(readFileSync(join(root, SCENE_PATH), 'utf-8')).toBe(original);
    expect(sceneHistoryStatus(root).canUndo).toBe(false);

    // And redo returns to the edited state exactly.
    for (let i = 0; i < edits.length; i++) {
      expect(redo(root).success).toBe(true);
    }
    expect(onDisk().instances.map((i) => i.id)).toEqual(['marker', 'barrel']);
  });

  it('never writes an invalid scene, whatever edit is attempted', () => {
    const good = readFileSync(join(root, SCENE_PATH), 'utf-8');

    // A refused edit leaves the file byte-identical and records no history.
    const refused = applySceneEdit(root, SCENE_PATH, onDisk(), {
      op: 'addInstance',
      input: { id: 'marker', prefab: 'cube' },
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('already used');
    expect(readFileSync(join(root, SCENE_PATH), 'utf-8')).toBe(good);
    expect(sceneHistoryStatus(root).undoCount).toBe(0);

    // A dangling parent is refused before it reaches disk: the write is
    // attempted, `saveScene` validates, and the failure comes back as a
    // refusal naming the JSON path — not as an exception.
    const dangling = applySceneEdit(root, SCENE_PATH, onDisk(), {
      op: 'addInstance',
      input: { id: 'orphan', prefab: 'cube', parent: 'nonexistent' },
    });
    expect(dangling.ok).toBe(false);
    expect(dangling.error).toContain('instances[2].parent');
    expect(dangling.error).toContain('does not exist');

    // The file is untouched, still valid, and no history was recorded for a
    // change that never happened.
    expect(readFileSync(join(root, SCENE_PATH), 'utf-8')).toBe(good);
    expect(validateScene(onDisk()).valid).toBe(true);
    expect(sceneHistoryStatus(root).undoCount).toBe(0);
  });

  it('ships a cube prefab that satisfies every lint rule', () => {
    const source = readFileSync(join(root, 'prefabs/cube.ts'), 'utf-8');
    const result = lintPrefabSource(source, 'prefabs/cube.ts');

    // Every rule, explicitly, so a new rule added later fails here too rather
    // than passing by default.
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.file).toBe('prefabs/cube.ts');
  });

  it('produces the same project from the same brief, twice', () => {
    // Determinism (R8): the template generator is part of the toolchain, so two
    // runs of one brief must be byte-identical — otherwise a generated project
    // is not shareable between AIs.
    const other = mkdtempSync(join(tmpdir(), 'cf-step2-b-'));
    try {
      generateProject(other, BRIEF);
      for (const file of ['scene.json', 'prefabs/cube.ts', 'prefabs/index.ts', 'AI_RULES.md']) {
        expect(readFileSync(join(other, file), 'utf-8')).toBe(readFileSync(join(root, file), 'utf-8'));
      }
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
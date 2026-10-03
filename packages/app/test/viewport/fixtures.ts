/**
 * test/viewport/fixtures.ts — shared scene files and prefabs.
 *
 * A `sceneFile()` builder rather than literal JSON so each test can state only
 * the field it is about, and so an unrelated schema addition does not touch
 * eleven test bodies. Everything is run through core's `sceneFileSchema` first,
 * which means these fixtures are also an assertion that the viewport's inputs
 * are the validated shape it claims to accept — a fixture that stops
 * validating fails loudly rather than quietly feeding the builder something
 * impossible.
 *
 * ## Why these are real prefabs and not stubs
 *
 * Every prefab here satisfies the actual `PrefabDefinition` contract: it takes
 * the injected Three module, uses the injected `rng` for its only randomness,
 * and returns `{ object, parts }` without touching a scene (SPEC R7). A stub
 * that ignored the `rng` parameter would let a broken seeding implementation
 * pass, which is exactly the bug this area must not have.
 */

import * as THREE from 'three';
import { sceneFileSchema, type SceneFile, type SceneInstance } from '@contextforge/core';
import type { PrefabDefinition, PrefabParams, ThreeModule } from '@contextforge/core';
import { z } from 'zod';

/** Accept any params; the viewport is not what validates them. */
const anyParams = z.record(z.string(), z.unknown()) as unknown as z.ZodType<PrefabParams>;

/** A prefab built from an arbitrary Three.js factory, for one-off tests. */
export function makePrefab(
  name: string,
  create: PrefabDefinition['create'],
): PrefabDefinition {
  return { name, description: `test prefab ${name}`, paramsSchema: anyParams, create };
}

// ── prefabs ─────────────────────────────────────────────────────────────────

/** A cube at the origin. The simplest thing that can be picked. */
export const boxPrefab: PrefabDefinition = {
  name: 'box',
  description: 'A unit cube.',
  paramsSchema: anyParams,
  create(three) {
    const T = three as unknown as typeof THREE;
    const mesh = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshStandardMaterial());
    mesh.name = 'box';
    return { object: mesh, parts: {} };
  },
};

/** A group with two named children, so part selection has something to select. */
export const twoPartPrefab: PrefabDefinition = {
  name: 'two-part',
  description: 'A parent group with two named children.',
  paramsSchema: anyParams,
  create(three) {
    const T = three as unknown as typeof THREE;
    const group = new T.Group();
    const left = new T.Mesh(new T.SphereGeometry(0.5, 8, 8), new T.MeshStandardMaterial());
    left.name = 'left';
    const right = new T.Mesh(new T.SphereGeometry(0.5, 8, 8), new T.MeshStandardMaterial());
    right.name = 'right';
    right.position.x = 2;
    group.add(left, right);
    return { object: group, parts: { left, right } };
  },
};

/**
 * A prefab that throws.
 *
 * The scenario the viewport must survive: an AI edits a prefab file and the
 * file no longer runs. `ipc.ts` says a failed prefab must produce a placeholder
 * and a row in the outliner, "not a viewer that refuses to open".
 */
export const throwingPrefab: PrefabDefinition = {
  name: 'explodes',
  description: 'Throws on purpose.',
  paramsSchema: anyParams,
  create() {
    throw new Error('prefab is broken: params.legLength is undefined');
  },
};

/** A prefab whose `create` succeeds but returns something unusable. */
export const badReturnPrefab: PrefabDefinition = {
  name: 'bad-return',
  description: 'Returns a plain object instead of an Object3D.',
  paramsSchema: anyParams,
  create() {
    return {
      object: { position: [1, 2, 3] },
      parts: {},
    } as unknown as { object: unknown; parts: Record<string, unknown> };
  },
};

/**
 * A prefab whose randomness is visible, so the seed can be asserted.
 *
 * The offset lands on a **child**, not on the returned root, because the root's
 * transform is the instance's placement and `buildSceneGraph` overwrites it from
 * the scene file. A prefab that tried to place its own root would be fighting
 * the scene data — this is also the reason a prefab's randomness shows up as
 * variation *within* an object rather than as a misplacement.
 */
export const jitterPrefab: PrefabDefinition = {
  name: 'jitter',
  description: 'A group holding one box at a seeded random offset.',
  paramsSchema: anyParams,
  create(three, _params, rng) {
    const T = three as unknown as typeof THREE;
    const group = new T.Group();
    const mesh = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshStandardMaterial());
    mesh.position.set(rng.next(), rng.next(), rng.next());
    mesh.name = 'jitter';
    group.add(mesh);
    return { object: group, parts: { mesh } };
  },
};

/** The random offset a `jitter` instance produced, for the seeding tests. */
export function jitterOf(object: THREE.Object3D): [number, number, number] {
  const child = object.children[0];
  if (child === undefined) {
    throw new Error('jitter prefab produced no child to read an offset from');
  }
  return child.position.toArray();
}

/** The registry the non-failure tests build with. */
export const healthyPrefabs: readonly PrefabDefinition[] = [boxPrefab, twoPartPrefab, jitterPrefab];

/** A registry that includes a prefab which throws. */
export const brokenPrefabs: readonly PrefabDefinition[] = [boxPrefab, throwingPrefab, badReturnPrefab];

/** The Three module as a prefab receives it. */
export function asThreeModule(): ThreeModule {
  return THREE as unknown as ThreeModule;
}

// ── scene builders ──────────────────────────────────────────────────────────

/** The camera every fixture uses unless it says otherwise. */
export const DEFAULT_CAMERA = {
  kind: 'perspective' as const,
  position: [0, 5, 10] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  fov: 60,
};

/** Build a validated `SceneFile` from instance overrides. */
export function sceneFile(overrides: {
  name?: string;
  seed?: number;
  instances?: Array<Partial<SceneInstance> & { id: string; prefab: string }>;
  lights?: SceneFile['lights'];
  camera?: SceneFile['camera'];
}): SceneFile {
  const instances: SceneInstance[] = (overrides.instances ?? []).map((partial) => ({
    id: partial.id,
    prefab: partial.prefab,
    params: partial.params ?? {},
    transform: partial.transform ?? {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    ...(partial.parent !== undefined ? { parent: partial.parent } : {}),
    ...(partial.name !== undefined ? { name: partial.name } : {}),
    ...(partial.model !== undefined ? { model: partial.model } : {}),
    ...(partial.visible !== undefined ? { visible: partial.visible } : {}),
    ...(partial.locked !== undefined ? { locked: partial.locked } : {}),
  }));

  const parsed = sceneFileSchema.safeParse({
    version: 1,
    name: overrides.name ?? 'TestScene',
    engine: 'three',
    seed: overrides.seed ?? 1234,
    instances,
    lights: overrides.lights ?? [],
    camera: overrides.camera ?? DEFAULT_CAMERA,
  });

  if (!parsed.success) {
    throw new Error(
      `Test fixture is not a valid scene: ${parsed.error.issues
        .map((i) => `${i.path.join('.')} — ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/** A three-instance scene: a parent with two children, the child first. */
export function hierarchicalScene(): SceneFile {
  return sceneFile({
    instances: [
      // Deliberately out of order: `child` is listed before `parent`, which is
      // what an AI writing the file produces and what a single-pass builder
      // would silently drop.
      { id: 'child', prefab: 'box', parent: 'parent' },
      { id: 'parent', prefab: 'two-part' },
      { id: 'other', prefab: 'box' },
    ],
  });
}
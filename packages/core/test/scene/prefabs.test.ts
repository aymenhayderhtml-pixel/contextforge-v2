/**
 * scene/prefabs.test.ts — the prefab registry contract (SPEC §4.4).
 *
 * The registry is the boundary between a scene's *data* and Three.js, so what
 * is tested here is mostly refusal: an unknown prefab, a duplicate name, and
 * params that do not match the prefab's own schema must all be reported against
 * the instance that caused them, not swallowed.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  indexPrefabs,
  validateScenePrefabs,
  type PrefabDefinition,
  type PrefabRegistry,
  type ThreeModule,
} from '../../src/scene/prefabs/index.js';
import { mulberry32 } from '../../src/scene/rng.js';
import { parseScene } from '../../src/scene/sceneFile.js';
import type { SceneFile } from '../../src/scene/scene.schema.js';

/** A `three` stub: enough to prove `create` is handed the module, not a global. */
const threeStub = {
  Object3D: class Object3D {},
  Group: class Group {},
  Mesh: class Mesh {},
  MeshStandardMaterial: class MeshStandardMaterial {},
  MeshBasicMaterial: class MeshBasicMaterial {},
  BoxGeometry: class BoxGeometry {},
  SphereGeometry: class SphereGeometry {},
  CylinderGeometry: class CylinderGeometry {},
  PlaneGeometry: class PlaneGeometry {},
} as unknown as ThreeModule;

const cubeParams = z.object({ size: z.number() }).strict();

const cube: PrefabDefinition = {
  name: 'cube',
  description: 'A box.',
  paramsSchema: cubeParams,
  create(three, params, rng) {
    const mesh = new (three.Mesh as new () => unknown)();
    const size = params['size'] ?? 1;
    mesh.position = { jitter: rng.range(-1, 1), size };
    return { object: mesh, parts: { body: mesh } };
  },
};

const coin: PrefabDefinition = {
  name: 'coin',
  paramsSchema: z.object({}).strict(),
  create(three) {
    return { object: new (three.Object3D as new () => unknown)(), parts: {} };
  },
};

const registry: PrefabRegistry = { prefabs: [cube, coin] };

function sceneWith(instances: unknown[]): SceneFile {
  return parseScene({
    version: 1,
    name: 'Level1',
    engine: 'three',
    seed: 1,
    instances,
    camera: { kind: 'perspective', position: [0, 0, 5], rotation: [0, 0, 0], fov: 60 },
  });
}

const identity = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

describe('indexPrefabs', () => {
  it('indexes by name', () => {
    const index = indexPrefabs(registry);
    expect(index.get('cube')?.name).toBe('cube');
    expect(index.get('coin')).toBeDefined();
  });

  it('refuses a duplicate name rather than resolving last-wins', () => {
    // Which prefab a scene instance gets would otherwise depend on file order,
    // and two AIs would place different things in the same slot.
    const clash: PrefabRegistry = { prefabs: [cube, { ...cube, description: 'other' }] };
    expect(() => indexPrefabs(clash)).toThrow(/Duplicate prefab name "cube"/);
  });
});

describe('validateScenePrefabs', () => {
  it('accepts a scene whose params match', () => {
    const scene = sceneWith([
      { id: 'a', prefab: 'cube', transform: identity, params: { size: 2 } },
      { id: 'b', prefab: 'coin', transform: identity, params: {} },
    ]);
    expect(validateScenePrefabs(scene, registry)).toEqual([]);
  });

  it('reports an unknown prefab, naming the registered alternatives', () => {
    const scene = sceneWith([
      { id: 'a', prefab: 'pyramid', transform: identity, params: {} },
    ]);
    const errors = validateScenePrefabs(scene, registry);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('instances[0].prefab');
    expect(errors[0]?.message).toContain('no registered prefab named "pyramid"');
    expect(errors[0]?.message).toContain('cube, coin');
  });

  it('reports a bad param, naming the JSON path of the param', () => {
    // The whole point of paramsSchema: an AI's bad param is reported here,
    // rather than reaching Three.js and producing a silently wrong object.
    const scene = sceneWith([
      { id: 'a', prefab: 'cube', transform: identity, params: { size: 'big' } },
    ]);
    const errors = validateScenePrefabs(scene, registry);
    expect(errors[0]?.path).toBe('instances[0].params.size');
    expect(errors[0]?.message).toContain('prefab "cube"');
  });

  it('reports an unknown param key', () => {
    const scene = sceneWith([
      { id: 'a', prefab: 'coin', transform: identity, params: { colour: 'red' } },
    ]);
    const errors = validateScenePrefabs(scene, registry);
    expect(errors[0]?.path).toContain('params');
    expect(errors[0]?.message).toContain('colour');
  });

  it('reports every bad instance, not just the first', () => {
    const scene = sceneWith([
      { id: 'a', prefab: 'cube', transform: identity, params: { size: 1 } },
      { id: 'b', prefab: 'cube', transform: identity, params: { size: 'x' } },
      { id: 'c', prefab: 'nope', transform: identity, params: {} },
    ]);
    const errors = validateScenePrefabs(scene, registry);
    expect(errors.map((e) => e.path)).toEqual([
      'instances[1].params.size',
      'instances[2].prefab',
    ]);
  });
});

describe('a prefab create function', () => {
  it('receives three, params and a seeded rng as arguments', () => {
    // No globals: everything the prefab needs arrives in the call.
    const result = cube.create(threeStub, { size: 4 }, mulberry32(1));
    expect(result.object).toBeDefined();
    expect(result.parts['body']).toBe(result.object);
  });

  it('is deterministic for a given seed', () => {
    const a = cube.create(threeStub, { size: 1 }, mulberry32(99));
    const b = cube.create(threeStub, { size: 1 }, mulberry32(99));
    expect(a.object).toEqual(b.object);
  });
});

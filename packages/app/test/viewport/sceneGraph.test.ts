/**
 * test/viewport/sceneGraph.test.ts — the pure scene-graph builder.
 *
 * Headless by construction: no DOM, no WebGL context, no GPU. Three.js builds
 * real Object3D trees in Node, which is exactly what makes these assertions
 * possible — the object a developer will see and the object the test inspects
 * are the same object.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { rngFor } from '@contextforge/core';
import type { PrefabDefinition } from '@contextforge/core';

import { buildSceneGraph, indexPrefabDefinitions } from '../../src/renderer/viewport/sceneGraph.js';
import { isErrorMarker } from '../../src/renderer/viewport/markers.js';
import { boxPrefab, brokenPrefabs, healthyPrefabs, hierarchicalScene, jitterOf, jitterPrefab, makePrefab, throwingPrefab, twoPartPrefab, sceneFile } from './fixtures.js';

function registryOf(...prefabs: readonly PrefabDefinition[]): Map<string, PrefabDefinition> {
  return indexPrefabDefinitions(prefabs).index;
}

describe('buildSceneGraph — object counts', () => {
  it('creates one root object per instance', () => {
    const build = buildSceneGraph(hierarchicalScene(), registryOf(boxPrefab, twoPartPrefab));
    expect(build.instances).toHaveLength(3);
    expect(build.byId.size).toBe(3);
    expect(build.root.children).toHaveLength(2); // parent + other; child is nested
  });

  it('builds an empty scene without throwing', () => {
    const build = buildSceneGraph(sceneFile({ instances: [] }), new Map());
    expect(build.instances).toHaveLength(0);
    expect(build.failures).toHaveLength(0);
    expect(build.root.children).toHaveLength(0);
  });

  it('exposes prefab parts without the caller walking the tree', () => {
    const build = buildSceneGraph(
      sceneFile({ instances: [{ id: 'p', prefab: 'two-part' }] }),
      registryOf(twoPartPrefab),
    );
    const node = build.byId.get('p');
    expect(node).toBeDefined();
    expect(Object.keys(node?.parts ?? {})).toEqual(['left', 'right']);
  });
});

describe('buildSceneGraph — transforms', () => {
  it('applies position, rotation and scale from the scene file', () => {
    const scene = sceneFile({
      instances: [
        {
          id: 'crate',
          prefab: 'box',
          transform: {
            position: [3, -4, 5],
            rotation: [0, Math.PI / 2, 0],
            scale: [2, 2, 2],
          },
        },
      ],
    });

    const object = buildSceneGraph(scene, registryOf(boxPrefab)).byId.get('crate')?.object;
    expect(object).toBeDefined();
    expect(object?.position.toArray()).toEqual([3, -4, 5]);
    expect(object?.rotation.y).toBeCloseTo(Math.PI / 2);
    expect(object?.scale.toArray()).toEqual([2, 2, 2]);
  });

  it('honours visible: false by clearing the flag', () => {
    const scene = sceneFile({
      instances: [
        { id: 'shown', prefab: 'box' },
        { id: 'hidden', prefab: 'box', visible: false },
      ],
    });
    const build = buildSceneGraph(scene, registryOf(boxPrefab));
    expect(build.byId.get('shown')?.object.visible).toBe(true);
    expect(build.byId.get('hidden')?.object.visible).toBe(false);
  });

  it('tags each object with its instance id for picking', () => {
    const build = buildSceneGraph(
      sceneFile({ instances: [{ id: 'crate', prefab: 'box' }] }),
      registryOf(boxPrefab),
    );
    expect(build.byId.get('crate')?.object.userData['cfInstanceId']).toBe('crate');
  });

  it('prefers name over id as the Three object name, and falls back to id', () => {
    const build = buildSceneGraph(
      sceneFile({
        instances: [
          { id: 'a', prefab: 'box', name: 'Friendly Crate' },
          { id: 'b', prefab: 'box' },
        ],
      }),
      registryOf(boxPrefab),
    );
    expect(build.byId.get('a')?.object.name).toBe('Friendly Crate');
    expect(build.byId.get('b')?.object.name).toBe('b');
  });
});

describe('buildSceneGraph — parenting is order-independent', () => {
  it('links a child declared before its parent', () => {
    // `hierarchicalScene` lists `child` first on purpose.
    const build = buildSceneGraph(hierarchicalScene(), registryOf(boxPrefab, twoPartPrefab));

    const parent = build.byId.get('parent')?.object;
    const child = build.byId.get('child')?.object;
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(child?.parent).toBe(parent);
    expect(parent?.children).toContain(child);
    expect(build.root.children).toContain(parent);
  });

  it('nests three levels deep', () => {
    const build = buildSceneGraph(
      sceneFile({
        instances: [
          { id: 'c', prefab: 'box', parent: 'b' },
          { id: 'b', prefab: 'box', parent: 'a' },
          { id: 'a', prefab: 'box' },
        ],
      }),
      registryOf(boxPrefab),
    );

    const a = build.byId.get('a')?.object;
    const b = build.byId.get('b')?.object;
    const c = build.byId.get('c')?.object;
    expect(b?.parent).toBe(a);
    expect(c?.parent).toBe(b);
    expect(build.root.children).toEqual([a]);
  });

  it('places an instance at the root when parent is absent', () => {
    const build = buildSceneGraph(
      sceneFile({ instances: [{ id: 'solo', prefab: 'box' }] }),
      registryOf(boxPrefab),
    );
    expect(build.byId.get('solo')?.object.parent).toBe(build.root);
  });

  it('reports a dangling parent instead of dropping the instance', () => {
    // The schema refuses this on the way in, so the builder is fed an
    // already-validated file's sibling case: a parent id that vanished between
    // validation and build. The instance must still be visible.
    const scene = sceneFile({ instances: [{ id: 'orphan', prefab: 'box' }] });
    const withBadParent = { ...scene, instances: [{ ...scene.instances[0]!, parent: 'ghost' }] };

    const build = buildSceneGraph(withBadParent, registryOf(boxPrefab));
    expect(build.instances).toHaveLength(1);
    expect(build.byId.get('orphan')?.object.parent).toBe(build.root);
    expect(build.failures.some((f) => f.kind === 'dangling-parent' && f.id === 'orphan')).toBe(true);
  });

  it('breaks a parent cycle rather than recursing forever', () => {
    // Neither the schema nor a hand-written file should produce this, but a
    // partially corrupted file can, and `Object3D.add` would reparent forever.
    const scene = sceneFile({
      instances: [
        { id: 'a', prefab: 'box', parent: 'b' },
        { id: 'b', prefab: 'box', parent: 'a' },
      ],
    });

    const build = buildSceneGraph(scene, registryOf(boxPrefab));
    expect(build.instances).toHaveLength(2);
    // Every object is reachable from the root and no node is its own ancestor.
    const reachable = new Set<string>();
    const walk = (node: THREE.Object3D): void => {
      const id = node.userData['cfInstanceId'];
      if (typeof id === 'string') reachable.add(id);
      for (const child of node.children) walk(child);
    };
    walk(build.root);
    expect(reachable).toEqual(new Set(['a', 'b']));
  });
});

describe('buildSceneGraph — seeding (SPEC R7/R8)', () => {
  it('gives the same instance the same layout on two builds of the same scene', () => {
    const scene = sceneFile({
      seed: 99,
      instances: [
        { id: 'rock-a', prefab: 'jitter' },
        { id: 'rock-b', prefab: 'jitter' },
      ],
    });

    const first = buildSceneGraph(scene, registryOf(jitterPrefab));
    const second = buildSceneGraph(scene, registryOf(jitterPrefab));

    for (const id of ['rock-a', 'rock-b']) {
      const object = first.byId.get(id)?.object as THREE.Object3D;
      expect(jitterOf(object)).toEqual(jitterOf(second.byId.get(id)?.object as THREE.Object3D));
    }
  });

  it('gives different instances different streams from the same scene seed', () => {
    const scene = sceneFile({
      seed: 99,
      instances: [
        { id: 'rock-a', prefab: 'jitter' },
        { id: 'rock-b', prefab: 'jitter' },
      ],
    });
    const build = buildSceneGraph(scene, registryOf(jitterPrefab));
    expect(jitterOf(build.byId.get('rock-a')?.object as THREE.Object3D)).not.toEqual(
      jitterOf(build.byId.get('rock-b')?.object as THREE.Object3D),
    );
  });

  it('matches rngFor(scene.seed, id) exactly, so the stream is not invented here', () => {
    // Pins the contract: the viewport seeds the prefab with core's own function,
    // rather than reimplementing a hash that could drift from it.
    const seed = 4242;
    const scene = sceneFile({ seed, instances: [{ id: 'widget', prefab: 'jitter' }] });
    const expected = rngFor(seed, 'widget');

    const object = buildSceneGraph(scene, registryOf(jitterPrefab)).byId.get('widget')?.object as THREE.Object3D;
    const [x, y, z] = jitterOf(object);
    expect(x).toBeCloseTo(expected.next(), 12);
    expect(y).toBeCloseTo(expected.next(), 12);
    expect(z).toBeCloseTo(expected.next(), 12);
  });

  it('changes the whole scene when the scene seed changes', () => {
    const instances = [{ id: 'rock', prefab: 'jitter' }] as const;
    const a = buildSceneGraph(sceneFile({ seed: 1, instances: [...instances] }), registryOf(jitterPrefab));
    const b = buildSceneGraph(sceneFile({ seed: 2, instances: [...instances] }), registryOf(jitterPrefab));
    expect(jitterOf(a.byId.get('rock')?.object as THREE.Object3D)).not.toEqual(
      jitterOf(b.byId.get('rock')?.object as THREE.Object3D),
    );
  });

  it('does not depend on instance array order', () => {
    const forwards = sceneFile({
      seed: 7,
      instances: [
        { id: 'a', prefab: 'jitter' },
        { id: 'b', prefab: 'jitter' },
      ],
    });
    const backwards = sceneFile({
      seed: 7,
      instances: [
        { id: 'b', prefab: 'jitter' },
        { id: 'a', prefab: 'jitter' },
      ],
    });

    const one = buildSceneGraph(forwards, registryOf(jitterPrefab));
    const two = buildSceneGraph(backwards, registryOf(jitterPrefab));
    expect(jitterOf(one.byId.get('a')?.object as THREE.Object3D)).toEqual(
      jitterOf(two.byId.get('a')?.object as THREE.Object3D),
    );
  });

  it('overwrites any root transform a prefab set, so the scene file wins', () => {
    // A prefab that positions its own root is fighting the scene data; the
    // instance's placement is authoritative.
    const greedy = makePrefab('greedy', (three) => {
      const T = three as unknown as typeof THREE;
      const mesh = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshStandardMaterial());
      mesh.position.set(99, 99, 99);
      return { object: mesh, parts: {} };
    });

    const scene = sceneFile({
      instances: [
        {
          id: 'g',
          prefab: 'greedy',
          transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
      ],
    });
    const object = buildSceneGraph(scene, registryOf(greedy)).byId.get('g')?.object;
    expect(object?.position.toArray()).toEqual([1, 2, 3]);
  });
});

describe('buildSceneGraph — a throwing prefab does not break the viewport', () => {
  it('does not throw', () => {
    const scene = sceneFile({
      instances: [
        { id: 'good', prefab: 'box' },
        { id: 'bad', prefab: 'explodes' },
        { id: 'also-good', prefab: 'box' },
      ],
    });

    expect(() => buildSceneGraph(scene, registryOf(...brokenPrefabs, boxPrefab))).not.toThrow();
  });

  it('substitutes a placeholder that is visibly an error marker', () => {
    const scene = sceneFile({ instances: [{ id: 'bad', prefab: 'explodes' }] });
    const build = buildSceneGraph(scene, registryOf(throwingPrefab));

    const node = build.byId.get('bad');
    expect(node?.placeholder).toBe(true);
    expect(isErrorMarker(node?.object as THREE.Object3D)).toBe(true);
    expect(node?.object.userData['message']).toContain('prefab is broken');
  });

  it('keeps the surrounding instances intact', () => {
    const scene = sceneFile({
      instances: [
        { id: 'a', prefab: 'box' },
        { id: 'bad', prefab: 'explodes' },
        { id: 'c', prefab: 'box' },
      ],
    });
    const build = buildSceneGraph(scene, registryOf(boxPrefab, throwingPrefab));

    expect(build.instances).toHaveLength(3);
    expect(build.root.children).toHaveLength(3);
    expect(build.byId.get('a')?.placeholder).toBe(false);
    expect(build.byId.get('c')?.placeholder).toBe(false);
  });

  it('reports the failure with the instance id, the prefab name and the reason', () => {
    const scene = sceneFile({ instances: [{ id: 'bad', prefab: 'explodes' }] });
    const build = buildSceneGraph(scene, registryOf(throwingPrefab));

    const failure = build.failures.find((f) => f.id === 'bad');
    expect(failure?.kind).toBe('prefab-threw');
    expect(failure?.prefab).toBe('explodes');
    expect(failure?.message).toContain('bad');
    expect(failure?.message).toContain('explodes');
    expect(failure?.message).toContain('params.legLength is undefined');
  });

  it('leaves the placeholder pickable under the same instance id', () => {
    const scene = sceneFile({ instances: [{ id: 'bad', prefab: 'explodes' }] });
    const build = buildSceneGraph(scene, registryOf(throwingPrefab));
    expect(build.byId.get('bad')?.object.userData['cfInstanceId']).toBe('bad');
  });

  it('applies the instance transform to the placeholder too', () => {
    const scene = sceneFile({
      instances: [
        {
          id: 'bad',
          prefab: 'explodes',
          transform: { position: [9, 9, 9], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
      ],
    });
    const build = buildSceneGraph(scene, registryOf(throwingPrefab));
    expect(build.byId.get('bad')?.object.position.toArray()).toEqual([9, 9, 9]);
  });

  it('handles a prefab that returns something other than an Object3D', () => {
    const bad = makePrefab('weird', () => ({ object: 'not an object', parts: {} }));
    const scene = sceneFile({ instances: [{ id: 'w', prefab: 'weird' }] });

    const build = buildSceneGraph(scene, registryOf(bad));
    expect(build.byId.get('w')?.placeholder).toBe(true);
    expect(build.failures.some((f) => f.kind === 'prefab-threw')).toBe(true);
  });

  it('reports a prefab name that is not in the registry, and still places the instance', () => {
    const scene = sceneFile({ instances: [{ id: 'ghost', prefab: 'deleted-prefab' }] });
    const build = buildSceneGraph(scene, registryOf(boxPrefab));

    expect(build.instances).toHaveLength(1);
    expect(build.byId.get('ghost')?.placeholder).toBe(true);
    expect(build.unknownPrefabs).toEqual(['ghost']);
    expect(build.failures.some((f) => f.kind === 'unknown-prefab')).toBe(true);
  });
});

describe('indexPrefabDefinitions', () => {
  it('indexes by name', () => {
    const { index } = indexPrefabDefinitions(healthyPrefabs);
    expect([...index.keys()].sort()).toEqual(['box', 'jitter', 'two-part']);
  });

  it('reports a duplicate name and keeps the first, rather than throwing', () => {
    const { index, failures } = indexPrefabDefinitions([boxPrefab, boxPrefab]);
    expect(index.size).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain('more than once');
  });
});

describe('buildSceneGraph — .glb references', () => {
  it('queues a model for loading instead of trying to load it synchronously', () => {
    const scene = sceneFile({
      instances: [
        { id: 'hero', prefab: 'box', model: 'models/hero.glb' },
        { id: 'plain', prefab: 'box' },
      ],
    });
    const build = buildSceneGraph(scene, registryOf(boxPrefab));

    expect(build.pendingModels).toHaveLength(1);
    expect(build.pendingModels[0]?.path).toBe('models/hero.glb');
    expect(build.pendingModels[0]?.id).toBe('hero');
    // The prefab's object is still there to parent the loaded model into.
    expect(build.pendingModels[0]?.object).toBe(build.byId.get('hero')?.object);
    expect(build.failures).toHaveLength(0);
  });

  it('does not throw when a model path points at a file that does not exist', () => {
    const scene = sceneFile({ instances: [{ id: 'hero', prefab: 'box', model: 'models/missing.glb' }] });
    expect(() => buildSceneGraph(scene, registryOf(boxPrefab))).not.toThrow();
  });
});
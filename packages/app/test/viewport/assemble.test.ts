/**
 * test/viewport/assemble.test.ts — lights, grid sizing, and the whole
 * build-and-report pipeline without a GPU.
 *
 * This is the closest a headless test gets to "opens the scene": everything the
 * viewport does between receiving a `SceneFile` and needing a WebGL context is
 * asserted here, including the rule that a broken prefab costs a row and a
 * marker rather than a blank screen.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { assembleScene, defaultLightRig } from '../../src/renderer/viewport/assemble.js';
import { indexPrefabDefinitions } from '../../src/renderer/viewport/sceneGraph.js';
import { isErrorMarker } from '../../src/renderer/viewport/markers.js';
import { boxPrefab, sceneFile, throwingPrefab, twoPartPrefab } from './fixtures.js';
import { gridSizeForRadius } from '../../src/renderer/viewport/stage.js';

const registry = indexPrefabDefinitions([boxPrefab, twoPartPrefab]).index;
const brokenRegistry = indexPrefabDefinitions([boxPrefab, throwingPrefab]).index;

describe('assembleScene — lights', () => {
  it('uses the scene\'s own lights when it declares them', () => {
    const scene = sceneFile({
      instances: [{ id: 'a', prefab: 'box' }],
      lights: [
        { id: 'sun', kind: 'directional', color: '#ffffff', intensity: 1, position: [1, 2, 3] },
        { id: 'sky', kind: 'ambient', color: '#aabbcc', intensity: 0.5 },
      ],
    });

    const assembled = assembleScene(scene, registry);
    expect(assembled.lightNames).toEqual(['sun', 'sky']);
    const sun = assembled.root.getObjectByName('sun');
    expect(sun).toBeInstanceOf(THREE.DirectionalLight);
  });

  it('falls back to a neutral rig when the scene declares none', () => {
    // `lights` defaults to `[]`, so an unlit scene file is the normal case, not
    // a broken one. A black viewport would look like the viewer failed.
    const assembled = assembleScene(
      sceneFile({ instances: [{ id: 'a', prefab: 'box' }] }),
      registry,
    );
    expect(assembled.lightNames).toEqual(['cf:key', 'cf:fill', 'cf:ambient']);
    expect(assembled.root.getObjectByName('cf:key')).toBeInstanceOf(THREE.DirectionalLight);
  });

  it('never mixes the fallback rig with the scene\'s lights', () => {
    const assembled = assembleScene(
      sceneFile({
        instances: [{ id: 'a', prefab: 'box' }],
        lights: [{ id: 'sun', kind: 'point', color: '#ffffff', intensity: 2 }],
      }),
      registry,
    );
    expect(assembled.lightNames).toEqual(['sun']);
    expect(assembled.root.getObjectByName('cf:key')).toBeUndefined();
  });

  it('lights are children of the scene root, so a reload replaces them', () => {
    const assembled = assembleScene(sceneFile({ instances: [] }), registry);
    for (const name of assembled.lightNames) {
      expect(assembled.root.getObjectByName(name)?.parent).toBe(assembled.root);
    }
  });

  it('the fallback rig is a fresh set of objects each call', () => {
    // Shared light objects would be reparented out of the previous scene on the
    // second load, which is the kind of bug that only shows after two reloads.
    const first = defaultLightRig();
    const second = defaultLightRig();
    expect(first[0]).not.toBe(second[0]);
  });
});

describe('assembleScene — grid sizing', () => {
  it('gives a small scene a small grid, not an ocean of cells', () => {
    const assembled = assembleScene(
      sceneFile({ instances: [{ id: 'a', prefab: 'box' }] }),
      registry,
    );
    expect(assembled.gridSize).toBe(20);
  });

  it('grows the grid for a scene spread over a large area', () => {
    const spread = Array.from({ length: 20 }, (_, i) => ({
      id: `box-${i}`,
      prefab: 'box',
      transform: { position: [i * 20, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] },
    }));
    const assembled = assembleScene(sceneFile({ instances: spread }), registry);
    expect(assembled.gridSize).toBeGreaterThan(100);
  });

  it('does not let the fallback rig inflate the grid', () => {
    // The rig sits at y=10; measuring the root including it would stretch the
    // grid to a size the scene never uses. The assertion is that a scene is
    // sized by its *content*, not by the lights that were just added — so a
    // scene of the same content must get the same grid either way.
    //
    // (An empty scene is deliberately wider: with nothing to frame, a radius of
    // 10 gives the developer somewhere to click. That is not a regression.)
    const one = assembleScene(sceneFile({ instances: [{ id: 'a', prefab: 'box' }] }), registry);
    const oneLit = assembleScene(
      sceneFile({
        instances: [{ id: 'a', prefab: 'box' }],
        lights: [{ id: 'sun', kind: 'directional', color: '#ffffff', intensity: 1, position: [5, 10, 7] }],
      }),
      registry,
    );

    // A single unit box gives the minimum grid, whether or not lights are declared.
    expect(one.gridSize).toBe(20);
    expect(oneLit.gridSize).toBe(one.gridSize);

    // A scene spread far apart must get a bigger grid. (At 3 units it does not:
    // both clamp to the 20-unit minimum, which is right for a small scene, so
    // the spread has to exceed that before the assertion means anything.)
    const spread = assembleScene(
      sceneFile({
        instances: [
          { id: 'a', prefab: 'box' },
          {
            id: 'b',
            prefab: 'box',
            transform: { position: [40, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
        ],
      }),
      registry,
    );
    expect(spread.gridSize).toBeGreaterThan(one.gridSize);

    // The empty scene's default, pinned so the rig cannot change it silently.
    const empty = assembleScene(sceneFile({ instances: [] }), registry);
    expect(empty.gridSize).toBe(gridSizeForRadius(10));
  });
});

describe('assembleScene — problems are reported, never thrown', () => {
  it('reports a throwing prefab and still returns every instance', () => {
    const assembled = assembleScene(
      sceneFile({
        instances: [
          { id: 'good', prefab: 'box' },
          { id: 'bad', prefab: 'explodes' },
          { id: 'also-good', prefab: 'box' },
        ],
      }),
      brokenRegistry,
    );

    expect(assembled.instances).toHaveLength(3);
    expect(assembled.placeholderCount).toBe(1);
    expect(assembled.problems).toHaveLength(1);
    expect(assembled.problems[0]?.level).toBe('error');
    expect(assembled.problems[0]?.id).toBe('bad');
  });

  it('reports an unknown prefab at error level', () => {
    const assembled = assembleScene(
      sceneFile({ instances: [{ id: 'ghost', prefab: 'nope' }] }),
      registry,
    );
    expect(assembled.problems[0]?.id).toBe('ghost');
    expect(assembled.problems[0]?.message).toContain('nope');
  });

  it('reports a registry problem as a warning, alongside the build\'s errors', () => {
    const assembled = assembleScene(
      sceneFile({ instances: [{ id: 'bad', prefab: 'explodes' }] }),
      brokenRegistry,
      {
        registryFailures: [
          { id: '<registry:box>', prefab: 'box', kind: 'unknown-prefab', message: 'Duplicate prefab name "box".' },
        ],
      },
    );

    const warning = assembled.problems.find((p) => p.level === 'warning');
    const error = assembled.problems.find((p) => p.level === 'error');
    expect(warning?.message).toContain('Duplicate');
    expect(error?.id).toBe('bad');
  });

  it('reports nothing for a clean scene', () => {
    const assembled = assembleScene(
      sceneFile({ instances: [{ id: 'a', prefab: 'box' }] }),
      registry,
    );
    expect(assembled.problems).toHaveLength(0);
    expect(assembled.placeholderCount).toBe(0);
  });
});

describe('assembleScene — .glb queue', () => {
  it('lists model paths to load and leaves the graph intact', () => {
    const assembled = assembleScene(
      sceneFile({
        instances: [
          { id: 'hero', prefab: 'box', model: 'models/hero.glb' },
          { id: 'plain', prefab: 'box' },
        ],
      }),
      registry,
    );

    expect(assembled.pendingModels.map((m) => m.path)).toEqual(['models/hero.glb']);
    // The prefab's object exists so the loaded model has somewhere to go.
    expect(assembled.pendingModels[0]?.object).toBe(assembled.byId.get('hero')?.object);
    expect(assembled.instances).toHaveLength(2);
  });

  it('reports no problem for a model that has not been fetched yet', () => {
    // The load is asynchronous and the frame is already drawn; a failure is
    // reported when it arrives, not speculatively now.
    const assembled = assembleScene(
      sceneFile({ instances: [{ id: 'hero', prefab: 'box', model: 'models/hero.glb' }] }),
      registry,
    );
    expect(assembled.problems).toHaveLength(0);
  });
});

describe('assembleScene — the built graph', () => {
  it('exposes instance ids for the outliner and the picker', () => {
    const assembled = assembleScene(
      sceneFile({
        instances: [
          { id: 'child', prefab: 'box', parent: 'parent' },
          { id: 'parent', prefab: 'two-part' },
        ],
      }),
      registry,
    );

    expect([...assembled.byId.keys()].sort()).toEqual(['child', 'parent']);
    expect(assembled.byId.get('child')?.object.parent).toBe(assembled.byId.get('parent')?.object);
  });

  it('marks a placeholder so the outliner can label it', () => {
    const assembled = assembleScene(
      sceneFile({ instances: [{ id: 'bad', prefab: 'explodes' }] }),
      brokenRegistry,
    );
    const object = assembled.byId.get('bad')?.object as THREE.Object3D;
    expect(assembled.byId.get('bad')?.placeholder).toBe(true);
    expect(isErrorMarker(object)).toBe(true);
  });

  it('is a fresh root on every call, so a reload does not inherit anything', () => {
    const scene = sceneFile({ instances: [{ id: 'a', prefab: 'box' }] });
    const first = assembleScene(scene, registry);
    const second = assembleScene(scene, registry);
    expect(first.root).not.toBe(second.root);
    expect(first.byId.get('a')?.object).not.toBe(second.byId.get('a')?.object);
  });
});
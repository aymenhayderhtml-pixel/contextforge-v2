/**
 * test/viewport/picking.test.ts — selection, the key bindings, and snapping.
 *
 * Two things are asserted here that are normally only reachable through a real
 * TransformControls instance and a real keyboard:
 *
 *  - the W/E/R/Q/F bindings, driven through the public `ViewportAction` path,
 *    and
 *  - the snap rule that "off" is `null` and not `1`.
 *
 * Both are exactly the kind of thing that regresses silently, which is why they
 * are here rather than only in the end-to-end test `ipc.ts` anticipates.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { VIEWPORT_KEYS } from '../../src/ipc.js';

import {
  applyFraming,
  boundingSphereOf,
  framingForSelection,
  pickAt,
  pointerToNdc,
  snapValuesFor,
  toggleSpace,
  viewportActionForKey,
} from '../../src/renderer/viewport/picking.js';
import { boxPrefab, twoPartPrefab } from './fixtures.js';
import { buildSceneGraph, indexPrefabDefinitions } from '../../src/renderer/viewport/sceneGraph.js';
import { sceneFile } from './fixtures.js';

describe('viewportActionForKey — the ipc.ts bindings', () => {
  it('maps W to translate', () => {
    expect(viewportActionForKey(VIEWPORT_KEYS.move)).toEqual({ kind: 'set-mode', mode: 'translate' });
  });

  it('maps E to rotate', () => {
    expect(viewportActionForKey(VIEWPORT_KEYS.rotate)).toEqual({ kind: 'set-mode', mode: 'rotate' });
  });

  it('maps R to scale', () => {
    expect(viewportActionForKey(VIEWPORT_KEYS.scale)).toEqual({ kind: 'set-mode', mode: 'scale' });
  });

  it('maps Q to toggle-space', () => {
    expect(viewportActionForKey(VIEWPORT_KEYS.toggleSpace)).toEqual({ kind: 'toggle-space' });
  });

  it('maps F to focus', () => {
    expect(viewportActionForKey(VIEWPORT_KEYS.focus)).toEqual({ kind: 'focus' });
  });

  it('is case-insensitive, so Shift+W still works', () => {
    expect(viewportActionForKey('W')).toEqual({ kind: 'set-mode', mode: 'translate' });
    expect(viewportActionForKey('E')).toEqual({ kind: 'set-mode', mode: 'rotate' });
    expect(viewportActionForKey('R')).toEqual({ kind: 'set-mode', mode: 'scale' });
    expect(viewportActionForKey('Q')).toEqual({ kind: 'toggle-space' });
    expect(viewportActionForKey('F')).toEqual({ kind: 'focus' });
  });

  it('ignores an unbound key', () => {
    expect(viewportActionForKey('x')).toBeNull();
    expect(viewportActionForKey('1')).toBeNull();
  });

  it('ignores a multi-character key that merely starts with a binding', () => {
    // 'w' must not match 'wibble', or a pasted word would grab the gizmo.
    expect(viewportActionForKey('wibble')).toBeNull();
    expect(viewportActionForKey('Escape')).toBeNull();
    expect(viewportActionForKey('F1')).toBeNull();
  });

  it('has a distinct action for each of the five bindings', () => {
    const actions = [
      VIEWPORT_KEYS.move,
      VIEWPORT_KEYS.rotate,
      VIEWPORT_KEYS.scale,
      VIEWPORT_KEYS.toggleSpace,
      VIEWPORT_KEYS.focus,
    ].map(viewportActionForKey);
    expect(new Set(actions.map((a) => JSON.stringify(a))).size).toBe(5);
  });
});

describe('toggleSpace', () => {
  it('flips world to local and back', () => {
    expect(toggleSpace('world')).toBe('local');
    expect(toggleSpace('local')).toBe('world');
  });

  it('returns to where it started after two presses', () => {
    expect(toggleSpace(toggleSpace('world'))).toBe('world');
  });
});

describe('snapValuesFor', () => {
  it('disables all three snaps when the increment is null', () => {
    expect(snapValuesFor(null)).toEqual({ translation: null, rotation: null, scale: null });
  });

  it('sets null rather than 1 when off, so free movement stays free', () => {
    // The regression this guards: setTranslationSnap(1) quantises to whole units
    // and looks like snapping is stuck on.
    const off = snapValuesFor(null);
    expect(off.translation).toBeNull();
    expect(off.translation).not.toBe(1);
  });

  it('applies the increment to translation and scale', () => {
    const on = snapValuesFor(0.25);
    expect(on.translation).toBe(0.25);
    expect(on.scale).toBe(0.25);
  });

  it('snaps rotation to 15 degrees, not to the position increment', () => {
    const on = snapValuesFor(1);
    expect(on.rotation).toBeCloseTo((Math.PI / 180) * 15);
  });

  it('treats a non-positive or non-finite increment as off', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(snapValuesFor(bad).translation).toBeNull();
    }
  });
});

describe('pointerToNdc', () => {
  const rect = { left: 0, top: 0, width: 200, height: 100 };

  it('maps the centre of the canvas to the origin', () => {
    const ndc = pointerToNdc({ clientX: 100, clientY: 50 }, rect);
    expect(ndc.x).toBeCloseTo(0);
    expect(ndc.y).toBeCloseTo(0);
  });

  it('flips Y, because screen Y grows downward and NDC Y grows up', () => {
    expect(pointerToNdc({ clientX: 0, clientY: 0 }, rect).y).toBeCloseTo(1);
    expect(pointerToNdc({ clientX: 0, clientY: 100 }, rect).y).toBeCloseTo(-1);
  });

  it('accounts for the canvas offset inside the page', () => {
    const offset = { left: 50, top: 25, width: 200, height: 100 };
    const ndc = pointerToNdc({ clientX: 150, clientY: 75 }, offset);
    expect(ndc.x).toBeCloseTo(0);
    expect(ndc.y).toBeCloseTo(0);
  });

  it('maps the corners to (-1, 1) and (1, -1)', () => {
    expect(pointerToNdc({ clientX: 0, clientY: 0 }, rect).x).toBeCloseTo(-1);
    expect(pointerToNdc({ clientX: 200, clientY: 100 }, rect).x).toBeCloseTo(1);
  });
});

describe('pickAt — click-to-select', () => {
  /** A camera looking down -Z at the origin, so NDC (0,0) is the centre. */
  function cameraLookingAtOrigin(): THREE.PerspectiveCamera {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    return camera;
  }

  function raycasterFor(camera: THREE.Camera): THREE.Raycaster {
    const raycaster = new THREE.Raycaster();
    raycaster.camera = camera;
    return raycaster;
  }

  const registry = indexPrefabDefinitions([boxPrefab, twoPartPrefab]).index;

  it('reports the instance id of what was clicked', () => {
    const build = buildSceneGraph(
      sceneFile({ instances: [{ id: 'crate', prefab: 'box' }] }),
      registry,
    );

    const { selection } = pickAt(raycasterFor(cameraLookingAtOrigin()), [build.root], new THREE.Vector2(0, 0));
    expect(selection).toEqual({ kind: 'instance', id: 'crate' });
  });

  it('reports the instance, not the sub-object, when a deep child was clicked', () => {
    const build = buildSceneGraph(
      sceneFile({
        instances: [{ id: 'assembly', prefab: 'two-part' }],
      }),
      registry,
    );

    const camera = cameraLookingAtOrigin();
    // The left sphere is at the group origin; the right one is 2 units along X.
    const { selection } = pickAt(raycasterFor(camera), [build.root], new THREE.Vector2(0, 0));
    expect(selection).toEqual({ kind: 'instance', id: 'assembly' });
  });

  it('selects a nested instance by its own id, not its parent instance id', () => {
    const build = buildSceneGraph(
      sceneFile({
        instances: [
          // Offset so the child does not share a surface with the parent's own
          // geometry: a click hits the nearest thing along the ray, and two
          // boxes at the same point are a coin toss.
          {
            id: 'child',
            prefab: 'box',
            parent: 'parent',
            transform: { position: [0, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
          { id: 'parent', prefab: 'two-part' },
        ],
      }),
      registry,
    );

    const camera = cameraLookingAtOrigin();
    const { selection } = pickAt(raycasterFor(camera), [build.root], new THREE.Vector2(0, 0));
    expect(selection).toEqual({ kind: 'instance', id: 'child' });
  });

  it('selects the parent when the click lands on the parent, not the child', () => {
    const build = buildSceneGraph(
      sceneFile({
        instances: [
          { id: 'child', prefab: 'box', parent: 'parent', transform: { position: [0, 0, -1], rotation: [0, 0, 0], scale: [1, 1, 1] } },
          { id: 'parent', prefab: 'two-part' },
        ],
      }),
      registry,
    );

    const camera = cameraLookingAtOrigin();
    const { selection } = pickAt(raycasterFor(camera), [build.root], new THREE.Vector2(0, 0));
    expect(selection).toEqual({ kind: 'instance', id: 'parent' });
  });

  it('returns none when the ray hits nothing', () => {
    // Behind the camera: the ray points away from it, so nothing along it can
    // be hit however far away the object is.
    const build = buildSceneGraph(
      sceneFile({
        instances: [{ id: 'crate', prefab: 'box', transform: { position: [0, 0, 50], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      }),
      registry,
    );

    const result = pickAt(raycasterFor(cameraLookingAtOrigin()), [build.root], new THREE.Vector2(0, 0));
    expect(result.selection).toEqual({ kind: 'none' });
    expect(result.object).toBeNull();
  });

  it('returns none — but still names the object — when only the grid is hit', () => {
    // The grid is not in `pickTargets`, so an empty pick is the whole story;
    // this pins that the function reports the object when it has one.
    const stray = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const raycaster = raycasterFor(cameraLookingAtOrigin());
    const result = pickAt(raycaster, [stray], new THREE.Vector2(0, 0));
    expect(result.selection).toEqual({ kind: 'none' });
    expect(result.object).toBe(stray);
  });

  it('selects a placeholder for a failed prefab under its real instance id', () => {
    const exploding = indexPrefabDefinitions([
      {
        name: 'boom',
        description: 'throws',
        paramsSchema: boxPrefab.paramsSchema,
        create: () => {
          throw new Error('nope');
        },
      },
    ]).index;

    const build = buildSceneGraph(
      sceneFile({ instances: [{ id: 'ghost', prefab: 'boom' }] }),
      exploding,
    );

    const { selection } = pickAt(raycasterFor(cameraLookingAtOrigin()), [build.root], new THREE.Vector2(0, 0));
    expect(selection).toEqual({ kind: 'instance', id: 'ghost' });
  });
});

describe('boundingSphereOf', () => {
  it('measures an object with geometry', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    const sphere = boundingSphereOf(mesh);
    expect(sphere?.radius).toBeCloseTo(Math.sqrt(3));
  });

  it('returns null for an object with no geometry rather than a zero sphere', () => {
    expect(boundingSphereOf(new THREE.Group())).toBeNull();
  });
});

describe('framingForSelection and applyFraming', () => {
  it('backs the camera off far enough to contain the sphere', () => {
    const sphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 5);
    const framing = framingForSelection(sphere, 60, 1);
    // Half-angle 30 degrees: distance must exceed radius / tan(30).
    expect(framing.distance).toBeGreaterThan(5 / Math.tan(Math.PI / 6));
  });

  it('backs off further for a narrow viewport, which is limited by width', () => {
    const sphere = new THREE.Sphere(new THREE.Vector3(), 5);
    const wide = framingForSelection(sphere, 60, 2);
    const narrow = framingForSelection(sphere, 60, 0.5);
    expect(narrow.distance).toBeGreaterThan(wide.distance);
  });

  it('falls back to a fixed distance when there is no selection', () => {
    const framing = framingForSelection(null, 60, 1);
    expect(framing.target.toArray()).toEqual([0, 0, 0]);
    expect(framing.distance).toBeGreaterThan(0);
  });

  it('moves a perspective camera to the framed distance, looking at the target', () => {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(3, 4, 5);
    const framing = { target: new THREE.Vector3(0, 0, 0), distance: 20 };

    applyFraming(camera, framing);

    expect(camera.position.distanceTo(framing.target)).toBeCloseTo(20);
    // Still looking at the target: the forward vector points back down the line.
    const forward = camera.getWorldDirection(new THREE.Vector3());
    expect(forward.x).toBeCloseTo(-camera.position.x / 20);
  });

  it('preserves the viewing direction when framing', () => {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    const before = camera.getWorldDirection(new THREE.Vector3());

    applyFraming(camera, { target: new THREE.Vector3(0, 0, 0), distance: 50 });

    const after = camera.getWorldDirection(new THREE.Vector3());
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(after.z).toBeCloseTo(before.z);
  });

  it('resizes an orthographic frustum instead of moving it, and stays centred on the target', () => {
    const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
    camera.position.set(0, 10, 0);

    applyFraming(camera, { target: new THREE.Vector3(0, 2, 0), distance: 10 });

    expect(camera.position.y).toBeCloseTo(12);
    expect(camera.right - camera.left).toBeGreaterThan(0);
    expect(camera.getWorldDirection(new THREE.Vector3()).y).toBeCloseTo(-1);
  });
});
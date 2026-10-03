/**
 * test/viewport/stage.test.ts — lights, camera, grid.
 *
 * Headless: Three.js builds lights and cameras without a renderer, so every
 * value the scene file specifies can be read straight back off the object.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { SceneLight } from '@contextforge/core';

import {
  buildCamera,
  buildLight,
  buildLights,
  createGroundGrid,
  defaultCameraFraming,
  gridSizeForRadius,
} from '../../src/renderer/viewport/stage.js';

function light(overrides: Partial<SceneLight> & Pick<SceneLight, 'kind'>): SceneLight {
  return { id: overrides.id ?? 'l', color: '#ffffff', intensity: 1, ...overrides } as SceneLight;
}

describe('buildLight', () => {
  it.each([
    ['ambient', THREE.AmbientLight],
    ['hemisphere', THREE.HemisphereLight],
    ['directional', THREE.DirectionalLight],
    ['point', THREE.PointLight],
    ['spot', THREE.SpotLight],
  ] as const)('builds a %s light', (kind, ctor) => {
    expect(buildLight(light({ kind }))).toBeInstanceOf(ctor);
  });

  it('carries the colour and intensity across', () => {
    const built = buildLight(light({ kind: 'directional', color: '#ff8800', intensity: 2.5 }));
    expect((built as THREE.DirectionalLight).color.getHex()).toBe(0xff8800);
    expect(built.intensity).toBe(2.5);
  });

  it('applies distance for a point light and a default of none when absent', () => {
    const withDistance = buildLight(light({ kind: 'point', distance: 12 })) as THREE.PointLight;
    const without = buildLight(light({ kind: 'point' })) as THREE.PointLight;
    expect(withDistance.distance).toBe(12);
    expect(without.distance).toBe(0); // 0 means "no cutoff" in Three.js
  });

  it('applies the cone angle for a spot light and defaults it when absent', () => {
    const withAngle = buildLight(light({ kind: 'spot', angle: Math.PI / 6 })) as THREE.SpotLight;
    const without = buildLight(light({ kind: 'spot' })) as THREE.SpotLight;
    expect(withAngle.angle).toBeCloseTo(Math.PI / 6);
    expect(without.angle).toBeCloseTo(Math.PI / 3);
  });

  it('reads the 6-digit hex colour the schema validated', () => {
    expect((buildLight(light({ kind: 'ambient', color: '#123456' })) as THREE.Light).color.getHex()).toBe(0x123456);
  });
});

describe('buildLights', () => {
  it('names each light by its scene id and applies position and shadows', () => {
    const built = buildLights([
      light({ id: 'sun', kind: 'directional', position: [1, 2, 3], castShadow: true }),
      light({ id: 'fill', kind: 'ambient' }),
    ]);

    expect(built.map((l) => l.id)).toEqual(['sun', 'fill']);
    expect(built[0]?.light.name).toBe('sun');
    expect(built[0]?.light.position.toArray()).toEqual([1, 2, 3]);
    expect(built[0]?.light.castShadow).toBe(true);
    expect(built[1]?.light.castShadow).toBe(false);
  });

  it('leaves a directional light pointing at the origin when the scene omits a position', () => {
    // Three.js points a directional light from its position at (0,0,0), so a
    // default at (0,0,0) would leave it with no direction at all. The light is
    // moved up rather than left at the origin, which is what makes it a light.
    const built = buildLights([light({ id: 'sun', kind: 'directional' })]);
    expect(built[0]?.light.position.toArray()).toEqual([0, 1, 0]);
  });

  it('returns an empty list for a scene with no lights', () => {
    expect(buildLights([])).toEqual([]);
  });
});

describe('buildCamera', () => {
  it('builds a perspective camera with fov, position and rotation', () => {
    const camera = buildCamera({
      kind: 'perspective',
      position: [4, 5, 6],
      rotation: [0.1, 0.2, 0.3],
      fov: 70,
      near: 0.5,
      far: 250,
    });

    expect(camera).toBeInstanceOf(THREE.PerspectiveCamera);
    const perspective = camera as THREE.PerspectiveCamera;
    expect(perspective.fov).toBe(70);
    expect(perspective.near).toBe(0.5);
    expect(perspective.far).toBe(250);
    expect(perspective.position.toArray()).toEqual([4, 5, 6]);
    expect(perspective.rotation.x).toBeCloseTo(0.1);
  });

  it('builds an orthographic camera whose frustum is the requested half-size', () => {
    const camera = buildCamera({
      kind: 'orthographic',
      position: [0, 10, 0],
      rotation: [0, 0, 0],
      orthoSize: 20,
    });

    expect(camera).toBeInstanceOf(THREE.OrthographicCamera);
    const ortho = camera as THREE.OrthographicCamera;
    expect(ortho.left).toBe(-20);
    expect(ortho.right).toBe(20);
    expect(ortho.top).toBe(20);
    expect(ortho.bottom).toBe(-20);
  });

  it('defaults an orthographic size, so the frustum is never degenerate', () => {
    const ortho = buildCamera({
      kind: 'orthographic',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    }) as THREE.OrthographicCamera;
    expect(ortho.right - ortho.left).toBeGreaterThan(0);
  });

  it('defaults a perspective fov and clipping planes', () => {
    const camera = buildCamera({
      kind: 'perspective',
      position: [0, 0, 5],
      rotation: [0, 0, 0],
    }) as THREE.PerspectiveCamera;
    expect(camera.fov).toBe(50);
    expect(camera.near).toBe(0.1);
    expect(camera.far).toBe(1000);
  });
});

describe('defaultCameraFraming', () => {
  it('places the camera outside the content, looking at it', () => {
    const centre = new THREE.Vector3(10, 0, 10);
    const framing = defaultCameraFraming(centre, 4);

    expect(framing.target.toArray()).toEqual([10, 0, 10]);
    expect(framing.position.distanceTo(centre)).toBeGreaterThan(4);
    // Above and to the side: a three-quarter view, not a flat elevation.
    expect(framing.position.y).toBeGreaterThan(centre.y);
  });

  it('keeps a zero-radius scene out of its own target', () => {
    const framing = defaultCameraFraming(new THREE.Vector3(), 0);
    expect(framing.position.length()).toBeGreaterThan(1);
  });
});

describe('createGroundGrid', () => {
  it('contains cells and two coloured axes', () => {
    const grid = createGroundGrid();
    const names = grid.children.map((c) => c.name);
    expect(names).toContain('cf:grid-cells');
    expect(names).toContain('cf:axis-x');
    expect(names).toContain('cf:axis-y');
  });

  it('lies in the XZ plane by default, which is where Y-up scenes put the floor', () => {
    const grid = createGroundGrid();
    const cells = grid.children.find((c) => c.name === 'cf:grid-cells');
    expect(cells).toBeInstanceOf(THREE.GridHelper);
    expect(cells?.position.y).toBe(0);
  });

  it('rotates into the XY plane for a Z-up scene', () => {
    const grid = createGroundGrid({ up: 'z' });
    expect(grid.rotation.x).toBeCloseTo(-Math.PI / 2);
  });

  it('builds the requested number of grid cells', () => {
    const countOf = (divisions: number): number => {
      const cells = createGroundGrid({ size: 100, divisions }).children.find(
        (c) => c.name === 'cf:grid-cells',
      ) as THREE.GridHelper;
      return (cells.geometry.getAttribute('position') as THREE.BufferAttribute).count;
    };

    // A GridHelper emits two line segments (four vertices) per division edge,
    // and `count` is monotonic in `divisions` — which is all the contract needs.
    expect(countOf(10)).toBeGreaterThan(0);
    expect(countOf(20)).toBeGreaterThan(countOf(10));
    expect(countOf(40)).toBeGreaterThan(countOf(20));
  });
});

describe('gridSizeForRadius', () => {
  it('grows with the scene but never returns a uselessly small grid', () => {
    expect(gridSizeForRadius(0.1)).toBe(20);
    expect(gridSizeForRadius(50)).toBeGreaterThan(100);
    expect(gridSizeForRadius(500)).toBeGreaterThan(gridSizeForRadius(50));
  });
});
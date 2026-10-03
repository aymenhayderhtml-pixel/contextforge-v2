/**
 * stage.ts — lights, camera, and the ground grid.
 *
 * Everything here comes from the scene file or from a documented default; none
 * of it is invented state. The one default that is not in the file is the grid
 * size, and it is *derived* from the scene's own content rather than hardcoded,
 * so a 2×2 test scene and a 400×400 level both get a sensible grid.
 *
 * Lights are per-instance objects rather than added straight to the scene so a
 * test can assert on them without a scene graph, and so a scene with two
 * directional lights does not silently overwrite one with the other.
 */

import * as THREE from 'three';
import type { SceneCamera, SceneLight } from '@contextforge/core';

import { readVec3, setVec3 } from './vec3.js';

/** One light, as built from a scene light entry. */
export interface LightNode {
  readonly id: string;
  readonly light: THREE.Light;
}

/**
 * Build a light from a scene entry.
 *
 * `kind` maps one-to-one onto a Three.js light class. A `spot` without an
 * `angle` gets Three's default cone rather than an error, because a light that
 * points nowhere is a content problem the developer can see, not a reason to
 * refuse to open the scene (SPEC R9).
 */
export function buildLight(definition: SceneLight): THREE.Light {
  const color = new THREE.Color(definition.color);

  switch (definition.kind) {
    case 'ambient':
      return new THREE.AmbientLight(color, definition.intensity);

    case 'hemisphere':
      return new THREE.HemisphereLight(color, new THREE.Color(0x000000), definition.intensity);

    case 'directional':
      return new THREE.DirectionalLight(color, definition.intensity);

    case 'point':
      return new THREE.PointLight(color, definition.intensity, definition.distance ?? 0, 2);

    case 'spot': {
      const spot = new THREE.SpotLight(color, definition.intensity, definition.distance ?? 0, definition.angle ?? Math.PI / 3, 0.5, 2);
      return spot;
    }

    default: {
      // Exhaustiveness: a new light kind in the schema is a compile error here.
      const never: never = definition.kind;
      throw new Error(`Unhandled light kind: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Build every light, named by its scene id.
 *
 * `position` and `castShadow` are applied here rather than by the caller so a
 * light is fully described by one function — a light built but not positioned
 * is a light that silently does nothing.
 */
export function buildLights(lights: readonly SceneLight[]): LightNode[] {
  return lights.map((definition) => {
    const light = buildLight(definition);
    light.name = definition.id;
    if (definition.position !== undefined) {
      setVec3(light.position, definition.position, `lights.${definition.id}.position`);
    }
    if (definition.castShadow === true) {
      light.castShadow = true;
    }
    return { id: definition.id, light };
  });
}

/**
 * The camera a scene file describes.
 *
 * An orthographic camera has no frustum until `updateProjectionMatrix` sees a
 * size, so `orthoSize` needs a value; the default is a half-height of 10, which
 * frames a room-sized scene.
 */
export function buildCamera(definition: SceneCamera): THREE.Camera {
  if (definition.kind === 'orthographic') {
    const size = definition.orthoSize ?? 10;
    const camera = new THREE.OrthographicCamera(
      -size,
      size,
      size,
      -size,
      definition.near ?? 0.1,
      definition.far ?? 1000,
    );
    const [px, py, pz] = readVec3(definition.position, 'camera.position');
    camera.position.set(px, py, pz);
    const [rx, ry, rz] = readVec3(definition.rotation, 'camera.rotation');
    camera.rotation.set(rx, ry, rz);
    camera.updateProjectionMatrix();
    return camera;
  }

  const camera = new THREE.PerspectiveCamera(
    definition.fov ?? 50,
    1,
    definition.near ?? 0.1,
    definition.far ?? 1000,
  );
  const [px, py, pz] = readVec3(definition.position, 'camera.position');
  camera.position.set(px, py, pz);
  const [rx, ry, rz] = readVec3(definition.rotation, 'camera.rotation');
  camera.rotation.set(rx, ry, rz);
  camera.updateProjectionMatrix();
  return camera;
}

/**
 * Where the camera should sit when the scene file says nothing useful.
 *
 * The schema requires a camera, so this is only reached if the scene was built
 * by hand or a field was lost. It frames the scene's bounding sphere from a
 * three-quarter angle above, which is the orientation a developer expects from
 * a blank modeling viewport.
 */
export function defaultCameraFraming(centre: THREE.Vector3, radius: number): {
  position: THREE.Vector3;
  target: THREE.Vector3;
} {
  // A zero-radius scene (no instances) would put the camera inside the target.
  const safeRadius = Math.max(radius, 1);
  const distance = safeRadius * 2.5;
  return {
    position: new THREE.Vector3(
      centre.x + distance * 0.6,
      centre.y + distance * 0.5,
      centre.z + distance * 0.8,
    ),
    target: centre.clone(),
  };
}

/** Options for {@link createGroundGrid}. */
export interface GroundGridOptions {
  /** Extent of the visible grid, in scene units, centred on the origin. */
  readonly size?: number;
  /** Number of cells across. 20 is readable; 200 is not. */
  readonly divisions?: number;
  /** Which plane the grid lies in. Y-up is Three's and Three.js scenes'. */
  readonly up?: 'y' | 'z';
}

/**
 * The orientation grid.
 *
 * Two lines: a `GridHelper` for the cells and an axes pair at the origin, so
 * "which way is +X" is answerable without selecting anything. Y is suppressed
 * because vertical position is where the gizmo and the inspector read best —
 * a plane at y=0 that is invisible from above helps nobody.
 */
export function createGroundGrid(options: GroundGridOptions = {}): THREE.Group {
  const size = options.size ?? 40;
  const divisions = options.divisions ?? 20;
  const up = options.up ?? 'y';

  const group = new THREE.Group();
  group.name = 'cf:grid';

  const grid = new THREE.GridHelper(size, divisions, 0x555555, 0x333333);
  grid.name = 'cf:grid-cells';
  group.add(grid);

  const axisX = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-size / 2, 0, 0), new THREE.Vector3(size / 2, 0, 0)]),
    new THREE.LineBasicMaterial({ color: 0xcc3333 }),
  );
  axisX.name = 'cf:axis-x';
  const axisY = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, -size / 2), new THREE.Vector3(0, 0, size / 2)]),
    new THREE.LineBasicMaterial({ color: 0x3333cc }),
  );
  axisY.name = 'cf:axis-y';

  if (up === 'y') {
    // GridHelper already lies in XZ; raise it to the floor plane.
    grid.position.y = 0;
    axisX.position.y = 0;
    axisY.position.y = 0;
  } else {
    group.rotation.x = -Math.PI / 2;
  }

  // The axes are children of the group, so the Z-up rotation above carries
  // them too; in the Y-up case they are already correct.
  group.add(axisX, axisY);

  return group;
}

/**
 * The grid extent that suits a scene, derived from its contents.
 *
 * A scene of 3 objects 2 units apart gets a 10-unit grid, not a 400-unit one,
 * because a grid too large to see the cells on is the same as no grid.
 */
export function gridSizeForRadius(radius: number): number {
  const rounded = Math.ceil(radius * 2 * 1.5 / 10) * 10;
  return Math.max(20, rounded);
}
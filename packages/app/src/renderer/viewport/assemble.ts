/**
 * assemble.ts — everything `load` does that does not need a GPU.
 *
 * Split out of `viewport.ts` for one reason: the decisions here are the ones a
 * test can actually check. "What does the viewport do with a scene that
 * declares no lights?" and "how big is the grid for this scene?" are content
 * decisions, and burying them behind a `WebGLRenderer` constructor would mean
 * they could only ever be checked by looking at pixels.
 *
 * `Viewport.loadFromIndex` is a thin shell over this: build, assemble, then
 * hand the result to the renderer and drain the pending `.glb` list.
 */

import * as THREE from 'three';
import type { SceneFile } from '@contextforge/core';
import type { AppError } from '../../errors.js';

import {
  buildSceneGraph,
  type InstanceNode,
  type PendingModel,
  type PrefabIndex,
  type SceneBuildFailure,
} from './sceneGraph.js';
import { buildLights, gridSizeForRadius } from './stage.js';

/** A problem, in the shape the owner is handed. */
export interface SceneProblem {
  readonly level: 'warning' | 'error';
  readonly id: string;
  readonly message: string;
  readonly appError?: AppError;
}

export interface AssembledScene {
  /** The scene root, lights included. */
  readonly root: THREE.Group;
  readonly instances: readonly InstanceNode[];
  readonly byId: ReadonlyMap<string, InstanceNode>;
  readonly pendingModels: readonly PendingModel[];
  readonly problems: readonly SceneProblem[];
  readonly errors: readonly AppError[];
  readonly placeholderCount: number;
  /** Extent to hand `createGroundGrid`, derived from the content. */
  readonly gridSize: number;
  /** The names of the lights actually added — the scene's, or the fallback rig. */
  readonly lightNames: readonly string[];
}

/** Options for {@link assembleScene}. */
export interface AssembleOptions {
  /**
   * Failures already known about the registry, e.g. a duplicate prefab name.
   * Reported alongside the build's own, at warning level: a duplicate is a
   * content problem, not a reason the scene cannot be shown.
   */
  readonly registryFailures?: readonly SceneBuildFailure[];
}

/**
 * A neutral three-light rig, used when a scene declares no lights.
 *
 * A modelling viewport with no light is a black screen with a grid in it, and
 * `lights: []` is a perfectly valid scene file — it is the default. So this is
 * a fallback rather than an error. The names are prefixed `cf:` so they are
 * visibly not the developer's, and cannot collide with a scene light id.
 */
export function defaultLightRig(): THREE.Light[] {
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(5, 10, 7);
  key.name = 'cf:key';

  const fill = new THREE.DirectionalLight(0xffffff, 0.4);
  fill.position.set(-6, 4, -5);
  fill.name = 'cf:fill';

  const ambient = new THREE.AmbientLight(0xffffff, 0.35);
  ambient.name = 'cf:ambient';

  return [key, fill, ambient];
}

/**
 * Build a complete, lit scene root from validated data.
 *
 * Total: a prefab that throws, a missing prefab, a dangling parent and a
 * `.glb` that will fail to load all produce reported problems and visible
 * objects, never an exception out of here (SPEC R9).
 */
export function assembleScene(
  scene: SceneFile,
  registry: PrefabIndex,
  options: AssembleOptions = {},
): AssembledScene {
  const registryFailures = options.registryFailures ?? [];
  const problems: SceneProblem[] = registryFailures.map((failure) => ({
    level: 'warning' as const,
    id: failure.id,
    message: failure.message,
  }));

  const build = buildSceneGraph(scene, registry);

  for (const failure of build.failures) {
    problems.push({
      level: 'error',
      id: failure.id,
      message: failure.message,
      ...(failure.appError ? { appError: failure.appError } : {}),
    });
  }

  // The scene's own lights, or the fallback rig. Added to the scene root rather
  // than to the Three scene so that a `load` replaces them along with
  // everything else, instead of accumulating a light per reload.
  const declared = buildLights(scene.lights);
  const lights = declared.length > 0 ? declared.map((node) => node.light) : defaultLightRig();
  for (const light of lights) build.root.add(light);

  // Size the grid from the geometry, ignoring the lights just added: a light at
  // (5, 10, 7) would otherwise stretch the grid to a size the scene never uses.
  const contentBounds = new THREE.Box3();
  for (const instance of build.instances) {
    contentBounds.expandByObject(instance.object);
  }
  const radius = contentBounds.isEmpty()
    ? 10
    : Math.max(contentBounds.getBoundingSphere(new THREE.Sphere()).radius, 1);

  return {
    root: build.root,
    instances: build.instances,
    byId: build.byId,
    pendingModels: build.pendingModels,
    problems,
    errors: build.errors,
    placeholderCount: build.instances.filter((instance) => instance.placeholder).length,
    gridSize: gridSizeForRadius(radius),
    lightNames: lights.map((light) => light.name),
  };
}
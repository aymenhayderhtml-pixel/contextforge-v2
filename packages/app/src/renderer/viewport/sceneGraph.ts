/**
 * sceneGraph.ts — turn a validated `SceneFile` into Three.js objects.
 *
 * This is the **data half** of the viewport: no DOM, no WebGL context, no
 * renderer. It takes the scene file and a prefab registry and produces an
 * object graph that a test can assert on headlessly — object count, transforms,
 * parenting, and what happens when a prefab throws.
 *
 * Three decisions worth stating, because each exists because of something in
 * the spec rather than taste:
 *
 *  1. **Parenting is applied in a second pass.** The scene schema guarantees
 *     `parent` names an existing instance, but it says nothing about *array
 *     order*. An AI writing `scene.json` will put a child before its parent
 *     sooner or later; a single pass would silently drop it on the floor. So
 *     every object is created first and the hierarchy is linked afterwards.
 *
 *  2. **A prefab that throws becomes a placeholder, not an exception.** A
 *     `scene.json` an AI has just written is the normal state of a project under
 *     active development, and `PrefabRegistryResult.failed` in `ipc.ts` says
 *     the same thing from the other side: one bad prefab must not be the reason
 *     the viewport refuses to open. The throw is caught per instance, a
 *     labelled error box is substituted, and the failure is reported with the
 *     instance id so the outliner can show a row for it.
 *
 *  3. **Randomness comes from `rngFor(scene.seed, instance.id)`.** Per instance,
 *     never per scene: one stream for the whole scene would put every scattered
 *     rock in the same place (SPEC R7), and a stream read from a global would
 *     make the scene non-reproducible (R8).
 */

import * as THREE from 'three';
import { rngFor } from './rng.js';
import type {
  PrefabDefinition,
  ThreeModule,
} from '@contextforge/core';
import type { SceneFile, SceneInstance } from '@contextforge/core';

import { createErrorMarker } from './markers.js';
import { setVec3 } from './vec3.js';
import { createAppError, type AppError } from '../../errors.js';
import { getRegisteredPrefab } from './registry.js';


/**
 * Why one instance is not the object its prefab promised.
 *
 * `prefab-threw` and `unknown-prefab` are separate because they need different
 * fixes from the developer: one is a bug in a prefab file, the other is a scene
 * referencing a prefab that was deleted or renamed.
 */
export type SceneBuildFailureKind = 'prefab-threw' | 'unknown-prefab' | 'invalid-prefab-result' | 'dangling-parent';

export interface SceneBuildFailure {
  /** The scene instance this failure belongs to. */
  readonly id: string;
  readonly prefab: string;
  readonly kind: SceneBuildFailureKind;
  /** A complete sentence, shown verbatim in the outliner. */
  readonly message: string;
  /** Structured AppError instance representing this failure. */
  readonly appError?: AppError;
}

/**
 * One instance as it exists in the scene graph.
 *
 * `object` is the node that was added to the scene root (or to its parent);
 * `parts` is whatever the prefab exposed, kept so a later feature can select a
 * sub-object without walking the tree (SPEC §4.4).
 */
export interface InstanceNode {
  readonly id: string;
  readonly prefab: string;
  readonly object: THREE.Object3D;
  readonly parts: Readonly<Record<string, unknown>>;
  /** True when `object` is a placeholder standing in for a failed prefab. */
  readonly placeholder: boolean;
}

/**
 * A `.glb` the scene refers to that has not been loaded yet.
 *
 * Loading is asynchronous and may fail, so it is *not* done inside this
 * function: a build must be synchronous and total. The viewport drains this
 * list with a GLTFLoader and turns each outcome into either real geometry or an
 * error marker (see `viewport.ts`).
 */
export interface PendingModel {
  readonly id: string;
  /** The project-relative path from `instance.model`, or from `prefab/param`. */
  readonly path: string;
  /** The node the loaded scene should be parented into. */
  readonly object: THREE.Object3D;
}

export interface SceneGraphBuild {
  /** The scene root. Add this to a `THREE.Scene`. */
  readonly root: THREE.Group;
  /** Every instance, in scene-array order. */
  readonly instances: readonly InstanceNode[];
  /** `id` → node, for picking and for attaching the gizmo. */
  readonly byId: ReadonlyMap<string, InstanceNode>;
  /** `.glb` references still to be loaded. Never throws out of the build. */
  readonly pendingModels: readonly PendingModel[];
  readonly failures: readonly SceneBuildFailure[];
  /** Instances whose prefab name was not in the registry. */
  readonly unknownPrefabs: readonly string[];
  /** Structured AppErrors emitted during scene building. */
  readonly errors: readonly AppError[];
}

/** The prefab registry as the viewport consumes it: by name. */
export type PrefabIndex = ReadonlyMap<string, PrefabDefinition>;

/**
 * Build a name→prefab index from an array.
 *
 * Unlike core's `indexPrefabs`, a duplicate here is *reported* rather than
 * thrown: the viewport's contract is that a registry problem costs one row in
 * the problems list, not the whole screen.
 */
export function indexPrefabDefinitions(
  prefabs: readonly PrefabDefinition[],
): { index: PrefabIndex; failures: SceneBuildFailure[] } {
  const index: Map<string, PrefabDefinition> = new Map();
  const failures: SceneBuildFailure[] = [];

  for (const prefab of prefabs) {
    if (index.has(prefab.name)) {
      failures.push({
        id: `<registry:${prefab.name}>`,
        prefab: prefab.name,
        kind: 'unknown-prefab',
        message:
          `Prefab "${prefab.name}" is defined more than once in the registry; ` +
          'the first definition is used and the duplicate is ignored.',
      });
      continue;
    }
    index.set(prefab.name, prefab);
  }

  return { index, failures };
}

/**
 * Is this value something we can put in a scene graph?
 *
 * A prefab is typed as returning `unknown`, because core must not depend on
 * Three.js (R3). A prefab written against a *different* copy of Three — or a
 * plain `{ position: [1,2,3] }` — is the most likely way `create` "succeeds"
 * while returning something unusable. Checking here gives a placeholder and a
 * message instead of a `TypeError` from deep inside `Group.add`.
 */
function isObject3D(value: unknown): value is THREE.Object3D {
  return value instanceof THREE.Object3D;
}

/** Format an unknown thrown value as a sentence rather than "undefined". */
function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) {
    return thrown.message;
  }
  return typeof thrown === 'string' ? thrown : JSON.stringify(thrown) ?? String(thrown);
}

/**
 * The `three` module handed to a prefab.
 *
 * A prefab receives the module rather than importing it (SPEC §4.4), so the
 * module is passed explicitly and typed as `ThreeModule` — the structural
 * shape core knows about, which the real Three namespace satisfies.
 */
const THREE_AS_MODULE = THREE as unknown as ThreeModule;

/** One created instance, before the hierarchy is linked. */
interface PendingInstance {
  readonly node: InstanceNode;
  readonly instance: SceneInstance;
}

/**
 * Build the scene graph for a validated scene file.
 *
 * Never throws for a bad prefab, a missing prefab, a missing parent or a broken
 * `.glb` reference — those are all reported in `failures` / `pendingModels`.
 */
export function buildSceneGraph(scene: SceneFile, registry: PrefabIndex): SceneGraphBuild {
  const failures: SceneBuildFailure[] = [];
  const errors: AppError[] = [];
  const pendingModels: PendingModel[] = [];
  const pending: PendingInstance[] = [];

  for (const instance of scene.instances) {
    const prefab = registry.get(instance.prefab) ?? getRegisteredPrefab(instance.prefab);

    if (prefab === undefined) {
      const message =
        `Instance "${instance.id}" refers to prefab "${instance.prefab}", which is not in the registry. ` +
        `Registered prefabs: ${[...registry.keys()].join(', ') || '(none)'}.`;
      const appError = createAppError({
        scope: 'instance',
        instanceId: instance.id,
        short: `Instance "${instance.id}" refers to unknown prefab "${instance.prefab}"`,
        details: message,
      });
      failures.push({
        id: instance.id,
        prefab: instance.prefab,
        kind: 'unknown-prefab',
        message,
        appError,
      });
      errors.push(appError);
      const marker = placeholderFor(instance, `prefab "${instance.prefab}" is not registered`);
      marker.userData['appError'] = appError;
      pending.push({
        node: {
          id: instance.id,
          prefab: instance.prefab,
          object: marker,
          parts: {},
          placeholder: true,
        },
        instance,
      });
      continue;
    }

    let object: THREE.Object3D;
    let parts: Record<string, unknown>;
    try {
      if (typeof (prefab as Partial<PrefabDefinition>).create !== 'function') {
        throw new Error(`Prefab "${prefab.name}" has no create() function`);
      }
      // Per-instance stream (R7): a prefab with randomness places the same
      // scatter every time, and differently per placement.
      const result = prefab.create(THREE_AS_MODULE, instance.params, rngFor(scene.seed, instance.id));

      if (!isObject3D(result.object)) {
        throw new Error(
          `Prefab "${prefab.name}" returned ${result.object === null ? 'null' : typeof result.object} ` +
            'from create() instead of a Three.js Object3D',
        );
      }
      object = result.object;
      parts = result.parts ?? {};
    } catch (thrown) {
      const message = describeThrown(thrown);
      const appError = createAppError({
        scope: 'instance',
        instanceId: instance.id,
        short: `Prefab "${prefab.name}" threw while creating instance "${instance.id}": ${message}`,
        details: thrown instanceof Error ? (thrown.stack ?? thrown.message) : message,
      });
      failures.push({
        id: instance.id,
        prefab: instance.prefab,
        kind: 'prefab-threw',
        message: `Prefab "${prefab.name}" threw while creating instance "${instance.id}": ${message}`,
        appError,
      });
      errors.push(appError);
      const marker = placeholderFor(instance, `prefab threw: ${message}`);
      marker.userData['appError'] = appError;
      pending.push({
        node: {
          id: instance.id,
          prefab: instance.prefab,
          object: marker,
          parts: {},
          placeholder: true,
        },
        instance,
      });
      continue;
    }

    applyTransform(object, instance);
    object.visible = instance.visible ?? true;
    object.name = instance.name ?? instance.id;
    object.userData['cfInstanceId'] = instance.id;
    object.userData['cfPlaceholder'] = false;

    const model = instance.model;
    if (model !== undefined && model !== '') {
      pendingModels.push({ id: instance.id, path: model, object });
    }

    pending.push({ node: { id: instance.id, prefab: instance.prefab, object, parts, placeholder: false }, instance });
  }

  // Second pass: linking the hierarchy. Order-independent by construction.
  const byId = new Map<string, InstanceNode>();
  for (const entry of pending) {
    byId.set(entry.node.id, entry.node);
  }

  const root = new THREE.Group();
  root.name = `scene:${scene.name}`;

  for (const entry of pending) {
    const parentId = entry.instance.parent;
    if (parentId === undefined || parentId === '') {
      root.add(entry.node.object);
      continue;
    }

    const parent = byId.get(parentId);
    if (parent === undefined) {
      failures.push({
        id: entry.node.id,
        prefab: entry.node.prefab,
        kind: 'dangling-parent',
        message:
          `Instance "${entry.node.id}" names parent "${parentId}", which is not an instance in this scene. ` +
          'It has been placed at the scene root instead.',
      });
      root.add(entry.node.object);
      continue;
    }

    parent.object.add(entry.node.object);
  }

  // The schema already refuses cycles, but a scene read from a partially
  // corrupted file could still contain one. `Object3D.add` handles it by
  // silently reparenting, which leaves the pair detached from the root and
  // invisible — so cycles are found by walking *up* from each instance rather
  // than down from the root, which cannot reach them.
  detectCycles(root, pending.map((entry) => entry.node), failures);

  // The hierarchy is only usable once world matrices agree with it.
  //
  // `Object3D.add` and `position.set` both mark the matrix dirty but do not
  // recompute it, and a `Raycaster` reads `matrixWorld` as it stands. Without
  // this call a freshly built graph raycasts every instance at the origin, so a
  // click selects whatever happened to be first rather than what was clicked.
  // The renderer would fix it on the next frame, which is exactly why the bug
  // only shows up in a headless test — and why it has to be fixed here.
  root.updateMatrixWorld(true);

  const instances = pending.map((entry) => entry.node);

  return {
    root,
    instances,
    byId,
    pendingModels,
    failures,
    unknownPrefabs: failures.filter((f) => f.kind === 'unknown-prefab' && f.id !== `<registry:${f.prefab}>`).map((f) => f.id),
    errors,
  };
}

/**
 * Apply a scene transform to an instance object.
 *
 * Euler radians, matching `scene.schema.ts`. `position`/`rotation`/`scale` are
 * separate `set` calls rather than a matrix compose so the inspector can read
 * them back without undoing a decomposition.
 */
export function applyTransform(object: THREE.Object3D, instance: SceneInstance): void {
  const { transform } = instance;
  setVec3(object.position, transform.position, `instances.${instance.id}.transform.position`);
  setVec3(object.rotation, transform.rotation, `instances.${instance.id}.transform.rotation`);
  setVec3(object.scale, transform.scale, `instances.${instance.id}.transform.scale`);
}

/** The stand-in box for an instance whose prefab could not produce an object. */
function placeholderFor(instance: SceneInstance, reason: string): THREE.Object3D {
  const marker = createErrorMarker(reason);
  marker.name = `placeholder:${instance.name ?? instance.id}`;
  marker.userData['cfInstanceId'] = instance.id;
  marker.userData['cfPlaceholder'] = true;
  applyTransform(marker, instance);
  marker.visible = instance.visible ?? true;
  return marker;
}

/**
 * Break any cycle in the parent relation, and report it.
 *
 * Walking upward from each instance with a visited set: a node already on the
 * current chain is the one that closed the loop, and it is detached to the root
 * so the rest of the scene stays renderable. Walking *down* from the root would
 * not find a cycle at all — a cycle is by definition unreachable from the root.
 */
function detectCycles(
  root: THREE.Group,
  instances: readonly InstanceNode[],
  failures: SceneBuildFailure[],
): void {
  for (const node of instances) {
    const chain = new Set<THREE.Object3D>();
    let current: THREE.Object3D | null = node.object;

    while (current !== null) {
      if (chain.has(current)) {
        const cycleStartId = current.userData['cfInstanceId'];
        failures.push({
          id: node.id,
          prefab: node.prefab,
          kind: 'dangling-parent',
          message:
            `Instance "${node.id}" takes its parent chain through "${String(cycleStartId)}" twice, ` +
            'so the parent relation is a cycle. It has been placed at the scene root instead.',
        });
        current.parent?.remove(current);
        root.add(current);
        break;
      }

      chain.add(current);
      current = current.parent;
    }
  }
}
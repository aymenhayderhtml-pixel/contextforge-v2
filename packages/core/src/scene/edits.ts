/**
 * scene/edits.ts — scene edits, each returning a new scene (SPEC §5 Step 2).
 *
 * Every operation here is **pure**: it takes a scene and returns a new one, and
 * never writes. That is what makes the Modeling screen's undo trivial and what
 * lets a caller apply a batch of edits and validate once at the end.
 *
 * The 20-step history lives in `history/history.ts` and is reused, not
 * reimplemented. `applySceneEdit` is the bridge: it runs the pure operation,
 * writes the file through `saveScene`, and records one transaction — so
 * "move the crate", which changes one line of one file, is one undo step and
 * not a special case (SPEC D5/D6).
 *
 * Why new scenes rather than in-place mutation: an edit that half-applies leaves
 * a scene that is neither the old one nor the new one, and the developer has no
 * way back. Returning a new value makes a failed edit a failed call.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getHistoryStatus,
  normalizeProjectPath,
  recordHistoryStep,
  undo as undoHistory,
  redo as redoHistory,
  type HistoryActionResult,
  type HistoryStatus,
} from '../history/history.js';
import { saveScene, serializeScene } from './sceneFile.js';
import type { SlotValidator, SlotVerdict } from './slots.js';
import {
  IDENTITY_TRANSFORM,
  type JsonValue,
  type SceneFile,
  type SceneInstance,
  type Transform,
  type Vec3,
} from './scene.schema.js';

/**
 * A 3-component vector, or a partial one to be merged into the existing.
 *
 * Mutable rather than `readonly` because the result is assigned straight into
 * a `Transform`, whose Zod-inferred vectors are mutable arrays. Accepting a
 * readonly tuple and widening it would hide the copy.
 */
export type Vec3Input = [number, number, number];

/** A transform change: any subset, absent parts keep their current value. */
export interface TransformPatch {
  position?: Vec3Input | undefined;
  rotation?: Vec3Input | undefined;
  scale?: Vec3Input | undefined;
}

/** What to add when placing a new instance. */
export interface NewInstance {
  id: string;
  prefab: string;
  transform?: Partial<Transform> | undefined;
  params?: Record<string, JsonValue> | undefined;
  model?: string | undefined;
  parent?: string | undefined;
  name?: string | undefined;
  visible?: boolean | undefined;
  locked?: boolean | undefined;
}

/** The result of a pure edit. */
export interface EditResult {
  /** The edited scene. Valid on success; the same value on failure. */
  scene: SceneFile;
  ok: boolean;
  /** Present only on failure, naming the instance and the reason. */
  error?: string | undefined;
}

function fail(scene: SceneFile, error: string): EditResult {
  return { scene, ok: false, error };
}

function findIndex(scene: SceneFile, id: string): number {
  return scene.instances.findIndex((instance) => instance.id === id);
}

/** Copy an instance with a merged transform. */
function withTransform(instance: SceneInstance, patch: TransformPatch): SceneInstance {
  return {
    ...instance,
    transform: {
      position: patch.position ?? instance.transform.position,
      rotation: patch.rotation ?? instance.transform.rotation,
      scale: patch.scale ?? instance.transform.scale,
    },
  };
}

/**
 * Move, rotate and/or scale an instance.
 *
 * Absent components keep their current value, so "nudge the crate up by two"
 * is `setTransform(scene, 'crate', { position: [0, 2, 0] })` — and the other
 * two components are not silently reset to zero, which is the mistake this
 * signature exists to prevent.
 */
export function setTransform(
  scene: SceneFile,
  instanceId: string,
  patch: TransformPatch,
): EditResult {
  const index = findIndex(scene, instanceId);
  if (index === -1) return fail(scene, `no instance with id "${instanceId}"`);

  const current = scene.instances[index];
  if (current === undefined) return fail(scene, `no instance with id "${instanceId}"`);

  const instances = [...scene.instances];
  instances[index] = withTransform(current, patch);

  return { scene: { ...scene, instances }, ok: true };
}

/**
 * Swap an instance's model asset.
 *
 * A swap that passes the scene's own checks can still be the failure SPEC §1
 * names: `character.glb` replaced by an unrigged mesh with no `idle` clip, which
 * loads cleanly and then animates as a statue. So a caller may pass a
 * **slot validator**; if it is absent the behaviour is exactly what it was
 * before — the scene checks alone, nothing more (SPEC R8: a default must not
 * start refusing edits nobody asked it to refuse).
 *
 * The validator receives only the candidate path. That keeps this function
 * pure — it still writes nothing, and it needs no project root, no slot
 * registry and no filesystem access of its own. `scene/slots.ts` provides both
 * the validator and `instanceSlotValidator`, which derives the expectations
 * from the instance's current model.
 *
 * On a rejection the scene is returned unchanged and `error` is the
 * validator's joined reasons. Returning rather than throwing is deliberate:
 * this is a message to the developer, not an exception (SPEC R9).
 */
export function swapModel(
  scene: SceneFile,
  instanceId: string,
  model: string,
  validator?: SlotValidator,
): EditResult {
  const index = findIndex(scene, instanceId);
  if (index === -1) return fail(scene, `no instance with id "${instanceId}"`);
  if (model.trim() === '') return fail(scene, 'model path must not be empty');

  const current = scene.instances[index];
  if (current === undefined) return fail(scene, `no instance with id "${instanceId}"`);

  // A validator that throws is treated as a refusal rather than allowed to
  // escape: an unreadable asset must not crash the Modeling screen.
  if (validator !== undefined) {
    let verdict: SlotVerdict | undefined;
    try {
      verdict = validator(model);
    } catch (error) {
      return fail(
        scene,
        `could not validate "${model}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!verdict.ok) {
      return fail(
        scene,
        verdict.reason === '' ? `"${model}" does not satisfy the slot contract` : verdict.reason,
      );
    }
  }

  const instances = [...scene.instances];
  instances[index] = { ...current, model };

  return { scene: { ...scene, instances }, ok: true };
}

/**
 * Place a new instance.
 *
 * The id is checked for uniqueness here rather than left to the schema, so the
 * error names the *clash* rather than a bare "invalid scene" from a later
 * validation pass.
 */
export function addInstance(scene: SceneFile, input: NewInstance): EditResult {
  if (findIndex(scene, input.id) !== -1) {
    return fail(scene, `instance id "${input.id}" is already used in this scene`);
  }

  const transform: Transform = {
    position: input.transform?.position ?? IDENTITY_TRANSFORM.position,
    rotation: input.transform?.rotation ?? IDENTITY_TRANSFORM.rotation,
    scale: input.transform?.scale ?? IDENTITY_TRANSFORM.scale,
  };

  const instance: SceneInstance = {
    id: input.id,
    prefab: input.prefab,
    transform,
    params: input.params ?? {},
    ...(input.parent !== undefined ? { parent: input.parent } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.visible !== undefined ? { visible: input.visible } : {}),
    ...(input.locked !== undefined ? { locked: input.locked } : {}),
  };

  return { scene: { ...scene, instances: [...scene.instances, instance] }, ok: true };
}

/**
 * Remove an instance, and re-parent anything that pointed at it.
 *
 * The re-parent is the part worth reading twice. Deleting the cube out from
 * under a stack of coins would otherwise leave three instances naming a parent
 * that no longer exists — a scene that fails to load. Children are moved to
 * the removed instance's own parent, so the hierarchy is preserved rather than
 * flattened to the root.
 */
export function removeInstance(scene: SceneFile, instanceId: string): EditResult {
  const index = findIndex(scene, instanceId);
  if (index === -1) return fail(scene, `no instance with id "${instanceId}"`);

  const removed = scene.instances[index];
  if (removed === undefined) return fail(scene, `no instance with id "${instanceId}"`);

  const newParent = removed.parent;
  const instances: SceneInstance[] = [];

  scene.instances.forEach((instance) => {
    if (instance.id === instanceId) return;
    if (newParent !== undefined && instance.parent === instanceId) {
      instances.push({ ...instance, parent: newParent });
      return;
    }
    instances.push(instance);
  });

  return { scene: { ...scene, instances }, ok: true };
}

/**
 * Merge params into an instance.
 *
 * A merge rather than a replace, because the common case is "the AI changed one
 * param of a prefab that has five". `params: {}` on an instance means "use all
 * prefab defaults", and a replace-with-{} would quietly reset every other
 * param. Pass `replace: true` to overwrite wholesale.
 */
export function setParams(
  scene: SceneFile,
  instanceId: string,
  params: Record<string, JsonValue>,
  options: { replace?: boolean } = {},
): EditResult {
  const index = findIndex(scene, instanceId);
  if (index === -1) return fail(scene, `no instance with id "${instanceId}"`);

  const current = scene.instances[index];
  if (current === undefined) return fail(scene, `no instance with id "${instanceId}"`);

  const merged = options.replace === true ? params : { ...current.params, ...params };
  const instances = [...scene.instances];
  instances[index] = { ...current, params: merged };

  return { scene: { ...scene, instances }, ok: true };
}

/** The pure edit operations, keyed by name — the surface `applySceneEdit` uses. */
export const SCENE_EDITS = {
  setTransform,
  swapModel,
  addInstance,
  removeInstance,
  setParams,
} as const;

/** The name of any scene edit operation. */
export type SceneEditName = keyof typeof SCENE_EDITS;

/**
 * An edit request, as a discriminated union.
 *
 * `swapModel` carries an optional `validator` so a caller going through
 * `applySceneEdit` — the path that writes to disk — gets the same slot check as
 * one calling `swapModel` directly. Without it the written scene and the
 * checked scene would be different scenes.
 */
export type SceneEdit =
  | { op: 'setTransform'; instanceId: string; patch: TransformPatch }
  | { op: 'swapModel'; instanceId: string; model: string; validator?: SlotValidator | undefined }
  | { op: 'addInstance'; input: NewInstance }
  | { op: 'removeInstance'; instanceId: string }
  | { op: 'setParams'; instanceId: string; params: Record<string, JsonValue>; replace?: boolean };

/** Run a pure edit against a scene. */
export function applyEdit(scene: SceneFile, edit: SceneEdit): EditResult {
  switch (edit.op) {
    case 'setTransform':
      return setTransform(scene, edit.instanceId, edit.patch);
    case 'swapModel':
      return swapModel(scene, edit.instanceId, edit.model, edit.validator);
    case 'addInstance':
      return addInstance(scene, edit.input);
    case 'removeInstance':
      return removeInstance(scene, edit.instanceId);
    case 'setParams':
      return setParams(scene, edit.instanceId, edit.params, { replace: edit.replace ?? false });
    default: {
      // Exhaustiveness: adding an op to the union without a branch here is a
      // compile error rather than a silent no-op.
      const never: never = edit;
      throw new Error(`Unknown scene edit: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Apply an edit, write it, and record one undo step.
 *
 * `scenePath` is **project-relative** (`scenes/Level1.scene.json`), not
 * absolute. That is the same convention `captureAndWrite` and `recordHistoryStep`
 * use, and it is required rather than stylistic: history resolves a change's
 * `path` against the project root when it undoes, so an absolute path would be
 * joined onto the project root and undo would write a file nobody is looking at
 * — undo appearing to do nothing while the scene on disk stayed edited.
 *
 * `now` is injected so tests get stable ids and timestamps (SPEC R8/D8).
 *
 * `options.readFile` exists only so a test can supply the previous content
 * without a file. The default reads the real file: recording `before: null`
 * for a file that exists would make undo **delete** it (SPEC D6), which is data
 * loss caused by a default rather than by anything the caller did wrong.
 *
 * On failure nothing is written and nothing is recorded: a refused edit must
 * not leave an undo step that appears to do nothing when pressed.
 */
export function applySceneEdit(
  projectPath: string,
  scenePath: string,
  scene: SceneFile,
  edit: SceneEdit,
  options: { readFile?: () => string | null; now?: number } = {},
): EditResult & { patchId?: string | undefined } {
  const result = applyEdit(scene, edit);
  if (!result.ok) return result;

  const absolutePath = join(normalizeProjectPath(projectPath), scenePath);

  const read = options.readFile ?? ((): string | null => readFileIfPresent(absolutePath));
  const before = read();
  const after = serializeScene(result.scene);

  if (before === after) {
    return { ...result, patchId: undefined };
  }

  // `saveScene` re-validates, which is what guarantees the file on disk is
  // always a scene that would load. An edit can pass every local check and
  // still break an invariant — adding an instance under a parent that does not
  // exist is the clear case — so the write is attempted inside a try and the
  // failure is returned as a refusal rather than thrown.
  //
  // Throwing here would be worse than returning: the caller is the Modeling
  // screen mid-interaction, and an exception across the UI boundary for a
  // condition the developer caused is not an error, it is a message.
  try {
    saveScene(absolutePath, result.scene);
  } catch (error) {
    return {
      scene,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const step = recordHistoryStep(
    projectPath,
    describeEdit(edit),
    [{ path: scenePath, before, after }],
    { op: edit.op },
    options.now ?? Date.now(),
  );

  return { ...result, patchId: step?.patchId };
}

/** The file's current content, or `null` when it does not exist yet. */
function readFileIfPresent(filePath: string): string | null {
  return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
}

/** A human-readable label for an edit, used as the undo description. */
function describeEdit(edit: SceneEdit): string {
  switch (edit.op) {
    case 'setTransform':
      return `Move ${edit.instanceId}`;
    case 'swapModel':
      return `Swap model of ${edit.instanceId}`;
    case 'addInstance':
      return `Add ${edit.input.prefab} "${edit.input.id}"`;
    case 'removeInstance':
      return `Remove ${edit.instanceId}`;
    case 'setParams':
      return `Set params of ${edit.instanceId}`;
    default:
      return 'Scene edit';
  }
}

/** Undo the most recent scene edit. */
export function undoSceneEdit(projectPath: string): HistoryActionResult {
  return undoHistory(projectPath);
}

/** Redo the most recently undone scene edit. */
export function redoSceneEdit(projectPath: string): HistoryActionResult {
  return redoHistory(projectPath);
}

/** Whether a scene edit can be undone, and what the next one is. */
export function sceneHistoryStatus(projectPath: string): HistoryStatus {
  return getHistoryStatus(projectPath);
}

// Re-exported so a caller building a new instance does not need a second import
// for the identity transform.
export { IDENTITY_TRANSFORM };
export type { SceneFile, Transform, Vec3 };

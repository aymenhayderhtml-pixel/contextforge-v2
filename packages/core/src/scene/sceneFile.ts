/**
 * scene/sceneFile.ts — validate, load and save `scene.json`.
 *
 * The schema in `scene.schema.ts` covers shape. The rules that need the whole
 * file — unique instance ids, a parent that exists, a parent chain that
 * terminates — live here, because Zod expresses them as a refinement over the
 * parsed document rather than as field types.
 *
 * Two behaviours are load-bearing and worth stating plainly:
 *
 *  - **Loading validates, and refuses.** An invalid scene throws with the JSON
 *    path of every problem, not the first one. A developer who fixed three
 *    typos should not have to re-run the tool three times to find the third
 *    (SPEC R9).
 *  - **Saving validates before it writes.** A scene produced by an edit
 *    operation that broke an invariant never reaches disk, so the file on disk
 *    is always a scene that would load.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sceneFileSchema, type SceneFile } from './scene.schema.js';

/** One problem found in a scene, located precisely enough to fix by hand. */
export interface SceneError {
  /** JSON path, e.g. `instances[3].transform.position` or `version`. */
  path: string;
  message: string;
}

/** The outcome of validating scene data. */
export interface SceneValidationResult {
  valid: boolean;
  errors: SceneError[];
  /** Present only when `valid` is true. */
  data?: SceneFile | undefined;
}

/**
 * Render a Zod path as a JSON path string.
 *
 * Zod's `path` is a mix of strings and numbers; a number is an array index and
 * a string is a key. Numbers become `[n]`, and the first key is written bare
 * so paths read as `instances[0].id` rather than `.instances[0].id`. An empty
 * path is the root, named `(root)`.
 */
function formatPath(path: ReadonlyArray<string | number>): string {
  if (path.length === 0) return '(root)';

  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else if (out === '') {
      out = segment;
    } else {
      out += `.${segment}`;
    }
  }
  return out;
}

/**
 * Validate unknown data as a `SceneFile`.
 *
 * Never throws: callers that want a value use `parseScene`, which does.
 */
export function validateScene(data: unknown): SceneValidationResult {
  const shape = sceneFileSchema.safeParse(data);

  if (!shape.success) {
    return {
      valid: false,
      errors: shape.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      })),
    };
  }

  const crossErrors = checkRelations(shape.data);
  if (crossErrors.length > 0) {
    return { valid: false, errors: crossErrors };
  }

  return { valid: true, errors: [], data: shape.data };
}

/**
 * Rules that need every instance to be seen at once.
 *
 * Kept out of the Zod schema because each is a statement about the *set* of
 * instances rather than about any one field, and because reporting them with
 * the same `path`/`message` shape as a shape error keeps the caller's error
 * rendering trivial.
 */
function checkRelations(scene: SceneFile): SceneError[] {
  const errors: SceneError[] = [];

  const indexById = new Map<string, number>();
  scene.instances.forEach((instance, index) => {
    const existing = indexById.get(instance.id);
    if (existing !== undefined) {
      errors.push({
        path: `instances[${index}].id`,
        message: `duplicate instance id "${instance.id}" — first defined at instances[${existing}]. Ids must be unique within a scene`,
      });
      return;
    }
    indexById.set(instance.id, index);
  });

  scene.instances.forEach((instance, index) => {
    if (instance.parent === undefined) return;

    if (instance.parent === instance.id) {
      errors.push({
        path: `instances[${index}].parent`,
        message: `instance "${instance.id}" parents itself`,
      });
      return;
    }

    if (!indexById.has(instance.parent)) {
      errors.push({
        path: `instances[${index}].parent`,
        message: `parent "${instance.parent}" does not exist — no instance has that id`,
      });
      return;
    }

    // Walk up from this instance. A path that revisits an id (other than the
    // start, already handled) is a cycle. Bounded by the instance count so a
    // malformed file cannot spin here.
    const seen = new Set<string>([instance.id]);
    let current: string | undefined = instance.parent;
    while (current !== undefined) {
      if (seen.has(current)) {
        errors.push({
          path: `instances[${index}].parent`,
          message: `parent chain from "${instance.id}" is a cycle through "${current}" — a scene's parent relation must be a tree`,
        });
        return;
      }
      seen.add(current);
      const parentIndex = indexById.get(current);
      current = parentIndex === undefined ? undefined : scene.instances[parentIndex]?.parent;
    }
  });

  const lightIds = new Set<string>();
  scene.lights.forEach((light, index) => {
    if (lightIds.has(light.id)) {
      errors.push({
        path: `lights[${index}].id`,
        message: `duplicate light id "${light.id}" — light ids must be unique within a scene`,
      });
    }
    lightIds.add(light.id);
  });

  return errors;
}

/** Validate scene data and return it, or throw naming every problem. */
export function parseScene(data: unknown, sourceLabel = 'scene'): SceneFile {
  const result = validateScene(data);
  if (!result.valid || result.data === undefined) {
    const detail = result.errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n');
    throw new Error(`${sourceLabel} is not a valid scene:\n${detail}`);
  }
  return result.data;
}

/**
 * Read and validate a `scene.json` from disk.
 *
 * `null` when the file does not exist, because "the project has no scene yet" is
 * a normal state for a new template and not an error. Every *other* problem
 * throws: a file that exists and is invalid is a bug or a bad AI edit, and
 * silently starting from an empty scene would discard the developer's work
 * (SPEC R9).
 */
export function loadScene(filePath: string): SceneFile | null {
  if (!existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new Error(
      `Could not read scene at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Scene at ${filePath} is not valid JSON: ${detail}`);
  }

  return parseScene(data, `Scene at ${filePath}`);
}

/**
 * Validate and write a scene.
 *
 * Validation happens *before* the write, so an invalid scene never lands on
 * disk. The file is written with 2-space indent and a trailing newline so it
 * stays readable and diffable between AIs (SPEC R8) — the alternative, a
 * minified single line, produces a one-line diff for any change at all.
 *
 * Key order is made explicit rather than left to insertion order, so a scene
 * round-trips byte-identically. See `orderedScene` below.
 */
export function saveScene(filePath: string, scene: SceneFile): void {
  // Re-validate on the way out. A caller holding a `SceneFile` type can still
  // have built it by hand with a duplicate id; the file is the boundary, so it
  // is checked here.
  const valid = parseScene(scene, `Scene for ${filePath}`);

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, serializeScene(valid), 'utf-8');
}

/**
 * Serialise a scene to its canonical text form.
 *
 * Keys are emitted in a fixed order and instances in their existing array
 * order, so saving an unmodified scene produces byte-identical output. That is
 * what makes `save → load → save` a no-op on disk, which the round-trip test
 * asserts and which a diff-friendly scene file depends on.
 */
export function serializeScene(scene: SceneFile): string {
  const ordered = {
    version: scene.version,
    name: scene.name,
    engine: scene.engine,
    seed: scene.seed,
    instances: scene.instances.map((instance) => {
      const out: Record<string, unknown> = { id: instance.id, prefab: instance.prefab };
      if (instance.name !== undefined) out['name'] = instance.name;
      if (instance.parent !== undefined) out['parent'] = instance.parent;
      out['transform'] = {
        position: instance.transform.position,
        rotation: instance.transform.rotation,
        scale: instance.transform.scale,
      };
      out['params'] = instance.params;
      if (instance.model !== undefined) out['model'] = instance.model;
      if (instance.visible !== undefined) out['visible'] = instance.visible;
      if (instance.locked !== undefined) out['locked'] = instance.locked;
      return out;
    }),
    lights: scene.lights.map((light) => {
      const out: Record<string, unknown> = { id: light.id, kind: light.kind };
      // `color` and `intensity` are required, so they come first by position.
      out['color'] = light.color;
      out['intensity'] = light.intensity;
      for (const key of ['position', 'distance', 'angle', 'castShadow'] as const) {
        const value = light[key];
        if (value !== undefined) out[key] = value;
      }
      return out;
    }),
    camera: (() => {
      const camera = scene.camera;
      const out: Record<string, unknown> = { kind: camera.kind };
      out['position'] = camera.position;
      out['rotation'] = camera.rotation;
      for (const key of ['fov', 'near', 'far', 'orthoSize'] as const) {
        const value = camera[key];
        if (value !== undefined) out[key] = value;
      }
      return out;
    })(),
  };

  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** A minimal valid scene, used as the starting point for a new project. */
export function emptyScene(name: string, seed = 0): SceneFile {
  return {
    version: 1,
    name,
    engine: 'three',
    seed,
    instances: [],
    lights: [
      {
        id: 'default-light',
        kind: 'ambient',
        color: '#ffffff',
        intensity: 1,
      },
    ],
    camera: {
      kind: 'perspective',
      position: [0, 5, 10],
      rotation: [-0.3, 0, 0],
      fov: 60,
      near: 0.1,
      far: 1000,
    },
  };
}

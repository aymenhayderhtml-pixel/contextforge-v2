/**
 * scene/prefabs/index.ts — the prefab registry (SPEC §4.4).
 *
 * A scene is data. Something has to turn that data into objects, and this is
 * the contract for it. Three things are fixed here, and all three exist because
 * something is injected rather than reached for:
 *
 *  - **`three` is a parameter.** A prefab does not `import * as THREE`. If it
 *    did, the registry would drag the whole of Three.js into every consumer
 *    including headless ones, and a prefab could not be exercised with a stub.
 *  - **`rng` is a parameter.** Randomness is seeded, so a scene is reproducible
 *    and therefore diffable (SPEC R7).
 *  - **The result is data, not a side effect.** `create` returns
 *    `{ object, parts }` and never calls `scene.add`. The caller composes. A
 *    prefab that added itself to the scene would be impossible to place twice
 *    and impossible to test in isolation.
 *
 * `parts` is a named map rather than a tree walk because the Modeling screen
 * needs to select "the left door" without knowing the object's internal
 * structure — and because a prefab is free to nest however it likes.
 *
 * The types here are deliberately loose about `three`: core must not depend on
 * Three.js (SPEC R3 — it is a headless package with no GPU), so `ThreeModule`
 * is the module's *shape* as far as a prefab is concerned, and a concrete
 * Three.js build satisfies it structurally.
 */

import type { z } from 'zod';
import type { JsonValue, SceneFile } from '../scene.schema.js';
import type { Rng } from '../rng.js';

/**
 * The part of the Three.js module a prefab may use.
 *
 * A prefab that needs a type from deep inside Three.js — `BufferGeometry`, say
 * — can widen this locally. The point is that `create` receives the module, so
 * a test can pass a stub and assert the shape of the output without a GPU.
 */
export interface ThreeModule {
  // Constructors and namespaces a prefab plausibly needs. Intentionally
  // minimal: a prefab that needs more declares what it needs.
  Object3D: unknown;
  Group: unknown;
  Mesh: unknown;
  MeshStandardMaterial: unknown;
  MeshBasicMaterial: unknown;
  BoxGeometry: unknown;
  SphereGeometry: unknown;
  CylinderGeometry: unknown;
  PlaneGeometry: unknown;
  [key: string]: unknown;
}

/** A sub-object a prefab exposes for selection and per-part editing. */
export type PrefabParts = Record<string, unknown>;

/** What `create` returns: the root object plus its named parts. */
export interface PrefabInstance {
  object: unknown;
  parts: PrefabParts;
}

/**
 * The parameter map a prefab was created with.
 *
 * `JsonValue`-constrained because the values came out of `scene.json`, and a
 * prefab that wants a richer type validates and narrows it against its own
 * `paramsSchema` — which is why the schema is part of the registry entry.
 */
export type PrefabParams = Record<string, JsonValue>;

/** A registry entry, as exported by each prefab module. */
export interface PrefabDefinition {
  /** The name a scene's `instances[].prefab` refers to. Must be unique. */
  name: string;
  /**
   * Build the object graph.
   *
   * Pure: no `this`, no globals, no `scene.add`. The lint in `scene/lint.ts`
   * enforces this structurally rather than trusting the signature.
   */
  create(three: ThreeModule, params: PrefabParams, rng: Rng): PrefabInstance;
  /**
   * The prefab's own param contract.
   *
   * Validated at the boundary, so an AI's bad `params` in `scene.json` is
   * reported against the offending param rather than reaching Three.js and
   * producing a silently wrong object.
   */
  paramsSchema: z.ZodType<PrefabParams>;
  /** One line, for the registry listing an AI reads. */
  description?: string | undefined;
}

/**
 * A named set of prefabs.
 *
 * `prefabs/index.ts` in a generated project exports this shape. The type lives
 * in core so the template generator, the lint and the viewer all agree on what
 * a registry is without any of them importing a generated project.
 */
export interface PrefabRegistry {
  prefabs: PrefabDefinition[];
}

/**
 * Index a registry by name, failing loudly on a duplicate.
 *
 * A duplicate name is refused rather than resolved last-wins: which prefab a
 * scene instance gets would then depend on file order, and two AIs editing the
 * same project would place different things in the same slot (SPEC R8/R9).
 */
export function indexPrefabs(registry: PrefabRegistry): Map<string, PrefabDefinition> {
  const index = new Map<string, PrefabDefinition>();

  for (const prefab of registry.prefabs) {
    const existing = index.get(prefab.name);
    if (existing !== undefined) {
      throw new Error(
        `Duplicate prefab name "${prefab.name}" in the registry — ` +
          `already defined by a module that also exports that name. Prefab names must be unique.`,
      );
    }
    index.set(prefab.name, prefab);
  }

  return index;
}

/**
 * Validate a scene's instance params against the registered prefabs.
 *
 * Returns one error per bad instance rather than stopping at the first, each
 * naming the JSON path. An unknown prefab name is reported as such rather than
 * skipped, because a scene referencing a prefab that does not exist cannot be
 * rendered and must not be presented as valid.
 */
export function validateScenePrefabs(
  scene: SceneFile,
  registry: PrefabRegistry,
): Array<{ path: string; message: string }> {
  const index = indexPrefabs(registry);
  const errors: Array<{ path: string; message: string }> = [];

  scene.instances.forEach((instance, i) => {
    const prefab = index.get(instance.prefab);
    if (prefab === undefined) {
      errors.push({
        path: `instances[${i}].prefab`,
        message: `no registered prefab named "${instance.prefab}" — registered prefabs: ${
          [...index.keys()].join(', ') || '(none)'
        }`,
      });
      return;
    }

    const parsed = prefab.paramsSchema.safeParse(instance.params);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path.map((p) => String(p)).join('.');
        errors.push({
          path: `instances[${i}].params${key === '' ? '' : `.${key}`}`,
          message: `prefab "${prefab.name}": ${issue.message}`,
        });
      }
    }
  });

  return errors;
}

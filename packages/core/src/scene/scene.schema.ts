/**
 * scene/scene.schema.ts — the `scene.json` contract (SPEC §4.2, R6).
 *
 * A scene is **data, not code**. Everything the Modeling screen can change
 * lives in one JSON file, validated with Zod on every read and every write, so
 * a bad edit is caught at the boundary instead of becoming a broken scene.
 *
 * The reader this schema is written for is an AI. That drives three decisions:
 *
 *  - **`.strict()` everywhere.** Zod strips unknown keys by default, which would
 *    silently swallow `postion` instead of `position` — the exact typo an AI
 *    makes, and the one that quietly produces a scene in the wrong place. A
 *    hand-written or AI-written scene therefore fails loudly on a bad key.
 *  - **Cross-field rules live in `superRefine`, not in the field types.** Zod's
 *    tree types cannot express "unique across this array" or "acyclic"; they are
 *    applied after the shape is accepted, and report a JSON path.
 *  - **No silent coercion.** A 2-component position is an error, never padded
 *    to `[x, y, 0]`, because a padded transform looks identical to a correct one
 *    in a 3D view and is wrong in the file.
 *
 * Every error message carries the JSON path it applies to. `zod`'s own
 * `issue.path` is joined into one `objects[3].transform.position` style string,
 * so an error names the exact place in the file rather than saying "invalid
 * scene" (SPEC R9).
 */

import { z } from 'zod';

/**
 * The scene file's shape version.
 *
 * A literal, not a range: a future version is refused rather than read with
 * best-effort defaults, because a v2 schema reading v3 data would quietly
 * discard whatever v3 added. The failure is the point.
 */
export const SCENE_SCHEMA_VERSION = 1;

/** Engines a scene can target. Mirrors the graph's `Engine`. */
export const SCENE_ENGINES = ['three', 'godot'] as const;

/**
 * Any JSON-serialisable value.
 *
 * Recursive by hand rather than via `z.lazy`, because prefab `params` are
 * validated against each prefab's own schema later; this only has to prove the
 * value can be written back to JSON unchanged.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/**
 * A 3-component vector.
 *
 * `length(3)` rather than a fixed tuple so the error can say "expected 3" and
 * name the actual length. A tuple type would say the same thing, but the schema
 * form keeps the message under our control.
 */
const vec3Schema = z
  .array(z.number().finite(), {
    required_error: 'a transform component is required',
  })
  .length(3, 'must have exactly 3 components (x, y, z)');

/**
 * Position, rotation and scale.
 *
 * Always present, never optional: a transform that defaults silently is how a
 * mesh ends up at the origin when the author meant it to be somewhere else.
 * The caller supplies defaults at edit time (`setTransform`), not at read time.
 */
export const transformSchema = z
  .object({
    position: vec3Schema,
    /** Euler angles in radians. */
    rotation: vec3Schema,
    scale: vec3Schema,
  })
  .strict();

/**
 * One placed object.
 *
 * `params` is typed loosely here and validated against the prefab's own
 * `paramsSchema` once the registry is known (SPEC §4.4). Validating it twice
 * would be wrong: the scene file must be loadable for a prefab this runtime
 * does not know about, and failing to load it would make the file unreadable
 * the moment a prefab is removed.
 */
export const sceneInstanceSchema = z
  .object({
    /** Unique within the scene. Cross-checked in `superRefine`. */
    id: z.string().min(1, 'instance id must not be empty'),
    /** Name of a registered prefab (SPEC R7). */
    prefab: z.string().min(1, 'prefab must not be empty'),
    /** Display name; defaults to `id`. */
    name: z.string().optional(),
    /** Another instance's id. Absent means root. Checked for cycles. */
    parent: z.string().optional(),
    transform: transformSchema,
    params: z.record(z.string(), jsonValueSchema).default({}),
    /** Optional model asset path, validated against a slot contract. */
    model: z.string().min(1).optional(),
    visible: z.boolean().optional(),
    /** Blocks AI edits. Honoured by the Modeling screen, not by the schema. */
    locked: z.boolean().optional(),
  })
  .strict();

/** A directional or point light. */
export const sceneLightSchema = z
  .object({
    id: z.string().min(1, 'light id must not be empty'),
    kind: z.enum(['ambient', 'directional', 'point', 'spot', 'hemisphere']),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'must be a 6-digit hex colour, e.g. "#ffffff"'),
    intensity: z.number().finite().min(0, 'intensity must be >= 0'),
    position: vec3Schema.optional(),
    /** Point/spot falloff distance. */
    distance: z.number().finite().min(0).optional(),
    /** Spot light cone angle in radians. */
    angle: z.number().finite().min(0).max(Math.PI).optional(),
    castShadow: z.boolean().optional(),
  })
  .strict();

/** The scene's camera. Exactly one, so a scene cannot render from nowhere. */
export const sceneCameraSchema = z
  .object({
    kind: z.enum(['perspective', 'orthographic']),
    position: vec3Schema,
    /** Euler radians. */
    rotation: vec3Schema,
    fov: z.number().finite().min(1).max(179).optional(),
    near: z.number().finite().min(0).optional(),
    far: z.number().finite().min(0).optional(),
    /** Orthographic half-height, when kind is "orthographic". */
    orthoSize: z.number().finite().min(0).optional(),
  })
  .strict();

/**
 * The whole file.
 *
 * `instances` (not `objects`) because every entry is a *placement of a prefab*,
 * never a free-floating object — the naming is the first place a reader learns
 * that rule, and it matches the registry an AI is scoped against.
 */
export const sceneFileSchema = z
  .object({
    version: z.literal(SCENE_SCHEMA_VERSION, {
      errorMap: () => ({
        message: `must be exactly ${SCENE_SCHEMA_VERSION} — a scene written for a different version is refused, not best-effort read`,
      }),
    }),
    /** Scene id, e.g. "Level1". */
    name: z.string().min(1, 'scene name must not be empty'),
    engine: z.enum(SCENE_ENGINES),
    /** Default randomness seed (SPEC R7). */
    seed: z.number().int().finite(),
    instances: z.array(sceneInstanceSchema),
    lights: z.array(sceneLightSchema).default([]),
    camera: sceneCameraSchema,
  })
  .strict();

export type Transform = z.infer<typeof transformSchema>;
export type SceneInstance = z.infer<typeof sceneInstanceSchema>;
export type SceneLight = z.infer<typeof sceneLightSchema>;
export type SceneCamera = z.infer<typeof sceneCameraSchema>;
export type SceneFile = z.infer<typeof sceneFileSchema>;

/** A 3-component vector, for callers building transforms by hand. */
export type Vec3 = [number, number, number];

/** The identity transform, used as the default for a new instance. */
export const IDENTITY_TRANSFORM: Transform = Object.freeze({
  position: [0, 0, 0] as Vec3,
  rotation: [0, 0, 0] as Vec3,
  scale: [1, 1, 1] as Vec3,
});

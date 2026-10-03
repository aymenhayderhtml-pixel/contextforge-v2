/**
 * fields.ts — deriving the inspector's params form, with no Svelte and no DOM.
 *
 * The inspector renders from `JsonSchema`, not from Zod: Zod is a Node-side
 * dependency and the renderer does not carry it, so the main process converts
 * once (`PrefabSummary.paramsJsonSchema`) and this file turns that into rows.
 *
 * ## What "generated" means here, precisely
 *
 * A row is derived from a *field name and a kind*, and a kind the renderer
 * cannot honour becomes a read-only row with the reason on it. It never becomes
 * a free-text input pretending to be a number — that is how a prefab's `Vec3`
 * param turns into the string `"1,2,3"` in `scene.json`, which the prefab's own
 * schema then rejects at load. An honest "cannot edit this" is better than a
 * control that writes a value the engine will refuse.
 *
 * ## Values come from three places, in this order
 *
 *  1. the instance's own `params` (what the scene actually says),
 *  2. the field's `default` from the prefab's schema,
 *  3. `undefined` — which the row renders as empty rather than as a fabricated
 *     zero. `params: {}` means "use all prefab defaults", and writing a 0 into
 *     it would change the instance without the developer touching anything.
 */

import type { FieldSchema, JsonSchema } from '../../ipc.js';
import type { JsonValue, SceneInstance, Transform, Vec3 } from '@contextforge/core';

/** The three editable vectors of a transform. */
export const VECTOR_AXES = ['x', 'y', 'z'] as const;

/** One axis of one vector. */
export type VectorAxis = (typeof VECTOR_AXES)[number];

/** Which transform vector a row edits. */
export type VectorKey = keyof Transform;

/** The editable input kinds the inspector can actually render. */
export type EditableKind = 'number' | 'string' | 'boolean' | 'select';

/** What a rendered row knows about itself. */
export interface FormField {
  /** The key in `params`, verbatim from the schema. */
  readonly name: string;
  /** A human label: the schema's `title`, or the name if the title is blank. */
  readonly title: string;
  readonly required: boolean;
  /**
   * The control to render.
   *
   * `'unsupported'` is a first-class kind rather than an early return, so a
   * renderer that forgot to handle it fails the type check instead of dropping
   * the field silently.
   */
  readonly kind: EditableKind | 'unsupported';
  /** Why an unsupported field cannot be edited. Empty for editable kinds. */
  readonly reason: string;
  /** The value to show, already defaulted. `null` for unsupported. */
  readonly value: JsonValue | null;
  /** Number bounds, when the schema declares them. */
  readonly min: number | null;
  readonly max: number | null;
  /**
   * True when `min` is an *exclusive* bound — Zod's `.positive()` and friends.
   *
   * Carried rather than collapsed into `min`, because dropping it is what let
   * the inspector accept `width: 0` while the game's own schema refused it:
   * without this slot the exclusive fact is gone before anything can act on it,
   * and the two halves of one rule disagree (D26). `min` still carries the bound
   * value, so a renderer that ignores this flag shows the same control as before.
   */
  readonly exclusiveMin: boolean;
  /** Choices, for a `select`. Empty for other kinds. */
  readonly options: readonly string[];
  /** The prefab's own default, for a "reset to default" affordance. */
  readonly hasDefault: boolean;
  readonly defaultValue: JsonValue | null;
}

/** A JSON value narrowed to what a form control can hold. */
export type FieldInputValue = string | number | boolean;

/** Empty schema: what a prefab that declares no params produces. */
export const EMPTY_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
};

/** The schema title, or the field name when the title is blank. */
export function fieldTitle(name: string, field: FieldSchema): string {
  const title = field.title.trim();
  return title === '' ? name : title;
}

/** The value to show for a field, given the instance's params and the default. */
export function fieldValue(
  name: string,
  field: FieldSchema,
  params: Readonly<Record<string, JsonValue>>,
): JsonValue | null {
  if (field.kind === 'unsupported') return null;
  const own = params[name];
  if (own !== undefined) return own;
  return field.default ?? null;
}

/** Turn one schema property into a row. */
export function toFormField(
  name: string,
  field: FieldSchema,
  schema: JsonSchema,
  params: Readonly<Record<string, JsonValue>>,
): FormField {
  const title = fieldTitle(name, field);
  const required = schema.required.includes(name);

  if (field.kind === 'unsupported') {
    return {
      name,
      title,
      required,
      kind: 'unsupported',
      reason: field.reason,
      value: null,
      min: null,
      max: null,
      exclusiveMin: false,
      options: [],
      hasDefault: false,
      defaultValue: null,
    };
  }

  const options = field.kind === 'string' ? (field.options ?? []) : [];
  const hasDefault = field.default !== undefined;

  return {
    name,
    title,
    required,
    kind: options.length > 0 ? 'select' : field.kind,
    reason: '',
    value: fieldValue(name, field, params),
    min: field.kind === 'number' ? (field.min ?? null) : null,
    max: field.kind === 'number' ? (field.max ?? null) : null,
    // Read straight off the schema's `FieldSchema`. An exclusive bound is a
    // fact about the rule, and it has to survive the trip to the input that
    // enforces it — see the note on the field itself.
    exclusiveMin: field.kind === 'number' && field.exclusiveMin === true,
    options,
    hasDefault,
    defaultValue: hasDefault ? (field.default ?? null) : null,
  };
}

/**
 * Build every row of the params form, in schema declaration order.
 *
 * Insertion order is kept rather than sorted: the prefab author chose the order,
 * and it is usually the order the fields make sense in. Sorting alphabetically
 * would put `height` between `gravity` and `speed` and read as a mistake.
 */
export function buildFormFields(
  schema: JsonSchema | null,
  params: Readonly<Record<string, JsonValue>>,
): FormField[] {
  if (schema === null) return [];
  return Object.entries(schema.properties).map(([name, field]) =>
    toFormField(name, field, schema, params),
  );
}

/**
 * Params present on the instance that the prefab's schema does not describe.
 *
 * With `additionalProperties: false` these are a scene that will fail
 * validation on save, so the inspector says so next to the form rather than
 * letting the developer discover it as a save error. With
 * `additionalProperties: true` they are legitimate, so nothing is shown.
 */
export function findUnknownParams(
  schema: JsonSchema | null,
  params: Readonly<Record<string, JsonValue>>,
): string[] {
  if (schema === null || schema.additionalProperties) return [];
  return Object.keys(params)
    .filter((name) => !(name in schema.properties))
    .sort();
}

/** Parse a text input into the type the field's kind requires. */
export function parseFieldInput(kind: EditableKind, raw: string): FieldInputValue | null {
  if (kind === 'boolean') return raw === 'true';
  if (kind === 'string' || kind === 'select') return raw;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Render a stored value back into what a text input needs. */
export function formatFieldInput(value: JsonValue | null): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Arrays and objects have no honest single-input representation; JSON is
  // shown so the developer can see what is actually stored.
  return JSON.stringify(value);
}

/**
 * Validate one field locally, before the edit is sent.
 *
 * Local validation exists only to keep a keystroke from becoming a failed write.
 * The authoritative check is the prefab's own Zod schema in the main process;
 * a value that passes here can still be refused there, and then its reason is
 * shown next to the field (SPEC R9).
 */
export function validateField(field: FormField, raw: string): string | null {
  if (field.kind === 'unsupported') return null;
  if (field.kind === 'boolean') return null;
  const trimmed = raw.trim();
  if (trimmed === '') {
    return field.required ? 'this field is required' : null;
  }
  if (field.kind === 'number') {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return 'must be a finite number';
    if (field.min !== null && parsed < field.min) return `must be at least ${field.min}`;
    if (field.max !== null && parsed > field.max) return `must be at most ${field.max}`;
  }
  if (field.kind === 'select' && !field.options.includes(trimmed)) {
    return `must be one of: ${field.options.join(', ')}`;
  }
  return null;
}

/**
 * The instance id whose params the form edits, and whether it is editable.
 *
 * `locked` is core's "blocks AI edits" flag (SPEC §4.2). The inspector honours
 * it as read-only rather than merely dimmed, because a disabled control that
 * still fires on a keyboard shortcut is not locked, it is just styled that way.
 */
export function editability(instance: SceneInstance | null): { editable: boolean; reason: string } {
  if (instance === null) return { editable: false, reason: 'nothing is selected' };
  if (instance.locked === true) {
    return { editable: false, reason: 'this instance is locked: edits are blocked until it is unlocked' };
  }
  return { editable: true, reason: '' };
}

/** Read one transform vector as a tuple, defensively. */
export function readVector(transform: Transform, key: VectorKey): Vec3 {
  const vector = transform[key];
  const [x = 0, y = 0, z = 0] = vector;
  return [x, y, z];
}

/** Build the transform patch for one edited axis, or `null` if unparseable. */
export function transformPatch(
  key: VectorKey,
  axis: VectorAxis,
  raw: string,
): { key: VectorKey; axis: VectorAxis; value: number } | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return { key, axis, value };
}

/** A full 3-vector patch, as core's `TransformPatch` wants it. */
export function vectorPatch(key: VectorKey, values: readonly [string, string, string]): {
  patch: Record<VectorKey, Vec3>;
} | null {
  const parsed: number[] = [];
  for (const raw of values) {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const value = Number(trimmed);
    if (!Number.isFinite(value)) return null;
    parsed.push(value);
  }
  const [x, y, z] = parsed as [number, number, number];
  return { patch: { [key]: [x, y, z] } as Record<VectorKey, Vec3> };
}

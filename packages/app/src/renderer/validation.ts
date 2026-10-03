/**
 * packages/app/src/renderer/validation.ts
 *
 * Parameter and instance validation for ContextForge v2 (Step 3b).
 *
 * Implements:
 * 1. Schema constraint validation (min, max, options, required, type).
 * 2. Generation of AppError objects scoped to fields (for example, Width = -10
 *    generates an error scoped to 'width').
 * 3. Validation helper for displaying errors directly under input fields.
 */

import type { AppError } from '../errors.js';
import { createAppError } from '../errors.js';
import type { FieldSchema, JsonSchema, PrefabSummary, SceneSnapshot } from '../ipc.js';
import type { FormField } from './components/fields.js';

/**
 * Validate a single parameter value against a FieldSchema.
 * Returns an error message string or null if valid.
 */
export function validateParamValue(
  field: FieldSchema,
  value: unknown,
  isRequired = false,
  fieldTitle?: string,
): string | null {
  const title = fieldTitle ?? (field.kind !== 'unsupported' ? field.title : 'Field');

  // Unsupported fields cannot be validated or edited
  if (field.kind === 'unsupported') return null;

  // Check required / empty values
  if (value === undefined || value === null || value === '') {
    return isRequired ? `${title} is required` : null;
  }

  if (field.kind === 'number') {
    let parsed: number;
    if (typeof value === 'number') {
      parsed = value;
    } else if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed === '') {
        return isRequired ? `${title} is required` : null;
      }
      parsed = Number(trimmed);
    } else {
      return `${title} must be a finite number`;
    }

    if (!Number.isFinite(parsed)) {
      return `${title} must be a finite number`;
    }
    // `exclusiveMin` is what Zod's `.positive()` becomes: the bound value is
    // 0, but 0 is *not* allowed. Checked before the inclusive test so the
    // message says "greater than 0" — the game's own Zod wording — rather
    // than "at least 0" for a value the game refuses.
    //
    // Without this the app accepts `width: 0`, the game skips the instance,
    // and the Problems panel reports nothing about a missing track (D26).
    if (field.exclusiveMin === true && field.min !== undefined) {
      if (parsed <= field.min) return `${title} must be greater than ${field.min}`;
    }
    if (field.min !== undefined && parsed < field.min) {
      return `${title} must be at least ${field.min}`;
    }
    if (field.max !== undefined && parsed > field.max) {
      return `${title} must be at most ${field.max}`;
    }
    return null;
  }

  if (field.kind === 'string') {
    const str = String(value);
    if (field.options !== undefined && field.options.length > 0) {
      if (!field.options.includes(str)) {
        return `${title} must be one of: ${field.options.join(', ')}`;
      }
    }
    return null;
  }

  if (field.kind === 'boolean') {
    if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
      return `${title} must be a boolean`;
    }
    return null;
  }

  return null;
}

/**
 * Validate all parameters of an instance against a prefab's JsonSchema.
 * Emits AppError objects scoped to each offending field (`scope: 'field'`).
 */
export function validateInstanceParams(
  params: Readonly<Record<string, unknown>>,
  schema: JsonSchema,
  instanceId?: string,
): AppError[] {
  const errors: AppError[] = [];

  for (const [name, field] of Object.entries(schema.properties)) {
    const isRequired = schema.required.includes(name);
    const value = params[name];

    const errorMsg = validateParamValue(field, value, isRequired, field.title || name);
    if (errorMsg !== null) {
      errors.push(
        createAppError({
          id: `err:param:${instanceId ?? 'instance'}:${name}`,
          scope: 'field',
          ...(instanceId !== undefined ? { instanceId } : {}),
          fieldPath: name,
          short: errorMsg,
          details: `Validation constraint failed for parameter "${name}". Current value: ${JSON.stringify(value)}. Constraint: ${JSON.stringify(field)}`,
        }),
      );
    }
  }

  // Check for unknown parameters if additionalProperties is false
  if (!schema.additionalProperties) {
    const knownKeys = new Set(Object.keys(schema.properties));
    for (const key of Object.keys(params)) {
      if (!knownKeys.has(key)) {
        errors.push(
          createAppError({
            id: `err:param:${instanceId ?? 'instance'}:unknown:${key}`,
            scope: 'field',
            ...(instanceId !== undefined ? { instanceId } : {}),
            fieldPath: key,
            short: `Unknown parameter "${key}" is not allowed by schema`,
            details: `Parameter "${key}" is present on instance "${instanceId ?? ''}" but is not declared in the prefab schema and additionalProperties is false.`,
          }),
        );
      }
    }
  }

  return errors;
}

/**
 * Every instance in a scene whose params fail its prefab's own schema — the
 * instances the running game will **skip**.
 *
 * ## Why this is one function and not two
 *
 * The Problems panel and the Scene screen both need this fact. They used to
 * compute it independently, which D26 recorded as a real gap: two derivations
 * of one thing drift, and nothing forces them to agree. They now call this, so
 * the panel's rows and the inspector's rows are the same rows with the same
 * ids, produced by the same comparison against the same numbers.
 *
 * ## Why it is not the same as `snapshot.problems`
 *
 * The main process's `paramProblems()` only sees a prefab's JSON-Schema
 * *summary* and checks for an unknown key or a missing required key — never a
 * bad *value*. So the shipped `track.width: -10` arrives from `snapshot.problems`
 * as nothing at all. This pass is the one that sees it, and that is why it is
 * kept as its own step rather than folded into the project-problem collection.
 *
 * Pure and synchronous: a snapshot in, an array of rows out. A test asserts
 * the rows directly rather than through markup, because the details body is
 * collapsed in server-rendered HTML and the offending value lives in it.
 *
 * @param snapshot The scene and its registry summaries, or null for "no scene".
 * @param prefabs  Registry summaries to validate against. Defaults to the
 *                 snapshot's own, which is the case both call sites mean.
 * @param existing Error ids already claimed by another source, so one fault is
 *                 not shown twice. A count the developer cannot trust is a
 *                 count they stop reading.
 */
export function collectSkippedInstanceProblems(
  snapshot: SceneSnapshot | null,
  prefabs?: readonly PrefabSummary[],
  existing: Iterable<string> = [],
): AppError[] {
  if (snapshot === null) return [];
  const registry = prefabs ?? snapshot.prefabs.prefabs;
  const byName = new Map(registry.map((p) => [p.name, p] as const));
  const seen = new Set(existing);
  const out: AppError[] = [];
  for (const inst of snapshot.scene.instances) {
    const summary = byName.get(inst.prefab);
    // An unregistered prefab is already reported as a missing prefab; its params
    // were never checked against anything, so there is nothing to say about them
    // here. Skipping it is not a silent skip — the missing-prefab row is the row.
    if (summary === undefined) continue;
    for (const err of validateInstanceParams(inst.params, summary.paramsJsonSchema, inst.id)) {
      if (seen.has(err.id)) continue;
      seen.add(err.id);
      out.push(err);
    }
  }
  return out;
}

/**
 * Validate a live input string against a FormField.
 * Used directly by UI input rows.
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
    // An exclusive bound is checked before the inclusive one, so the message
    // names the real rule. Without this the live input accepts `width: 0` while
    // `validateParamValue` — the same rule, reached through the Problems panel —
    // rejects it, and the inspector is the one the developer is typing into.
    if (field.exclusiveMin === true && field.min !== null && parsed <= field.min) {
      return `must be greater than ${field.min}`;
    }
    if (field.min !== null && parsed < field.min) return `must be at least ${field.min}`;
    if (field.max !== null && parsed > field.max) return `must be at most ${field.max}`;
  }
  if (field.kind === 'select' && !field.options.includes(trimmed)) {
    return `must be one of: ${field.options.join(', ')}`;
  }
  return null;
}

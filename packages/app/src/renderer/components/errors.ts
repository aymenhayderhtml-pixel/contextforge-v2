/**
 * errors.ts — deciding which control a refusal belongs under.
 *
 * The requirement is narrow and worth stating plainly: an error must appear next
 * to the field that caused it, not in a banner at the top of the panel. A banner
 * that says "Position must be a finite number" while the position inputs are
 * fifty pixels below it makes the developer hunt.
 *
 * `Result.reason` from the main process is a **complete sentence** (`ipc.ts`),
 * and the scene schema's own errors name a JSON path — `instances[3].params.speed`
 * (R9). So the reason usually already contains the field name, and the job here
 * is to find which one rather than to invent a new error format.
 *
 * Three sources of truth, in the order they are consulted:
 *
 *  1. a caller-supplied `field` — when the UI knows exactly which control it
 *     just edited, it says so and nothing is guessed;
 *  2. a JSON path in the reason (`params.speed`, `instances[2].transform.rotation[1]`),
 *     which is the scene schema naming the offending place (R9);
 *  3. a bare mention of a known field name in the sentence.
 *
 * If none of those match, the refusal is genuinely not about one control, and it
 * is returned as a `scope: 'global'` error to be shown above the form. Inventing
 * a field to attach a sentence to would be worse than admitting it does not
 * belong to one.
 */

import type { AppError } from '../../errors.js';
import type { FormField } from './fields.js';

/** Which control a refusal is shown under. */
export type ErrorScope =
  | { readonly kind: 'field'; readonly field: string }
  | { readonly kind: 'global' };

/** A refusal, resolved to the place it is displayed. */
export interface PlacedError {
  readonly scope: ErrorScope;
  /** The sentence, shown verbatim. Never rewritten, never truncated. */
  readonly reason: string;
  readonly details?: string;
  readonly error?: AppError;
}

/** The names a transform failure could be about, in a stable order. */
export const TRANSFORM_KEYS = ['position', 'rotation', 'scale'] as const;

/**
 * Find a `params.<name>` or `.params[<name>]` mention in a reason.
 *
 * Anchored on the field boundary rather than on a bare substring, so a field
 * called `scale` is not matched by the word "scale" inside an unrelated sentence
 * and `speed` is not matched inside `maxSpeed`.
 */
export function findParamPath(reason: string): string | null {
  const patterns = [
    /params\.([A-Za-z_$][\w$]*)/,
    /params\[["']([^"']+)["']\]/,
    /"params"\s*:\s*\{[^}]*?"([A-Za-z_$][\w$]*)"\s*:/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(reason);
    const name = match?.[1];
    if (name !== undefined) return name;
  }
  return null;
}

/**
 * Find a `transform.<key>` mention, e.g. "must have exactly 3 components" on
 * `transform.position` (the scene schema's own wording).
 */
export function findTransformPath(reason: string): string | null {
  for (const key of TRANSFORM_KEYS) {
    const pattern = new RegExp(`transform\\.?${key}|${key}\\[\\d\\]`);
    if (pattern.test(reason)) return key;
  }
  return null;
}

/**
 * Resolve a refusal to a control.
 *
 * `field` is what the caller knows: the inspector passes the name of the input
 * it just edited, so a refusal on that edit is never misfiled even if the
 * sentence happens to mention a different field (a param called `position`
 * inside a prefab, say). `fields` is the set of names the form currently shows.
 */
export function placeError(
  reasonOrError: string | AppError,
  fields: readonly FormField[],
  field?: string | null,
): PlacedError {
  const isAppErr = typeof reasonOrError !== 'string';
  const reason = isAppErr ? reasonOrError.short : reasonOrError;
  const details = isAppErr ? reasonOrError.details : undefined;
  const error = isAppErr ? reasonOrError : undefined;

  const known = new Set(fields.map((entry) => entry.name));

  if (isAppErr && reasonOrError.fieldPath !== undefined && known.has(reasonOrError.fieldPath)) {
    return {
      scope: { kind: 'field', field: reasonOrError.fieldPath },
      reason,
      ...(details ? { details } : {}),
      ...(error ? { error } : {}),
    };
  }

  if (field !== undefined && field !== null && field !== '' && known.has(field)) {
    return {
      scope: { kind: 'field', field },
      reason,
      ...(details ? { details } : {}),
      ...(error ? { error } : {}),
    };
  }

  const param = findParamPath(reason);
  if (param !== null && known.has(param)) {
    return {
      scope: { kind: 'field', field: param },
      reason,
      ...(details ? { details } : {}),
      ...(error ? { error } : {}),
    };
  }

  const transform = findTransformPath(reason);
  if (transform !== null) {
    return {
      scope: { kind: 'field', field: transform },
      reason,
      ...(details ? { details } : {}),
      ...(error ? { error } : {}),
    };
  }

  for (const entry of fields) {
    if (entry.name.length >= 3 && reason.includes(entry.name)) {
      return {
        scope: { kind: 'field', field: entry.name },
        reason,
        ...(details ? { details } : {}),
        ...(error ? { error } : {}),
      };
    }
  }

  return {
    scope: { kind: 'global' },
    reason,
    ...(details ? { details } : {}),
    ...(error ? { error } : {}),
  };
}

/** One input's worth of state, as the inspector tracks it. */
export interface FieldError {
  readonly name: string;
  /** The sentence from the main process, verbatim. */
  readonly reason: string;
}

/**
 * Split a list of placed errors into per-field errors and a global message.
 *
 * The **last** error for a field wins, because it is the most recent refusal and
 * the stale one describes an edit the developer has already moved past. The
 * first global message is kept and later ones are appended to it, so nothing the
 * main process said is silently dropped.
 */
export function groupErrors(errors: readonly PlacedError[]): {
  byField: ReadonlyMap<string, string>;
  global: string;
} {
  const byField = new Map<string, string>();
  const globals: string[] = [];
  for (const error of errors) {
    if (error.scope.kind === 'field') byField.set(error.scope.field, error.reason);
    else globals.push(error.reason);
  }
  return { byField, global: globals.join(' ') };
}

/** The reason to show for one field, preferring the refusal over local text. */
export function reasonForField(
  byField: ReadonlyMap<string, string>,
  name: string,
  local: string | null,
): string | null {
  const remote = byField.get(name);
  if (remote !== undefined) return remote;
  return local;
}

export {
  toAppError,
  formatErrorShort,
  formatErrorDetails,
  formatPrefabFailure,
  scopeErrorsToInstance,
  collectProjectProblems,
} from '../errorFormatting.js';

export {
  validateParamValue,
  validateInstanceParams,
} from '../validation.js';


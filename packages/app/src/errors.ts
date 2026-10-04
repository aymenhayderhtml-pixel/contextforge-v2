/**
 * packages/app/src/errors.ts
 *
 * Shared error model for ContextForge v2 (Step 3b).
 *
 * Every subagent depends on this shape.
 * Rule: Subagents must NOT edit this file or ipc.ts.
 */

export type ErrorScope = 'instance' | 'field' | 'project';

export interface AppError {
  /** Unique identifier for the error. */
  readonly id: string;
  /**
   * Scope of the error:
   * - 'instance': problem with a whole instance (e.g., prefab threw or failed to load).
   * - 'field': problem with a specific parameter field of an instance (e.g. width = -10).
   * - 'project': project-wide or scene-wide issue (e.g., duplicate IDs, unreferenced prefab, scene syntax).
   */
  readonly scope: ErrorScope;
  /** Instance ID this error relates to, if scoped to an instance or field. */
  readonly instanceId?: string | undefined;
  /** Field path (e.g., `params.width` or `width`) if scoped to a field. */
  readonly fieldPath?: string | undefined;
  /** Single concise summary line (e.g. "hazardCrate failed to load: Corrupted GLTF buffer"). */
  readonly short: string;
  /** Detailed error message, stack trace, or file paths (revealed via Details toggle). */
  readonly details?: string | undefined;
}

/** Factory to create an AppError */
/**
 * `?: string | undefined` on every optional, not `?: string`.
 *
 * Under `exactOptionalPropertyTypes` an optional property does not accept an
 * explicit `undefined`, so every caller passing `instanceId: maybeUndefined` —
 * which is what a narrowing expression produces — was an error. Widening the type
 * is the fix rather than coercing at each call site, because these values really
 * are sometimes absent, and `?? ''` would turn "no instance" into an empty
 * instance id, which then dedupes against a real one (D44).
 */
export function createAppError(opts: {
  id?: string | undefined;
  scope: ErrorScope;
  instanceId?: string | undefined;
  fieldPath?: string | undefined;
  short: string;
  details?: string | undefined;
}): AppError {
  const id =
    opts.id ??
    `err:${opts.scope}:${opts.instanceId ?? 'project'}:${opts.fieldPath ?? ''}:${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    scope: opts.scope,
    ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
    ...(opts.fieldPath !== undefined ? { fieldPath: opts.fieldPath } : {}),
    short: opts.short,
    ...(opts.details !== undefined ? { details: opts.details } : {}),
  };
}

/** Check if an error matches an instance */
export function isInstanceError(err: AppError, instanceId?: string): boolean {
  if (err.scope !== 'instance' && err.scope !== 'field') return false;
  if (instanceId !== undefined) {
    return err.instanceId === instanceId;
  }
  return true;
}

/** Check if an error matches a field */
export function isFieldError(err: AppError, instanceId?: string, fieldPath?: string): boolean {
  if (err.scope !== 'field') return false;
  if (instanceId !== undefined && err.instanceId !== instanceId) return false;
  if (fieldPath !== undefined && err.fieldPath !== fieldPath) return false;
  return true;
}

/** Filter errors for a specific instance (both whole-instance and its field errors) */
export function errorsForInstance(errors: readonly AppError[], instanceId: string): AppError[] {
  return errors.filter((err) => err.instanceId === instanceId);
}

/** Filter errors for a specific field of an instance */
export function errorsForField(
  errors: readonly AppError[],
  instanceId: string,
  fieldPath: string,
): AppError[] {
  return errors.filter(
    (err) => err.scope === 'field' && err.instanceId === instanceId && err.fieldPath === fieldPath,
  );
}

/** Filter project-level errors */
export function projectErrors(errors: readonly AppError[]): AppError[] {
  return errors.filter((err) => err.scope === 'project');
}

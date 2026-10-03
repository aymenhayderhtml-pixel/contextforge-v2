/**
 * packages/app/src/renderer/errorFormatting.ts
 *
 * Error formatting and scoping for ContextForge v2 (Step 3b).
 *
 * Implements:
 * 1. Error model integration with AppError (from packages/app/src/errors.ts).
 * 2. Short one-line summary formatting with expand/collapse details.
 * 3. Instance error scoping by instanceId.
 * 4. Project-level problems aggregation from snapshot.problems, missing prefabs,
 *    failed prefabs, and project errors.
 */

import type { AppError, ErrorScope } from '../errors.js';
import { createAppError } from '../errors.js';
import type { PrefabFailure, PrefabSummary, SceneSnapshot } from '../ipc.js';
import type { SceneInstance } from '@contextforge/core';

export interface TranslatedSyntaxError {
  /** Human-readable plain summary with line number, e.g. "Line 2: a { is never closed" */
  plain: string;
  /** Raw parser output */
  raw: string;
  /** Line number if known */
  line: number | null;
}

/**
 * Translate parser and tree-sitter terms into plain words with the line number.
 * Example: 'Line 2: a { is never closed' instead of raw tree-sitter error output.
 */
export function translateSyntaxError(
  rawMessage: string,
  line: number | null = null,
  _filePath?: string,
): TranslatedSyntaxError {
  const raw = String(rawMessage ?? '').trim();

  // Extract line number from message if not provided
  let resolvedLine = line;
  if (resolvedLine === null) {
    const lineMatch = /\b(?:line|position)\s+(\d+)\b/i.exec(raw);
    if (lineMatch?.[1]) {
      resolvedLine = Number.parseInt(lineMatch[1], 10);
    }
  }

  const linePrefix = resolvedLine !== null ? `Line ${resolvedLine}: ` : '';

  // Strip prefixes like "JavaScript/TypeScript syntax error: " or "GDScript syntax error: "
  let msg = raw.replace(/^(?:JavaScript\/TypeScript|GDScript|JSON)\s+syntax\s+error:\s*/i, '');
  msg = msg.replace(/^Syntax\s+error:\s*/i, '');

  let explanation = '';

  // 1. A missing punctuation token. The token tree-sitter named is kept
  //    verbatim rather than paraphrased ("a { is never closed" for "missing }"),
  //    because the paraphrase is a second guess layered on top of the parser's
  //    answer: when the two disagreed, the message named a construct that was
  //    not missing at all and sent the developer to the wrong file.
  //
  //    Matched narrowly, to the punctuation tree-sitter reports as a MISSING
  //    node. A loose `missing (.+)` would also swallow GDScript's
  //    "statement ... is missing a body", which names a construct rather than a
  //    token and is handled on the branch below.
  const missingPunctuation = /\bmissing\s+["']?([{}()[\];:,])["']?(?=\s|$)/.exec(msg);
  if (missingPunctuation?.[1] !== undefined) {
    explanation = `missing ${missingPunctuation[1]}`;
  } else if (/\bmissing\s+identifier\b/i.test(msg)) {
    explanation = 'missing a name or identifier';
  } else if (/statement\s+on\s+line\s+\d+\s+is\s+missing\s+a\s+body/i.test(raw)) {
    explanation = "statement is missing a body (needs a ':' and an indented block)";
  } else if (/\bmissing\s+(?:a\s+)?[\w]+/i.test(msg)) {
    // Already a plain phrase from core ("missing a name or identifier"). Passed
    // through verbatim: the fallback below rewrites `identifier` to `name`, and
    // running it over a phrase core has already made readable turns "a name or
    // identifier" into "a name or name". Checked *after* the GDScript sentence,
    // which also contains the word "missing" but names a construct.
    explanation = /^(missing\s+[\w ]+)/i.exec(msg)?.[1] ?? 'syntax error';
  } else if (/unexpected\s+token\s+(.+)\s+in\s+JSON/i.test(raw)) {
    const match = /unexpected\s+token\s+(.+)\s+in\s+JSON/i.exec(raw);
    explanation = `unexpected ${match?.[1] ?? 'token'} in JSON`;
  } else if (/unexpected\s+end\s+of\s+JSON/i.test(raw)) {
    explanation = 'unexpected end of JSON file';
  } else {
    // Check for "near '...'" or "near "..."
    const nearMatch = /near\s+["']([^"']+)["']/i.exec(msg);
    if (nearMatch?.[1]) {
      const snippet = nearMatch[1].trim();
      // Check if snippet contains unclosed delimiters
      const openBraces = (snippet.match(/\{/g) || []).length;
      const closeBraces = (snippet.match(/\}/g) || []).length;
      const openParens = (snippet.match(/\(/g) || []).length;
      const closeParens = (snippet.match(/\)/g) || []).length;
      const openBrackets = (snippet.match(/\[/g) || []).length;
      const closeBrackets = (snippet.match(/\]/g) || []).length;

      if (openBraces > closeBraces) {
        explanation = 'a { is never closed';
      } else if (openParens > closeParens) {
        explanation = 'a ( is never closed';
      } else if (openBrackets > closeBrackets) {
        explanation = 'a [ is never closed';
      } else if (snippet === '=') {
        explanation = "unexpected '=' without an expression";
      } else {
        explanation = `unexpected "${snippet}"`;
      }
    } else if (/\bmissing\s+token\b/i.test(msg)) {
      explanation = 'missing required token or punctuation';
    } else {
      // General cleanup of tree-sitter AST names
      explanation = msg
        .replace(/statement_block/g, 'block of code')
        .replace(/binary_expression/g, 'expression')
        .replace(/call_expression/g, 'function call')
        .replace(/identifier/g, 'name')
        .trim();
      if (!explanation) explanation = 'syntax error';
    }
  }

  const plain = `${linePrefix}${explanation}`;
  return { plain, raw, line: resolvedLine };
}

/**
 * Format a PrefabFailure into an AppError with a single short line and details.
 * Example: 'hazardCrate failed to load: Corrupted GLTF buffer'
 */
export function formatPrefabFailure(failure: PrefabFailure, scope: ErrorScope = 'project'): AppError {
  const short = `${failure.name} failed to load: ${failure.reason}`;
  const details = failure.file ? `File: ${failure.file}` : undefined;
  return createAppError({
    id: `err:prefab:${failure.name}`,
    scope,
    short,
    ...(details !== undefined ? { details } : {}),
  });
}

/**
 * Extract a single concise short line from a raw error or string.
 * Strips multi-line stack traces or file paths from the short line.
 */
export function extractShortLine(raw: string): string {
  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? '';
  return firstLine;
}

/**
 * Extract details (stack trace, file paths, etc.) from a raw error or string.
 */
export function extractDetails(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  if (lines.length <= 1) return undefined;
  const rest = lines.slice(1).join('\n').trim();
  return rest === '' ? undefined : rest;
}

/**
 * Convert any unknown error source (AppError, PrefabFailure, Error, string) into an AppError.
 *
 * `scene` is the scene an `instances[n]` path is resolved against. Without it an
 * index cannot be turned into an id, and using the index as the id is what this
 * function used to do — the bug D26/the Step 3d review recorded, where an
 * instance was labelled `0` and the "Go to instance" link selected nothing.
 */
export function toAppError(
  input: unknown,
  defaults?: { scope?: ErrorScope; instanceId?: string; fieldPath?: string },
  scene?: readonly SceneInstance[] | null,
): AppError {
  if (isAppError(input)) {
    if (
      (defaults?.scope !== undefined && defaults.scope !== input.scope) ||
      (defaults?.instanceId !== undefined && defaults.instanceId !== input.instanceId) ||
      (defaults?.fieldPath !== undefined && defaults.fieldPath !== input.fieldPath)
    ) {
      const scope = defaults?.scope ?? input.scope;
      const instanceId = defaults?.instanceId ?? input.instanceId;
      const fieldPath = defaults?.fieldPath ?? input.fieldPath;
      return createAppError({
        id: input.id,
        scope,
        ...(instanceId !== undefined ? { instanceId } : {}),
        ...(fieldPath !== undefined ? { fieldPath } : {}),
        short: input.short,
        ...(input.details !== undefined ? { details: input.details } : {}),
      });
    }
    return input;
  }

  if (isPrefabFailure(input)) {
    return formatPrefabFailure(input, defaults?.scope ?? 'project');
  }

  if (input instanceof Error) {
    const short = input.message || input.name;
    const stack = input.stack;
    const details = stack && stack !== input.message ? stack : undefined;
    return createAppError({
      scope: defaults?.scope ?? 'project',
      ...(defaults?.instanceId !== undefined ? { instanceId: defaults.instanceId } : {}),
      ...(defaults?.fieldPath !== undefined ? { fieldPath: defaults.fieldPath } : {}),
      short,
      ...(details !== undefined ? { details } : {}),
    });
  }

  const raw = String(input ?? '');
  const short = extractShortLine(raw);
  const details = extractDetails(raw);

  // Attempt to parse instanceId and fieldPath if not provided
  let instanceId = defaults?.instanceId;
  let fieldPath = defaults?.fieldPath;
  let scope = defaults?.scope ?? 'project';

  if (instanceId === undefined) {
    const instMatch = /instances\[(\d+)\]/.exec(raw) || /instance\s*["']([^"']+)["']/.exec(raw);
    if (instMatch?.[1] !== undefined) {
      // `instances[3]` is a *position*, and this used to be used as the id — so
      // the third kart's error was labelled "2". Two consequences, both bad: the
      // Problems panel offered a "Go to instance 2" link that selected nothing,
      // and the id shifted the moment an instance was added above. Resolving the
      // index against the scene turns it into the id, which is the only stable
      // identifier a file has.
      //
      // **Resolved against the scene only.** An index is a claim about *this*
      // scene's order; carrying it onward would say "instance 2" for a scene the
      // caller never supplied. With no scene the index is kept as a last resort
      // rather than dropped — a dangling but honest label beats no label (R9).
      const index = Number(instMatch[1]);
      const resolved = instanceIdAtIndex(scene, index);
      if (resolved !== undefined) {
        instanceId = resolved;
        scope = 'instance';
      } else if (String(instMatch[0]).startsWith('instance ')) {
        instanceId = instMatch[1];
        scope = 'instance';
      } else {
        instanceId = instMatch[1];
      }
    }
  }

  if (fieldPath === undefined) {
    const paramMatch = /params\.([A-Za-z_$][\w$]*)/.exec(raw) || /params\[["']([^"']+)["']\]/.exec(raw);
    if (paramMatch?.[1] !== undefined) {
      fieldPath = paramMatch[1];
      scope = 'field';
    } else {
      const transformMatch = /transform\.(position|rotation|scale)/.exec(raw);
      if (transformMatch?.[1] !== undefined) {
        fieldPath = transformMatch[1];
        scope = 'field';
      }
    }
  }

  return createAppError({
    scope,
    ...(instanceId !== undefined ? { instanceId } : {}),
    ...(fieldPath !== undefined ? { fieldPath } : {}),
    short,
    ...(details !== undefined ? { details } : {}),
  });
}

/**
 * The instance **id** at a position in the scene, or `undefined`.
 *
 * `undefined` for an index past the end, and for an absent scene — never a guess.
 * An index that resolves to nothing must not be turned into an id by
 * stringifying itself, because the label would then look like a real id to
 * everything downstream (SPEC R9).
 */
function instanceIdAtIndex(scene: readonly SceneInstance[] | null | undefined, index: number): string | undefined {
  if (scene === null || scene === undefined) return undefined;
  if (!Number.isInteger(index) || index < 0) return undefined;
  return scene[index]?.id;
}

function isAppError(val: unknown): val is AppError {
  if (typeof val !== 'object' || val === null) return false;
  const cand = val as Record<string, unknown>;
  return typeof cand['id'] === 'string' && typeof cand['scope'] === 'string' && typeof cand['short'] === 'string';
}

function isPrefabFailure(val: unknown): val is PrefabFailure {
  if (typeof val !== 'object' || val === null) return false;
  const cand = val as Record<string, unknown>;
  return typeof cand['name'] === 'string' && typeof cand['file'] === 'string' && typeof cand['reason'] === 'string';
}

/**
 * Format error as one short line.
 * Example: 'hazardCrate failed to load: Corrupted GLTF buffer'
 */
export function formatErrorShort(error: AppError | PrefabFailure | Error | string): string {
  if (isAppError(error)) return error.short;
  if (isPrefabFailure(error)) return `${error.name} failed to load: ${error.reason}`;
  if (error instanceof Error) return error.message || error.name;
  return extractShortLine(String(error));
}

/**
 * Get error details (stack trace, file paths, etc.) if any.
 */
export function formatErrorDetails(error: AppError | PrefabFailure | Error | string): string | undefined {
  if (isAppError(error)) return error.details;
  if (isPrefabFailure(error)) return error.file ? `File: ${error.file}` : undefined;
  if (error instanceof Error) return error.stack;
  return extractDetails(String(error));
}

/**
 * Instance error scoping: ensure the inspector only receives/shows errors that
 * belong to the currently selected instance (using `instanceId`).
 *
 * Rules:
 * 1. An AppError with `scope === 'project'` is NEVER an instance error.
 * 2. An AppError with `instanceId` must match the selected `instanceId`.
 * 3. A raw string that names a DIFFERENT instance is excluded.
 * 4. A raw string that names this instance or names only a field/transform is kept.
 */
export function scopeErrorsToInstance(
  errors: readonly (AppError | string)[],
  instanceId: string,
  instanceIndex?: number,
): AppError[] {
  const result: AppError[] = [];

  for (const err of errors) {
    if (isAppError(err)) {
      // Project errors do not belong to the instance inspector
      if (err.scope === 'project') continue;
      // If scoped to an instanceId, it must match
      if (err.instanceId !== undefined && err.instanceId !== instanceId) continue;
      // Belongs to this instance
      result.push(err);
      continue;
    }

    const raw = String(err);

    // Check if raw string explicitly mentions another instance
    // e.g. instances[2] when instanceIndex is 0
    const instIdxMatch = /instances\[(\d+)\]/.exec(raw);
    if (instIdxMatch?.[1] !== undefined) {
      const idx = Number(instIdxMatch[1]);
      if (instanceIndex !== undefined && idx !== instanceIndex) {
        continue;
      }
    }

    // e.g. instance id "other" or instance 'other'
    const idMatch = /instance\s*["']([^"']+)["']/.exec(raw);
    if (idMatch?.[1] !== undefined && idMatch[1] !== instanceId) {
      continue;
    }

    // Convert to AppError scoped to this instance
    const appErr = toAppError(raw, { instanceId });
    if (appErr.instanceId === instanceId || appErr.scope === 'field' || appErr.scope === 'instance') {
      result.push(appErr);
    }
  }

  return result;
}

export interface CollectProblemsOptions {
  snapshot?: SceneSnapshot | null;
  problems?: readonly (AppError | string)[];
  prefabs?: readonly PrefabSummary[];
  failedPrefabs?: readonly PrefabFailure[];
}

/**
 * Project-level problems: all project-wide issues (from snapshot.problems,
 * missing prefabs, project errors) go into one 'Problems (N)' panel.
 *
 * Returns a deduplicated array of AppError.
 */
export function collectProjectProblems(options: CollectProblemsOptions): AppError[] {
  const result: AppError[] = [];
  const seenIds = new Set<string>();

  function add(err: AppError): void {
    if (seenIds.has(err.id)) return;
    seenIds.add(err.id);
    result.push(err);
  }

  // 1. From snapshot.prefabs.failed or failedPrefabs
  const failures = options.failedPrefabs ?? options.snapshot?.prefabs.failed ?? [];
  for (const failure of failures) {
    add(formatPrefabFailure(failure, 'project'));
  }

  // 2. From missing prefabs referenced by instances in the scene
  const registeredPrefabNames = new Set<string>(
    (options.prefabs ?? options.snapshot?.prefabs.prefabs ?? []).map((p) => p.name),
  );
  const failedPrefabNames = new Set<string>(failures.map((f) => f.name));

  const instances: readonly SceneInstance[] = options.snapshot?.scene.instances ?? [];
  const reportedMissingPrefabs = new Set<string>();

  for (const inst of instances) {
    if (!registeredPrefabNames.has(inst.prefab) && !failedPrefabNames.has(inst.prefab)) {
      if (!reportedMissingPrefabs.has(inst.prefab)) {
        reportedMissingPrefabs.add(inst.prefab);
        add(
          createAppError({
            id: `err:missing-prefab:${inst.prefab}`,
            scope: 'project',
            short: `Missing prefab: "${inst.prefab}" is not registered`,
            details: `Instance "${inst.id}" references prefab "${inst.prefab}", which is missing from the project registry.`,
          }),
        );
      }
    }
  }

  // 3. From snapshot.problems. The snapshot's own instances are handed down so
  // an `instances[n]` path becomes that instance's **id**, not its index: a
  // "Go to instance 0" link that selects nothing is worse than no link, and an
  // index shifts every time a line is added above it (SPEC R9).
  const snapshotProblems = options.snapshot?.problems ?? [];
  for (const prob of snapshotProblems) {
    const appErr = toAppError(prob, { scope: 'project' }, instances);
    add(appErr);
  }

  // 4. From caller-provided problems array. No scene is passed: these strings
  // were produced outside any snapshot, so an index in one refers to nothing
  // this call knows about, and resolving it would be a guess.
  if (options.problems) {
    for (const prob of options.problems) {
      const appErr = toAppError(prob, { scope: 'project' });
      add(appErr);
    }
  }

  return result;
}

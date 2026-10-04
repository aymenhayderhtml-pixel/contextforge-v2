/**
 * electron/prefabLoader.ts — load a project's prefabs in the Electron main process.
 *
 * The renderer has no filesystem and no Zod (ipc.ts explains why). So the main
 * process owns the only two things a scene needs before it can be drawn: the
 * registry of prefabs, and a description of each prefab's parameters good enough
 * for the Svelte inspector to build a form from.
 *
 * ## How a prefab gets loaded
 *
 * A project's `prefabs/index.ts` is TypeScript that an AI wrote, seconds ago, and
 * is not part of this application's build graph. It cannot simply be `import`ed:
 * it is not compiled, it imports `zod` and `@contextforge/core` by bare
 * specifier, and it lives in a folder that has no `node_modules` of its own. So
 * it is **bundled with esbuild at load time** and the resulting bundle is
 * imported.
 *
 * Four design points, each load-bearing:
 *
 *  - **A temp file, not an in-memory module.** A bundle that keeps its
 *    dependencies external contains bare `import 'three'` specifiers. Node
 *    cannot resolve those from a `data:` URL, and it cannot resolve them from a
 *    temp directory with no `node_modules` above it either. So the bundle is
 *    written to a real `.mjs` file and every external specifier is *rewritten to
 *    an absolute URL* first (see `externalResolverPlugin`), which makes
 *    resolution independent of where the file lands.
 *  - **`three` and `@contextforge/core` stay external.** The main process
 *    already has both loaded. Bundling Three.js would add megabytes and seconds
 *    to every reload, and — worse — would hand the project a *second copy* of
 *    Three.js whose classes are not identical to the app's, so an `instanceof
 *    Mesh` check across the boundary would be false. External means one
 *    Three.js, shared.
 *  - **Zod is bundled in.** Unlike Three.js, Zod is small, and a project pinning
 *    its own copy is legitimate. Two Zod copies in one registry is harmless; two
 *    Three.js copies is a class-identity bug.
 *  - **Every import is cache-busted.** A watcher rebuilds on every save, and Node
 *    caches ESM modules by URL forever, so a rebuild of an unchanged path would
 *    otherwise keep serving the *first* version. A per-import query suffix is
 *    what makes "reload" mean reload.
 *  - **esbuild's binary is re-pointed before esbuild is loaded.** esbuild `spawn`s a real
 *    executable, which cannot happen at a path inside an asar. In the packaged app
 *    that is `spawn ENOTDIR` for *every* prefab at once. See
 *    `ensureEsbuildBinaryIsExecutable` — the override must be in place before esbuild's
 *    module is *evaluated*, so `build` is imported dynamically rather than statically.
 *
 * ## A bad prefab is a row, not a crash
 *
 * One broken prefab in a directory of twelve is the normal state of a project an
 * AI is editing. So nothing in the load path throws:
 *
 *  - The bundle is imported in a try. If `prefabs/index.ts` itself throws at
 *    module-eval time, every prefab it imports is unreachable — so the registry
 *    is then recovered **file by file**, each `prefabs/*.ts` bundled and
 *    imported on its own. One file that throws costs one prefab, not eleven.
 *  - Each prefab is *smoke-tested* by calling its `create` with real Three.js
 *    and a seeded rng. A `create` that throws is reported with its file and
 *    message and excluded, which is exactly what lets the viewer draw a
 *    placeholder instead of refusing to open. The probe is only made when the
 *    prefab's own schema accepts the probe params, so a prefab with required
 *    params is never failed by a test that supplied none.
 *  - Zod → JSON Schema conversion refuses rather than guesses. A nested object
 *    becomes `{kind:'unsupported', reason}`, never an invented field kind the
 *    inspector cannot render.
 *
 * The result is a `PrefabRegistryResult` (ipc.ts) whose `failed` field is a
 * first-class result, not an error.
 */

import type { Plugin } from 'esbuild';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { z } from 'zod';

import { mulberry32 } from '@contextforge/core';
import type { PrefabDefinition, PrefabInstance, PrefabParams } from '@contextforge/core';
import type {
  FieldSchema,
  JsonSchema,
  PrefabFailure,
  PrefabRegistryResult,
  PrefabSummary,
} from '../ipc.js';

// ── Zod → JSON Schema ────────────────────────────────────────────────────────

/**
 * Raised when a `paramsSchema` cannot be described by the inspector's subset.
 *
 * Thrown rather than returning a best-effort object, because the alternative is
 * a form that silently drops constraints the Zod schema enforces — and the
 * developer finds out when a scene fails to validate for a reason the inspector
 * never showed (SPEC R9).
 */
export class UnsupportedParamsSchemaError extends Error {
  constructor(reason: string) {
    super(`Cannot describe this prefab's params in the inspector: ${reason}`);
    this.name = 'UnsupportedParamsSchemaError';
  }
}

/**
 * The parts of Zod's `_def` this module reads.
 *
 * Zod does not export these types, so they are declared here rather than reached
 * for with `any` (SPEC R1). Every field below is asserted against the real zod
 * in `prefabLoader.test.ts`, so a Zod upgrade that moves one fails a test
 * instead of silently producing a wrong form.
 */
interface ZodDefLike {
  readonly typeName: string;
  readonly unknownKeys?: string;
  readonly shape?: () => Record<string, z.ZodTypeAny>;
  readonly innerType?: z.ZodTypeAny;
  readonly defaultValue?: () => unknown;
  readonly values?: unknown[];
  readonly checks?: ReadonlyArray<{ kind: string; value?: number; regex?: RegExp; inclusive?: boolean }>;
}

/** A module namespace, or the parts of one this loader is willing to use. */
interface ModuleExports {
  readonly [key: string]: unknown;
}

/** The `three` argument a prefab's `create` is called with. */
type PrefabThreeModule = Parameters<PrefabDefinition['create']>[0];

/** The `_def` of a schema, defensively. */
function defOf(schema: z.ZodTypeAny): ZodDefLike {
  const candidate = (schema as unknown as { _def?: ZodDefLike })._def;
  if (candidate === undefined || typeof candidate.typeName !== 'string') {
    throw new UnsupportedParamsSchemaError(
      'the schema is not a Zod type (no `_def.typeName`), so nothing can be said about it',
    );
  }
  return candidate;
}

/** A readable name for a Zod type, for the `reason` the UI shows. */
function describeTypeName(typeName: string): string {
  return typeName.startsWith('Zod') ? typeName.slice(3).toLowerCase() : typeName;
}

/** A human title for a field: Zod's `.describe()` if given, else the key. */
function titleFor(key: string, schema: z.ZodTypeAny): string {
  const described = schema.description;
  if (described !== undefined && described.trim() !== '') return described.trim();
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  if (spaced === '') return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Convert one field's Zod type into a `FieldSchema`, or refuse.
 *
 * Refusal is the honest outcome for anything nested, array-shaped, or a union:
 * the inspector renders three field kinds, and emitting a fourth it does not
 * know would render an empty box (SPEC R9 — never a plausible-looking wrong
 * answer).
 *
 * **Bounds.** `min`/`max` are reported for inclusive *and* exclusive Zod checks,
 * and a non-inclusive `min` is additionally marked `exclusiveMin`. The mark
 * exists because the two are otherwise indistinguishable — `.positive()` and
 * `.nonnegative()` both carry the bound 0, and reading it as inclusive lets the
 * app accept a value the game skips (D26). `validateParamValue` in the renderer
 * is what enforces it; this module's job is only to not lose the fact.
 */
function fieldSchemaFor(key: string, schema: z.ZodTypeAny): FieldSchema {
  const def = defOf(schema);
  const title = titleFor(key, schema);

  switch (def.typeName) {
    case 'ZodDefault': {
      const inner = def.innerType;
      if (inner === undefined) {
        throw new UnsupportedParamsSchemaError(`"${key}" is a default with nothing inside it`);
      }
      const innerField = fieldSchemaFor(key, inner);
      const value = def.defaultValue?.();
      // A default that does not match its field's kind is dropped rather than
      // forced: a string field with a numeric default is a broken schema, and
      // the type checker is where that belongs, not a coerced value in a form.
      switch (innerField.kind) {
        case 'number':
          return typeof value === 'number' ? { ...innerField, default: value } : innerField;
        case 'string':
          return typeof value === 'string' ? { ...innerField, default: value } : innerField;
        case 'boolean':
          return typeof value === 'boolean' ? { ...innerField, default: value } : innerField;
        case 'unsupported':
          return innerField;
      }
      break;
    }

    // Wrappers that do not change the field's kind. A `.nullable()` number is
    // still a number input; the null case is the form's problem, not the
    // conversion's, and claiming otherwise would invent a field kind.
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodReadonly':
    case 'ZodCatch': {
      const inner = def.innerType;
      if (inner === undefined) {
        throw new UnsupportedParamsSchemaError(`"${key}" is a ${def.typeName} with nothing inside it`);
      }
      return fieldSchemaFor(key, inner);
    }

    case 'ZodNumber': {
      const field: {
        kind: 'number';
        title: string;
        min?: number;
        max?: number;
        exclusiveMin?: true;
      } = {
        kind: 'number',
        title,
      };
      for (const check of def.checks ?? []) {
        if (typeof check.value !== 'number') continue;
        // `inclusive` is what separates `.positive()` from `.nonnegative()`:
        // both carry `value: 0`, but one accepts 0 and the other does not. Read
        // as an inclusive bound, a `.positive()` becomes "min 0" and the app
        // accepts a value the game refuses — the app and the game then disagree
        // about one instance with nothing reporting it (D26). So the bound is
        // carried *and* marked, and `validation.ts` enforces the real rule.
        //
        // The last check of a kind wins, because that is the one Zod applies.
        if (check.kind === 'min') {
          field.min = check.value;
          if (check.inclusive === false) field.exclusiveMin = true;
          else delete field.exclusiveMin;
        } else if (check.kind === 'max') {
          field.max = check.value;
        }
      }
      return field;
    }

    case 'ZodString': {
      const field: { kind: 'string'; title: string; pattern?: string } = { kind: 'string', title };
      const pattern = (def.checks ?? []).find((c) => c.kind === 'regex')?.regex;
      if (pattern !== undefined) field.pattern = pattern.source;
      return field;
    }

    case 'ZodEnum':
    case 'ZodNativeEnum': {
      const options = (def.values ?? []).map((v) => String(v));
      if (options.length === 0) {
        throw new UnsupportedParamsSchemaError(`"${key}" is an enum with no values`);
      }
      return { kind: 'string', title, options };
    }

    case 'ZodBoolean':
      return { kind: 'boolean', title };

    default:
      return {
        kind: 'unsupported',
        title,
        reason: `"${key}" is a ${describeTypeName(def.typeName)}, which the inspector has no field for`,
      };
  }

  // Unreachable: the switch above returns or breaks, and the break above is
  // only reached if a new wrapper case is added without a return.
  throw new UnsupportedParamsSchemaError(`"${key}" is a ${describeTypeName(def.typeName)}`);
}

/** Whether a key must be present in an input object. */
function isRequired(schema: z.ZodTypeAny): boolean {
  const def = defOf(schema);
  // A default or a catch makes the key optional *on input*, which is what the
  // inspector's `required` list is about: the form decides whether to render an
  // empty field or pre-fill the default.
  return def.typeName !== 'ZodDefault' && def.typeName !== 'ZodCatch' && def.typeName !== 'ZodOptional';
}

/**
 * Derive the inspector's JSON-Schema view of a prefab's params.
 *
 * The one Zod → JSON-Schema conversion in the project (ipc.ts says why: one
 * conversion beats a second implementation drifting in the renderer).
 *
 * Throws `UnsupportedParamsSchemaError` when the schema is not a plain object —
 * `additionalProperties` cannot be set honestly for, say, a union, and guessing
 * `true` would mean the inspector quietly accepted keys the prefab rejects.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = defOf(schema);
  if (def.typeName !== 'ZodObject') {
    throw new UnsupportedParamsSchemaError(
      `its paramsSchema is a ${describeTypeName(def.typeName)}, not an object, so the inspector ` +
        'has no form to build',
    );
  }
  const shape = def.shape?.();
  if (shape === undefined) {
    throw new UnsupportedParamsSchemaError('its paramsSchema exposes no shape');
  }

  const properties: Record<string, FieldSchema> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    properties[key] = fieldSchemaFor(key, field);
    if (isRequired(field)) required.push(key);
  }

  return {
    type: 'object',
    properties,
    required,
    // `.strict()` is the only thing that sets this to `false`. Zod's default is
    // to *strip* unknown keys silently, so a form that offered a key the schema
    // ignores would teach the wrong lesson about the contract; `passthrough`
    // genuinely does accept them.
    additionalProperties: def.unknownKeys !== 'strict',
  };
}

// ── Isolation ────────────────────────────────────────────────────────────────

/** Format a thrown value for `PrefabFailure.reason`, with a few stack frames. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const head = (error.stack ?? '')
      .split('\n')
      .slice(0, 4)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .join(' | ');
    return head === '' ? error.message : `${error.message} — ${head}`;
  }
  return String(error);
}

/**
 * The params to probe a prefab with, or `null` when no honest probe exists.
 *
 * `{}` first, because that exercises the prefab's own defaults. If the schema
 * rejects it, no probe is attempted: fabricating values for required params
 * would test something the developer never asked for, and a prefab would be
 * failed for a call it was never written to accept.
 */
function probeParams(schema: z.ZodTypeAny): PrefabParams | null {
  if (schema === undefined || typeof (schema as { safeParse?: unknown }).safeParse !== 'function') {
    return {};
  }
  const parsed = schema.safeParse({});
  return parsed.success ? (parsed.data as PrefabParams) : null;
}

/** Whether a value is a `PrefabDefinition` well enough to be summarised. */
export function isPrefabDefinition(value: unknown): value is PrefabDefinition {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record['name'] === 'string' && typeof record['create'] === 'function';
}

/**
 * Turn a recovered `PrefabDefinition` into a summary, or the reason it cannot
 * become one.
 *
 * The prefab is *called* here, with real Three.js and a seeded rng, because a
 * `create` that throws is a prefab the viewer cannot draw, and a summary that
 * claimed otherwise would be a lie (SPEC R9).
 *
 * Returning a `PrefabFailure` rather than throwing is the isolation boundary:
 * every caller treats a bad prefab as a row, and no caller needs a try.
 */
export function summarizePrefab(
  definition: PrefabDefinition,
  file: string,
  three: PrefabThreeModule,
): PrefabSummary | PrefabFailure {
  const name = typeof definition.name === 'string' ? definition.name : '';
  if (name === '') {
    return { name: '(unnamed)', file, reason: 'the prefab has no non-empty `name`' };
  }

  if (typeof definition.create !== 'function') {
    return { name, file, reason: 'the prefab has no `create(three, params, rng)` function' };
  }

  let paramsJsonSchema: JsonSchema;
  try {
    paramsJsonSchema = zodToJsonSchema(definition.paramsSchema);
  } catch (error) {
    return { name, file, reason: describeError(error) };
  }

  const params = probeParams(definition.paramsSchema);
  if (params !== null) {
    let instance: PrefabInstance;
    try {
      instance = definition.create(three, params, mulberry32(0));
    } catch (error) {
      return { name, file, reason: describeError(error) };
    }
    if (instance === null || typeof instance !== 'object' || !('object' in instance)) {
      return { name, file, reason: '`create` did not return an object with an `object` key' };
    }
  }

  return { name, description: definition.description ?? '', paramsJsonSchema };
}

/** Whether a `summarizePrefab` result is a failure rather than a summary. */
function isFailure(value: PrefabSummary | PrefabFailure): value is PrefabFailure {
  return !('paramsJsonSchema' in value);
}

/**
 * Add one recovered prefab to a result, keeping the first of a duplicate name.
 *
 * `indexPrefabs` in core refuses duplicates loudly, and rightly: which prefab a
 * scene instance gets would otherwise depend on file order. Here both copies are
 * already loaded, so the later one is *reported* and dropped — the same outcome,
 * with a row the developer can act on instead of an exception.
 */
function collect(
  result: PrefabRegistryResult,
  seen: Map<string, string>,
  definition: PrefabDefinition,
  file: string,
  three: PrefabThreeModule,
): void {
  const name = typeof definition.name === 'string' ? definition.name : '';
  const existing = seen.get(name);
  if (existing !== undefined) {
    result.failed.push({
      name,
      file,
      reason:
        `duplicate prefab name — already defined in ${existing}. ` +
        'Prefab names must be unique, so this one was not loaded.',
    });
    return;
  }

  const summary = summarizePrefab(definition, file, three);
  if (isFailure(summary)) {
    result.failed.push(summary);
    return;
  }
  seen.set(name, file);
  result.prefabs.push(summary);
}

// ── Bundling ─────────────────────────────────────────────────────────────────

/** Specifiers always provided by the host and never bundled in. */
export const EXTERNAL_SPECIFIERS = ['three', '@contextforge/core'] as const;

/**
 * Point esbuild at a binary that can actually be executed, once per process.
 *
 * ## The defect this exists to prevent
 *
 * esbuild is not a pure library. `esbuild/lib/main.js` locates its platform package
 * and then `child_process.spawn`s that binary as a real executable file. Inside an
 * Electron asar that fails with **`spawn ENOTDIR`**, and it fails *identically for
 * every prefab*, because each prefab goes through the same `build()` call:
 *
 *   ```
 *   spawn ENOTDIR — at ChildProcess.spawn (node:internal/child_process:458:11)
 *   ```
 *
 * The reason is the seam between two different pieces of Electron's asar support.
 * Electron patches `fs` so `readFileSync('.../app.asar/x')` succeeds and transparently
 * redirects a *read* of an unpacked file to `app.asar.unpacked`. It does **not** patch
 * `child_process`, so `require.resolve('@esbuild/linux-x64/bin/esbuild')` — which
 * legitimately returns a path *inside* `app.asar` — hands `spawn` a path that is not a
 * file on disk. `spawn` says ENOTDIR and every prefab becomes a row in the Problems
 * panel.
 *
 * Nothing in the dev tree shows this: there the resolved path is a real file.
 *
 * ## The fix
 *
 * Rewrite the `.asar` segment of the resolved path to `.asar.unpacked`, which is where
 * the real file lives, and hand it to esbuild through `ESBUILD_BINARY_PATH`. The binary
 * is already unpacked in the shipped package — `@esbuild/linux-x64` declares
 * `"preferUnplugged": true`, which electron-builder honours — so this only corrects the
 * *path*; it never copies or extracts anything.
 *
 * Why the environment variable rather than patching esbuild's internals: it is the
 * documented, stable override, it is read by `generateBinPath()` before esbuild's own
 * resolution runs, and it leaves a deliberate mark (`esbuildForcedBinaryPath`) that a
 * test can assert.
 *
 * **The variable must be set before esbuild's module is evaluated, not merely before
 * `build()` is called.** `esbuild/lib/main.js` reads it once at module scope
 * (`var ESBUILD_BINARY_PATH = process.env.ESBUILD_BINARY_PATH || ...`), and
 * `generateBinPath()` reads that *constant* — esbuild never re-reads `process.env`. A
 * static `import { build } from 'esbuild'` is hoisted above every statement in this file,
 * so it captures the unset value first and this function's later `process.env` write is
 * ignored. That is why `build` is instead loaded with a dynamic `await import('esbuild')`
 * *after* the guard at each call site (see `bundleEntry`). Setting the variable afterwards
 * has no effect at all.
 *
 * Every failure path **falls back to doing nothing**, leaving esbuild's own resolution in
 * charge: if the path cannot be resolved, or the unpacked twin does not exist, or the
 * rewrite finds no `.asar` in the path, the correct behaviour is the current behaviour.
 * A dev-tree process must be completely unaffected by this function.
 */
let esbuildForcedBinaryPath: string | null = null;

/**
 * The unpacked twin of a path inside an asar, or `null` when there is nothing to rewrite.
 *
 * `resources/app.asar/node_modules/x` → `resources/app.asar.unpacked/node_modules/x`.
 */
export function unpackedAsarPath(path: string): string | null {
  const marker = `${sep}app.asar${sep}`;
  const at = path.lastIndexOf(marker);
  if (at === -1) return null;
  return `${path.slice(0, at)}${sep}app.asar.unpacked${sep}${path.slice(at + marker.length)}`;
}

/**
 * Best-effort: make esbuild's binary executable from this process, if it is not already.
 *
 * Returns the path handed to esbuild, or `null` when nothing needed doing (the dev tree,
 * or an already-valid setup). Never throws — see the fallback note above.
 */
export function ensureEsbuildBinaryIsExecutable(): string | null {
  if (esbuildForcedBinaryPath !== null) return esbuildForcedBinaryPath;

  const already = process.env.ESBUILD_BINARY_PATH;
  // Respect an explicit override the operator set. Rewriting it would be surprising:
  // if someone pinned a path, that is the path they asked for.
  if (typeof already === 'string' && already !== '' && existsSync(already)) {
    esbuildForcedBinaryPath = null;
    return null;
  }

  try {
    const here = fileURLToPath(import.meta.url);
    const specifier = `@esbuild/${process.platform}-${process.arch}/bin/esbuild`;
    const inAsar = createRequire(join(here, 'noop.js')).resolve(specifier);
    const rewritten = unpackedAsarPath(inAsar);
    if (rewritten === null || !existsSync(rewritten)) return null;

    process.env.ESBUILD_BINARY_PATH = rewritten;
    esbuildForcedBinaryPath = rewritten;
    return rewritten;
  } catch {
    // esbuild's own resolution is correct in every case we cannot improve on.
    return null;
  }
}

/** The binary path this process forced, or `null`. Read by the packaging test. */
export function forcedEsbuildBinaryPath(): string | null {
  return esbuildForcedBinaryPath;
}

/**
 * How each external specifier must be loaded.
 *
 * `esm` matters. Three.js and Zod both publish two builds behind an `exports`
 * map, and the bundle is `format: 'esm'`: a `require`-condition resolution
 * would hand it `three/build/three.cjs` and `zod/index.cjs`, which an ESM import
 * can only load through a CJS interop wrapper — and in a *temp directory* that
 * wrapper is exactly the kind of thing that fails. Asking for the `import`
 * condition gets `three/build/three.module.js` and `zod/index.js`, which is the
 * same pair the app already loaded.
 */
type ExternalLoad = 'esm' | 'require';

/**
 * Specifiers resolved as CommonJS rather than as ES modules.
 *
 * Empty by default, and that is the right default: the bundle is `format: 'esm'`,
 * so the `import` condition is the one that matches what the output can actually
 * load. A CJS-only library has no `import` condition, so the walk falls through
 * to its `main` field and CJS interop — which is correct without a knob.
 */
const REQUIRE_EXTERNALS: ReadonlySet<string> = new Set<string>();

/** A resolution attempt, and where it came from. */
interface Resolved {
  readonly path: string;
  readonly from: 'project' | 'host';
}

const RESOLVE_CONDITIONS: Record<ExternalLoad, string[]> = {
  esm: ['import', 'module', 'default'],
  require: ['require', 'module', 'default'],
};

/** Read the `exports` field of a package manifest, or `null` if unreadable. */
function readManifest(packageJson: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(packageJson, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Join the conditions a manifest actually offers, so nothing is invented. */
function supportedConditions(manifest: Record<string, unknown>, wanted: string[]): string[] {
  const exportsField = manifest['exports'];
  if (exportsField === undefined || exportsField === null) return wanted;
  const conditions = new Set<string>();
  const collect = (node: unknown): void => {
    if (typeof node === 'string') return;
    if (Array.isArray(node)) {
      for (const child of node) collect(child);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        conditions.add(key);
        collect(child);
      }
    }
  };
  collect(exportsField);
  return wanted.filter((condition) => conditions.has(condition));
}

/** Find the `node_modules/<name>` directory that `root` would use. */
function findPackageDir(root: string, packageName: string): string | null {
  let dir = root;
  for (;;) {
    const candidate = join(dir, 'node_modules', packageName);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve `specifier` through `packageName`'s `exports` map.
 *
 * Only the subset of the `exports` grammar a dependency specifier can use: a
 * string, a conditions object, or an array of them. Anything else returns `null`,
 * and the caller falls back to Node's own resolver — which is correct for every
 * case a hand-rolled exports walker would get wrong. A partial implementation of
 * `exports` that silently produced the wrong file would be worse than none
 * (the reasoning behind D2).
 */
function resolveViaExports(
  packageDir: string,
  specifier: string,
  packageName: string,
  load: ExternalLoad,
): string | null {
  const manifest = readManifest(join(packageDir, 'package.json'));
  if (manifest === null) return null;

  const conditions = supportedConditions(manifest, RESOLVE_CONDITIONS[load]);
  if (conditions.length === 0) return null;

  const exportsField = manifest['exports'];
  if (exportsField === undefined || exportsField === null) return null;

  // `.` for the package root, `./sub/path` for a subpath export.
  const subpath = specifier === packageName ? '.' : `.${specifier.slice(packageName.length)}`;

  const entry =
    typeof exportsField === 'string' || Array.isArray(exportsField)
      ? // A shorthand `exports` only ever describes the package root.
        subpath === '.'
        ? exportsField
        : undefined
      : (exportsField as Record<string, unknown>)[subpath];
  if (entry === undefined) return null;

  const walk = (node: unknown): string | null => {
    if (typeof node === 'string') {
      return isAbsolute(node) ? node : join(packageDir, node);
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = walk(child);
        if (found !== null && existsSync(found)) return found;
      }
      return null;
    }
    if (node !== null && typeof node === 'object') {
      // Conditions in preference order: `import` before `default`, so a
      // dual-published package gives the ESM build.
      for (const condition of conditions) {
        const child = (node as Record<string, unknown>)[condition];
        if (child === undefined) continue;
        const found = walk(child);
        if (found !== null && existsSync(found)) return found;
      }
    }
    return null;
  };

  const found = walk(entry);
  return found !== null && existsSync(found) ? found : null;
}

/**
 * Resolve a bare specifier to a single absolute file path.
 *
 * Searched roots, nearest first:
 *
 *  1. **the project** — a project with its own `node_modules` uses it, so a
 *     pinned dependency is the one that runs;
 *  2. **the host** — the app's `node_modules`, found by walking up from this
 *     module. This is the fallback that makes a bare project folder with no
 *     `node_modules` of its own loadable at all, which is the normal case.
 *
 * `import.meta.resolve` is deliberately not used: it is unimplemented in
 * Vitest's module runner, and this module has to work under the test runner as
 * well as in Electron's main process.
 */
export function resolveExternal(
  projectRoot: string,
  specifier: string,
  load: ExternalLoad,
): Resolved | null {
  const roots = [projectRoot, ...HOST_RESOLVE_ROOTS];

  for (const [index, root] of roots.entries()) {
    const from: Resolved['from'] = index === 0 ? 'project' : 'host';

    // An `exports`-aware walk first, because it is the only way to get the
    // `import` condition right for a dual-published package.
    const packageName = packageNameOf(specifier);
    if (packageName !== null) {
      const packageDir = findPackageDir(root, packageName);
      if (packageDir !== null) {
        const viaExports = resolveViaExports(packageDir, specifier, packageName, load);
        if (viaExports !== null) return { path: viaExports, from };

        // No usable `exports` entry: fall back to the manifest's own fields.
        // `module` before `main` for ESM, because `main` is usually CJS.
        const manifest = readManifest(join(packageDir, 'package.json'));
        const fallback = manifest?.[load === 'esm' ? 'module' : 'main'];
        if (typeof fallback === 'string') {
          return { path: join(packageDir, fallback), from };
        }
      }
    }

    // Last resort for anything the walks above did not understand: Node's own
    // resolver, which is right for `node:` builtins and odd layouts.
    try {
      return { path: createRequire(join(root, 'noop.js')).resolve(specifier), from };
    } catch {
      // Try the next root.
    }
  }

  return null;
}

/**
 * The package a bare specifier names, or `null` if it is not a bare specifier.
 *
 * `'zod'` → `'zod'`, `'@scope/name'` → `'@scope/name'`, `'@scope/name/sub'` →
 * `'@scope/name'`, `'./rel'` → `null`.
 */
function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith('.') || isAbsolute(specifier)) return null;
  if (!specifier.startsWith('@')) return specifier;
  const [scope, name] = specifier.slice(1).split('/');
  return scope === undefined || name === undefined ? null : `@${scope}/${name}`;
}

/**
 * The directories the host resolves from, nearest first.
 *
 * `import.meta.url` is captured once at module load, and each entry is a *file*
 * path, which is what the upward `node_modules` walk and `createRequire` both
 * need. Walking up three levels from `src/electron/` or from `dist/electron/`
 * reaches the workspace root in either layout.
 */
const HOST_RESOLVE_ROOTS: string[] = [dirname(fileURLToPath(import.meta.url))];

/**
 * esbuild plugin: make every bare specifier an absolute external import.
 *
 * A temp bundle has no `node_modules` above it, so a left-alone `import 'zod'`
 * would fail at *import* time even though esbuild resolved it at build time.
 * Rewriting to an absolute URL is what makes the written file self-sufficient.
 *
 * Every hit is marked `external`, so the bundle keeps an absolute `import`
 * instead of inlining a library. See the file header for why Three.js in
 * particular must not be inlined.
 */
function externalResolverPlugin(projectRoot: string): Plugin {
  return {
    name: 'cf-prefab-external-resolver',
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return undefined;
        if (args.path.startsWith('.') || isAbsolute(args.path)) return undefined;

        // `node:` builtins and the app's own `three`/`core` externals stay as
        // specifiers: esbuild already knows not to bundle them, and rewriting
        // them would be churn.
        if (BUILTIN_SPECIFIERS.has(args.path)) return { path: args.path, external: true };
        if (EXTERNAL_SPECIFIERS.includes(args.path as (typeof EXTERNAL_SPECIFIERS)[number])) {
          return { path: args.path, external: true };
        }

        const load: ExternalLoad = REQUIRE_EXTERNALS.has(args.path) ? 'require' : 'esm';
        const resolved = resolveExternal(projectRoot, args.path, load);
        if (resolved !== null) return { path: resolved.path, external: true };

        return {
          errors: [
            {
              text:
                `Cannot resolve "${args.path}" from the prefab bundle — not from the project ` +
                `(${projectRoot}) and not from the app. Install it in the project, or drop the import.`,
            },
          ],
        };
      });
    },
  };
}

/** Node builtins a prefab may import; left as specifiers, never bundled. */
const BUILTIN_SPECIFIERS = new Set<string>([
  'fs',
  'path',
  'os',
  'url',
  'crypto',
  'util',
  'module',
  'assert',
  'events',
  'stream',
  'buffer',
  'node:fs',
  'node:path',
  'node:os',
  'node:url',
  'node:crypto',
  'node:util',
  'node:module',
  'node:assert',
  'node:events',
  'node:stream',
  'node:buffer',
]);

/** A bundle on disk, and how to remove it. */
export interface BundleHandle {
  /** Absolute path of the written `.mjs`. */
  readonly file: string;
  /** Remove the bundle's temp directory. Safe to call twice. */
  dispose(): void;
}

/** A written bundle and the URL to import it from. */
export interface Bundle {
  readonly handle: BundleHandle;
  readonly importUrl: string;
}

/**
 * Bundle one entry point into a temp `.mjs` and return it.
 *
 * `write: false` plus our own write is deliberate: it puts the file's lifecycle
 * in one place, so the caller can dispose of the temp directory on every path
 * including a failed import. The temp dir is unique per call, so two loads of
 * two projects never collide, and `dispose` removes the whole directory rather
 * than one file.
 */
export async function bundleEntry(entryPoint: string, projectRoot: string): Promise<Bundle> {
  const dir = mkdtempSync(join(tmpdir(), 'contextforge-prefabs-'));
  let disposed = false;
  const handle: BundleHandle = {
    file: join(dir, 'registry.mjs'),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };

  try {
    // Before `build()`: inside an asar this rewrites esbuild's binary path to the
    // unpacked real file. See `ensureEsbuildBinaryIsExecutable` for why `spawn` needs it.
    ensureEsbuildBinaryIsExecutable();
    // The import is *here*, after the guard, and not at the top of the file: esbuild
    // captures `process.env.ESBUILD_BINARY_PATH` into a module-scope constant when its
    // module is evaluated and never re-reads the environment. A static import is hoisted
    // above every statement here, so it would capture the unset value first — the exact
    // packaged `spawn ENOTDIR` bug. Loading it dynamically, after the guard, evaluates it
    // with the path already in place.
    const { build } = await import('esbuild');
    const result = await build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      write: false,
      sourcemap: 'inline',
      // Belt and braces: the resolver plugin marks these external too, but the
      // explicit list documents the intent where esbuild's options are read.
      external: [...EXTERNAL_SPECIFIERS],
      plugins: [externalResolverPlugin(projectRoot)],
      logLevel: 'silent',
    });

    const output = result.outputFiles[0];
    if (output === undefined) {
      throw new Error(`esbuild produced no output for ${entryPoint}`);
    }

    // **Every third-party specifier becomes an absolute file URL.** The bundle
    // lives in an OS temp directory with no `node_modules` above it, so a
    // left-alone `import 'some-lib'` — or esbuild's bare absolute path — would
    // fail at import time even though esbuild resolved it at build time.
    // Rewriting here rather than only in the resolver plugin means the file on
    // disk is correct, not just esbuild's bookkeeping.
    //
    // `three` and `@contextforge/core` are *not* rewritten: they are the app's
    // own externals, and a temp path to them would be a *second* copy of
    // Three.js — megabytes, and a class identity that would break `instanceof
    // Mesh` across the boundary. A bare `three` in an ESM bundle is resolved
    // through the host's own module graph, which is the single copy.
    const code = output.text.replace(
      /(\bfrom\s*|\bimport\s*|\bimport\()(["'])([^"']+)\2/g,
      (match, keyword: string, quote: string, specifier: string) => {
        if (EXTERNAL_SPECIFIERS.includes(specifier as (typeof EXTERNAL_SPECIFIERS)[number])) return match;
        if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return match; // already a URL, or node:
        if (specifier.startsWith('.')) return match; // relative: esbuild resolved it
        // Everything else is a bare specifier or an absolute path esbuild wrote
        // for an external, and both need to become a URL Node can load from a
        // temp directory.
        return `${keyword}${quote}${pathToFileURL(specifier).href}${quote}`;
      },
    );

    writeFileSync(handle.file, code, 'utf-8');
  } catch (error) {
    handle.dispose();
    throw error;
  }

  return { handle, importUrl: pathToFileURL(handle.file).href };
}

/**
 * An esbuild plugin that bundles prefabs as a browser ES module.
 * Inlines project/host dependencies like Zod, shims Three and @contextforge/core
 * to refer to global/injected objects.
 */
function browserExternalResolverPlugin(projectRoot: string): Plugin {
  return {
    name: 'cf-browser-external-resolver',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^three(\/.*)?$/ }, (args) => ({
        path: args.path,
        namespace: 'three-browser-shim',
      }));
      buildApi.onLoad({ filter: /.*/, namespace: 'three-browser-shim' }, () => ({
        contents: `
          const T = (typeof window !== 'undefined' && ((window as any).__THREE__ || (window as any).THREE))
            || (typeof globalThis !== 'undefined' && ((globalThis as any).__THREE__ || (globalThis as any).THREE))
            || {};
          export default T;
          export const {
            BoxGeometry, SphereGeometry, CylinderGeometry, PlaneGeometry, TorusGeometry,
            Mesh, Group, Object3D, Vector3, Color,
            MeshStandardMaterial, MeshBasicMaterial, CanvasTexture, Texture
          } = T;
        `,
        loader: 'ts',
      }));

      buildApi.onResolve({ filter: /^@contextforge\/core(\/.*)?$/ }, (args) => ({
        path: args.path,
        namespace: 'cf-core-browser-shim',
      }));
      buildApi.onLoad({ filter: /.*/, namespace: 'cf-core-browser-shim' }, () => ({
        contents: `
          const core = (typeof window !== 'undefined' && (window as any).__CF_CORE__)
            || (typeof globalThis !== 'undefined' && (globalThis as any).__CF_CORE__)
            || {};
          export default core;
          export const { rngFor, mulberry32 } = core;
        `,
        loader: 'ts',
      }));

      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return undefined;
        if (args.path.startsWith('.') || isAbsolute(args.path)) return undefined;

        // Resolve external package (e.g. zod) using host or project node_modules
        const resolved = resolveExternal(projectRoot, args.path, 'esm');
        if (resolved !== null) {
          // Do not mark as external; return path so esbuild bundles it into browser module
          return { path: resolved.path };
        }

        return {
          errors: [
            {
              text: `Cannot resolve "${args.path}" for browser prefab bundle from ${projectRoot}`,
            },
          ],
        };
      });
    },
  };
}

/** Result of bundling prefabs for the browser. */
export interface BrowserBundle {
  /** The bundled JavaScript code for the browser ES module. */
  readonly code: string;
  /** Disposable handle for the bundle on disk. */
  readonly handle: BundleHandle;
}

/**
 * Bundle a project's prefabs into a single browser-loadable ES module.
 * Inlines dependencies such as Zod and provides shims for Three.js and core.
 */
export async function bundlePrefabsForBrowser(
  projectRootOrEntry: string,
  options: LoadOptions = {},
): Promise<BrowserBundle> {
  let projectRoot: string;
  let entryPoint: string;

  if (
    projectRootOrEntry.endsWith('.ts') ||
    projectRootOrEntry.endsWith('.js') ||
    projectRootOrEntry.endsWith('.mjs')
  ) {
    entryPoint = resolvePath(projectRootOrEntry);
    projectRoot = dirname(dirname(entryPoint));
  } else {
    projectRoot = resolvePath(projectRootOrEntry);
    const prefabDir = options.prefabDir ?? join(projectRoot, 'prefabs');
    entryPoint = join(prefabDir, 'index.ts');
  }

  const dir = mkdtempSync(join(tmpdir(), 'contextforge-browser-prefabs-'));
  let disposed = false;
  const handle: BundleHandle = {
    file: join(dir, 'browser-bundle.mjs'),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };

  try {
    ensureEsbuildBinaryIsExecutable();
    // Dynamic for the same reason as `bundleEntry`: esbuild must be evaluated with
    // `ESBUILD_BINARY_PATH` already set, which a hoisted static import cannot guarantee.
    const { build } = await import('esbuild');
    const result = await build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      write: false,
      sourcemap: 'inline',
      plugins: [browserExternalResolverPlugin(projectRoot)],
      logLevel: 'silent',
    });

    const output = result.outputFiles[0];
    if (output === undefined) {
      throw new Error(`esbuild produced no output for ${entryPoint}`);
    }

    const code = output.text;
    writeFileSync(handle.file, code, 'utf-8');
    return { code, handle };
  } catch (error) {
    handle.dispose();
    throw error;
  }
}

// ── Loading ──────────────────────────────────────────────────────────────────

/** Incremented per import so a rebuild is never served from Node's module cache. */
let importGeneration = 0;

/** Import a freshly written bundle, bypassing the module cache. */
async function importFresh(importUrl: string): Promise<ModuleExports> {
  importGeneration += 1;
  return (await import(`${importUrl}?v=${importGeneration}`)) as ModuleExports;
}

/** The `prefabs` array of a bundle's registry export, or `null` if there is none. */
function registryOf(module: ModuleExports): readonly unknown[] | null {
  const candidate = module['registry'] ?? module['default'];
  if (candidate === null || typeof candidate !== 'object') return null;
  const prefabs = (candidate as { prefabs?: unknown }).prefabs;
  return Array.isArray(prefabs) ? (prefabs as readonly unknown[]) : null;
}

/** Every `prefabs/*.ts` file except the index, in a stable order (SPEC R8). */
export function prefabSourceFiles(prefabDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(prefabDir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.d.ts') && entry !== 'index.ts')
    .filter((entry) => {
      try {
        return statSync(join(prefabDir, entry)).isFile();
      } catch {
        return false;
      }
    })
    .sort()
    .map((entry) => join(prefabDir, entry));
}

/**
 * Recover prefabs from each source file separately.
 *
 * The fallback for a registry that cannot be evaluated at all. `prefabs/index.ts`
 * is a barrel: it imports every prefab, so one throwing file takes the barrel
 * down with it. Importing the files one at a time contains the blast radius to
 * one prefab — the difference between eleven working prefabs and none.
 */
async function loadPerFile(
  prefabDir: string,
  projectRoot: string,
  three: PrefabThreeModule,
): Promise<PrefabRegistryResult> {
  const result: PrefabRegistryResult = { prefabs: [], failed: [] };
  const seen = new Map<string, string>();

  for (const file of prefabSourceFiles(prefabDir)) {
    let handle: BundleHandle | null = null;
    try {
      const bundle = await bundleEntry(file, projectRoot);
      handle = bundle.handle;
      const module = await importFresh(bundle.importUrl);

      const listed = registryOf(module);
      const definitions: PrefabDefinition[] =
        listed !== null
          ? listed.filter(isPrefabDefinition)
          : Object.values(module).filter(isPrefabDefinition);

      if (definitions.length === 0) {
        result.failed.push({
          name: basename(file, '.ts'),
          file,
          reason:
            'exports no prefab definition — no `registry`, and no export with a `name` and a `create`',
        });
        continue;
      }
      for (const definition of definitions) {
        collect(result, seen, definition, file, three);
      }
    } catch (error) {
      result.failed.push({ name: basename(file, '.ts'), file, reason: describeError(error) });
    } finally {
      handle?.dispose();
    }
  }

  return result;
}

/** Options for `loadPrefabRegistry`. */
export interface LoadOptions {
  /** Directory holding `index.ts`. Defaults to `<projectRoot>/prefabs`. */
  readonly prefabDir?: string;
}

/**
 * Load a project's prefabs. Never throws.
 *
 * Returns the registry the viewer draws, plus one `PrefabFailure` per prefab
 * that could not be used. A missing `prefabs/` directory is a failure row rather
 * than a throw, because a project the developer has just created has no prefabs
 * and the Scene screen must still open.
 */
export async function loadPrefabRegistry(
  projectRoot: string,
  options: LoadOptions = {},
): Promise<PrefabRegistryResult> {
  const root = resolvePath(projectRoot);
  const prefabDir = options.prefabDir ?? join(root, 'prefabs');
  const indexPath = join(prefabDir, 'index.ts');
  const result: PrefabRegistryResult = { prefabs: [], failed: [] };

  if (!existsSync(prefabDir)) {
    result.failed.push({
      name: 'prefabs',
      file: prefabDir,
      reason: `no prefabs directory at ${prefabDir} — a project has no prefabs until one is created`,
    });
    return result;
  }

  if (!existsSync(indexPath)) {
    result.failed.push({
      name: 'prefabs',
      file: indexPath,
      reason: `no registry at ${indexPath} — a prefabs directory must have an index.ts exporting a registry`,
    });
    return result;
  }

  let three: PrefabThreeModule;
  try {
    // A bare `import 'three'` from *this* module works, because the app's own
    // module graph resolves it — and it must be the same instance the prefabs
    // get, or `instanceof Mesh` would be false across the boundary. Dynamic, so
    // the module stays importable (and testable) without Three.js loaded.
    three = (await import('three')) as unknown as PrefabThreeModule;
  } catch (error) {
    result.failed.push({
      name: 'prefabs',
      file: prefabDir,
      reason: `could not load Three.js, which the main process provides to every prefab: ${describeError(error)}`,
    });
    return result;
  }

  const seen = new Map<string, string>();
  let handle: BundleHandle | null = null;

  try {
    const bundle = await bundleEntry(indexPath, root);
    handle = bundle.handle;
    const module = await importFresh(bundle.importUrl);

    const listed = registryOf(module);
    if (listed === null) {
      throw new Error(
        'the registry module exports no `registry` object with a `prefabs` array ' +
          `(saw: ${Object.keys(module).join(', ') || 'nothing'})`,
      );
    }

    for (const entry of listed) {
      if (!isPrefabDefinition(entry)) {
        const name =
          entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string'
            ? (entry as { name: string }).name
            : '(unnamed)';
        result.failed.push({
          name,
          file: indexPath,
          reason:
            'is listed in the registry but is not a prefab definition — it needs a `name: string` ' +
            'and a `create(three, params, rng)` function',
        });
        continue;
      }
      collect(result, seen, entry, indexPath, three);
    }
    return result;
  } catch (error) {
    // The barrel itself failed. Report it, then recover file by file, so one
    // broken prefab does not cost the whole registry.
    result.failed.push({
      name: 'prefabs/index.ts',
      file: indexPath,
      reason: `${describeError(error)} — every prefab is loaded file by file instead.`,
    });
    const recovered = await loadPerFile(prefabDir, root, three);
    result.prefabs.push(...recovered.prefabs);
    result.failed.push(...recovered.failed);
    return result;
  } finally {
    handle?.dispose();
  }
}

// ── Watching ─────────────────────────────────────────────────────────────────

/** How long changes are collected before a rebuild (ms). */
export const WATCH_DEBOUNCE_MS = 150;

/** The loader the main process holds for the open project. */
export interface PrefabLoader {
  /** The project this loader watches. */
  readonly projectRoot: string;
  /** The last successful load, or `null` before the first one. */
  current(): PrefabRegistryResult | null;
  /** Reload and return the new registry. Does not notify subscribers. */
  reload(): Promise<PrefabRegistryResult>;
  /** Stop watching. Idempotent. */
  dispose(): void;
}

/** Options for `createPrefabLoader`. */
export interface PrefabLoaderOptions extends LoadOptions {
  /** Called after every rebuild triggered by a change. */
  readonly onChanged?: (registry: PrefabRegistryResult) => void;
  /** Debounce window for filesystem events. Defaults to `WATCH_DEBOUNCE_MS`. */
  readonly debounceMs?: number;
}

/**
 * Create a loader that keeps a project's registry current.
 *
 * The watcher is `fs.watch` on the prefabs directory, debounced, because saving
 * one file fires several events and an AI writing four files fires dozens. One
 * rebuild per burst is the difference between a live inspector and a rebuild
 * storm. Rebuilds are serialised on a promise chain so two overlapping rebuilds
 * cannot land out of order.
 *
 * **A project with no `prefabs/` yet** is the case worth naming: there is nothing
 * to watch, so the loader watches the *project root* instead and re-checks after
 * every event. Creating `prefabs/index.ts` then picks the watcher up with no app
 * restart — which matters, because the fresh-project state is the state the app
 * is in most often during a first session.
 */
export function createPrefabLoader(
  projectRoot: string,
  options: PrefabLoaderOptions = {},
): PrefabLoader {
  const root = resolvePath(projectRoot);
  const prefabDir = options.prefabDir ?? join(root, 'prefabs');
  const debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;

  let current: PrefabRegistryResult | null = null;
  let disposed = false;
  let watcher: FSWatcher | null = null;
  let watchedDir: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let rebuilding: Promise<void> = Promise.resolve();

  const load = (): Promise<PrefabRegistryResult> => loadPrefabRegistry(root, { prefabDir });

  /** Watch `dir`, closing any previous watcher. Best effort: never throws. */
  const attach = (dir: string): void => {
    if (watchedDir === dir) return;
    if (watcher !== null) {
      try {
        watcher.close();
      } catch {
        // Already closed by the OS.
      }
      watcher = null;
    }
    watchedDir = dir;
    try {
      watcher = watch(dir, { persistent: false }, () => schedule());
    } catch {
      // The directory vanished between the check and the watch — an AI deleting
      // `prefabs/` does that. Fall back to the project root, which always exists.
      watchedDir = null;
      if (dir !== root) attach(root);
    }
  };

  const schedule = (): void => {
    if (disposed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      rebuilding = rebuilding
        .then(async () => {
          if (disposed) return;
          const result = await load();
          if (disposed) return;
          current = result;
          attach(existsSync(prefabDir) ? prefabDir : root);
          options.onChanged?.(result);
        })
        .catch(() => {
          // `loadPrefabRegistry` is documented not to throw; this is the
          // belt-and-braces path so no watcher can take the main process down.
        });
    }, debounceMs);
    timer.unref?.();
  };

  attach(existsSync(prefabDir) ? prefabDir : root);

  return {
    projectRoot: root,
    current: () => current,
    async reload(): Promise<PrefabRegistryResult> {
      const result = await load();
      if (disposed) return result;
      current = result;
      attach(existsSync(prefabDir) ? prefabDir : root);
      return result;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (watcher !== null) {
        try {
          watcher.close();
        } catch {
          // Already closed.
        }
        watcher = null;
      }
      watchedDir = null;
      current = null;
    },
  };
}

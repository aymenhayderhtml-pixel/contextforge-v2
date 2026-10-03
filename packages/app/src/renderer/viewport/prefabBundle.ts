/**
 * prefabBundle.ts — load browser ES module prefab bundles into the renderer.
 *
 * Takes a browser-bundled ES module (as code, data URL, blob URL, or module namespace)
 * and extracts executable `PrefabDefinition` objects whose `create` functions
 * can be invoked with Three.js.
 */

import type { PrefabDefinition } from '@contextforge/core';
import { registerPrefabs } from './registry.js';

/** Check if a value is an executable PrefabDefinition. */
export function isPrefabDefinition(value: unknown): value is PrefabDefinition {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as PrefabDefinition).name === 'string' &&
    (value as PrefabDefinition).name.length > 0 &&
    typeof (value as PrefabDefinition).create === 'function'
  );
}

/** Extract all executable prefab definitions from an imported module namespace. */
export function extractPrefabDefinitions(moduleObj: unknown): PrefabDefinition[] {
  if (moduleObj === null || typeof moduleObj !== 'object') return [];

  const candidate =
    (moduleObj as Record<string, unknown>).registry ??
    (moduleObj as Record<string, unknown>).default ??
    moduleObj;

  if (candidate !== null && typeof candidate === 'object') {
    const prefabs = (candidate as { prefabs?: unknown }).prefabs;
    if (Array.isArray(prefabs)) {
      return prefabs.filter(isPrefabDefinition);
    }
  }

  return Object.values(moduleObj as Record<string, unknown>).filter(isPrefabDefinition);
}

/**
 * Import a raw JavaScript string as a module.
 *
 * Two paths, because the two runtimes disagree about whether `blob:` is
 * importable and the difference is not negotiable in either direction:
 *
 *  - **The renderer** goes through a `blob:` URL. `script-src` allows `blob:`
 *    and deliberately does not allow `data:` (see `CONTENT_SECURITY_POLICY` in
 *    the main process): a `data:` URL can carry any script, so allowing it would
 *    hand an injected string the ability to run, which is exactly what
 *    `contextIsolation` and the policy exist to prevent.
 *  - **Node** (the headless tests) has no CSP but its ESM loader cannot import a
 *    `blob:` URL at all — it treats it as a bare specifier and fails with
 *    "Cannot find package 'blob:...'". There, `data:` is the only encoding the
 *    loader accepts.
 *
 * So the branch is on what the runtime supports, not on what the policy wants,
 * and the CSP is enforced in the place it applies. Each path revokes/frees its
 * own URL when the import settles.
 */
async function importRawModule(code: string): Promise<unknown> {
  if (canImportBlob()) {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try {
      return await import(/* @vite-ignore */ url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // `Buffer` is a Node global and this module also compiles for the renderer,
  // whose tsconfig deliberately has no Node types. Reached through
  // `globalThis` with a typed lookup rather than a bare `Buffer`, which would
  // drag `@types/node` into the renderer build for one call.
  const nodeBuffer = (globalThis as { Buffer?: { from(s: string, enc: string): { toString(enc: string): string } } })
    .Buffer;
  if (nodeBuffer === undefined) {
    throw new Error('loadPrefabBundle: no way to encode a module in this runtime');
  }
  const base64 = nodeBuffer.from(code, 'utf-8').toString('base64');
  return import(/* @vite-ignore */ `data:text/javascript;base64,${base64}`);
}

/**
 * Whether this runtime can `import()` a `blob:` URL.
 *
 * Chromium can; Node cannot and fails with a package-resolution error. The check
 * is deliberately a real one rather than a `typeof window` guess, because the
 * renderer is the only place the distinction matters and a wrong guess there
 * would be a CSP violation at runtime.
 */
function canImportBlob(): boolean {
  try {
    // Node defines this global; the browser does not.
    return typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node !== 'string';
  } catch {
    return true;
  }
}

/**
 * Load prefabs from an ES module, code bundle, or URL, registering them into
 * the viewport's runtime registry.
 *
 * A raw code string is turned into a module by `importRawModule` — see there for
 * why the renderer uses `blob:` and Node uses `data:`.
 */
export async function loadPrefabBundle(codeOrUrlOrModule: unknown): Promise<PrefabDefinition[]> {
  if (codeOrUrlOrModule === null || codeOrUrlOrModule === undefined) return [];

  let moduleObj: unknown;
  if (typeof codeOrUrlOrModule === 'string') {
    const str = codeOrUrlOrModule.trim();
    if (
      str.startsWith('http://') ||
      str.startsWith('https://') ||
      str.startsWith('file://') ||
      str.startsWith('data:') ||
      str.startsWith('blob:')
    ) {
      moduleObj = await import(/* @vite-ignore */ str);
    } else {
      moduleObj = await importRawModule(str);
    }
  } else if (typeof codeOrUrlOrModule === 'object') {
    moduleObj = codeOrUrlOrModule;
  } else {
    return [];
  }

  const definitions = extractPrefabDefinitions(moduleObj);
  registerPrefabs(definitions);
  return definitions;
}

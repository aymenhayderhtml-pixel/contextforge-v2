/**
 * vite.config.ts — the renderer build.
 *
 * Three things are decided here, and each exists for a reason the config file
 * states.
 *
 * 1. **`plugins: [svelte()]` with no preprocess.** The renderer has no TypeScript
 *    inside `.svelte` files, so it needs no preprocessing step. Adding one would
 *    mean another transform the build could fail at, for nothing.
 *
 * 2. **`build.outDir: 'dist/renderer'`, `emptyOutDir: false`.** The renderer is
 *    built into a subdirectory of `dist` because `dist/electron` holds the
 *    `tsc` output of the main process, and an empty-out-dir would delete it. The
 *    two builds write side by side and neither owns the other.
 *
 * 3. **`resolve.alias` for the runes shim, applied to `dev` and `test` only.**
 *    `src/renderer/runes.ts` is written against `svelte/internal/client` so the
 *    real `$state` is used in the app. Vitest runs in Node with no component, and
 *    while Svelte's rune runtime does work there, this alias makes the test
 *    environment's semantics explicit and independent of that: under test the
 *    shim is a two-function `get`/`set` over a plain value. The store is written
 *    so that is equivalent — it never mutates state in place, every change
 *    replaces the whole `EditorState` — which is what makes one implementation
 *    serve both environments honestly instead of approximately.
 *
 * The aliases are the one piece of build configuration that both the app and the
 * tests depend on, so the vitest side is asserted by
 * `packages/app/test/shell/runes.test.ts` rather than left as a comment here.
 */

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const SRC = fileURLToPath(new URL('./src', import.meta.url));
const REND = fileURLToPath(new URL('./src/renderer', import.meta.url));

/** Aliases that only apply outside a real Svelte bundle. */
const headlessAliases = {
  'svelte/internal/client': fileURLToPath(new URL('./test/shell/headlessRunes.ts', import.meta.url)),
  '$lib': REND,
};

export default defineConfig(({ mode }) => {
  const headless = mode === 'test' || mode === 'development';

  return {
    base: './',
    // Vite's own dev server is not used by `npm start` — the app loads a built
    // bundle from disk in both modes (see `electron/main.ts`). It exists only for
    // working on the renderer in a browser, where there is no preload and
    // therefore no bridge to talk to.
    plugins: [svelte()],

    resolve: {
      alias: headless ? headlessAliases : { $lib: REND },
      // Core is published as a package with an `exports` map, so it resolves
      // normally; the conditions matter because the renderer is a *browser*
      // bundle and must not pick up a Node-only entry point.
      conditions: ['browser', 'import', 'default'],
    },

    build: {
      outDir: 'dist/renderer',
      emptyOutDir: false,
      target: 'chrome130',
      // Electron 44 ships Chromium 130. Targeting it means no downlevelled
      // syntax and no polyfills, which is also why the renderer can use `?.` and
      // `??` freely and why core's targets need no transpiling.
      sourcemap: true,
      minify: false,
      rollupOptions: {
        // All renderer imports of @contextforge/core are `import type` (erased
        // at build time). Externalizing prevents Vite from accidentally pulling
        // in tree-sitter, node:fs, node:path — which are not available in the
        // renderer sandbox. The one runtime function the renderer needed
        // (rngFor) lives in renderer/viewport/rng.ts instead.
        external: ['@contextforge/core'],
      },
    },

    server: {
      port: 5178,
      strictPort: true,
    },
  };
});

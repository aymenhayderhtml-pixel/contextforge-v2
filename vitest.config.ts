import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

/**
 * One runner for every package.
 *
 * Three settings are load-bearing and none has a sensible default:
 *
 *  - **`pool: 'forks'`.** tree-sitter grammars are native modules loaded per
 *    process. Fork workers (rather than threads) keep the native handle on its own
 *    thread, which is what makes the grammar tests reliable rather than
 *    intermittently segfaulting.
 *
 *  - **the Svelte plugin.** Without it, a test that imports a `.svelte` file
 *    fails during *import analysis* — before any assertion runs — so the failure
 *    reads as a broken component rather than as a missing plugin. The renderer
 *    has real components under test, so the plugin is registered for all
 *    packages; core never imports one, and pays only for the transform hook
 *    never firing.
 *
 *  - **the `svelte/internal/client` alias.** Under Node there is no bundle, so
 *    `runes.ts` would reach Svelte's real rune runtime. The store is written
 *    against that module so its logic can be exercised headlessly; this alias
 *    points at the plain-object implementation the app's own tests use, and
 *    `runes.ts` exports `usingRealRunes` so a test can assert which one is live.
 *    See `packages/app/src/renderer/runes.ts` for why the two are equivalent for
 *    a store that never mutates state in place.
 */
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      'svelte/internal/client': fileURLToPath(
        new URL('./packages/app/test/shell/headlessRunes.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    pool: 'forks',
    // The watcher tests wait on real `fs.watch` events behind a 150ms debounce,
    // and the smoke suite extracts a whole real project, so the timeout has to be
    // generous. These are the only tests that wait.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

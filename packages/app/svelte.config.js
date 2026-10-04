/**
 * packages/app/svelte.config.js
 *
 * The Svelte compiler config, as `svelte-check` needs it.
 *
 * **Why this file exists at all, given that `vite.config.ts` uses the Vite plugin
 * with no config file.** Because `svelte-check` does not read `vite.config.ts`: it
 * wants a Svelte config, and without one it reports "No Svelte configuration found
 * in vite config" once per component — twelve identical errors that are all the
 * same missing-file error. A gate that reports a dozen copies of one
 * configuration mistake buries the thirty-odd real type errors underneath it.
 *
 * `vitePreprocess` is what strips the TypeScript out of `<script lang="ts">`.
 * The Vite plugin gets that for free through its own default; `svelte-check` has
 * no Vite plugin behind it, so it needs this explicitly. Without it, every
 * `lang="ts"` component is a parse error rather than a type-checked file.
 *
 * It is deliberately minimal and deliberately mirrors the Vite plugin's settings:
 * no custom compiler options, no extensions, nothing the build does not also do.
 * A config that disagreed with `vite.config.ts` would type-check a program that is
 * not the one that ships, which is worse than no check.
 */

import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
};

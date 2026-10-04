/**
 * Ambient types for the renderer's build-time constants.
 *
 * **`import.meta.env` is Vite's, and TypeScript does not know it** without this
 * file. `ProblemsPanel.svelte` reads `import.meta.env.DEV` inside a `$effect`
 * that throws when the panel's count disagrees with its parent's (D44), and that
 * read was a type error until this existed: `Property 'env' does not exist on
 * type 'ImportMeta'`.
 *
 * Declared as a `.d.ts` inside the app rather than pulling in `vite/client` via
 * `compilerOptions.types`, because the app's tsconfig sets `"types": ["node"]`
 * deliberately — adding `vite` to that list would load Vite's whole ambient
 * surface into the *main* process too, which has no `import.meta.env` and does
 * not want one. This file scopes the declaration to the renderer, which is the
 * only place that has a Vite build around it.
 *
 * `ImportMetaEnv` is the interface Vite merges its own keys into, so a value Vite
 * does not define here is still an error rather than silently `undefined` — which
 * is the property that matters: `import.meta.env.DEV` must not quietly be `undefined`
 * and disable the D44 guard in production.
 */

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
  readonly BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

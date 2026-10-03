/**
 * node-builtin-refusal.mjs — `node:fs` and `node:path` for a headless harness
 * that is standing in for a browser.
 *
 * The generated project's `loadScene.ts` is a **browser** module: it fetches
 * `scene.json` and never calls core's `loadScene()`/`saveScene()`, which are the
 * only functions in `@contextforge/core` that touch a filesystem. Core is
 * headless by rule (SPEC R3), so it must not grow a browser-only branch to avoid
 * importing `node:fs` at all.
 *
 * `redirectNodeBuiltins()` in `step3.e2e.test.ts` points the generated code's
 * `node:fs`/`node:path` imports here. Every export **throws**, naming what was
 * called — because the alternative is worse:
 *
 *  - A stub returning `undefined` makes `loadScene()` report "no scene at
 *    <path>" for a project whose `scene.json` is sitting right there. That is a
 *    wrong answer that reads exactly like a right one (SPEC R9).
 *  - A stub that emulates a filesystem in memory is a second implementation of
 *    "what is on disk", and the test would then be asserting against its own
 *    fiction rather than against the file the generator wrote.
 *
 * If a real call ever reaches one of these, the test fails naming the function
 * and the reason, which is the outcome worth having.
 */

/** Build a function that refuses, naming what was called and what to do instead. */
function refuse(specifier, name, instead) {
  return () => {
    throw new Error(
      `${specifier}'s ${name}() was called from a project that fetches scene.json over HTTP. ` +
        `${instead}`,
    );
  };
}

export const existsSync = refuse('node:fs', 'existsSync', 'Fetch the scene instead.');
export const readFileSync = refuse('node:fs', 'readFileSync', 'Fetch the scene instead.');
export const writeFileSync = refuse('node:fs', 'writeFileSync', 'This module cannot write files.');
export const mkdirSync = refuse('node:fs', 'mkdirSync', 'This module cannot create folders.');
export const dirname = refuse('node:path', 'dirname', 'Use a URL instead of a filesystem path.');
export const join = refuse('node:path', 'join', 'Use URL resolution instead of path joining.');
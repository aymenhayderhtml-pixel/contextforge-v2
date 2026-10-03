/**
 * test/shell/headlessRunes.ts — the Node implementation of the runes shim.
 *
 * Vite aliases `svelte/internal/client` to this file in `development` and `test`
 * (see `vite.config.ts`). Under a real Svelte build the alias is not applied and
 * the app uses genuine `$state`.
 *
 * ## What is guaranteed to be the same in both
 *
 * `get` returns the value, `set` replaces it, and a `Source<T>` is read only
 * through those two functions. That is the entire contract `store.ts` relies on,
 * because the store never mutates a value in place: every change replaces the
 * whole `EditorState` with a new object. There is therefore nothing in the store
 * that behaves differently here than in the browser.
 *
 * ## What is not the same
 *
 * Reactivity. There are no effects, so nothing re-renders on a `set`. That is
 * fine for a test and it is *only* fine for a test — a test asserts the value
 * the store exposes, which is what a component would read. A test that needed to
 * assert re-rendering would be testing the component, and that is a different
 * suite with a different tool.
 *
 * The point of the split is that this is stated here rather than discovered later:
 * if the store ever grows an in-place mutation — pushing onto an array it read
 * from state, say — it will pass every test in this file's world and be wrong in
 * the browser. `store.test.ts` asserts the store's own invariant, which is the
 * guard for that.
 */

import type { Source } from '../../src/renderer/runes.js';

/** A `Source` in Node: the value itself, read only through `get`/`set`. */
export type PlainSource<T> = { readonly __value: T };

/**
 * A reactive value, outside a component.
 *
 * Marked with a brand so a `Source` from the real runtime can be told apart from
 * one made here if that ever matters. It is not exported, because nothing should
 * need it.
 */
export function state<T>(initial: T): Source<T> {
  return { __value: initial } as unknown as Source<T>;
}

/** Read a source. */
export function get<T>(source: Source<T>): T {
  return (source as unknown as PlainSource<T>).__value;
}

/** Replace a source's value. */
export function set<T>(source: Source<T>, value: T): void {
  (source as unknown as { __value: T }).__value = value;
}

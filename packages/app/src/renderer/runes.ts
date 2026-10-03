/**
 * renderer/runes.ts — a two-function shim over Svelte's rune internals.
 *
 * ## Why this exists
 *
 * The store holds editor state in Svelte 5 `$state`, which means a plain Vitest
 * run — no browser, no component tree, no Electron — cannot exercise the logic
 * the task cares about: an edit producing a new snapshot, undo, a disk change
 * arriving. A store that can only be tested by mounting a component is a store
 * whose logic is untested.
 *
 * So the store is written against two functions declared here, and the real ones
 * are substituted at bundle time. Two lines of configuration in `vite.config.ts`
 * (D1) buy a store that is testable in Node and uses real runes in the app, with
 * no `#if` in the store and no second implementation to drift.
 *
 * ## Why not `svelte/store` instead
 *
 * Svelte's `writable` is a store contract, not a reactivity primitive: it needs
 * an explicit `subscribe`, and a component reading it needs a `$` prefix that
 * does not survive into a plain function. `$state` is the opposite — a plain
 * property that is reactive where it is read, with no subscription plumbing at
 * all. Using `writable` here would mean the store's API is "subscribe to me",
 * which is a worse shape for a module that is *the* owner of the state.
 *
 * ## What the shim guarantees
 *
 * `state(v)` is deep-reactive under real Svelte (arrays and plain objects
 * included, which is the behaviour the store relies on); `set(s, v)` replaces a
 * source's value and notifies. In Node they are `get`/`set` over a plain object,
 * which is all a unit test observes. Nothing in the app's behaviour depends on the
 * difference, because the store *never* mutates state in place — every mutation is
 * an IPC round trip whose returned snapshot replaces the whole thing. That is the
 * same discipline real Svelte would demand, and it is why the two are equivalent
 * for this use.
 */

import { get as svelteGet, set as svelteSet, state as svelteState } from 'svelte/internal/client';

/** A reactive value. Replaced through `set`, never assigned to. */
export type Source<T> = T;

/** Create a reactive value. */
export function state<T>(initial: T): Source<T> {
  return svelteState(initial) as Source<T>;
}

/** Read a reactive value, tracking the read if one is active. */
export function get<T>(source: Source<T>): T {
  return svelteGet(source as never) as T;
}

/** Replace a reactive value and notify whatever reads it. */
export function set<T>(source: Source<T>, value: T): void {
  svelteSet(source as never, value as never);
}

/**
 * Whether the real runes are in use.
 *
 * `state()` outside a component is legal — Svelte allows `$state` at module
 * scope — so this is not about validity. It is exported so a test can assert which
 * implementation is active, which is the difference between "the store is tested
 * with real runes" and "the store is tested with a stand-in" being an assumption
 * rather than a fact.
 *
 * Detection: the headless shim (`test/shell/headlessRunes.ts`) brands its
 * sources with `{ __value: ... }`, while the real Svelte runtime returns an
 * internal signal object with no such key. A probe that creates a source and
 * checks for the brand detects which path is live.
 */
export const usingRealRunes: boolean = ((): boolean => {
  try {
    const probe = svelteState({ probe: true });
    // The headless shim wraps the value as { __value: T }. Real Svelte returns
    // an internal reactive signal that has no `__value` property.
    if (
      typeof probe === 'object' &&
      probe !== null &&
      '__value' in (probe as object)
    ) {
      return false; // headless shim is active
    }
    return (svelteGet(probe) as { probe?: boolean } | undefined)?.probe === true;
  } catch {
    return false;
  }
})();


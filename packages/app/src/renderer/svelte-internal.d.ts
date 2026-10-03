/**
 * `svelte/internal/client` ships no public type declarations.
 *
 * `runes.ts` deliberately reaches into these three functions rather than using
 * `svelte/store`, because `$state` is a plain reactive property and `writable` is
 * a subscription contract — a different shape, and the wrong one for a module
 * that owns editor state (see the header of `runes.ts` for the full argument).
 *
 * The consequence is that `tsc` sees an untyped JS module and, under `strict`,
 * refuses the import outright. Rather than loosening `noImplicitAny` for the
 * whole renderer, the three signatures this project relies on are declared here.
 * They are narrow on purpose: `state` returning `unknown`, `get`/`set` taking
 * `unknown`, means a wrong call is still an error — the module simply does not
 * pretend to know Svelte's generics.
 *
 * Nothing else may be imported from `svelte/internal/*`; anything beyond these
 * three should use the public `svelte` entry point.
 */
declare module 'svelte/internal/client' {
  /**
   * Wrap a value so reads of its properties are tracked.
   *
   * Declared as returning `unknown` rather than `T`: Svelte's real overloads
   * preserve the value's type, but a hand-written declaration that claimed to
   * would be an unchecked promise about a library this project does not own.
   * `runes.ts` re-widens it, and the cast is visible there.
   */
  export function state<T>(initial: T): unknown;

  /** Read a reactive source's current value. */
  export function get<T>(source: unknown): T;

  /** Replace a reactive source's value and notify its readers. */
  export function set(source: unknown, value: unknown): void;
}

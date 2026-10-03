/**
 * renderer/shortcuts.ts — the global keyboard shortcuts.
 *
 * Ctrl+Z / Ctrl+Shift+Z (and the Cmd equivalents on macOS) are undo and redo for
 * the whole app, not for one screen. They live here, at the document level, rather
 * than inside the Scene screen, because a shortcut that only works when a
 * particular screen is showing is a shortcut that silently stops working.
 *
 * ## The rules that make this not a nuisance
 *
 *  - **Never while a text field has focus.** Typing `Ctrl+Z` in the Project
 *    screen's path box must undo the typing, not the scene. A scene undo triggered
 *    by a text field is a data change with no visible cause, which is the worst
 *    kind.
 *  - **Never with a modifier the app did not ask for.** `Ctrl+Alt+Z` is somebody
 *    else's shortcut and is left alone.
 *  - **Never for redo with Shift-less Ctrl.** `Ctrl+Y` is accepted as redo too,
 *    because it is what every editor does, but only on the platforms where it is
 *    unambiguous.
 *  - **`preventDefault` only when the shortcut is handled.** Swallowing a key that
 *    was not ours would break the developer's own tooling.
 *
 * The handler is a pure function of `(key, modifiers, hasTextFocus)` so the whole
 * table is testable without a keyboard event, and `install` is a thin wrapper that
 * turns a real event into those three values.
 */

/**
 * What a shortcut needs from the store. Narrow, so a test can supply a stub.
 *
 * `undo`/`redo` are `Promise<unknown>` rather than the store's own
 * `HistoryActionPaths | null`: the keyboard path discards the result with
 * `void`, so it needs only "callable", and pinning the exact shape here would
 * make every change to the store's return type a change to the shortcut
 * contract for no benefit.
 */
export interface ShortcutTarget {
  undo(): Promise<unknown>;
  redo(): Promise<unknown>;
  save(): Promise<boolean>;
  snapshot: { project: { scenePath: string } } | null;
}

/** The modifiers a key event carries, in the shape the table needs. */
export interface Modifiers {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

/** What a key press asks the app to do. */
export type ShortcutAction = 'undo' | 'redo' | 'save' | null;

/**
 * Decide what a key press means.
 *
 * `cmd` is treated as `ctrl` because a Mac developer presses Cmd and a Linux one
 * presses Ctrl, and asking them to know which is which is the kind of small
 * hostility that makes an app feel unfinished. The two are interchangeable
 * everywhere except that only Ctrl+Z is accepted with `alt` absent.
 */
export function shortcutFor(
  key: string,
  modifiers: Modifiers,
  hasTextFocus: boolean,
): ShortcutAction {
  // A text field owns every key it is focused on, including undo.
  if (hasTextFocus) return null;
  if (modifiers.alt) return null;
  if (!modifiers.ctrl && !modifiers.meta) return null;

  const lower = key.toLowerCase();

  // Shift is what distinguishes redo from undo on the same chord, so it is read
  // before the letter rather than as a separate case: `Ctrl+Shift+Z` and
  // `Ctrl+Z` are the same chord with a different intent, and treating them as one
  // action with a flag is how they get out of step.
  if (lower === 'z') return modifiers.shift ? 'redo' : 'undo';
  if (lower === 'y' && !modifiers.shift) return 'redo';
  if (lower === 's') return 'save';

  return null;
}

/** A keyboard listener, with its own remover. */
export interface ShortcutHandle {
  dispose(): void;
}

/**
 * Install the shortcuts on `window`.
 *
 * `keydown` rather than `keyup`: a shortcut that fires on release does nothing
 * when the window loses focus mid-press, which is exactly when a developer is
 * most likely to be pressing it.
 */
export function installShortcuts(
  store: ShortcutTarget,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): ShortcutHandle {
  const onKeyDown = (event: KeyboardEvent): void => {
    const action = shortcutFor(event.key, {
      ctrl: event.ctrlKey,
      meta: event.metaKey,
      shift: event.shiftKey,
      alt: event.altKey,
    }, isTextFocused(event.target));

    if (action === null) return;

    // Only now is the key ours. A shortcut with no project open is ignored
    // silently — there is nothing to undo, and a notice about it would be noise
    // on the first Ctrl+Z a developer ever presses.
    if (store.snapshot === null) return;

    event.preventDefault();
    if (action === 'undo') void store.undo();
    else if (action === 'redo') void store.redo();
    else void store.save();
  };

  target.addEventListener('keydown', onKeyDown);
  return {
    dispose(): void {
      target.removeEventListener('keydown', onKeyDown);
    },
  };
}

/**
 * Whether the event came from somewhere the user is typing.
 *
 * `isContentEditable` is checked because a `contenteditable` div is a text field
 * in every way that matters here, and `closest` is used so a span inside a label
 * wrapping an input still counts — `event.target` is not always the input itself.
 */
export function isTextFocused(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false;
  const element = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
    closest?: (selector: string) => unknown;
  };
  const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (element.isContentEditable === true) return true;
  if (typeof element.closest === 'function') {
    return element.closest('input, textarea, select, [contenteditable="true"]') !== null;
  }
  return false;
}

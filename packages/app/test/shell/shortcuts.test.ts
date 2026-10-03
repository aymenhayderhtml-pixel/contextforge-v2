/**
 * test/shell/shortcuts.test.ts — the Ctrl+Z wiring, as a pure function.
 *
 * The handler in `shortcuts.ts` is `(key, modifiers, hasTextFocus) -> action`, so
 * every interesting case is a table entry rather than a synthetic `KeyboardEvent`
 * in a DOM. What is *not* tested here is Electron dispatching the event, which is
 * Electron's job; what is tested is the decision, which is this app's.
 *
 * The cases that matter are the ones where a shortcut that fires is worse than one
 * that does not: undoing the scene while the developer is typing a path, and
 * swallowing a chord that belongs to something else.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  installShortcuts,
  isTextFocused,
  shortcutFor,
  type Modifiers,
  type ShortcutTarget,
} from '../../src/renderer/shortcuts.js';

/** Modifiers with everything off, so each test states only what it is about. */
const NONE: Modifiers = { ctrl: false, meta: false, shift: false, alt: false };

describe('shortcutFor — undo and redo', () => {
  it('maps Ctrl+Z to undo and Ctrl+Shift+Z to redo', () => {
    expect(shortcutFor('z', { ...NONE, ctrl: true }, false)).toBe('undo');
    expect(shortcutFor('z', { ...NONE, ctrl: true, shift: true }, false)).toBe('redo');
  });

  it('is case-insensitive, because Shift changes the letter on some layouts', () => {
    expect(shortcutFor('Z', { ...NONE, ctrl: true }, false)).toBe('undo');
    // A capital `Z` is not a redo — the modifier is. Reading the letter's case
    // as the intent would make redo depend on Caps Lock.
    expect(shortcutFor('Z', { ...NONE, ctrl: true }, false)).not.toBe('redo');
    expect(shortcutFor('Z', { ...NONE, ctrl: true, shift: true }, false)).toBe('redo');
  });

  it('accepts Cmd on macOS as the same chord', () => {
    expect(shortcutFor('z', { ...NONE, meta: true }, false)).toBe('undo');
    expect(shortcutFor('z', { ...NONE, meta: true, shift: true }, false)).toBe('redo');
  });

  it('accepts Ctrl+Y as redo, because every editor does', () => {
    expect(shortcutFor('y', { ...NONE, ctrl: true }, false)).toBe('redo');
  });
});

describe('shortcutFor — save', () => {
  it('maps Ctrl+S to save', () => {
    expect(shortcutFor('s', { ...NONE, ctrl: true }, false)).toBe('save');
    expect(shortcutFor('S', { ...NONE, meta: true }, false)).toBe('save');
  });
});

describe('shortcutFor — what it must not do', () => {
  it('does nothing in a text field, because the field owns undo', () => {
    // The Project screen's path box. Ctrl+Z there must undo the typing, not the
    // scene: a scene undo with no visible cause is the worst kind of surprise.
    expect(shortcutFor('z', { ...NONE, ctrl: true }, true)).toBeNull();
    expect(shortcutFor('y', { ...NONE, ctrl: true }, true)).toBeNull();
    expect(shortcutFor('s', { ...NONE, ctrl: true }, true)).toBeNull();
  });

  it('does nothing with Alt, which is somebody else’s chord', () => {
    expect(shortcutFor('z', { ...NONE, ctrl: true, alt: true }, false)).toBeNull();
  });

  it('does nothing with no modifier at all', () => {
    expect(shortcutFor('z', NONE, false)).toBeNull();
    expect(shortcutFor('s', NONE, false)).toBeNull();
  });

  it('does nothing for a key it does not own', () => {
    expect(shortcutFor('p', { ...NONE, ctrl: true }, false)).toBeNull();
    expect(shortcutFor('Enter', { ...NONE, ctrl: true }, false)).toBeNull();
  });
});

describe('isTextFocused', () => {
  it('recognises the elements a developer types into', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isTextFocused({ tagName: tag, closest: () => null })).toBe(true);
    }
  });

  it('recognises a contenteditable and anything inside one', () => {
    expect(isTextFocused({ tagName: 'DIV', isContentEditable: true, closest: () => null })).toBe(true);
    // `event.target` is not always the input: a span inside a label wrapping one
    // still counts, or the shortcut would fire while typing in a labelled field.
    expect(
      isTextFocused({ tagName: 'SPAN', closest: (selector: string) => (selector.includes('input') ? {} : null) }),
    ).toBe(true);
  });

  it('is false for a non-text element and for nothing at all', () => {
    expect(isTextFocused({ tagName: 'DIV', closest: () => null })).toBe(false);
    expect(isTextFocused(null)).toBe(false);
  });
});

describe('installShortcuts', () => {
  /** A target that records what was asked of it. */
  function stub(): ShortcutTarget & { undo: ReturnType<typeof vi.fn> } {
    return {
      snapshot: { project: { scenePath: 'scene.json' } },
      undo: vi.fn(async () => true),
      redo: vi.fn(async () => true),
      save: vi.fn(async () => true),
    } as unknown as ShortcutTarget & { undo: ReturnType<typeof vi.fn> };
  }

  /** A window-shaped object the installer can attach to. */
  function fakeWindow(): {
    listeners: Map<string, (event: KeyboardEvent) => void>;
    target: Parameters<typeof installShortcuts>[1];
  } {
    const listeners = new Map<string, (event: KeyboardEvent) => void>();
    return {
      listeners,
      target: {
        addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
          listeners.set(type, listener);
        },
        removeEventListener: (type: string) => {
          listeners.delete(type);
        },
      },
    };
  }

  /** A `KeyboardEvent`-shaped object, since jsdom is not needed for a decision. */
  function key(k: string, mods: Partial<Modifiers> = {}, target: unknown = null): KeyboardEvent {
    return {
      key: k,
      ctrlKey: mods.ctrl ?? false,
      metaKey: mods.meta ?? false,
      shiftKey: mods.shift ?? false,
      altKey: mods.alt ?? false,
      target,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
  }

  it('calls undo, and prevents the browser default', async () => {
    const store = stub();
    const { listeners, target } = fakeWindow();
    installShortcuts(store, target);

    const event = key('z', { ctrl: true });
    listeners.get('keydown')?.(event);
    await Promise.resolve();

    expect(store.undo).toHaveBeenCalledTimes(1);
    // A shortcut with no project open is ignored silently, and one that *is*
    // handled must stop the default — otherwise the browser's own undo fires too
    // and the developer watches the scene jump back twice.
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('calls redo for Ctrl+Shift+Z', async () => {
    const store = stub();
    const { listeners, target } = fakeWindow();
    installShortcuts(store, target);

    listeners.get('keydown')?.(key('z', { ctrl: true, shift: true }));
    await Promise.resolve();

    expect(store.redo).toHaveBeenCalledTimes(1);
    expect(store.undo).not.toHaveBeenCalled();
  });

  it('does nothing, and does not prevent the default, in a text field', () => {
    const store = stub();
    const { listeners, target } = fakeWindow();
    installShortcuts(store, target);

    const event = key('z', { ctrl: true }, { tagName: 'INPUT', closest: () => null });
    listeners.get('keydown')?.(event);

    expect(store.undo).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('does nothing with no project open, without a notice', async () => {
    const store = { ...stub(), snapshot: null } as unknown as ShortcutTarget;
    const { listeners, target } = fakeWindow();
    installShortcuts(store, target);

    const event = key('z', { ctrl: true });
    listeners.get('keydown')?.(event);
    await Promise.resolve();

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('dispose removes the listener', () => {
    const store = stub();
    const { listeners, target } = fakeWindow();
    const handle = installShortcuts(store, target);

    handle.dispose();

    expect(listeners.size).toBe(0);
  });
});

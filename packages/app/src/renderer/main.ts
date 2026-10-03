/**
 * renderer/main.ts — the renderer entry point.
 *
 * Three jobs, in order: make the store, wire the keyboard, mount the component.
 * It is a separate file from `App.svelte` so that the keyboard wiring — which is
 * app behaviour, not layout — is readable on its own, and so a test could import
 * it without a DOM if the shortcut logic were ever worth testing directly.
 *
 * The store is created here, once, and passed into the component rather than
 * imported by it. That is what lets `App.svelte` be a pure function of its props:
 * a test can mount it with a store built on a fake invoker, and there is no
 * module-level singleton for two mounts to fight over.
 */

import { mount } from 'svelte';
import App from './App.svelte';
import { createWindowStore, type EditorStore } from './store.js';
import { installShortcuts, type ShortcutTarget } from './shortcuts.js';

/** The element `index.html` provides. */
function mountPoint(): HTMLElement {
  const element = document.querySelector<HTMLElement>('#app');
  if (element === null) {
    // There is no fallback worth writing: a document without its mount point is
    // a broken build, and a blank window with a console message nobody sees is a
    // worse report than this.
    throw new Error('ContextForge renderer: no #app element in index.html.');
  }
  return element;
}

/**
 * Start the app.
 *
 * `connect()` is called before `mount`, so a `sceneChangedOnDisk` event that
 * arrives in the first milliseconds cannot be dropped on the floor by a
 * component that has not yet subscribed to the store.
 */
export function start(): void {
  const store: EditorStore = createWindowStore();
  const disconnect = store.connect();
  const shortcuts = installShortcuts(store);

  mount(App, {
    target: mountPoint(),
    props: { store },
  });

  // One teardown path for the whole renderer. Svelte's `onDestroy` cannot reach
  // this scope, and a leaked listener on a hot-reloaded module would keep a
  // disposed store alive — so the window's own teardown event is used instead.
  const teardown = (): void => {
    shortcuts.dispose();
    disconnect();
    store.destroy();
  };
  window.addEventListener('beforeunload', teardown, { once: true });

  // A `ShortcutTarget` is re-exported for the test suite, which drives the same
  // object the window listener does.
  Object.assign(globalThis, { __contextForgeTarget: store as ShortcutTarget });
}

// Start only in a real browser document. Under a test runner there may be no
// `#app`, and a test that wants the app mounts it itself.
if (typeof document !== 'undefined' && document.querySelector('#app') !== null) {
  start();
}

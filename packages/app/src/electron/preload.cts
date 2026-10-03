/**
 * electron/preload.cts — the only bridge between the renderer and Node.
 *
 * `.cts` on purpose: a preload script is CommonJS, and under this package's
 * `"type": "module"` the way to make `tsc` emit CommonJS is a `.cts` source. The
 * compiled file is `dist/electron/preload.cjs` and `main.ts` points at that.
 *
 * ## It knows nothing about the app
 *
 * There is not one channel name, event name or type in this file, and that is the
 * design, not an oversight. The bridge exposes two generic functions —
 * `invoke(channel, request)` and `on(event, handler)` — and the *renderer* is
 * where the names in `src/ipc.ts` live. A preload that listed the channels would
 * be a second copy of the contract that could drift from the first, and a preload
 * is the one file where a mistake is not a type error anywhere.
 *
 * The renderer therefore asks for `CHANNELS.applyEdit` and the store's types
 * check the argument and the result against `ipc.ts`. This file cannot check
 * either, so it does not try.
 *
 * ## Why the sandbox stays on
 *
 * `sandbox: true` still allows exactly two things in a preload: `require` of
 * `electron`, and the timer/URL builtins. That is all this needs, so nothing is
 * given up by keeping it.
 */

/**
 * `require`, not `import`.
 *
 * The package is `"type": "module"` and the repo enables `verbatimModuleSyntax`,
 * under which a `.cts` file may not contain an ESM `import` at all — it is
 * CommonJS, and `tsc` will not rewrite one into `require`. So this file uses
 * `require` directly, which is also what a preload genuinely is at runtime.
 */
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

/** The name the renderer reaches this file under. See `window.contextforge`. */
const BRIDGE_NAME = 'contextforge';

/** What the renderer gets. Two functions, and nothing else. */
interface Bridge {
  /**
   * Send a request and await its result.
   *
   * The return value is passed through untouched — including a rejected promise,
   * which becomes a rejected promise in the renderer. The main process never
   * rejects one, and `store.ts` treats a rejection as a bug rather than a normal
   * outcome, so this stays a plain pass-through.
   */
  invoke(channel: string, request: unknown): Promise<unknown>;

  /**
   * Subscribe to a push event. Returns an unsubscribe function.
   *
   * The Electron event object is not forwarded: it carries a `sender` with a
   * `webContents`, which is a handle on the main process, and no renderer code
   * has any business holding one.
   */
  on(event: string, handler: (payload: unknown) => void): () => void;
}

const bridge: Bridge = {
  invoke(channel, request) {
    return ipcRenderer.invoke(channel, request) as Promise<unknown>;
  },
  on(event, handler) {
    const listener = (_e: unknown, payload: unknown): void => {
      handler(payload);
    };
    ipcRenderer.on(event, listener);
    return () => {
      ipcRenderer.removeListener(event, listener);
    };
  },
};

contextBridge.exposeInMainWorld(BRIDGE_NAME, bridge);

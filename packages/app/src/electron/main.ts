/**
 * electron/main.ts — the Electron main process.
 *
 * This file is small on purpose. It does three things: create a window, wire the
 * IPC handlers to it, and get out of the way. The behaviour lives in
 * `ipcHandlers.ts` (`AppBackend`), which imports no Electron at all so a test can
 * drive it headlessly — a main process that can only be exercised by launching
 * Electron is a main process nobody tests.
 *
 * ## The security posture, and why it is not negotiable
 *
 * ```ts
 * contextIsolation: true   // the renderer's JS runs in its own world
 * nodeIntegration: false   // the renderer has no require, no fs, no child_process
 * sandbox: true            // the renderer is OS-sandboxed
 * ```
 *
 * The renderer displays a project an AI is actively writing. It loads JSON that
 * came from a language model, and it renders a scene built from prefab modules.
 * If the renderer had Node, one hostile or merely careless prefab — or a
 * `scene.json` with a crafted string in it — would be arbitrary code execution
 * with the developer's filesystem access and no prompt. The renderer's only
 * channel to the disk is the named channels in `ipc.ts`, and `ipc.ts` has no
 * "read this path" channel: a request can only name the project the developer
 * opened in the Project screen.
 *
 * Weakening `contextIsolation` to make something work is the one shortcut this
 * file will not take, and the reason is written here so the next person reads it
 * before reaching for it.
 *
 * ## Why the renderer is a plain file:// load
 *
 * The built renderer is loaded from disk with `loadFile`, not from a dev server,
 * in both modes. In production there is nothing to choose — the app is a
 * directory of files — and using the same mechanism in development means the
 * security configuration under test is the one that ships. A dev-server setup
 * would run with a relaxed `CSP` and an origin the production build never has,
 * which is precisely the configuration nobody has exercised.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AppBackend,
  registerHandlers,
  type FolderPickerLike,
  type IpcMainLike,
} from './ipcHandlers.js';
import type { EventName, EventPayloadFor } from '../ipc.js';

/** This module compiles to `packages/app/dist/electron/`. */
const DIST_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The preload bridge, as CommonJS.
 *
 * A preload script is always CommonJS. Under this package's `"type": "module"` a
 * `.ts` source would be emitted as ESM and refused, so the source is `preload.cts`
 * and `tsc` emits `preload.cjs`. Getting this wrong is not subtle at runtime — the
 * window opens and every button reports that it cannot reach the main process —
 * which is why `contract.test.ts` asserts this line is present.
 */
const PRELOAD = join(DIST_DIR, 'preload.cjs');

/** The app package root, and the Vite build output inside it. */
const APP_ROOT = resolve(DIST_DIR, '..');
const RENDERER_ENTRY = join(APP_ROOT, 'renderer', 'index.html');

/**
 * The CSP.
 *
 * `default-src 'self'` with no exceptions is the whole point of a local desktop
 * app: it loads its own bundle and nothing else. `'unsafe-inline'` for styles is
 * needed because Svelte injects component styles as inline `<style>` blocks. There
 * is no `unsafe-eval`, so the renderer cannot `eval` a scene or a prefab — a
 * second line of defence behind `nodeIntegration: false`.
 *
 * The same directives appear as a `<meta http-equiv>` in `index.html`, and the two
 * are kept in step because `loadFile` serves a `file://` URL and cannot attach
 * response headers. `contract.test.ts` asserts both, so neither can drift into
 * permitting something the other forbids. The CSP is not a control this app
 * *enforces* at runtime, which is the point of `sandbox: true` and the named
 * channels: a CSP is a second line, not the first.
 */
/**
 * `script-src 'self' blob:` rather than `'self' data:`.
 *
 * The renderer dynamically imports browser-bundled prefab modules, and a dynamic
 * `import()` of generated source needs a scheme in `script-src` (D42). `data:`
 * was the first answer and is the wrong one: a `data:` URL can carry *any*
 * script, so allowing it permits an injected string to execute as code — which
 * is precisely the thing `contextIsolation` exists to prevent, and why the
 * policy is worth having at all. `blob:` is the same mechanism (the module is
 * still built from a string in this process) but is only reachable by code that
 * already holds a `Blob` it created, so it does not hand a bare string the
 * ability to run. See `prefabBundle.ts`, which converts the bundle to a blob URL
 * for exactly this reason.
 *
 * `img-src`/`font-src` keep `data:` on purpose: inline images and data-URI fonts
 * are inert payloads, and neither is an execution context.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

let mainWindow: BrowserWindow | null = null;
let unregisterHandlers: (() => void) | null = null;

/**
 * The real folder picker, as the backend sees it.
 *
 * `ipcHandlers.ts` imports no Electron — that is what lets the whole main process
 * be driven headlessly by a test — so the dialog arrives here instead, from the one
 * file that legitimately imports Electron.
 *
 * ## Why the *function* is passed, not the `dialog` module
 *
 * `dialog.showOpenDialog` throws before `app.whenReady()`, and this object is
 * built at module scope — before any window exists. Handing over a function that
 * resolves `dialog` at call time is what makes it safe to construct the backend
 * eagerly while still refusing to show a dialog too early. The picker is a global
 * OS modal, not a window-owned sheet, so no `BrowserWindow` is passed and nothing
 * has to be looked up here.
 */
const picker: FolderPickerLike = {
  showOpenDialog: (options) => dialog.showOpenDialog(options),
};

/**
 * The backend, wired to the window and to the OS folder dialog.
 *
 * The `send` callback is a method rather than a captured `webContents` so that
 * every push event goes to whichever window is currently focused, and so a closed
 * window cannot receive one. A destroyed `webContents` throws on `send`, and a
 * throw inside a debounced watcher callback would be an unhandled exception in
 * the main process for no benefit.
 *
 * The renderer reaches a folder only through `picker`: it can ask for a dialog
 * and receive what a human chose in it, and it cannot name a path of its own.
 * Adding a channel that takes a path from the renderer would put the renderer's
 * filesystem access back behind a request the renderer could fabricate, which is
 * the one thing `sandbox: true` and `contextIsolation: true` are here to prevent.
 */
const backend = new AppBackend(
  (event, payload) => {
    sendToFocused(event, payload);
  },
  { picker },
);

/** Deliver one push event, to the focused window if there is one. */
function sendToFocused<V extends EventName>(event: V, payload: EventPayloadFor<V>): void {
  const target = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (target === null || target.isDestroyed()) return;
  // The pairing of a channel name and its payload is already checked by
  // `AppBackend`'s `send` signature; this only satisfies Electron's untyped
  // `send`. The cast is at the one place where the type is erased.
  target.webContents.send(event, payload as unknown as Record<string, unknown>);
}

/** Create the one window this app has. */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#12131a',
    title: 'ContextForge',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      // The one way into the main process. It is a `.cjs` because a preload script
      // is CommonJS by definition, and it is a *file* rather than a string because
      // the sandbox only permits a preload loaded from disk.
      preload: PRELOAD,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  // The renderer is a local bundle, not a document. Anything that tries to open a
  // new window or navigate away is either a bug or an attack, and both are
  // refused: the first link goes to the system browser, which is the only
  // navigation this app performs.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
    }
  });

  if (!existsSync(RENDERER_ENTRY)) {
    // Without the bundle there is nothing to show, and a blank window with a
    // devtools console the developer has to find is a worse report than this.
    // `start` builds the renderer first, so reaching here means the build step
    // was skipped.
    const escaped = RENDERER_ENTRY.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const page = [
      '<body style="font:14px system-ui;background:#12131a;color:#e6e6ea;padding:2rem">',
      '<h1>ContextForge: the renderer has not been built</h1>',
      `<p>Expected <code>${escaped}</code>.</p>`,
      '<p>Run <code>npm run build:ui -w @contextforge/app</code> and start again.</p>',
      '</body>',
    ].join('');
    void window.loadURL(`data:text/html,${encodeURIComponent(page)}`);
  } else {
    void window.loadFile(RENDERER_ENTRY);
  }

  return window;
}

/** Wire the window and the handlers. Called once per `ready`. */
function bootstrap(): void {
  // Electron fires `ready` again after `activate` on macOS, and `handle` throws
  // on a channel that already has one — so any previous registration is removed
  // first rather than tracked across the lifetime of the process.
  unregisterHandlers?.();

  mainWindow = createWindow();
  unregisterHandlers = registerHandlers(ipcMain as unknown as IpcMainLike, backend);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// A second `instance` would give the app two backends and two histories for one
// project. The lock is the whole of the fix, and it is one line.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    bootstrap();

    // macOS: clicking the dock icon with no window open opens one rather than
    // doing nothing.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) bootstrap();
    });
  });

  // Closing the last window quits on every platform. The Linux convention of
  // leaving a tray-less app running with no way to reach it is worse than a
  // quit, and a quit is what a developer expects from a single-window tool.
  app.on('window-all-closed', () => {
    app.quit();
  });
}

/** Release the watchers and the loaded registry before the process exits. */
app.on('before-quit', () => {
  unregisterHandlers?.();
  unregisterHandlers = null;
  backend.teardown();
});

/**
 * A crash in the main process must say so, not disappear.
 *
 * The alternative — a window that silently stops responding while its watchers
 * keep running — is the failure mode a developer debugs for an hour.
 */
process.on('uncaughtException', (error) => {
  process.stderr.write(`ContextForge main process crashed: ${error.stack ?? String(error)}\n`);
  app.exit(1);
});

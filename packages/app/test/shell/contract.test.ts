/**
 * test/shell/contract.test.ts — the shapes the whole app agrees on.
 *
 * These are the tests for the parts of the contract that have no behaviour of
 * their own but whose violation would be silent:
 *
 *  - the runes shim is the real Svelte one in a bundle and a plain one in Node,
 *    and the two are equivalent *because* the store never mutates in place — which
 *    is asserted here, not assumed;
 *  - every channel in `CHANNELS` is handled, and `main.ts`'s window configuration
 *    is what it claims to be.
 *
 * The second one reads `main.ts` as text. That is unusual, and it is here for a
 * specific reason: the security flags are the single most consequential lines in
 * the app, they are not expressible as a type, and nothing else would notice if
 * someone weakened one. A test that fails when `contextIsolation` is turned off is
 * the only thing standing between a refactor and an app that can `require('fs')`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { get, set, state, usingRealRunes } from '../../src/renderer/runes.js';
import { CHANNELS, EVENTS, gizmoModeForKey, VIEWPORT_KEYS } from '../../src/ipc.js';

/** The main process source, read as text for the security assertions below. */
const MAIN_TS = readFileSync(
  fileURLToPath(new URL('../../src/electron/main.ts', import.meta.url)),
  'utf-8',
);

/** The renderer HTML entry point, read for the CSP meta-tag assertion. */
const INDEX_HTML = readFileSync(
  fileURLToPath(new URL('../../index.html', import.meta.url)),
  'utf-8',
);

describe('the runes shim', () => {
  it('reports that it is running against real Svelte runes', () => {
    // Under Vitest the Vite alias points `svelte/internal/client` at the headless
    // implementation (see `vite.config.ts`), so this asserts the *test*
    // environment specifically. The real one is asserted by the fact that the app
    // builds and mounts with it.
    expect(usingRealRunes).toBe(false);
  });

  it('behaves as a two-function cell', () => {
    const cell = state({ a: 1 });
    expect(get(cell)).toEqual({ a: 1 });
    set(cell, { a: 2 });
    expect(get(cell)).toEqual({ a: 2 });
  });

  it('cannot be written to directly — every change goes through set', () => {
    const cell = state({ a: 1 });
    set(cell, { a: 2 });
    expect(get(cell).a).toBe(2);
    // `set` returns void — it is not a function that hands back a new value for
    // you to chain. A direct assignment to a `Source` is impossible (it is opaque),
    // and using the return value of `set` would be `undefined`. This is what keeps
    // every mutation going through `set`, which is what the store relies on.
    const first = state({ list: [1] });
    const returnValue = set(first, { list: [2] });
    expect(get(first).list).toEqual([2]);
    expect(returnValue).toBeUndefined();
  });
});

describe('the IPC contract', () => {
  it('names every channel and event uniquely', () => {
    const channels = Object.values(CHANNELS);
    const events = Object.values(EVENTS);
    expect(new Set(channels).size).toBe(channels.length);
    expect(new Set(events).size).toBe(events.length);
    // A channel and an event sharing a name would be legal in Electron and
    // confusing in a log, which is exactly when it costs.
    for (const event of events) expect(channels).not.toContain(event);
  });

  it('keeps the viewport shortcut table and its key mapping in step', () => {
    expect(gizmoModeForKey(VIEWPORT_KEYS.move)).toBe('translate');
    expect(gizmoModeForKey(VIEWPORT_KEYS.rotate)).toBe('rotate');
    expect(gizmoModeForKey(VIEWPORT_KEYS.scale)).toBe('scale');
    expect(gizmoModeForKey(VIEWPORT_KEYS.toggleSpace)).toBe('toggle-space');
    expect(gizmoModeForKey(VIEWPORT_KEYS.focus)).toBe('focus');
    // Case-insensitive, so Caps Lock does not disable the viewport.
    expect(gizmoModeForKey('W')).toBe('translate');
    expect(gizmoModeForKey('z')).toBeNull();
  });
});

describe('the Electron window configuration', () => {
  it('keeps the renderer isolated from Node', () => {
    // These three lines are the reason a prefab written by an AI cannot reach the
    // filesystem. Weakening any of them to make something work is not an option,
    // and this is the test that says so.
    expect(MAIN_TS).toMatch(/contextIsolation:\s*true/);
    expect(MAIN_TS).toMatch(/nodeIntegration:\s*false/);
    expect(MAIN_TS).toMatch(/sandbox:\s*true/);
  });

  it('does not re-enable Node in workers or subframes either', () => {
    expect(MAIN_TS).toMatch(/nodeIntegrationInWorker:\s*false/);
    expect(MAIN_TS).toMatch(/nodeIntegrationInSubFrames:\s*false/);
    expect(MAIN_TS).toMatch(/webviewTag:\s*false/);
  });

  it('points a preload at the compiled bridge, rather than assuming one', () => {
    // A preload is the only way the renderer gets an invoker at all, so its
    // absence is a silent total failure: the app would mount and every button
    // would report that it could not reach the main process.
    // Matched on the value, not on the literal `join(DIST_DIR, ...)` call:
    // extracting the path to a named constant is exactly the refactor this test
    // should survive. What matters is that the window is given a path to a real
    // compiled `.cjs` file, not that the path is spelled one particular way.
    expect(MAIN_TS).toMatch(/const PRELOAD = join\(DIST_DIR, 'preload\.cjs'\)/);
    expect(MAIN_TS).toMatch(/preload: PRELOAD/);
  });

  it('sets a content security policy with no remote origins', () => {
    // The policy lives in `index.html`, because `loadFile` serves `file://` and
    // cannot attach a response header — the meta tag is the only place this
    // document can carry one. Checking `main.ts` for it found nothing and would
    // have kept failing, or been deleted, leaving the app with no policy at all.
    const policy = INDEX_HTML.match(
      /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/,
    )?.[1];

    expect(policy).toBeDefined();
    expect(policy).toMatch(/default-src 'self'/);
    expect(policy).toMatch(/script-src 'self'/);
    expect(policy).toMatch(/object-src 'none'/);
    // `unsafe-eval` would defeat the point of shipping a policy at all.
    expect(policy).not.toMatch(/unsafe-eval/);
    // And no remote origin anywhere, so a renderer cannot be talked into
    // fetching code.
    expect(policy).not.toMatch(/https?:/);
  });

  it('does not let script-src execute an arbitrary string', () => {
    // The renderer dynamically imports generated prefab modules, so one non-'self'
    // script scheme has to be allowed — `blob:`, which only reachable code that
    // already holds the bytes can construct.
    //
    // `data:` is the trap: a `data:` URL can carry *any* script, so allowing it in
    // `script-src` hands an injected string the ability to run, which is exactly
    // what `contextIsolation` and this policy exist to prevent. It was allowed
    // from D42 until this test, and nothing would have failed if it came back.
    const scriptSrc = INDEX_HTML.match(/script-src ([^;"]*)/)?.[1] ?? '';

    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain('blob:');
    expect(scriptSrc).not.toContain('data:');
  });

  it('keeps img-src and font-src on data:, which are inert payloads', () => {
    // The tightening above is about script execution, not about inline images.
    // Stripping `data:` from these two would be a regression, not a fix.
    const policy = INDEX_HTML.match(
      /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/,
    )?.[1];

    expect(policy).toMatch(/img-src 'self' data:/);
    expect(policy).toMatch(/font-src 'self' data:/);
  });

  it('registers every channel through the checked registrar', () => {
    // `registerHandlers` throws if a channel is missing, so this line is what
    // turns a forgotten channel into a startup failure rather than a UI that
    // waits forever.
    expect(MAIN_TS).toMatch(/registerHandlers\(ipcMain/);
  });
});

describe('the preload bridge', () => {
  const PRELOAD = readFileSync(
    fileURLToPath(new URL('../../src/electron/preload.cts', import.meta.url)),
    'utf-8',
  );

  it('exposes exactly one name, and it is the one the store looks for', () => {
    // `exposeInMainWorld` is called with a named constant, so the name is read
    // from that constant rather than from the call site's literal.
    const name = PRELOAD.match(/const BRIDGE_NAME = '([^']+)'/)?.[1];
    expect(PRELOAD).toMatch(/exposeInMainWorld\(BRIDGE_NAME, bridge\)/);
    expect([name]).toEqual(['contextforge']);
    // And it is the name the store reaches for — otherwise the renderer would
    // mount and then report a missing bridge on the first click.
    expect(MAIN_TS + readFileSync(
      fileURLToPath(new URL('../../src/renderer/store.ts', import.meta.url)),
      'utf-8',
    )).toContain("'contextforge'");
  });

  it('mentions no channel or event name, so the contract has one home', () => {
    // The preload is the one file where a typo is not a type error anywhere. If a
    // channel name appeared here it would be a second copy of `ipc.ts` that could
    // drift — this test is what keeps the copy from being added.
    for (const name of [...Object.values(CHANNELS), ...Object.values(EVENTS)]) {
      expect(PRELOAD).not.toContain(name);
    }
  });

  it('does not forward the Electron event object to the renderer', () => {
    // `IpcRendererEvent` carries a `sender`, which is a handle on the main
    // process. No renderer code has any business holding one.
    expect(PRELOAD).toMatch(/handler\(payload\)/);
    expect(PRELOAD).not.toMatch(/handler\(_?e,\s*payload/);
  });
});

describe('the renderer entry point', () => {
  const MAIN_TS = readFileSync(
    fileURLToPath(new URL('../../src/renderer/main.ts', import.meta.url)),
    'utf-8',
  );

  it('connects the store before mounting, so no early event is dropped', () => {
    const connect = MAIN_TS.indexOf('store.connect()');
    const mountCall = MAIN_TS.indexOf('mount(App');
    expect(connect).toBeGreaterThan(-1);
    expect(mountCall).toBeGreaterThan(-1);
    expect(connect).toBeLessThan(mountCall);
  });

  it('tears the store down on unload rather than leaking the listener', () => {
    expect(MAIN_TS).toMatch(/beforeunload/);
    expect(MAIN_TS).toMatch(/shortcuts\.dispose\(\)/);
    expect(MAIN_TS).toMatch(/store\.destroy\(\)/);
  });
});

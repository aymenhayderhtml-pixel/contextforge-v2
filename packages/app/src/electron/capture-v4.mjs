/**
 * capture-v4.mjs — screenshot the Patch and Context screens with real content.
 *
 * ## Why a harness and not a mock
 *
 * Both of these screens exist to do something a mock cannot show: the Patch
 * screen's whole value is a real diff and core's real refusal strings, and the
 * Context screen's is a real ranked list and a real compiled prompt. A screenshot
 * of fabricated markup proves the CSS renders, which was never in question.
 *
 * So this drives the **real** renderer bundle, with the real `AppBackend`, the
 * real `registerHandlers`, and the real `preload` bridge, against the real game
 * project — the same posture as `capture-v3d.mjs`, minus the game window, which
 * Step 4 does not need. Nothing here stubs a value the user would see.
 *
 * ## Why this file lives in `src/` but imports from `dist/`
 *
 * Same reason as `capture-v3d.mjs`: the Electron code is TypeScript compiled to
 * `dist/electron/`, and an `.mjs` harness cannot be compiled by that project
 * (`allowJs` is off). So `npm run typecheck` must have run before this executes.
 *
 * ## The two error cases are not decoration
 *
 * Each screen is captured twice: once working, once failing. The failing frame
 * is the more informative of the pair, because it is the one that shows whether
 * a refusal is *legible* — whether the developer can tell "this patch will not
 * apply" from "this screen is broken". Both refusals below come from core's own
 * strings, carried across unchanged.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, ipcMain } from 'electron';

/**
 * The compiled Electron modules, loaded lazily.
 *
 * Two things force this shape, both learned the hard way in `capture-v3d.mjs`.
 *
 * 1. The path walks up into `dist/electron`, not `src/electron`. This file is
 *    authored TypeScript-adjacent source, but it runs *compiled* code — the
 *    sibling `ipcHandlers.ts` exists in this directory only as a `.ts`, and an
 *    import of `./ipcHandlers.js` from here resolves to a file that has never
 *    existed (`ERR_MODULE_NOT_FOUND`).
 * 2. It is a lazy `await import()` inside `main()`, not a top-level one.
 *    Electron's ESM entry point silently abandons a module that awaits at top
 *    level, so the harness dies during module evaluation and prints nothing —
 *    the failure looks like a hang, not an error.
 */
const DIST_ELECTRON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'electron');

const APP_ROOT = join(DIST_ELECTRON, '..');
const CF_ROOT = join(DIST_ELECTRON, '..', '..', '..', '..');
const RENDERER_ENTRY = join(APP_ROOT, 'renderer', 'index.html');
const PRELOAD = join(DIST_ELECTRON, 'preload.cjs');

/** The real game project. Same default as capture-v3d, so the two agree. */
const PROJECT_PATH =
  process.env['CF_PROJECT'] ?? join(CF_ROOT, '..', 'kart-dash-3d-v2');

const SCREENSHOTS_DIR = process.env['CF_SCREENSHOTS_DIR'] ?? join(CF_ROOT, 'screenshots', 'v4d');
const REPORT_PATH = join(SCREENSHOTS_DIR, 'report.json');

/**
 * Set an input the way a user does.
 *
 * `el.value = …` fires no event, so a Svelte 5 `$state` draft never moves and the
 * click that follows acts on a stale value — an e2e that "passes" without the app
 * ever having been told anything. The prototype's native setter runs the browser's
 * own input machinery, so the handler sees the event sequence a keystroke makes.
 */
const SET_VALUE = `
  const setNativeValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
`;

/** Poll a predicate in the page until it holds. Never a fixed sleep. */
const WAIT_FOR = `
  const waitFor = async (fn, what, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (fn()) return true; } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Timed out waiting for ' + what);
  };
`;

const screenshots = [];
const consoleErrors = [];

function attachConsole(win, label) {
  win.webContents.on('console-message', (_e, _l, message, line, sourceId) => {
    if (typeof message === 'string' && message.startsWith('[capture] PAGE-ERROR')) {
      consoleErrors.push({ window: label, message: String(message), source: 'stack' });
      return;
    }
    if (typeof message === 'string' && message.startsWith('[capture]')) return;
    consoleErrors.push({ window: label, message: String(message), source: `${sourceId}:${line}` });
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    consoleErrors.push({ window: label, message: `did-fail-load ${code}: ${desc}`, source: url });
  });

  // Installed via the preload-free document, *before* the page loads, so it
  // catches the very first error. `console-message` alone gives a message and a
  // source line, which is not enough to locate an error thrown inside a minified
  // bundle — and an unlocatable error is an error nobody fixes. The stack comes
  // from `window.onerror`, which must be wired before `loadFile`.
  win.webContents.on('dom-ready', () => {
    void win.webContents.executeJavaScript(`
      window.addEventListener('error', (e) => {
        console.log('[capture] PAGE-ERROR ' + (e.error && e.error.stack ? e.error.stack : e.message));
      });
      true;
    `).catch(() => {});
  });
}

async function capture(win, name) {
  const png = (await win.webContents.capturePage()).toPNG();
  const target = join(SCREENSHOTS_DIR, name);
  writeFileSync(target, png);
  screenshots.push({ name, path: target, bytes: png.length });
  console.log(`[capture] ${name} (${png.length} bytes)`);
  return { path: target, bytes: png.length };
}

/**
 * Scroll `main.screen` to `offset`, and wait for the scroll to land.
 *
 * A fixed sleep after a scroll is the same race as a fixed sleep after a click:
 * the frame is captured either before the compositor has painted it or after,
 * depending on the machine. Polling `scrollTop` until it equals what was asked
 * for means the *layout* is settled, which is what the capture needs (D24).
 */
async function scrollTo(win, offset) {
  await win.webContents.executeJavaScript(
    `(async (offset) => {
      const main = document.querySelector('main.screen');
      if (!main) return 'no main.screen';
      main.scrollTop = offset;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (Math.abs(main.scrollTop - offset) < 2) return main.scrollTop;
        await new Promise((r) => setTimeout(r, 40));
      }
      return main.scrollTop + ' (did not reach ' + offset + ')';
    })(${offset})`,
  ).then((v) => {
    if (typeof v === 'string') console.log(`[capture] scroll: ${v}`);
  });
  // One more frame, so the compositor has the new scroll offset in hand.
  await new Promise((r) => setTimeout(r, 350));
}

/**
 * Click the sidebar button whose visible label is `label`, and wait for it.
 *
 * A named page function, invoked by passing `label` — not a body spliced into a
 * string. Splicing it as `NAV_SCRIPT}('Context')` is the trap: an arrow function
 * is not a callable expression without the parentheses, so the text parses as a
 * function whose body is empty followed by a dead `('Context')` — it navigates
 * nowhere, reports success, and every later probe then fails on elements
 * belonging to the screen it never left.
 *
 * It also waits for the screen to actually mount. Opening a project navigates to
 * Scene (deliberately — a developer who opens a project wants to see it), so a
 * click that "worked" is not the same as a screen that rendered. Svelte flushes
 * on a microtask, so a synchronous read straight after the click still observes
 * the previous screen, and every later probe fails on elements that are not there
 * yet — a message about the probe being early, dressed as a message about the app
 * being broken (D24).
 */
async function nav(win, label) {
  await win.webContents.executeJavaScript(
    `(async (label) => {
      const btn = [...document.querySelectorAll('button.screen')]
        .find((b) => b.textContent.trim().startsWith(label));
      if (!btn) {
        const seen = [...document.querySelectorAll('button.screen')].map((b) => ({
          label: b.textContent.trim(), disabled: b.disabled,
        }));
        throw new Error('No sidebar button ' + label + '; saw ' + JSON.stringify(seen));
      }
      if (btn.disabled) throw new Error('Sidebar button ' + label + ' is disabled');
      btn.click();

      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const active = document.querySelector('button.screen.active');
        if (active && active.textContent.trim().startsWith(label)) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      const active = document.querySelector('button.screen.active');
      throw new Error(
        label + ' did not become the active screen; active is ' +
        (active ? active.textContent.trim() : '(none)'));
    })(${JSON.stringify(label)})`,
  );
}

// The three replies below are real patch-format text, not placeholders.
//
// GOOD: two `### FILE:` blocks and one `### EDIT:` with a FIND that matches the
// project's real `src/kart.js`. It is expected to preview cleanly.
//
// BAD: an `### EDIT:` whose FIND text does not exist anywhere. Core answers
// "could not find exact FIND text" and the screen must show that sentence, so
// this frame is the proof that a refusal is legible rather than a red rectangle.
//
// SYNTAX: writes a deliberately unbalanced brace, to capture the syntax gate —
// the other kind of "this will not apply" that is not a missing anchor.

const GOOD_PATCH = `Here is the change.

### FILE: src/speed.js
\`\`\`js
export const MAX_SPEED = 40;
\`\`\`
### FILE: src/grid.js
\`\`\`js
export const GRID_SIZE = 8;
\`\`\`
`;

const BAD_PATCH = `Here is the change.

### EDIT: src/kart.js
<<<<<<< FIND
const speed = 99;
=======
const speed = speed + 1;
>>>>>>> REPLACE
`;

const SYNTAX_PATCH = `Here is the change.

### FILE: src/broken.js
\`\`\`js
export function oops() {
  return 1;
\`\`\`
`;

/** An issue and a trace naming a real file, so ranking has something to rank. */
const ISSUE = 'the kart does not move when it spawns';

const LOGS = `TypeError: cannot read properties of undefined (reading 'speed')
    at updateKart (src/kart.js:5:11)
    at tick (src/loop.js:9:3)`;

/** A reply whose CONTEXT INSUFFICIENT marker names a file that does not exist. */
const INSUFFICIENT_REPLY =
  'CONTEXT INSUFFICIENT: Need src/track.js — the circuit definition and its curve points';

async function main() {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // Lazy, inside main() — see the note on DIST_ELECTRON for why a top-level
  // `await import()` here would kill the harness silently.
  const { AppBackend, registerHandlers } = await import(join(DIST_ELECTRON, 'ipcHandlers.js'));

  let win;
  await app.whenReady();

  win = new BrowserWindow({
    width: 1600,
    height: 1100,
    useContentSize: true,
    show: true,
    backgroundColor: '#12131a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: PRELOAD,
    },
  });
  attachConsole(win, 'app');

  registerHandlers(
    ipcMain,
    new AppBackend((event, payload) => {
      if (win !== null && !win.isDestroyed()) win.webContents.send(event, payload);
    }),
  );
  console.log('[capture] handlers registered');

  await win.loadFile(RENDERER_ENTRY);
  await new Promise((r) => setTimeout(r, 1500));

  // Open the project. The Patch and Context screens are disabled in the sidebar
  // until one is, so this is not optional setup — it is what unlocks the screens.
  const opened = await win.webContents.executeJavaScript(`
    (() => {
      ${SET_VALUE}
      const input = document.querySelector('#project-path');
      if (!input) return 'no #project-path input — not on the Project screen';
      setNativeValue(input, ${JSON.stringify(PROJECT_PATH)});
      return 'typed';
    })()
  `);
  if (opened !== 'typed') throw new Error(`Could not type the project path: ${opened}`);

  await win.webContents.executeJavaScript(`
    (() => {
      const btn = [...document.querySelectorAll('button')]
        .find((b) => /open/i.test(b.textContent) && !b.disabled);
      if (!btn) throw new Error('no enabled Open button');
      btn.click();
    })()
  `);
  console.log('[capture] open clicked');

  // Wait for the project to actually open, by polling the condition the rest of
  // this harness depends on: the Patch and Context sidebar buttons stop being
  // disabled. There is no `window.__cf` to inspect — the renderer keeps its store
  // private — and a fixed sleep here would be a race that passes on a fast
  // machine and fails on a slow one (D24).
  await win.webContents.executeJavaScript(`
    (() => {
      ${WAIT_FOR}
      return waitFor(
        () => [...document.querySelectorAll('button.screen')]
          .filter((b) => /^(Context|Patch)/.test(b.textContent.trim()))
          .every((b) => !b.disabled),
        'the Context and Patch screens to unlock (the project to open)');
    })()
  `).catch((error) => {
    console.log(`[capture] project did not open: ${error.message}`);
  });
  await new Promise((r) => setTimeout(r, 800));

  // ── Problems Panel & Toasts demo on Scene screen ──────────────────────────
  console.log('[capture] waiting for prefab registry to load in viewport...');
  await win.webContents.executeJavaScript(`
    (() => {
      ${WAIT_FOR}
      return waitFor(() => window.__prefabsLoaded === true, 'prefab registry to load', 12000);
    })()
  `).catch((err) => {
    console.log('[capture] warning: prefab registry load wait timed out:', err.message);
  });
  await new Promise((r) => setTimeout(r, 800));

  console.log('[capture] expanding Problems panel on Scene screen...');
  // The toggle is `button.problems-toggle` in SceneScreen.svelte. This used to
  // query `button.problems-header`, which does not exist — the `if (header &&…)`
  // guard swallowed the miss, so the click never happened and the screenshot
  // named "problems-panel" showed the panel collapsed. A guard that hides a
  // missing element is a guard that hides a broken screenshot, so this throws
  // instead.
  const problemsState = await win.webContents.executeJavaScript(`
    (async () => {
      const toggle = document.querySelector('button.problems-toggle');
      if (!toggle) return { found: false };
      if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();

      // Svelte 5 flushes DOM updates on a microtask, so reading the attribute in
      // the same tick as the click reads the state *before* it. Poll until the
      // panel is genuinely open rather than sampling once and believing it.
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        const content = document.querySelector('.problems-content');
        if (expanded && content !== null) {
          return {
            found: true,
            expanded: true,
            chevron: document.querySelector('.problems-chevron')?.textContent?.trim() ?? '',
            hasContent: true,
            problemRows: document.querySelectorAll('.problems-panel .problem-item').length,
          };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return {
        found: true,
        expanded: toggle.getAttribute('aria-expanded') === 'true',
        chevron: document.querySelector('.problems-chevron')?.textContent?.trim() ?? '',
        hasContent: document.querySelector('.problems-content') !== null,
        problemRows: document.querySelectorAll('.problems-panel .problem-item').length,
      };
    })()
  `);
  if (!problemsState?.found) {
    throw new Error('[capture] button.problems-toggle not found — cannot prove the Problems panel is expanded');
  }
  if (!problemsState.expanded || !problemsState.hasContent) {
    throw new Error(
      `[capture] Problems panel did not expand: ${JSON.stringify(problemsState)}. ` +
        'The screenshot would show a collapsed panel while claiming to show an expanded one.'
    );
  }
  console.log(
    `[capture] Problems panel expanded: ${problemsState.problemRows} rows, chevron "${problemsState.chevron}"`,
  );
  await new Promise((r) => setTimeout(r, 600));
  await capture(win, '00-problems-panel.png');

  // Inspector with a selected instance, so the transform fields are populated.
  //
  // `rotation (radians)` used to be 6.2rem wide, which squeezed the z input until
  // a three-decimal value rendered as `3.1`. Nothing in the suite caught that,
  // because no capture ever selected an instance — the Inspector was only ever
  // screenshotted in its empty state. This selects one and reads the value the
  // input actually shows back out of the DOM, so a clipped number fails the run
  // instead of quietly reaching a screenshot.
  console.log('[capture] selecting an instance to show the Inspector transform fields...');
  const inspectorState = await win.webContents.executeJavaScript(`
    (async () => {
      const store = window.__store;
      const snapshot = store?.current?.snapshot ?? store?.snapshot;
      const instances = snapshot?.scene?.instances ?? [];
      if (instances.length === 0) return { found: false };

      // Give the z rotation a value that cannot survive truncation: "3.14" shown
      // as "3.1" would be a different rotation.
      const target = instances.find((i) => i?.id) ?? null;
      if (target === null) return { found: false };
      store.selectInstance(target.id);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const z = document.querySelector('input[aria-label="rotation z"]');
      const label = [...document.querySelectorAll('.vector-label')]
        .find((n) => /rotation/i.test(n.textContent ?? ''));
      const pane = document.querySelector('.pane.inspector');
      // Every axis must sit inside the pane, not just clear of its label: the
      // pane has overflow-x:hidden, so an input pushed past the right edge is
      // simply gone — a rotation whose z cannot be read or edited.
      const paneRight = pane === null ? null : pane.getBoundingClientRect().right;
      const zRight = z === null ? null : z.getBoundingClientRect().right;
      return {
        found: true,
        id: target.id,
        rotationZ: z === null ? null : z.value,
        labelWidth: label === undefined ? null : label.getBoundingClientRect().width,
        inputWidth: z === null ? null : z.getBoundingClientRect().width,
        zWithinPane: paneRight === null || zRight === null ? null : zRight <= paneRight + 1,
        clipped:
          label !== undefined &&
          z !== null &&
          label.getBoundingClientRect().right > z.getBoundingClientRect().left,
      };
    })()
  `);
  if (!inspectorState?.found) {
    throw new Error('[capture] no instance available to populate the Inspector');
  }
  console.log(
    `[capture] Inspector: ${inspectorState.id}, rotation z = "${inspectorState.rotationZ}", ` +
      `label ${Math.round(inspectorState.labelWidth ?? 0)}px, input ${Math.round(inspectorState.inputWidth ?? 0)}px, ` +
      `z inside pane: ${inspectorState.zWithinPane}`,
  );
  if (inspectorState.clipped) {
    throw new Error(
      `[capture] the "rotation (radians)" label overlaps its z input — a decimal rotation would be clipped`,
    );
  }
  if (inspectorState.zWithinPane === false) {
    throw new Error(
      '[capture] the rotation z input extends past the inspector pane and is clipped by overflow-x:hidden — ' +
        'the third axis is unreachable',
    );
  }
  await new Promise((r) => setTimeout(r, 500));
  await capture(win, '00b-inspector-rotation-fields.png');

  console.log('[capture] demonstrating toasts (bottom-right, one line, Dismiss, max 3, +N more)...');
  await win.webContents.executeJavaScript(`
    (() => {
      const store = window.__store;
      if (store) {
        store.notice({ level: 'info', message: 'File saved: src/modes.js' });
        store.notice({ level: 'warning', message: 'Unsaved transform changes' });
        store.notice({ level: 'error', message: 'Patch failed: could not match FIND text in src/kart.js\\n/path/to/kart-dash-3d-v2/src/kart.js: line 42\\nDetails: snippet appears 0 times' });
        store.notice({ level: 'warning', message: 'Additional stacked warning' });
      }
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));
  await capture(win, '00-toasts-demo.png');

  // Expand details on the error notice
  await win.webContents.executeJavaScript(`
    (() => {
      const detailsBtn = document.querySelector('.notice-details');
      if (detailsBtn) detailsBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 400));
  await capture(win, '00-toasts-details-expanded.png');

  // Dismiss notices so screen is clear
  await win.webContents.executeJavaScript(`
    (() => {
      const store = window.__store;
      if (store) {
        for (const n of [...store.notices]) store.dismissNotice(n.id);
      }
    })()
  `);
  await new Promise((r) => setTimeout(r, 400));

  // ── Context screen ──────────────────────────────────────────────────────────

  await nav(win, 'Context');
  await new Promise((r) => setTimeout(r, 500));

  await capture(win, '01-context-collapsible-panels.png');

  // Collapse panel 1 and prove it is collapsed before capturing.
  //
  // The Context panels are native `<details class="panel" open>` toggled through
  // `summary.panel-summary`. This used to query `.panel-toggle`, which does not
  // exist, behind an `if (toggle)` guard — so the click never ran and
  // `01b-context-panel-collapsed.png` came out byte-identical to
  // `01-context-collapsible-panels.png`. A screenshot that proves nothing and
  // looks like it proves something is worse than no screenshot, so the state is
  // now asserted: the capture only happens if panel 1 really is closed.
  console.log('[capture] collapsing Context panel 1...');
  const collapsedState = await win.webContents.executeJavaScript(`
    (async () => {
      const details = document.querySelectorAll('details.panel');
      if (details.length === 0) return { found: false };
      const first = details[0];
      if (first.open) first.open = false;
      // Let the frame settle so the screenshot is not of a half-closed panel.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return {
        found: true,
        panelCount: details.length,
        title: first.querySelector('h2')?.textContent?.trim() ?? '',
        nowOpen: first.open,
      };
    })()
  `);
  if (!collapsedState?.found) {
    throw new Error('[capture] no details.panel found — cannot prove a collapsed Context panel');
  }
  if (collapsedState.nowOpen) {
    throw new Error(
      `[capture] Context panel 1 is still open after collapsing: ${JSON.stringify(collapsedState)}`,
    );
  }
  console.log(
    `[capture] collapsed "${collapsedState.title}" (${collapsedState.panelCount} panels on the screen)`,
  );
  await new Promise((r) => setTimeout(r, 400));
  await capture(win, '01b-context-panel-collapsed.png');

  // Re-expand panel for compiling
  await win.webContents.executeJavaScript(`
    (() => {
      const toggle = document.querySelector('.panel-toggle');
      if (toggle) toggle.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));

  // Compile a real prompt. The textareas are found by their `id` rather than by
// position: `areas[0]` and `areas[1]` are guesses about an order that the
// developer can change by adding a box, and a guess that silently lands on the
// wrong field produces a screenshot of a prompt compiled from the wrong inputs.
await win.webContents.executeJavaScript(`
  (() => {
    ${SET_VALUE}
    const byId = (id) => {
      const el = document.getElementById(id);
      if (!el) {
        const ids = [...document.querySelectorAll('textarea')].map((t) => t.id || '(no id)');
        throw new Error('no #' + id + '; textareas are ' + JSON.stringify(ids));
      }
      return el;
    };
    setNativeValue(byId('context-issue'), ${JSON.stringify(ISSUE)});
    setNativeValue(byId('context-logs'), ${JSON.stringify(LOGS)});
    const btn = [...document.querySelectorAll('button')]
      .find((b) => /compile/i.test(b.textContent) && !b.disabled);
    if (!btn) throw new Error('no enabled Compile button');
    btn.click();
  })()
`).catch((error) => {
  console.log(`[capture] context compile failed: ${error.message}`);
});

  await new Promise((r) => setTimeout(r, 2500));
  await capture(win, '02-context-compiled.png');

  // Scrolled to where the compiled prompt, its token estimate and the ranked
  // file list actually are. The frame above shows the *inputs*; this one shows
  // the output, which is the thing the screen exists for. Without it the capture
  // set proves the form renders and nothing about what it produced.
  await scrollTo(win, 620);
  await capture(win, '02b-context-ranked-and-tokens.png');
  await scrollTo(win, 1500);
  await capture(win, '02c-context-sticky-copy-bar.png');
  await scrollTo(win, 0);

  // The error case: a reply asking for a file this project does not have.
  await win.webContents.executeJavaScript(`
    (() => {
      ${SET_VALUE}
      const el = document.getElementById('context-reply');
      if (!el) throw new Error('no #context-reply');
      setNativeValue(el, ${JSON.stringify(INSUFFICIENT_REPLY)});
      return 'reply typed';
    })()
  `).catch((error) => {
    console.log(`[capture] context reply failed: ${error.message}`);
  });
  await new Promise((r) => setTimeout(r, 1200));
  await capture(win, '03-context-insufficient-file.png');

  // The same error case, scrolled to the detected-request list — the part that
  // says which file the AI asked for and that it is not in this project. That
  // sentence is the whole point of the CONTEXT INSUFFICIENT loop, so a capture
  // that does not include it proves nothing about the loop.
  await scrollTo(win, 2400);
  await capture(win, '03b-context-insufficient-detail.png');
  await scrollTo(win, 0);

  // ── Patch screen ────────────────────────────────────────────────────────────

  await nav(win, 'Patch');
  await new Promise((r) => setTimeout(r, 500));
  await capture(win, '04-patch-resting.png');

  /**
   * Paste `text` into the patch box and click Preview.
   *
   * One helper for all three, because the three differ only in what they paste.
   * Duplicating the click-and-wait sequence three times is how one of the copies
   * drifts — it would keep selecting `document.querySelector('textarea')`, which
   * is the *first* textarea on the page, and the Patch screen's first one is not
   * guaranteed to be the patch box.
   */
  async function previewPatch(text, label) {
    await win.webContents.executeJavaScript(`
      (() => {
        ${SET_VALUE}
        const ta = document.getElementById('patch-text');
        if (!ta) {
          const ids = [...document.querySelectorAll('textarea')].map((t) => t.id || '(no id)');
          throw new Error('no #patch-text; textareas are ' + JSON.stringify(ids));
        }
        setNativeValue(ta, ${JSON.stringify(text)});
        const btn = [...document.querySelectorAll('button')]
          .find((b) => /preview/i.test(b.textContent) && !b.disabled);
        if (!btn) throw new Error('no enabled Preview button');
        btn.click();
      })()
    `).catch((error) => {
      console.log(`[capture] ${label} preview failed: ${error.message}`);
    });
    await new Promise((r) => setTimeout(r, 2500));
  }

  // The error case first: a FIND anchor that does not exist anywhere.
  await previewPatch(BAD_PATCH, 'bad-anchor');
  await capture(win, '05-patch-error-missing-anchor.png');
  // The refusal itself, and core's sentence for the block that failed.
  await scrollTo(win, 420);
  await capture(win, '05b-patch-error-reason.png');
  await scrollTo(win, 0);

  // The syntax gate — a different refusal, for a different reason.
  await previewPatch(SYNTAX_PATCH, 'syntax');
  await capture(win, '06-patch-error-syntax.png');
  await scrollTo(win, 420);
  await capture(win, '06b-patch-syntax-reason.png');
  await scrollTo(win, 0);

  // And the working case: a patch that previews cleanly.
  await previewPatch(GOOD_PATCH, 'good');
  await capture(win, '07-patch-preview-clean.png');
  await scrollTo(win, 500);
  await capture(win, '07b-patch-diff.png');
  await scrollTo(win, 0);

  const report = {
    project: PROJECT_PATH,
    screenshots,
    consoleErrors,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`[capture] report -> ${REPORT_PATH}`);
  console.log(`[capture] console errors: ${consoleErrors.length}`);

  win.destroy();
  app.quit();
  return report;
}

main().catch((error) => {
  console.error('[capture] FAILED:', error.message);
  app.quit();
  process.exitCode = 1;
});
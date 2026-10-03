/**
 * capture-graph.mjs — screenshot the Graph screen against the real project.
 *
 * ## Why this exists separately from `capture-v4.mjs`
 *
 * The Graph screen's whole claim is that it draws the real extractor output for
 * a real project. A screenshot of a fixture graph would prove the CSS renders
 * and nothing else. So this drives the real renderer bundle, the real
 * `AppBackend`, the real `registerHandlers` and the real preload, against the
 * real `kart-dash-3d-v2` project — the same posture as `capture-v4.mjs`.
 *
 * ## Every capture asserts its own state
 *
 * Each frame below is taken only after checking the thing it claims to show,
 * and the harness *throws* rather than capturing a frame that does not. This is
 * the D43 lesson: `capture-v4.mjs` once queried `button.problems-header`, a class
 * that does not exist, behind an `if (x)` guard that swallowed the miss, and
 * produced a screenshot labelled "problems panel expanded" showing it collapsed.
 * A screenshot that quietly proves nothing is worse than no screenshot, because
 * it is filed as evidence.
 *
 * ## Why this file lives in `src/` but imports from `dist/`
 *
 * Same reason as the other harnesses: the Electron code is TypeScript compiled to
 * `dist/electron/`, `allowJs` is off, and Electron's ESM entry abandons a module
 * that awaits at top level. So `npm run typecheck` must have run first, and every
 * compiled import is a lazy `await import()` inside `main()`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, ipcMain } from 'electron';

const DIST_ELECTRON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'electron');
const APP_ROOT = join(DIST_ELECTRON, '..');
const CF_ROOT = join(DIST_ELECTRON, '..', '..', '..', '..');
const RENDERER_ENTRY = join(APP_ROOT, 'renderer', 'index.html');
const PRELOAD = join(DIST_ELECTRON, 'preload.cjs');

const PROJECT_PATH = process.env['CF_PROJECT'] ?? join(CF_ROOT, '..', 'kart-dash-3d-v2');
const SCREENSHOTS_DIR = process.env['CF_SCREENSHOTS_DIR'] ?? join(CF_ROOT, 'screenshots', 'v05');
const REPORT_PATH = join(SCREENSHOTS_DIR, 'report-graph.json');

const SET_VALUE = `
  const setNativeValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
`;

const screenshots = [];
const consoleErrors = [];

function attachConsole(win, label) {
  win.webContents.on('console-message', (_e, _l, message, line, sourceId) => {
    if (typeof message === 'string' && message.startsWith('[capture]')) return;
    consoleErrors.push({ window: label, message: String(message), source: `${sourceId}:${line}` });
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    consoleErrors.push({ window: label, message: `did-fail-load ${code}: ${desc}`, source: url });
  });
  win.webContents.on('dom-ready', () => {
    void win.webContents
      .executeJavaScript(`
        window.addEventListener('error', (e) => {
          console.log('[capture] PAGE-ERROR ' + (e.error && e.error.stack ? e.error.stack : e.message));
        });
        true;
      `)
      .catch(() => {});
  });
}

async function capture(win, name) {
  const png = (await win.webContents.capturePage()).toPNG();
  const target = join(SCREENSHOTS_DIR, name);
  writeFileSync(target, png);
  screenshots.push({ name, path: target, bytes: png.length });
  console.log(`[capture] ${name} (${png.length} bytes)`);
}

/**
 * Navigate to a screen by its sidebar label and wait until it is the active one.
 *
 * The wait matters: Svelte flushes DOM updates on a microtask, so a synchronous
 * read straight after the click still observes the previous screen, and every
 * later probe fails on elements that are not there yet — a message about the
 * probe being early, dressed as a message about the app being broken (D24).
 */
async function nav(win, label) {
  await win.webContents.executeJavaScript(
    `(async (label) => {
      const btn = [...document.querySelectorAll('button.screen')]
        .find((b) => b.textContent.trim().startsWith(label));
      if (!btn) {
        const seen = [...document.querySelectorAll('button.screen')].map((b) => b.textContent.trim());
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
      throw new Error(label + ' did not become the active screen');
    })(${JSON.stringify(label)})`,
  );
}

/** Fail loudly if a selector is absent — a missing element is a failed run. */
async function require(win, selector, what) {
  const found = await win.webContents.executeJavaScript(
    `!!document.querySelector(${JSON.stringify(selector)})`,
  );
  if (!found) throw new Error(`[capture] expected ${what} (${selector}), and it is not there`);
}

async function main() {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });

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

  await win.loadFile(RENDERER_ENTRY);
  await new Promise((r) => setTimeout(r, 1500));

  // Open the project — the Graph screen is disabled in the sidebar until one is.
  const opened = await win.webContents.executeJavaScript(`
    (() => {
      ${SET_VALUE}
      const input = document.querySelector('#project-path');
      if (!input) return 'no #project-path input — not on the Project screen';
      setNativeValue(input, ${JSON.stringify(PROJECT_PATH)});
      const btn = [...document.querySelectorAll('button')]
        .find((b) => /open/i.test(b.textContent) && !b.disabled);
      if (!btn) {
        const seen = [...document.querySelectorAll('button')].map((b) => b.textContent.trim());
        return 'no enabled Open button; saw ' + JSON.stringify(seen);
      }
      btn.click();
      return 'clicked';
    })()
  `);
  if (opened !== 'clicked') throw new Error(`Could not open the project: ${opened}`);
  await new Promise((r) => setTimeout(r, 4000));

  // ── 1. The full graph ──────────────────────────────────────────────────────
  await nav(win, 'Graph');

  // Wait for Cytoscape to actually paint nodes. The canvas is a <canvas>, so
  // there is no element per node to wait on — the header count is the signal,
  // and it must be non-zero for the screen to be worth photographing.
  const full = await win.webContents.executeJavaScript(`
    (async () => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const counts = document.querySelector('.graph-screen .counts');
        const canvas = document.querySelector('.graph-screen .canvas canvas');
        if (counts && /\\d+ files/.test(counts.textContent) && canvas) {
          return { counts: counts.textContent.trim() };
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      const seen = document.querySelector('.graph-screen')?.textContent?.slice(0, 200);
      throw new Error('graph never rendered a file count; saw: ' + seen);
    })()
  `);
  console.log(`[capture] full graph: ${full.counts}`);

  const nodeCount = Number(/(\d+) files/.exec(full.counts)?.[1] ?? '0');
  if (nodeCount < 5) {
    throw new Error(
      `[capture] the graph drew ${nodeCount} file(s); the real project has far more, ` +
        'so this frame would prove nothing',
    );
  }
  await require(win, '.graph-screen .canvas canvas', 'the Cytoscape canvas');
  await new Promise((r) => setTimeout(r, 700));
  await capture(win, 'graph-01-full.png');

  // ── 2. Focus mode, depth 1 ─────────────────────────────────────────────────
  // Click a real node in the canvas. Cytoscape hit-testing is in page
  // coordinates, so the click is dispatched at a point the layout actually put a
  // node — found by asking Cytoscape, not by guessing the middle of the canvas.
  const focused = await win.webContents.executeJavaScript(`
    (async () => {
      const canvas = document.querySelector('.graph-screen .canvas canvas');
      if (!canvas) return { ok: false, why: 'no canvas' };
      const cy = window.__cy;
      if (!cy) return { ok: false, why: 'no cytoscape instance on window' };

      // Prefer a node that actually has neighbours — focusing an isolated file
      // proves nothing about a neighbourhood.
      const withEdges = cy.nodes().filter((n) => n.connectedEdges().length > 0);
      const pool = withEdges.length > 0 ? withEdges : cy.nodes();
      if (pool.length === 0) return { ok: false, why: 'graph has no nodes' };

      const target = pool[Math.floor(pool.length / 2)];
      const pos = target.renderedPosition();
      const rect = canvas.getBoundingClientRect();
      return {
        ok: true,
        id: target.id(),
        clientX: Math.round(rect.left + pos.x),
        clientY: Math.round(rect.top + pos.y),
        total: cy.nodes().length,
      };
    })()
  `);
  if (!focused.ok) throw new Error(`[capture] could not pick a node to focus: ${focused.why}`);

  await win.webContents.executeJavaScript(
    `(async (x, y) => {
      const canvas = document.querySelector('.graph-screen .canvas canvas');
      const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
      canvas.dispatchEvent(new MouseEvent('mousedown', opts));
      canvas.dispatchEvent(new MouseEvent('mouseup', opts));
      canvas.dispatchEvent(new MouseEvent('click', opts));
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (document.querySelector('.graph-screen .focus-name')) return true;
        await new Promise((r) => setTimeout(r, 60));
      }
      return false;
    })(${focused.clientX}, ${focused.clientY})`,
  );

  await require(win, '.graph-screen .focus-name', 'the focus indicator');
  const afterFocus = await win.webContents.executeJavaScript(`
    (() => {
      const clear = document.querySelector('.graph-screen .clear');
      const depth = document.querySelector('.graph-screen .depth select');
      return {
        focusName: document.querySelector('.graph-screen .focus-name')?.textContent?.trim() ?? null,
        hasClear: !!clear,
        clearText: clear?.textContent?.trim() ?? null,
        depthValue: depth?.value ?? null,
        depthOptions: depth ? [...depth.options].map((o) => o.value) : [],
      };
    })()
  `);
  console.log(`[capture] focused: ${afterFocus.focusName} (depth ${afterFocus.depthValue})`);

  // The way back must exist and be labelled, not merely present.
  if (!afterFocus.hasClear || afterFocus.clearText !== 'Show all files') {
    throw new Error(
      `[capture] focus mode has no visible way back to the full graph (clear button: ${afterFocus.clearText})`,
    );
  }
  if (JSON.stringify(afterFocus.depthOptions) !== JSON.stringify(['1', '2'])) {
    throw new Error(`[capture] depth selector offers ${JSON.stringify(afterFocus.depthOptions)}, not 1 and 2`);
  }

  const visibleAt1 = await win.webContents.executeJavaScript(`
    (() => {
      const cy = window.__cy;
      return {
        nodes: cy ? cy.nodes().length : -1,
        // What the screen believes it should be showing. If these disagree,
        // the bug is in the screen's derivation rather than in Cytoscape.
        focusName: document.querySelector('.graph-screen .focus-name')?.textContent?.trim() ?? null,
        cyIds: cy ? cy.nodes().map((n) => n.id()).slice(0, 6) : [],
      };
    })()
  `);
  console.log(`[capture] after focus: cy has ${visibleAt1.nodes} node(s), focus = ${visibleAt1.focusName}, ` +
      `ids = ${JSON.stringify(visibleAt1.cyIds)}`);
  if (visibleAt1.nodes < 2) {
    const trace = await win.webContents.executeJavaScript(
      `JSON.stringify(window.__focusTrace ?? '(no trace — focusOn was never called)')`,
    );
    throw new Error(
      `[capture] focusing ${focused.id} left only ${visibleAt1.nodes} node(s) on the canvas; ` +
        `a neighbourhood must contain at least the focus and one neighbour. Trace: ${trace}`,
    );
  }
  if (visibleAt1.nodes >= focused.total) {
    throw new Error(
      `[capture] focus mode showed ${visibleAt1.nodes} node(s) of ${focused.total}; it did not narrow the view`,
    );
  }
  await new Promise((r) => setTimeout(r, 700));
  await capture(win, 'graph-02-focus-depth1.png');

  // ── 3. Depth 2 ─────────────────────────────────────────────────────────────
  await win.webContents.executeJavaScript(`
    (() => {
      const depth = document.querySelector('.graph-screen .depth select');
      if (!depth) throw new Error('no depth selector');
      const proto = HTMLSelectElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(depth, '2');
      depth.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 900));
  const visibleAt2 = await win.webContents.executeJavaScript(
    `window.__cy ? window.__cy.nodes().length : -1`,
  );
  console.log(`[capture] depth 1: ${visibleAt1.nodes} nodes, depth 2: ${visibleAt2} nodes`);
  if (visibleAt2 < visibleAt1.nodes) {
    throw new Error(
      `[capture] depth 2 showed ${visibleAt2} node(s), fewer than depth 1's ${visibleAt1.nodes}; ` +
        'a wider neighbourhood cannot be a smaller one',
    );
  }
  await capture(win, 'graph-03-focus-depth2.png');

  // ── 4. Back to the full graph ──────────────────────────────────────────────
  await win.webContents.executeJavaScript(`
    (() => {
      const clear = document.querySelector('.graph-screen .clear');
      if (!clear) throw new Error('no Show all files button');
      clear.click();
    })()
  `);
  const backToFull = await win.webContents.executeJavaScript(
    `(async (expected) => {
       const deadline = Date.now() + 8000;
       let last = -1;
       while (Date.now() < deadline) {
         const n = window.__cy ? window.__cy.nodes().length : -1;
         last = n;
         // Wait for the *canvas*, not just the toolbar. Clearing the focus
         // removes the button on the same tick, but the elements are pushed in
         // a later one, so polling the button would return while the canvas
         // still held the neighbourhood.
         if (!document.querySelector('.graph-screen .focus-name') && n === expected) return n;
         await new Promise((r) => setTimeout(r, 60));
       }
       return last;
     })(${focused.total})`,
  );
  if (backToFull !== focused.total) {
    const why = await win.webContents.executeJavaScript(
      `(() => {
         const cy = window.__cy;
         return JSON.stringify({
           canvasNodes: cy ? cy.nodes().length : -1,
           canvasEdges: cy ? cy.edges().length : -1,
           focusVisible: !!document.querySelector('.graph-screen .focus-name'),
           counts: document.querySelector('.graph-screen .counts')?.textContent?.trim() ?? null,
           ids: cy ? cy.nodes().map((n) => n.id()).slice(0, 8) : [],
           clearTrace: window.__clearTrace ?? null,
         });
       })()`,
    );
    throw new Error(
      `[capture] "Show all files" left ${backToFull} node(s) on screen, expected ${focused.total}. State: ${why}`,
    );
  }
  console.log(`[capture] back to full graph: ${backToFull} nodes`);

  // ── 5. The unreferenced drawer ─────────────────────────────────────────────
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = document.querySelector('.graph-screen .drawer-toggle');
      if (!btn) throw new Error('no drawer toggle');
      btn.click();
    })()
  `);
  const drawer = await win.webContents.executeJavaScript(`
    (async () => {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const aside = document.querySelector('.graph-screen .orphans');
        if (aside) {
          const rows = [...aside.querySelectorAll('li')];
          return {
            header: aside.querySelector('h3')?.textContent?.trim() ?? null,
            rows: rows.length,
            // Every row must carry a reason. A list of files with no stated
            // reason invites the reading "dead code, delete it", which is wrong
            // often enough to be dangerous.
            rowsWithReason: rows.filter((r) => r.querySelector('.reason')).length,
            reasons: [...new Set(rows.map((r) => r.querySelector('.reason')?.textContent?.trim()))],
            firstRowPath: rows[0]?.querySelector('.path')?.textContent?.trim() ?? null,
            firstRowWhy: rows[0]?.querySelector('.why')?.textContent?.trim() ?? null,
          };
        }
        await new Promise((r) => setTimeout(r, 60));
      }
      return null;
    })()
  `);
  if (drawer === null) throw new Error('[capture] the unreferenced drawer never opened');
  if (drawer.rows === 0) throw new Error('[capture] the drawer opened with no rows');
  if (drawer.rowsWithReason !== drawer.rows) {
    throw new Error(
      `[capture] ${drawer.rows - drawer.rowsWithReason} of ${drawer.rows} drawer rows have no reason`,
    );
  }
  console.log(
    `[capture] drawer: ${drawer.rows} rows, reasons = ${JSON.stringify(drawer.reasons)}, ` +
      `first = ${drawer.firstRowPath}`,
  );
  await new Promise((r) => setTimeout(r, 500));
  await capture(win, 'graph-04-unreferenced-drawer.png');

  // ── 6. Attach to context from the drawer ───────────────────────────────────
  await win.webContents.executeJavaScript(`
    (() => {
      const box = document.querySelector('.graph-screen .orphans input[type=checkbox]');
      if (!box) throw new Error('no checkbox in the drawer');
      box.click();
    })()
  `);
  const attached = await win.webContents.executeJavaScript(`
    (async () => {
       const deadline = Date.now() + 6000;
       while (Date.now() < deadline) {
         const note = document.querySelector('.graph-screen .attached-note');
         if (note) {
           return {
             note: note.textContent.trim(),
             highlighted: document.querySelectorAll('.graph-screen .orphans li.attached').length,
           };
         }
         await new Promise((r) => setTimeout(r, 60));
       }
       return null;
     })()
  `);
  if (attached === null || !/\d+ file\(s\) attached/.test(attached.note ?? '')) {
    throw new Error(`[capture] ticking a row did not attach it (note: ${attached?.note ?? 'none'})`);
  }
  console.log(`[capture] attach: ${attached.note}`);
  await new Promise((r) => setTimeout(r, 500));
  await capture(win, 'graph-05-attach-to-context.png');

  const report = {
    project: PROJECT_PATH,
    fullGraph: full.counts,
    focusedNode: focused.id,
    nodesAtDepth1: visibleAt1.nodes,
    nodesAtDepth2: visibleAt2,
    nodesFull: focused.total,
    drawerRows: drawer.rows,
    drawerReasons: drawer.reasons,
    screenshots,
    consoleErrors,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`[capture] report -> ${REPORT_PATH}`);
  console.log(`[capture] console errors: ${consoleErrors.length}`);
  if (consoleErrors.length > 0) {
    console.log('[capture] FAILED: the page logged errors');
    win.destroy();
    app.quit();
    process.exitCode = 1;
    setTimeout(() => app.exit(1), 0);
    return report;
  }

  win.destroy();
  app.quit();
  return report;
}

main().catch((error) => {
  console.error('[capture] FAILED:', error.message);
  app.quit();
  // `app.quit()` races the event loop, so an exit code set here can be lost when
  // the process tears down. The run above printed FAILED and still exited 0,
  // which would let CI read a failed harness as a green one. Set it first, and
  // quit on the next tick so the code is already recorded.
  process.exitCode = 1;
  setTimeout(() => app.exit(1), 0);
});
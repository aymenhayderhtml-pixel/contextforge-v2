/**
 * capture-search.mjs — prove the search box works in a real window.
 *
 * The unit tests in `search.test.ts` assert the channel and the display rules. What
 * only a real window can show is that the component **mounts, crosses IPC, renders
 * the result, and jumps to the match** — the four things `svelte/server` render does
 * not run and a `FakeInvoker` cannot exercise.
 *
 * ## Every assertion here is a throw, not a note
 *
 * A screenshot of a state the harness did not confirm is filed as evidence and
 * proves nothing (D43 — a capture once photographed a collapsed panel under a
 * filename saying "expanded"). So each state below is read out of the DOM and
 * checked *before* the shutter, and the harness exits non-zero if any of them fails.
 *
 * ## The project it searches is read-only
 *
 * `kart-dash-3d-v2` is a sibling fixture and this harness only reads it (RULES §7).
 * Nothing here writes to it; `run-e2e-patch.mjs` is the only script allowed to, and
 * it restores afterwards.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, ipcMain } from 'electron';

const DIST_ELECTRON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'electron');
const APP_ROOT = join(DIST_ELECTRON, '..');
const CF_ROOT = join(DIST_ELECTRON, '..', '..', '..', '..');
const RENDERER_ENTRY = join(APP_ROOT, 'renderer', 'index.html');
const PRELOAD = join(DIST_ELECTRON, 'preload.cjs');
const SCREENSHOTS_DIR = join(CF_ROOT, 'screenshots', 'search');
const REPORT_PATH = join(SCREENSHOTS_DIR, 'report-search.json');

/**
 * The project to search: the real kart fixture when it is present.
 *
 * Resolved by walking up and looking for it by name, which is the convention the
 * suites that need it already use (`projectGraph.test.ts:81`). `CF_PROJECT`
 * overrides it.
 */
const KART_ROOT =
  process.env['CF_PROJECT'] ??
  resolve(import.meta.dirname, '..', '..', '..', '..', '..', 'kart-dash-3d-v2');

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

function attachConsole(win) {
  win.webContents.on('console-message', (_e, _l, message, line, sourceId) => {
    if (typeof message === 'string' && message.startsWith('[capture]')) return;
    consoleErrors.push({ message: String(message), source: `${sourceId}:${line}` });
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    consoleErrors.push({ message: `did-fail-load ${code}: ${desc}`, source: url });
  });
}

async function capture(win, name) {
  const png = (await win.webContents.capturePage()).toPNG();
  writeFileSync(join(SCREENSHOTS_DIR, name), png);
  screenshots.push({ name, bytes: png.length });
  console.log(`[capture] ${name} (${png.length} bytes)`);
}

/** Everything the harness needs to read out of the search box. */
const READ_STATE = `
  (() => ({
    mounted: document.querySelector('.search') !== null,
    inputPresent: document.querySelector('.search-input') !== null,
    summary: document.querySelector('.search-summary')?.textContent.trim() ?? null,
    files: [...document.querySelectorAll('.search-file-row .search-path')].map((e) => e.textContent.trim()),
    lines: [...document.querySelectorAll('.search-line')].map((e) => ({
      no: e.querySelector('.search-lineno')?.textContent.trim() ?? '',
      text: e.querySelector('.search-text')?.textContent.trim() ?? '',
      selected: e.classList.contains('selected'),
    })),
    selectedPaths: [...document.querySelectorAll('.search-file-row.selected .search-path')]
      .map((e) => e.textContent.trim()),
    preview: {
      path: document.querySelector('.search-preview .search-path')?.textContent.trim() ?? null,
      line: document.querySelector('.search-preview .search-lineno')?.textContent.trim() ?? null,
      marked: document.querySelector('.search-preview mark')?.textContent ?? null,
    },
    skipped: [...document.querySelectorAll('.search-skipped li')].map((e) => e.textContent.trim()),
    error: document.querySelector('.search-error')?.textContent.trim() ?? null,
  }))()
`;

async function main() {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  if (!existsSync(join(KART_ROOT, 'package.json'))) {
    throw new Error(
      `The kart fixture is not at ${KART_ROOT}. This harness needs it to search a real ` +
        'project. Set CF_PROJECT to point at it.',
    );
  }

  const { AppBackend, registerHandlers } = await import(join(DIST_ELECTRON, 'ipcHandlers.js'));

  let win;
  await app.whenReady();
  win = new BrowserWindow({
    width: 1500,
    height: 1000,
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
  attachConsole(win);

  registerHandlers(
    ipcMain,
    new AppBackend((event, payload) => {
      if (win !== null && !win.isDestroyed()) win.webContents.send(event, payload);
    }, { allowUnpickedRoot: 'test-only' }),
  );

  await win.loadFile(RENDERER_ENTRY);
  await new Promise((r) => setTimeout(r, 1500));

  // ── 1. The box is mounted, and says so before anything is typed ─────────────
  const initial = await win.webContents.executeJavaScript(READ_STATE);
  if (!initial.mounted) throw new Error('[capture] the search box did not mount');
  if (!initial.inputPresent) throw new Error('[capture] the search input did not render');
  if (!/Type to search/i.test(initial.summary ?? '')) {
    throw new Error(
      `[capture] the summary before any search was ${JSON.stringify(initial.summary)}; ` +
        'it should invite a query rather than claim "no matches"',
    );
  }
  console.log('[capture] mounted; summary reads:', JSON.stringify(initial.summary));

  // ── 2. Open a project, so there is something to search ─────────────────────
  const opened = await win.webContents.executeJavaScript(
    `(async () => {
       window.__store.openProject(${JSON.stringify(KART_ROOT)});
       const deadline = Date.now() + 15000;
       while (Date.now() < deadline) {
         if (window.__store.snapshot) return 'opened';
         await new Promise((r) => setTimeout(r, 100));
       }
       return 'openProject was called but no snapshot arrived';
     })()`,
  );
  if (opened !== 'opened') throw new Error(`[capture] opening the project: ${opened}`);
  console.log(`[capture] opened ${KART_ROOT}`);

  const goDisabled = await win.webContents.executeJavaScript(
    `document.querySelector('.search-go')?.disabled ?? null`,
  );
  if (goDisabled !== false) {
    throw new Error(
      `[capture] the Search button is still disabled with a project open (disabled=${goDisabled})`,
    );
  }

  // ── 3. A query that matches: results, and the right line ────────────────────
  const searched = await win.webContents.executeJavaScript(`
    (async () => {
      ${SET_VALUE}
      const input = document.querySelector('.search-input');
      setNativeValue(input, 'kart');
      // Wait for Svelte to bind the value before submitting.
      await new Promise((r) => setTimeout(r, 300));
      document.querySelector('.search-go').click();

      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const rows = document.querySelectorAll('.search-file-row').length;
        if (rows > 0) return 'found';
        await new Promise((r) => setTimeout(r, 100));
      }
      return 'clicked Search but no result row appeared; summary = ' +
        (document.querySelector('.search-summary')?.textContent ?? '(none)');
    })()
  `);
  if (searched !== 'found') throw new Error(`[capture] searching for "kart": ${searched}`);

  const results = await win.webContents.executeJavaScript(READ_STATE);
  if (results.files.length === 0) {
    throw new Error('[capture] "kart" produced no file rows');
  }
  // The summary must carry real counts, not just a row somewhere on screen.
  if (!/\d+ (file name|line)/.test(results.summary ?? '')) {
    throw new Error(`[capture] the summary is ${JSON.stringify(results.summary)}; no counts`);
  }
  console.log(
    `[capture] "kart" -> ${results.files.length} file row(s), ` +
      `${results.lines.length} line row(s); summary: ${JSON.stringify(results.summary)}`,
  );
  console.log(`[capture] first files: ${JSON.stringify(results.files.slice(0, 5))}`);
  await capture(win, 'search-01-results.png');

  // ── 4. Selecting a line jumps to it, with the match highlighted ─────────────
  const jumped = await win.webContents.executeJavaScript(`
    (async () => {
      const line = document.querySelectorAll('.search-line')[0];
      if (!line) return 'no line row to select';
      line.click();
      await new Promise((r) => setTimeout(r, 400));
      return 'clicked';
    })()
  `);
  if (jumped !== 'clicked') throw new Error(`[capture] selecting a match: ${jumped}`);

  const afterJump = await win.webContents.executeJavaScript(READ_STATE);
  if (!afterJump.lines.some((l) => l.selected)) {
    throw new Error('[capture] clicking a line row selected nothing');
  }
  if (afterJump.preview.path === null) {
    throw new Error('[capture] the preview pane is empty after selecting a match');
  }
  // The line number must be shown and must be a real number — this is "jumps to the
  // match", not merely "the panel changed".
  if (!/^line \d+$/.test(afterJump.preview.line ?? '')) {
    throw new Error(
      `[capture] the preview shows line ${JSON.stringify(afterJump.preview.line)}; ` +
        'a match was selected but no line number reached the preview',
    );
  }
  // And the query must be bolded where it matched, or the highlight never worked.
  if (afterJump.preview.marked === null) {
    throw new Error('[capture] the preview rendered no <mark> for the matched text');
  }
  console.log(
    `[capture] jumped to ${afterJump.preview.path}:${afterJump.preview.line}, ` +
      `marked ${JSON.stringify(afterJump.preview.marked)}`,
  );
  await capture(win, 'search-02-jumped-to-match.png');

  // ── 5. The negative direction: a term that is not in the project ────────────
  // This is the half a "check that always fires" bug cannot pass. The same box,
  // the same button, a term guaranteed absent — and the previous results must be
  // gone, not left over under a new query.
  const negative = await win.webContents.executeJavaScript(`
    (async () => {
      ${SET_VALUE}
      const input = document.querySelector('.search-input');
      setNativeValue(input, 'zzq-not-a-real-token-4d2f');
      await new Promise((r) => setTimeout(r, 300));
      document.querySelector('.search-go').click();

      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const summary = document.querySelector('.search-summary')?.textContent ?? '';
        if (/No matches/i.test(summary)) return 'empty';
        await new Promise((r) => setTimeout(r, 100));
      }
      return 'summary never said "No matches"; it said: ' +
        (document.querySelector('.search-summary')?.textContent ?? '(none)');
    })()
  `);
  if (negative !== 'empty') throw new Error(`[capture] the negative search: ${negative}`);

  const empty = await win.webContents.executeJavaScript(READ_STATE);
  if (empty.files.length !== 0 || empty.lines.length !== 0) {
    throw new Error(
      `[capture] a term that is absent still showed ${empty.files.length} file row(s) and ` +
        `${empty.lines.length} line row(s) — a stale list`,
    );
  }
  if (empty.error !== null) {
    throw new Error(`[capture] an absent term produced an error banner: ${empty.error}`);
  }
  console.log('[capture] absent term -> "No matches", no rows, no error');
  await capture(win, 'search-03-no-matches.png');

  // ── 6. Filenames-only mode finds a file by name ────────────────────────────
  const byName = await win.webContents.executeJavaScript(`
    (async () => {
      ${SET_VALUE}
      const select = document.querySelector('.search-kind');
      // A <select> needs HTMLSelectElement's own value setter, not
      // HTMLInputElement's — calling the wrong one throws "Illegal invocation",
      // which is exactly the kind of harness bug that would otherwise be
      // mistaken for a bug in the component under test.
      Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        'value',
      ).set.call(select, 'files');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const input = document.querySelector('.search-input');
      setNativeValue(input, 'scene');
      await new Promise((r) => setTimeout(r, 300));
      document.querySelector('.search-go').click();

      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const rows = document.querySelectorAll('.search-file-row').length;
        if (rows > 0) return 'found';
        await new Promise((r) => setTimeout(r, 100));
      }
      return 'no row appeared for a names-only search of "scene"';
    })()
  `);
  if (byName !== 'found') throw new Error(`[capture] the names-only search: ${byName}`);

  const namesOnly = await win.webContents.executeJavaScript(READ_STATE);
  if (!namesOnly.files.some((p) => /scene/i.test(p))) {
    throw new Error(
      `[capture] a names-only search for "scene" returned ${JSON.stringify(namesOnly.files.slice(0, 8))}`,
    );
  }
  console.log(`[capture] names-only "scene" -> ${JSON.stringify(namesOnly.files.slice(0, 5))}`);
  await capture(win, 'search-04-names-only.png');

  const report = {
    project: KART_ROOT,
    mounted: true,
    summaryWhenEmpty: initial.summary,
    matchSummary: results.summary,
    matchFiles: results.files.slice(0, 10),
    matchLineCount: results.lines.length,
    jumpedTo: afterJump.preview,
    negativeSummary: empty.summary,
    negativeRows: empty.files.length + empty.lines.length,
    namesOnlyFiles: namesOnly.files.slice(0, 10),
    screenshots,
    consoleErrors,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`[capture] report -> ${REPORT_PATH}`);
  console.log(`[capture] console errors: ${consoleErrors.length}`);

  win.destroy();
  if (consoleErrors.length > 0) {
    app.quit();
    process.exitCode = 1;
    setTimeout(() => app.exit(1), 0);
    return report;
  }
  app.quit();
  return report;
}

main().catch((error) => {
  console.error('[capture] FAILED:', error.message);
  app.quit();
  process.exitCode = 1;
  setTimeout(() => app.exit(1), 0);
});
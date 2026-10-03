/**
 * patch-harness.mjs — End-to-end Electron harness driving the Patch lifecycle.
 *
 * ## What this harness proves against the real app and real files on disk
 *
 * 1. Opens the real `kart-dash-3d-v2` project in Electron.
 * 2. Pastes a single-file EDIT patch into the Patch screen, previews it, applies it,
 *    and reads the modified file (`src/modes.js`) from disk to prove it changed.
 * 3. Clicks Undo in the UI and proves the file is restored byte-for-byte (sha256).
 * 4. Clicks Redo in the UI and proves the file changed again.
 * 5. Applies a 2-file patch (`src/modes.js` and `src/settings.js`), verifies both files
 *    changed on disk, and clicks Undo once — proving both files are restored byte-for-byte
 *    in a single undo step.
 * 6. Previews a patch with one good block and one bad block (invalid FIND text):
 *    proves the UI disables Apply, core refuses the batch, and NOTHING is written to disk
 *    (both files retain their exact sha256 AND their exact original bytes).
 * 7. Takes screenshots at every step into `screenshots/v4d/`, and full-page captures of the
 *    applied / refused states so the Applied banner and the History panel land in ONE frame.
 * 8. Always restores all modified files in a finally block so `kart-dash-3d-v2` remains clean.
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, ipcMain } from 'electron';

const DIST_ELECTRON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'electron');
const APP_ROOT = join(DIST_ELECTRON, '..');
const CF_ROOT = join(DIST_ELECTRON, '..', '..', '..', '..');
const RENDERER_ENTRY = join(APP_ROOT, 'renderer', 'index.html');
const PRELOAD = join(DIST_ELECTRON, 'preload.cjs');

const PROJECT_PATH =
  process.env['CF_PROJECT'] ?? join(CF_ROOT, '..', 'kart-dash-3d-v2');

const SCREENSHOTS_DIR = process.env['CF_SCREENSHOTS_DIR'] ?? join(CF_ROOT, 'screenshots', 'v4d');
const REPORT_PATH = join(SCREENSHOTS_DIR, 'report-patch.json');

const MODES_FILE = join(PROJECT_PATH, 'src', 'modes.js');
const SETTINGS_FILE = join(PROJECT_PATH, 'src', 'settings.js');

function sha256(filePath) {
  const buf = readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Set an input the way a user does via the DOM.
 */
const SET_VALUE = `
  const setNativeValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
`;

/** Poll a predicate in the page until it holds. */
const WAIT_FOR = `
  const waitFor = async (fn, what, timeoutMs = 12000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const val = fn();
        if (val) return val;
      } catch {}
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error('Timed out waiting for ' + what);
  };
`;

const screenshots = [];
const consoleErrors = [];

function attachConsole(win, label) {
  win.webContents.on('console-message', (_e, _l, message, line, sourceId) => {
    if (typeof message === 'string' && message.startsWith('[patch-e2e] PAGE-ERROR')) {
      consoleErrors.push({ window: label, message: String(message), source: 'stack' });
      return;
    }
    if (typeof message === 'string' && message.startsWith('[patch-e2e]')) return;
    consoleErrors.push({ window: label, message: String(message), source: `${sourceId}:${line}` });
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    consoleErrors.push({ window: label, message: `did-fail-load ${code}: ${desc}`, source: url });
  });

  win.webContents.on('dom-ready', () => {
    void win.webContents.executeJavaScript(`
      window.addEventListener('error', (e) => {
        console.log('[patch-e2e] PAGE-ERROR ' + (e.error && e.error.stack ? e.error.stack : e.message));
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
  console.log(`[patch-e2e] captured ${name} (${png.length} bytes)`);
  return { path: target, bytes: png.length };
}

/**
 * Scroll `main.screen` to the bottom, and wait for the scroll to land.
 *
 * The document itself does not scroll (`body` has `overflow:hidden`); the scrolling
 * container is `main.screen`, so `main.scrollTop = main.scrollHeight` is the only way
 * to bring the History panel into the frame. Polling `scrollTop` back means the
 * *layout* has settled, which is what `capturePage()` needs.
 */
async function scrollToBottom(win) {
  await win.webContents.executeJavaScript(`
    (async () => {
      const main = document.querySelector('main.screen');
      if (!main) return 'no main.screen';
      main.scrollTop = main.scrollHeight;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const atBottom = Math.abs(main.scrollHeight - main.clientHeight - main.scrollTop) < 2;
        if (atBottom) return 'scrollTop ' + main.scrollTop + ' of ' + main.scrollHeight;
        await new Promise((r) => setTimeout(r, 40));
      }
      return 'scrollTop ' + main.scrollTop + ' (did not reach bottom of ' + main.scrollHeight + ')';
    })()
  `).then((v) => {
    if (typeof v === 'string') console.log(`[patch-e2e] scrollToBottom: ${v}`);
  });
  // One more frame, so the compositor has the new scroll offset in hand.
  await new Promise((r) => setTimeout(r, 350));
}

/**
 * Assert the History panel is really in the DOM before we scroll to it and shoot it.
 *
 * Scrolling to the bottom and capturing would happily produce a frame that cuts the
 * History panel off again; the failure being guarded against is a *missing* panel, not
 * an un-scrolled one, so the check is a DOM lookup.
 */
async function assertHistoryPanelPresent(win, stepName) {
  const res = await win.webContents.executeJavaScript(`
    (() => {
      const headings = [...document.querySelectorAll('h2')];
      const history = headings.find((h) => /^history/i.test(h.textContent.trim()));
      return {
        ok: true,
        found: history !== undefined,
        text: history === undefined ? '' : history.textContent.replace(/\\s+/g, ' ').trim(),
        counts: history === undefined
          ? ''
          : ((history.querySelector('.counts') || {}).textContent || '').replace(/\\s+/g, ' ').trim(),
      };
    })()
  `);
  if (!res.found) {
    throw new Error(`[patch-e2e] ${stepName} failed page assertion: History heading is not present in the DOM`);
  }
  return res;
}

/**
 * Capture the WHOLE Patch screen — banner AND History panel — in a single frame.
 *
 * `capturePage()` with no arguments only grabs the visible viewport, and the window is
 * 1600x1400, so a tall screen loses its bottom. When `main.screen`'s content is taller
 * than the window we grow the *content* to fit the whole scroll height and restore the
 * original size afterwards. When it already fits, growing would only add empty pixels,
 * so we scroll to the bottom and capture normally.
 *
 * The recorded width/height come from the PNG itself, not from `getContentSize()`:
 * the latter is in logical pixels and the image is in device pixels, so on a scaled
 * display they differ by the scale factor and the report would describe a frame that
 * was never written.
 */
async function captureFullPage(win, name) {
  const metrics = await win.webContents.executeJavaScript(`
    (() => {
      const main = document.querySelector('main.screen');
      if (!main) return { ok: false, error: 'no main.screen' };
      const rect = main.getBoundingClientRect();
      return {
        ok: true,
        contentWidth: Math.ceil(rect.width),
        contentHeight: main.scrollHeight,
        viewportHeight: Math.ceil(rect.height),
        clientWidth: main.clientWidth,
        clientHeight: main.clientHeight,
      };
    })()
  `);
  if (!metrics.ok) throw new Error(`[patch-e2e] captureFullPage ${name} failed: ${metrics.error}`);

  const [originalWidth, originalHeight] = win.getContentSize();
  // A few px of slack so borders/padding never cost us the last row of pixels.
  const needed = metrics.contentHeight + 32;
  let mode;

  if (metrics.contentHeight <= metrics.clientHeight) {
    mode = 'scrolled (content already fits the window)';
    await scrollToBottom(win);
    const shot = await capture(win, name);
    return { ...shot, mode, ...pngSize(shot.path) };
  }

  if (originalHeight >= needed) {
    // Tall window already: scrolling shows the same frame, and keeping the frame in
    // the real window size is more honest than a 3x-tall image of the same pixels.
    mode = `scrolled (window already ${originalHeight}px tall, content ${metrics.contentHeight}px)`;
    await scrollToBottom(win);
    const shot = await capture(win, name);
    return { ...shot, mode, ...pngSize(shot.path) };
  }

  mode = `resized (content ${metrics.contentHeight}px > window ${originalHeight}px)`;
  try {
    win.setContentSize(originalWidth, needed);
    await new Promise((r) => setTimeout(r, 500));
    const shot = await capture(win, name);
    return { ...shot, mode, ...pngSize(shot.path) };
  } finally {
    win.setContentSize(originalWidth, originalHeight);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * The pixel dimensions actually written to `filePath`, read from the PNG's IHDR.
 *
 * Sixteen bytes of header, not `getContentSize()`: on this machine the scale factor
 * is 1.5625, so a window of 754 logical pixels produces a 1178-pixel image, and a
 * report that quoted the logical size would describe a frame nobody ever wrote.
 */
function pngSize(filePath) {
  const fd = openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(24);
    readSync(fd, header, 0, 24, 0);
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    closeSync(fd);
  }
}

async function nav(win, label) {
  await win.webContents.executeJavaScript(`
    (async (label) => {
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
    })(${JSON.stringify(label)})
  `);
}

// ── Test Patches ─────────────────────────────────────────────────────────────

const SINGLE_EDIT_PATCH = `Here is the single edit patch.

### EDIT: src/modes.js
<<<<<<< FIND
export const POINTS_TABLE = [15, 12, 10, 8, 6, 4, 2, 1];
=======
export const POINTS_TABLE = [25, 20, 15, 10, 8, 6, 4, 2];
>>>>>>> REPLACE
`;

const TWO_FILE_PATCH = `Here is the two-file patch.

### EDIT: src/modes.js
<<<<<<< FIND
export const POINTS_TABLE = [15, 12, 10, 8, 6, 4, 2, 1];
=======
export const POINTS_TABLE = [30, 25, 20, 15, 10, 8, 6, 4];
>>>>>>> REPLACE

### EDIT: src/settings.js
<<<<<<< FIND
  difficulty: 'normal',
=======
  difficulty: 'hard',
>>>>>>> REPLACE
`;

const BAD_BLOCK_PATCH = `Here is a patch with one good block and one bad block.

### EDIT: src/modes.js
<<<<<<< FIND
export const POINTS_TABLE = [15, 12, 10, 8, 6, 4, 2, 1];
=======
export const POINTS_TABLE = [99, 88, 77, 66, 55, 44, 33, 22];
>>>>>>> REPLACE

### EDIT: src/settings.js
<<<<<<< FIND
  this_line_does_not_exist_in_settings_anywhere: 999999,
=======
  this_line_is_fake: 111111,
>>>>>>> REPLACE
`;

export async function runPatchLoop() {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  if (!existsSync(MODES_FILE) || !existsSync(SETTINGS_FILE)) {
    return {
      status: 'skipped',
      reason: `Target files in ${PROJECT_PATH} do not exist`,
      screenshots: [],
      verifications: [],
    };
  }

  // Record initial clean states byte-for-byte
  const initialModesContent = readFileSync(MODES_FILE, 'utf8');
  const initialModesSha = sha256(MODES_FILE);
  const initialSettingsContent = readFileSync(SETTINGS_FILE, 'utf8');
  const initialSettingsSha = sha256(SETTINGS_FILE);

  console.log(`[patch-e2e] Initial modes.js sha256:    ${initialModesSha}`);
  console.log(`[patch-e2e] Initial settings.js sha256: ${initialSettingsSha}`);

  const verifications = [];

  const restoreAll = () => {
    if (existsSync(MODES_FILE) && sha256(MODES_FILE) !== initialModesSha) {
      writeFileSync(MODES_FILE, initialModesContent, 'utf8');
      console.log('[patch-e2e] Restored modes.js to initial content');
    }
    if (existsSync(SETTINGS_FILE) && sha256(SETTINGS_FILE) !== initialSettingsSha) {
      writeFileSync(SETTINGS_FILE, initialSettingsContent, 'utf8');
      console.log('[patch-e2e] Restored settings.js to initial content');
    }
  };

  let win = null;

  try {
    const { AppBackend, registerHandlers } = await import(join(DIST_ELECTRON, 'ipcHandlers.js'));

    win = new BrowserWindow({
      width: 1600,
      height: 1400,
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
    console.log('[patch-e2e] IPC handlers registered');

    await win.loadFile(RENDERER_ENTRY);
    await new Promise((r) => setTimeout(r, 1200));

    // ── 1. Open project ──────────────────────────────────────────────────────
    console.log(`[patch-e2e] Opening project: ${PROJECT_PATH}`);
    await win.webContents.executeJavaScript(`
      (() => {
        ${SET_VALUE}
        const input = document.querySelector('#project-path');
        if (!input) throw new Error('no #project-path input found');
        setNativeValue(input, ${JSON.stringify(PROJECT_PATH)});
        const btn = [...document.querySelectorAll('button')]
          .find((b) => /open/i.test(b.textContent) && !b.disabled);
        if (!btn) throw new Error('no enabled Open button found');
        btn.click();
      })()
    `);

    // Wait for project to load and unlock Patch screen
    await win.webContents.executeJavaScript(`
      (() => {
        ${WAIT_FOR}
        return waitFor(
          () => [...document.querySelectorAll('button.screen')]
            .filter((b) => /^(Context|Patch)/.test(b.textContent.trim()))
            .every((b) => !b.disabled),
          'Context and Patch screens to unlock');
      })()
    `);
    console.log('[patch-e2e] Project unlocked');

    await nav(win, 'Patch');
    await new Promise((r) => setTimeout(r, 500));
    await capture(win, '01-open-project.png');

    // Helper: paste patch into textarea
    async function setPatchText(text) {
      await win.webContents.executeJavaScript(`
        (() => {
          ${SET_VALUE}
          const ta = document.getElementById('patch-text');
          if (!ta) throw new Error('no #patch-text textarea');
          setNativeValue(ta, ${JSON.stringify(text)});
        })()
      `);
    }

    // Helper: click preview and wait
    async function clickPreview() {
      const res = await win.webContents.executeJavaScript(`
        (async () => {
          try {
            ${WAIT_FOR}
            const btn = [...document.querySelectorAll('button')]
              .find((b) => /preview/i.test(b.textContent) && !b.disabled);
            if (!btn) return { ok: false, error: 'no enabled Preview button' };
            btn.click();
            await waitFor(() => {
              const files = document.querySelectorAll('section.file');
              const refusal = document.querySelector('.refusal');
              return files.length > 0 || refusal !== null;
            }, 'preview to finish and render files or refusal', 10000);
            return { ok: true };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        })()
      `);
      if (!res.ok) throw new Error('[patch-e2e] clickPreview failed: ' + res.error);
      await new Promise((r) => setTimeout(r, 600));
    }

    // Helper: click apply and wait
    async function clickApply() {
      const res = await win.webContents.executeJavaScript(`
        (async () => {
          try {
            ${WAIT_FOR}
            const btn = [...document.querySelectorAll('button')]
              .find((b) => /apply patch/i.test(b.textContent) && !b.disabled);
            if (!btn) return { ok: false, error: 'no enabled Apply patch button' };
            btn.click();
            await waitFor(() => {
              const h2s = [...document.querySelectorAll('h2')].map(h => h.textContent.trim());
              const hasApplied = h2s.some(t => /applied/i.test(t));
              const hasRefusal = document.querySelector('.refusal') !== null;
              return hasApplied || hasRefusal;
            }, 'apply to finish and render Applied or refusal', 10000);
            return { ok: true };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        })()
      `);
      if (!res.ok) throw new Error('[patch-e2e] clickApply failed: ' + res.error);
      await new Promise((r) => setTimeout(r, 600));
    }

    // Helper: click undo and wait
    async function clickUndo() {
      const res = await win.webContents.executeJavaScript(`
        (async () => {
          try {
            ${WAIT_FOR}
            const btn = [...document.querySelectorAll('button')]
              .find((b) => b.textContent.trim() === 'Undo' && !b.disabled);
            if (!btn) return { ok: false, error: 'no enabled Undo button' };
            btn.click();
            await waitFor(() => {
              const redo = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Redo');
              return redo && !redo.disabled;
            }, 'undo to complete and Redo to become enabled', 10000);
            return { ok: true };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        })()
      `);
      if (!res.ok) throw new Error('[patch-e2e] clickUndo failed: ' + res.error);
      await new Promise((r) => setTimeout(r, 600));
    }

    // Helper: click redo and wait
    async function clickRedo() {
      const res = await win.webContents.executeJavaScript(`
        (async () => {
          try {
            ${WAIT_FOR}
            const btn = [...document.querySelectorAll('button')]
              .find((b) => b.textContent.trim() === 'Redo' && !b.disabled);
            if (!btn) return { ok: false, error: 'no enabled Redo button' };
            btn.click();
            await waitFor(() => {
              const undo = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Undo');
              return undo && !undo.disabled;
            }, 'redo to complete and Undo to become enabled', 10000);
            return { ok: true };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        })()
      `);
      if (!res.ok) throw new Error('[patch-e2e] clickRedo failed: ' + res.error);
      await new Promise((r) => setTimeout(r, 600));
    }

    async function assertPageState(stepName, checks) {
      const res = await win.webContents.executeJavaScript(`
        (() => {
          try {
            const bodyText = (document.body.textContent || '') + '\\n' + (document.body.innerText || '');
            const headings = [...document.querySelectorAll('h2')].map((h) => h.textContent.trim().split(String.fromCharCode(10))[0].trim());
            const undoBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Undo');
            const redoBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Redo');
            const applyBtn = [...document.querySelectorAll('button')].find((b) => /apply patch/i.test(b.textContent));
            return {
              ok: true,
              text: bodyText,
              headings,
              undoEnabled: undoBtn ? !undoBtn.disabled : false,
              redoEnabled: redoBtn ? !redoBtn.disabled : false,
              applyDisabled: applyBtn ? applyBtn.disabled : true,
            };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        })()
      `);

      if (!res.ok) throw new Error(`[patch-e2e] ${stepName} evaluate state failed: ` + res.error);
      const state = res;

      if (checks.hasHeading) {
        for (const h of checks.hasHeading) {
          if (!state.headings.some((heading) => heading.toLowerCase().startsWith(h.toLowerCase()))) {
            throw new Error(`[patch-e2e] ${stepName} failed page assertion: expected heading "${h}", found: ${JSON.stringify(state.headings)}`);
          }
        }
      }
      if (checks.notHasHeading) {
        for (const h of checks.notHasHeading) {
          if (state.headings.some((heading) => heading.toLowerCase().startsWith(h.toLowerCase()))) {
            throw new Error(`[patch-e2e] ${stepName} failed page assertion: expected NOT to find heading "${h}", found: ${JSON.stringify(state.headings)}`);
          }
        }
      }

      if (checks.containsText) {
        for (const str of checks.containsText) {
          if (!state.text.toLowerCase().includes(str.toLowerCase())) {
            console.error(`[patch-e2e] Assertion failure! Looking for "${str}". Full body text:\\n---\\n${state.text}\\n---`);
            throw new Error(`[patch-e2e] ${stepName} failed page assertion: expected text to contain "${str}"`);
          }
        }
      }
      if (checks.notContainsText) {
        for (const str of checks.notContainsText) {
          if (state.text.toLowerCase().includes(str.toLowerCase())) {
            console.error(`[patch-e2e] Assertion failure! Expected NOT to find "${str}". Full body text:\\n---\\n${state.text}\\n---`);
            throw new Error(`[patch-e2e] ${stepName} failed page assertion: expected text NOT to contain "${str}"`);
          }
        }
      }
      if (checks.undoEnabled !== undefined && state.undoEnabled !== checks.undoEnabled) {
        throw new Error(`[patch-e2e] ${stepName} failed assertion: Undo button expected enabled=${checks.undoEnabled}, got ${state.undoEnabled}`);
      }
      if (checks.redoEnabled !== undefined && state.redoEnabled !== checks.redoEnabled) {
        throw new Error(`[patch-e2e] ${stepName} failed assertion: Redo button expected enabled=${checks.redoEnabled}, got ${state.redoEnabled}`);
      }
      if (checks.applyDisabled !== undefined && state.applyDisabled !== checks.applyDisabled) {
        throw new Error(`[patch-e2e] ${stepName} failed assertion: Apply button expected disabled=${checks.applyDisabled}, got ${state.applyDisabled}`);
      }
    }

    // ── 2. Single EDIT patch -> Preview -> Apply -> Disk check ──────────────
    console.log('[patch-e2e] Step 2: Pasting single EDIT patch into modes.js...');
    await setPatchText(SINGLE_EDIT_PATCH);
    await clickPreview();
    await capture(win, '02-single-patch-preview.png');

    console.log('[patch-e2e] Applying single EDIT patch...');
    await clickApply();
    const singleAppliedSha = sha256(MODES_FILE);
    const singleAppliedContent = readFileSync(MODES_FILE, 'utf8');

    if (singleAppliedSha === initialModesSha) {
      throw new Error('Step 2 failed: modes.js sha256 did not change on disk after Apply');
    }
    if (!singleAppliedContent.includes('25, 20, 15, 10')) {
      throw new Error('Step 2 failed: modes.js on disk does not contain replacement content');
    }
    await assertPageState('Step 2 After Apply', {
      containsText: ['1 step kept'],
      hasHeading: ['Applied'],
      notHasHeading: ['Undone'],
      undoEnabled: true,
      redoEnabled: false,
    });
    console.log(`[patch-e2e] Step 2 PASSED: modes.js changed to sha256 ${singleAppliedSha}, page shows '1 step kept' and 'Applied', Undo enabled`);
    verifications.push({
      step: '2-single-patch-apply',
      initialModesSha,
      singleAppliedSha,
      changed: true,
      passed: true,
    });
    await assertHistoryPanelPresent(win, 'Step 2 After Apply');
    await scrollToBottom(win);
    await capture(win, '03-single-patch-applied.png');

    // ── 3. Press Undo -> Prove back byte for byte ────────────────────────────
    console.log('[patch-e2e] Step 3: Clicking Undo...');
    await clickUndo();
    const singleUndoneSha = sha256(MODES_FILE);

    if (singleUndoneSha !== initialModesSha) {
      throw new Error(
        `Step 3 failed: modes.js sha256 after undo (${singleUndoneSha}) does not match initial (${initialModesSha})`,
      );
    }
    await assertPageState('Step 3 After Undo', {
      containsText: ['0 steps kept'],
      hasHeading: ['Undone'],
      notHasHeading: ['Applied'],
      undoEnabled: false,
      redoEnabled: true,
    });
    console.log(`[patch-e2e] Step 3 PASSED: modes.js is back byte-for-byte (${singleUndoneSha}), page shows 'Undone', Redo enabled`);
    verifications.push({
      step: '3-single-patch-undo',
      initialModesSha,
      singleUndoneSha,
      matchedByteForByte: true,
      passed: true,
    });
    await assertHistoryPanelPresent(win, 'Step 3 After Undo');
    await scrollToBottom(win);
    await capture(win, '04-single-patch-undone.png');

    // ── 4. Press Redo -> Prove changed again ─────────────────────────────────
    console.log('[patch-e2e] Step 4: Clicking Redo...');
    await clickRedo();
    const singleRedoneSha = sha256(MODES_FILE);

    if (singleRedoneSha !== singleAppliedSha) {
      throw new Error(
        `Step 4 failed: modes.js sha256 after redo (${singleRedoneSha}) does not match applied (${singleAppliedSha})`,
      );
    }
    await assertPageState('Step 4 After Redo', {
      containsText: ['1 step kept'],
      notHasHeading: ['Undone'],
      undoEnabled: true,
      redoEnabled: false,
    });
    console.log(`[patch-e2e] Step 4 PASSED: modes.js changed again to ${singleRedoneSha}, Undo enabled again`);
    verifications.push({
      step: '4-single-patch-redo',
      singleAppliedSha,
      singleRedoneSha,
      matchedApplied: true,
      passed: true,
    });
    await capture(win, '05-single-patch-redone.png');

    // Reset clean before 2-file test
    console.log('[patch-e2e] Resetting to clean state before 2-file test...');
    await clickUndo();
    if (sha256(MODES_FILE) !== initialModesSha) {
      throw new Error('Reset failed: modes.js is not back to initial');
    }
    await assertPageState('Reset clean before 2-file test', {
      containsText: ['0 steps kept'],
      undoEnabled: false,
      redoEnabled: true,
    });
    await capture(win, '06-single-patch-reset.png');

    // ── 5. Apply 2-file patch and undo as ONE step ───────────────────────────
    console.log('[patch-e2e] Step 5: Applying 2-file patch (modes.js & settings.js)...');
    await setPatchText(TWO_FILE_PATCH);
    await clickPreview();
    await capture(win, '07-two-file-patch-preview.png');

    await clickApply();
    const twoFilesModesSha = sha256(MODES_FILE);
    const twoFilesSettingsSha = sha256(SETTINGS_FILE);

    if (twoFilesModesSha === initialModesSha) {
      throw new Error('Step 5 failed: modes.js was not changed by 2-file patch');
    }
    if (twoFilesSettingsSha === initialSettingsSha) {
      throw new Error('Step 5 failed: settings.js was not changed by 2-file patch');
    }
    await assertPageState('Step 5 After 2-file Apply', {
      containsText: ['1 step kept'],
      hasHeading: ['Applied'],
      notHasHeading: ['Undone'],
      undoEnabled: true,
      redoEnabled: false,
    });
    console.log(`[patch-e2e] Step 5 apply PASSED: both files changed on disk, exactly 1 history step`);
    console.log(`  modes.js:    ${twoFilesModesSha}`);
    console.log(`  settings.js: ${twoFilesSettingsSha}`);
    await assertHistoryPanelPresent(win, 'Step 5 After 2-file Apply');
    await scrollToBottom(win);
    await capture(win, '08-two-file-patch-applied.png');

    // One frame holding BOTH the Applied banner and the History panel, so a reviewer
    // can read "1 step kept" and the two file names without scrolling between shots.
    const fullPageApply = await captureFullPage(win, '12-two-file-applied-fullpage.png');
    console.log(
      `[patch-e2e] 12-two-file-applied-fullpage.png: ${fullPageApply.mode}, ` +
        `${fullPageApply.width}x${fullPageApply.height}`,
    );

    console.log('[patch-e2e] Step 5: Undoing 2-file patch in one step...');
    await clickUndo();
    const twoFilesUndoneModesSha = sha256(MODES_FILE);
    const twoFilesUndoneSettingsSha = sha256(SETTINGS_FILE);

    if (twoFilesUndoneModesSha !== initialModesSha) {
      throw new Error(
        `Step 5 undo failed: modes.js sha256 (${twoFilesUndoneModesSha}) != initial (${initialModesSha})`,
      );
    }
    if (twoFilesUndoneSettingsSha !== initialSettingsSha) {
      throw new Error(
        `Step 5 undo failed: settings.js sha256 (${twoFilesUndoneSettingsSha}) != initial (${initialSettingsSha})`,
      );
    }

    // A matching sha256 already means matching bytes; reading the files and comparing
    // with `===` states the claim in the form the reviewer can check by eye, and fails
    // with the actual on-disk text in the report rather than a lone digest.
    const twoFilesUndoneModesContent = readFileSync(MODES_FILE, 'utf8');
    const twoFilesUndoneSettingsContent = readFileSync(SETTINGS_FILE, 'utf8');
    if (twoFilesUndoneModesContent !== initialModesContent) {
      throw new Error('Step 5 undo failed: modes.js content on disk is not byte-identical to the initial content');
    }
    if (twoFilesUndoneSettingsContent !== initialSettingsContent) {
      throw new Error(
        'Step 5 undo failed: settings.js content on disk is not byte-identical to the initial content',
      );
    }

    const TWO_FILE_UNDO_SUMMARY = 'Reverted 2 files: src/modes.js, src/settings.js';
    await assertPageState('Step 5 After 2-file Undo', {
      containsText: ['0 steps kept', TWO_FILE_UNDO_SUMMARY],
      hasHeading: ['Undone'],
      notHasHeading: ['Applied'],
      undoEnabled: false,
      redoEnabled: true,
    });
    console.log('[patch-e2e] Step 5 PASSED: both files restored byte-for-byte in ONE undo step');
    console.log(`[patch-e2e] Step 5 undo message names both files: "${TWO_FILE_UNDO_SUMMARY}"`);
    verifications.push({
      step: '5-two-file-patch-apply-and-undo',
      initialModesSha,
      twoFilesModesSha,
      twoFilesUndoneModesSha,
      initialSettingsSha,
      twoFilesSettingsSha,
      twoFilesUndoneSettingsSha,
      modesByteIdentical: true,
      settingsByteIdentical: true,
      bothRestoredByteForByte: true,
      undoSummary: TWO_FILE_UNDO_SUMMARY,
      undoSummaryNamesBothFiles: true,
      fullPageAppliedCapture: {
        name: fullPageApply.name,
        mode: fullPageApply.mode,
        width: fullPageApply.width,
        height: fullPageApply.height,
      },
      passed: true,
    });
    await assertHistoryPanelPresent(win, 'Step 5 After 2-file Undo');
    await scrollToBottom(win);
    await capture(win, '09-two-file-patch-undone.png');
    const fullPageUndo = await captureFullPage(win, '09b-two-file-undo-names-files.png');
    console.log(
      `[patch-e2e] 09b-two-file-undo-names-files.png: ${fullPageUndo.mode}, ` +
        `${fullPageUndo.width}x${fullPageUndo.height}`,
    );

    // ── 6. Apply patch with 1 bad block -> Prove NOTHING written ─────────────
    console.log('[patch-e2e] Step 6: Testing patch with one bad block...');
    await setPatchText(BAD_BLOCK_PATCH);
    await clickPreview();
    await capture(win, '10-bad-block-patch-preview.png');

    // Verify UI disables Apply button and displays block failure
    await assertPageState('Step 6 Bad block preview', {
      containsText: ['0 steps kept'],
      applyDisabled: true,
    });

    const uiInspection = await win.webContents.executeJavaScript(`
      (() => {
        const failure = document.querySelector('.failure');
        const blocked = document.querySelector('.blocked') || document.querySelector('.refusal');
        const applyBtn = [...document.querySelectorAll('button')].find((b) => /apply patch/i.test(b.textContent));
        return {
          hasFailure: failure !== null,
          hasBlocked: blocked !== null,
          applyDisabled: applyBtn !== null && applyBtn.disabled === true,
        };
      })()
    `);

    if (!uiInspection.applyDisabled) {
      throw new Error('Step 6 failed: Apply button was NOT disabled when a patch block failed');
    }
    console.log('[patch-e2e] UI correctly disabled Apply button and flagged failed block');

    // ── 6a. Force the UI path anyway: click the disabled Apply button ─────────
    // A disabled button swallows the click, so this proves the *user* route is closed.
    // The direct IPC call below then proves the *backend* route is closed too; a
    // harness that only did the latter would still pass if the UI let clicks through.
    const modesShaBeforeClick = sha256(MODES_FILE);
    const settingsShaBeforeClick = sha256(SETTINGS_FILE);
    const forcedClick = await win.webContents.executeJavaScript(`
      (() => {
        const applyBtn = [...document.querySelectorAll('button')]
          .find((b) => /apply patch/i.test(b.textContent));
        if (!applyBtn) return { ok: false, error: 'no Apply patch button found' };
        const disabledBeforeClick = applyBtn.disabled === true;
        applyBtn.click();
        return { ok: true, disabledBeforeClick };
      })()
    `);

    if (!forcedClick.ok) {
      throw new Error('[patch-e2e] Step 6 forced-click failed: ' + forcedClick.error);
    }
    if (!forcedClick.disabledBeforeClick) {
      throw new Error('Step 6 failed: Apply button was not disabled when the forced-click check ran');
    }
    await new Promise((r) => setTimeout(r, 800));

    const modesShaAfterClick = sha256(MODES_FILE);
    const settingsShaAfterClick = sha256(SETTINGS_FILE);
    if (modesShaAfterClick !== modesShaBeforeClick) {
      throw new Error(
        `Step 6 failed: clicking the disabled Apply button changed modes.js (${modesShaBeforeClick} -> ${modesShaAfterClick})`,
      );
    }
    if (settingsShaAfterClick !== settingsShaBeforeClick) {
      throw new Error(
        `Step 6 failed: clicking the disabled Apply button changed settings.js (${settingsShaBeforeClick} -> ${settingsShaAfterClick})`,
      );
    }
    console.log(
      '[patch-e2e] Clicking the disabled Apply button wrote nothing; both shas unchanged. Proceeding to the direct IPC path.',
    );

    // Even if IPC apply is invoked directly, verify backend refuses and writes nothing
    const ipcResult = await win.webContents.executeJavaScript(`
      (async () => {
        try {
          const res = await window.contextforge.invoke('patch:apply', {
            text: ${JSON.stringify(BAD_BLOCK_PATCH)},
          });
          return res;
        } catch (err) {
          return { ok: false, reason: err.message };
        }
      })()
    `);

    if (ipcResult.ok === true) {
      throw new Error('Step 6 failed: IPC patch:apply succeeded on a patch with an invalid block!');
    }
    console.log(`[patch-e2e] Backend refused bad patch: "${ipcResult.reason}"`);

    // Verify disk content untouched byte-for-byte
    const badModesSha = sha256(MODES_FILE);
    const badSettingsSha = sha256(SETTINGS_FILE);

    if (badModesSha !== initialModesSha) {
      throw new Error(`Step 6 failed: modes.js was modified! All-or-nothing atomicity broken!`);
    }
    if (badSettingsSha !== initialSettingsSha) {
      throw new Error(`Step 6 failed: settings.js was modified! All-or-nothing atomicity broken!`);
    }

    // The same claim with `===` on the raw file contents rather than on a digest.
    const badModesContent = readFileSync(MODES_FILE, 'utf8');
    const badSettingsContent = readFileSync(SETTINGS_FILE, 'utf8');
    if (badModesContent !== initialModesContent) {
      throw new Error('Step 6 failed: modes.js content on disk differs from the initial content');
    }
    if (badSettingsContent !== initialSettingsContent) {
      throw new Error('Step 6 failed: settings.js content on disk differs from the initial content');
    }

    // The atomicity claim in its sharpest form: this patch carries a GOOD block (the
    // modes.js edit, which alone would apply cleanly) and a BAD block. If the batch
    // were applied block-by-block, the good block would already be on disk. Finding
    // the bad patch's replacement text means the good block was written; not finding
    // it means the batch wrote NEITHER block.
    const BAD_BLOCK_REPLACEMENT = '99, 88, 77, 66, 55, 44, 33, 22';
    const goodBlockNotApplied = !readFileSync(MODES_FILE, 'utf8').includes(BAD_BLOCK_REPLACEMENT);
    if (!goodBlockNotApplied) {
      throw new Error(
        `Step 6 failed: modes.js contains the bad patch's replacement text (${BAD_BLOCK_REPLACEMENT}) — ` +
          'the good block was applied even though a sibling block failed!',
      );
    }

    console.log('[patch-e2e] Step 6 PASSED: NOTHING written to disk, both files untouched byte-for-byte');
    console.log(`[patch-e2e] Good block in the refused batch was not applied ("${BAD_BLOCK_REPLACEMENT}" absent)`);

    await assertPageState('Step 6 After bad block refusal', {
      containsText: ['0 steps kept'],
      applyDisabled: true,
      // A refused patch must leave nothing to undo; if Undo were live here, some
      // earlier step would have leaked a history entry into this count.
      undoEnabled: false,
    });

    const badBlockHistory = await assertHistoryPanelPresent(win, 'Step 6 After bad block refusal');
    if (badBlockHistory.counts !== '0 steps kept') {
      throw new Error(
        `[patch-e2e] Step 6 After bad block refusal failed page assertion: History expected "0 steps kept", got "${badBlockHistory.counts}"`,
      );
    }

    verifications.push({
      step: '6-bad-block-nothing-written',
      initialModesSha,
      badModesSha,
      initialSettingsSha,
      badSettingsSha,
      modesByteIdentical: true,
      settingsByteIdentical: true,
      bytesWritten: 0,
      goodBlockNotApplied: true,
      applyDisabled: uiInspection.applyDisabled,
      applyDisabledAtClickTime: forcedClick.disabledBeforeClick,
      forcedClickWroteNothing: true,
      undoDisabledAfterRefusal: true,
      historyStepsKept: 0,
      refusalReason: ipcResult.reason,
      atomicityPreserved: true,
      passed: true,
    });
    await capture(win, '11-bad-block-nothing-written.png');
    const fullPageBadBlock = await captureFullPage(win, '11b-bad-block-nothing-written-fullpage.png');
    console.log(
      `[patch-e2e] 11b-bad-block-nothing-written-fullpage.png: ${fullPageBadBlock.mode}, ` +
        `${fullPageBadBlock.width}x${fullPageBadBlock.height}`,
    );

    const report = {
      project: PROJECT_PATH,
      timestamp: new Date().toISOString(),
      screenshots,
      verifications,
      consoleErrors,
      status: 'passed',
    };
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`[patch-e2e] Report written to ${REPORT_PATH}`);

    return report;
  } finally {
    // ── 8. Always restore the files at the end ────────────────────────────────
    restoreAll();
    console.log('[patch-e2e] Final sanity check:');
    console.log(`  modes.js sha256:    ${sha256(MODES_FILE)} (matches initial: ${sha256(MODES_FILE) === initialModesSha})`);
    console.log(`  settings.js sha256: ${sha256(SETTINGS_FILE)} (matches initial: ${sha256(SETTINGS_FILE) === initialSettingsSha})`);

    if (win !== null && !win.isDestroyed()) {
      win.destroy();
    }
  }
}

async function main() {
  await app.whenReady();
  let result;
  try {
    result = await runPatchLoop();
  } catch (error) {
    console.error('[patch-e2e] FATAL ERROR:', error.stack || error.message);
    console.error('[patch-e2e] Console errors:', JSON.stringify(consoleErrors, null, 2));
    result = { status: 'failed', error: error.message };
  }
  console.log(JSON.stringify(result, null, 2));
  app.exit(result.status === 'passed' ? 0 : result.status === 'skipped' ? 2 : 1);
}

// Top-level await is not supported in Electron ESM main entry point; execute main()
main().catch((err) => {
  console.error('[patch-e2e] Uncaught:', err);
  app.exit(1);
});

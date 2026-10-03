/**
 * capture-newproject.mjs — prove the New Project gate in a real window.
 *
 * The unit tests assert `checkBrief` and the `disabled` binding. What only a
 * real window can show is the rule the phase is about: **the copy button is
 * disabled until the idea is filled in, and enabled after.**
 *
 * Every assertion here is a throw, not a note. A screenshot of a state the
 * harness did not confirm is filed as evidence and proves nothing — the D43
 * lesson, from a capture that once photographed a collapsed panel under a
 * filename saying "expanded".
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
const SCREENSHOTS_DIR = join(CF_ROOT, 'screenshots', 'v05');
const REPORT_PATH = join(SCREENSHOTS_DIR, 'report-newproject.json');

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
  writeFileSync(join(SCREENSHOTS_DIR, name), png);
  screenshots.push({ name, bytes: png.length });
  console.log(`[capture] ${name} (${png.length} bytes)`);
}

/** The step indicator's state, read from the DOM. */
async function readState(win) {
  return win.webContents.executeJavaScript(
    `(() => {
       const steps = [...document.querySelectorAll('.steps li')].map((li) => ({
         label: li.textContent.trim(),
         active: li.classList.contains('active'),
         done: li.classList.contains('done'),
       }));
       const buttons = [...document.querySelectorAll('.new-project button')].map((b) => ({
         text: b.textContent.trim(),
         disabled: b.disabled,
       }));
       return {
         steps,
         buttons,
         nameValue: document.querySelector('#np-name')?.value ?? null,
         ideaValue: document.querySelector('#np-idea')?.value ?? null,
         problems: [...document.querySelectorAll('.brief-problems li')].map((li) => li.textContent.trim()),
         promptLength: document.querySelector('.new-project .prompt')?.textContent.length ?? 0,
       };
     })()`,
  );
}

/** The Copy prompt button, or null when step 3 is not showing. */
function copyButton(state) {
  return state.buttons.find((b) => /copy prompt|copied/i.test(b.text)) ?? null;
}

async function main() {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const { AppBackend, registerHandlers } = await import(join(DIST_ELECTRON, 'ipcHandlers.js'));

  let win;
  await app.whenReady();
  win = new BrowserWindow({
    width: 1400,
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
    }),
  );

  await win.loadFile(RENDERER_ENTRY);
  await new Promise((r) => setTimeout(r, 1500));

  // ── Open the New Project flow ───────────────────────────────────────────────
  const opened = await win.webContents.executeJavaScript(`
    (() => {
      const btn = [...document.querySelectorAll('button')]
        .find((b) => /new project/i.test(b.textContent));
      if (!btn) {
        const seen = [...document.querySelectorAll('button')].map((b) => b.textContent.trim());
        return 'no New project button; saw ' + JSON.stringify(seen);
      }
      btn.click();
      return 'clicked';
    })()
  `);
  if (opened !== 'clicked') throw new Error(`Could not open the flow: ${opened}`);
  await new Promise((r) => setTimeout(r, 800));

  const step1 = await readState(win);
  console.log(`[capture] step 1: ${JSON.stringify(step1.steps.map((s) => s.label))}`);

  if (step1.steps.length !== 3) {
    throw new Error(`[capture] the flow shows ${step1.steps.length} step(s), not 3`);
  }
  // Step 3 must not be reachable yet: the prompt field is absent at step 1.
  if (step1.promptLength !== 0) {
    throw new Error('[capture] a prompt was rendered at step 1, before any idea was written');
  }

  // ── Step 1 → 2, with a name ─────────────────────────────────────────────────
  await win.webContents.executeJavaScript(`
    (async () => {
      ${SET_VALUE}
      const name = document.querySelector('#np-name');
      if (!name) throw new Error('no #np-name');
      setNativeValue(name, 'star-crawler');
      await new Promise((r) => setTimeout(r, 400));
      const buttons = [...document.querySelectorAll('.new-project button')];
      const next = buttons.find((b) => /describe the game/i.test(b.textContent));
      if (!next) {
        throw new Error(
          'no "Next: describe the game" button; buttons were ' +
            JSON.stringify(buttons.map((b) => ({ t: b.textContent.trim(), d: b.disabled }))),
        );
      }
      if (next.disabled) throw new Error('the Next button is disabled even though a name was typed');
      next.click();
      // Wait for the field rather than a fixed sleep: Svelte flushes on a
      // microtask, so the click's effect is not visible on the next line.
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        if (document.querySelector('#np-idea')) return 'advanced';
        await new Promise((r) => setTimeout(r, 60));
      }
      return 'clicked, but step 2 never appeared';
    })()
  `).then((v) => {
    if (v !== 'advanced') throw new Error(`Step 1 → 2: ${v}`);
  });

  const step2 = await readState(win);
  if (step2.ideaValue === null) throw new Error('[capture] step 2 did not show the idea field');
  if (step2.promptLength !== 0) {
    throw new Error('[capture] a prompt was rendered at step 2, before any idea was written');
  }

  // ── The gate: step 2 with no idea must not enable Build ─────────────────────
  // Step 2's button is "Build the prompt". It is asserted *reachable* but that
  // `toPrompt` refuses, because `canCopy` is false.
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = [...document.querySelectorAll('.new-project button')]
        .find((b) => /build the prompt/i.test(b.textContent));
      if (!btn) throw new Error('no Build the prompt button at step 2');
      btn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 700));

  const afterEmptyBuild = await readState(win);
  if (afterEmptyBuild.promptLength !== 0) {
    throw new Error(
      `[capture] "Build the prompt" produced a ${afterEmptyBuild.promptLength}-char prompt ` +
        'with no idea written — the gate did not hold',
    );
  }
  const activeAfterEmpty = afterEmptyBuild.steps.find((s) => s.active)?.label ?? '(none)';
  console.log(
    `[capture] gate held: no prompt with an empty idea; active step = ${JSON.stringify(activeAfterEmpty)}, ` +
      `buttons = ${JSON.stringify(afterEmptyBuild.buttons)}`,
  );
  if (activeAfterEmpty === 'Take the prompt') {
    // The guard is `if (!canCopy) return`, so reaching step 3 with no idea means
    // the guard did not hold. Worth failing on rather than photographing.
    throw new Error(
      '[capture] the flow advanced to step 3 with no idea written; the gate did not hold',
    );
  }
  await capture(win, 'newproject-02-gate-empty-idea.png');

  // Type the idea in (still on step 2), then build the prompt.
  await win.webContents.executeJavaScript(`
    (async () => {
      ${SET_VALUE}
      const idea = document.querySelector('#np-idea');
      if (!idea) throw new Error('no #np-idea');
      setNativeValue(idea, 'You drive a hover car around a collapsing space station, collecting fuel pods.');
      await new Promise((r) => setTimeout(r, 700));
      return true;
    })()
  `);

  const filled = await readState(win);
  if (filled.problems.length > 0) {
    throw new Error(
      `[capture] a complete brief still reported problems: ${JSON.stringify(filled.problems)}`,
    );
  }

  // ── Step 3, and the copy button ─────────────────────────────────────────────
  await win.webContents.executeJavaScript(`
    (async () => {
      const btn = [...document.querySelectorAll('.new-project button')]
        .find((b) => /build the prompt/i.test(b.textContent));
      if (!btn) throw new Error('no Build the prompt button');
      btn.click();
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (document.querySelector('.new-project .prompt')) return true;
        await new Promise((r) => setTimeout(r, 60));
      }
      return false;
    })()
  `);
  await new Promise((r) => setTimeout(r, 900));

  const step3 = await readState(win);
  if (step3.promptLength < 500) {
    throw new Error(
      `[capture] step 3 rendered a ${step3.promptLength}-char prompt; a real one is far longer`,
    );
  }

  const copy = copyButton(step3);
  if (copy === null) {
    throw new Error(
      `[capture] no copy button on step 3; buttons were ${JSON.stringify(step3.buttons)}`,
    );
  }
  if (copy.disabled) {
    throw new Error(
      '[capture] the copy button is still disabled after a complete brief — the gate never opens',
    );
  }
  console.log(`[capture] step 3: prompt ${step3.promptLength} chars, copy button enabled`);
  await capture(win, 'newproject-04-step3-prompt-ready.png');

  // ── Back to step 2, clear the idea: the gate must close again ───────────────
  await win.webContents.executeJavaScript(`
    (async () => {
      ${SET_VALUE}
      const back = [...document.querySelectorAll('.new-project button')]
        .find((b) => b.textContent.trim() === 'Back');
      if (!back) {
        const seen = [...document.querySelectorAll('.new-project button')]
          .map((b) => b.textContent.trim());
        throw new Error('no Back button on step 3; buttons were ' + JSON.stringify(seen));
      }
      back.click();
      // Wait for the idea field rather than a fixed sleep.
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const idea = document.querySelector('#np-idea');
        if (idea) {
          setNativeValue(idea, '');
          await new Promise((r) => setTimeout(r, 800));
          return 'back-and-cleared';
        }
        await new Promise((r) => setTimeout(r, 60));
      }
      return 'Back clicked but the idea field never appeared';
    })()
  `).then((v) => {
    if (v !== 'back-and-cleared') throw new Error(`Clearing the idea: ${v}`);
  });
  const cleared = await readState(win);
  if (cleared.problems.length === 0) {
    throw new Error(
      '[capture] clearing the idea reported no problems; the gate did not close',
    );
  }
  console.log(`[capture] gate closed: ${cleared.problems.length} problem(s) reported`);

  const report = {
    steps: step1.steps.map((s) => s.label),
    promptLength: step3.promptLength,
    gateHeldOnEmptyIdea: true,
    gateOpenedOnFilledIdea: true,
    gateClosedAgainOnClearing: true,
    problemsWhenCleared: cleared.problems,
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
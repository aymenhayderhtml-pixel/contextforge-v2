/**
 * capture-brief.mjs — e2e test harness driving the Brief loop in Electron.
 *
 * Requirements:
 * 1. Open Context screen.
 * 2. Press 'New AI context', build One-shot brief with task and Interactive brief.
 * 3. Read .contextforge/brief.md from disk and assert:
 *    - the stack
 *    - the folder map
 *    - real public signatures
 *    - the scene.json and prefab rules
 *    - the patch format
 * 4. Assert that Interactive tells the AI to reply NEED: <path>.
 * 5. Simulate AI reply `NEED: src/track.js` and prove the file gets attached.
 * 6. Take screenshots at each step into screenshots/v4b/.
 * 7. Restore original state of .contextforge/brief.md.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
const REPORT_PATH = join(SCREENSHOTS_DIR, 'report.json');

const BRIEF_DIR = join(PROJECT_PATH, '.contextforge');
const BRIEF_FILE = join(BRIEF_DIR, 'brief.md');

const EXIT = { passed: 0, failed: 1, skipped: 2, couldNotStart: 3 };

const SET_VALUE = `
  const setNativeValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
`;

const WAIT_FOR = `
  const waitFor = async (fn, what, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (await fn()) return true; } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Timed out waiting for ' + what);
  };
`;

const screenshots = [];
const consoleErrors = [];
const assertions = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
  assertions.push({ pass: true, message });
  console.log(`[brief-e2e] ASSERT: ${message}`);
}

function attachConsole(win, label) {
  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const text = typeof event?.message === 'string' ? event.message : (typeof message === 'string' ? message : String(event));
    console.log(`[renderer-${label}] ${text}`);
    if (text.startsWith('[capture] PAGE-ERROR')) {
      consoleErrors.push({ window: label, message: text, source: 'stack' });
      return;
    }
    if (text.startsWith('[capture]')) return;
    consoleErrors.push({ window: label, message: text, source: `${sourceId}:${line}` });
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    consoleErrors.push({ window: label, message: `did-fail-load ${code}: ${desc}`, source: url });
  });

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
  console.log(`[brief-e2e] screenshot ${name} (${png.length} bytes)`);
  return { path: target, bytes: png.length };
}

async function scrollTo(win, offset) {
  await win.webContents.executeJavaScript(
    `(async (offset) => {
      const main = document.querySelector('main.screen') || document.querySelector('section.screen');
      if (!main) return 'no scroll container';
      main.scrollTop = offset;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (Math.abs(main.scrollTop - offset) < 2) return main.scrollTop;
        await new Promise((r) => setTimeout(r, 40));
      }
      return main.scrollTop + ' (did not reach ' + offset + ')';
    })(${offset})`,
  ).then((v) => {
    if (typeof v === 'string') console.log(`[brief-e2e] scroll: ${v}`);
  });
  await new Promise((r) => setTimeout(r, 350));
}

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

export async function runBriefE2E() {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // Record original brief state for clean restoration (Step 7)
  const hadBriefOriginally = existsSync(BRIEF_FILE);
  const hadBriefDirOriginally = existsSync(BRIEF_DIR);
  const originalBriefContent = hadBriefOriginally ? readFileSync(BRIEF_FILE, 'utf8') : null;

  let status = 'failed';
  let failureReason = null;

  try {
    const { AppBackend, registerHandlers } = await import(join(DIST_ELECTRON, 'ipcHandlers.js'));

    await app.whenReady();

    const win = new BrowserWindow({
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
    console.log('[brief-e2e] Electron handlers registered');

    await win.loadFile(RENDERER_ENTRY);
    await new Promise((r) => setTimeout(r, 1500));

    // Open project
    const opened = await win.webContents.executeJavaScript(`
      (() => {
        ${SET_VALUE}
        const input = document.querySelector('#project-path');
        if (!input) return 'no #project-path input — not on Project screen';
        setNativeValue(input, ${JSON.stringify(PROJECT_PATH)});
        return 'typed';
      })()
    `);
    if (opened !== 'typed') throw new Error(`Could not type project path: ${opened}`);

    await win.webContents.executeJavaScript(`
      (() => {
        const btn = [...document.querySelectorAll('button')]
          .find((b) => /open/i.test(b.textContent) && !b.disabled);
        if (!btn) throw new Error('no enabled Open button');
        btn.click();
      })()
    `);
    console.log('[brief-e2e] project Open clicked');

    // Wait for Context button to unlock
    await win.webContents.executeJavaScript(`
      (() => {
        ${WAIT_FOR}
        return waitFor(
          () => [...document.querySelectorAll('button.screen')]
            .filter((b) => /^(Context|Patch)/.test(b.textContent.trim()))
            .every((b) => !b.disabled),
          'Context button to unlock');
      })()
    `);
    await new Promise((r) => setTimeout(r, 800));

    // ── 1. Open the Context screen ────────────────────────────────────────────
    console.log('[brief-e2e] Navigating to Context screen...');
    await nav(win, 'Context');
    await new Promise((r) => setTimeout(r, 600));
    await capture(win, '01-context-resting.png');

    // ── 2. Press 'New AI context', build One-shot brief with a task ───────────
    console.log('[brief-e2e] Setting up One-shot brief with task...');
    const TASK_TEXT = 'Audit kart physics, check collision impulses and track boundary handling.';

    await win.webContents.executeJavaScript(`
      (() => {
        ${SET_VALUE}
        const radio = document.querySelector('input[type="radio"][value="oneShot"]');
        if (radio) {
          radio.click();
          radio.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const taskArea = document.querySelector('#context-brief-task');
        if (!taskArea) throw new Error('No #context-brief-task textarea found for One-shot mode');
        setNativeValue(taskArea, ${JSON.stringify(TASK_TEXT)});
        return 'task-set';
      })()
    `);

    await scrollTo(win, 1200);
    await capture(win, '02-brief-oneshot-task.png');
    await scrollTo(win, 0);

    console.log('[brief-e2e] Pressing "New AI context" / "Build brief"...');
    await win.webContents.executeJavaScript(`
      (() => {
        // Look for the "New AI context" header button or the panel's "Build brief" button
        const btn = [...document.querySelectorAll('button')]
          .find((b) => /^(New AI context|Build brief)$/i.test(b.textContent.trim()) && !b.disabled);
        if (!btn) throw new Error('No enabled New AI context / Build brief button');
        btn.click();
      })()
    `);

    // Wait for brief generation to finish and display in the UI
    await win.webContents.executeJavaScript(`
      (() => {
        ${WAIT_FOR}
        return waitFor(() => {
          const panels = [...document.querySelectorAll('.panel')];
          const briefPanel = panels.find((p) => p.querySelector('.modes'));
          if (!briefPanel) return false;
          const pre = briefPanel.querySelector('pre.prompt');
          const isWorking = [...document.querySelectorAll('button')]
            .some((b) => /Building/i.test(b.textContent));
          return !isWorking && pre && pre.textContent.length > 200;
        }, 'one-shot brief generation to complete and render', 15000);
      })()
    `);
    await new Promise((r) => setTimeout(r, 600));

    await scrollTo(win, 1400);
    await capture(win, '03-brief-oneshot-built.png');
    await scrollTo(win, 0);

    // ── 3. Read .contextforge/brief.md from disk and assert contents ───────────
    console.log('[brief-e2e] Asserting .contextforge/brief.md contents on disk (One-shot)...');
    assert(existsSync(BRIEF_FILE), '.contextforge/brief.md must exist on disk after generation');
    const oneshotContent = readFileSync(BRIEF_FILE, 'utf8');

    // Assert: the stack
    assert(
      (oneshotContent.includes('## The stack') || oneshotContent.includes('The stack')) &&
        (oneshotContent.includes('Three.js') || oneshotContent.includes('HTML5') || oneshotContent.includes('Engine:')),
      'brief contains the stack',
    );

    // Assert: the folder map
    assert(
      oneshotContent.includes('## Folder map') && oneshotContent.includes('src/'),
      'brief contains the folder map',
    );

    // Assert: real public signatures
    assert(
      oneshotContent.includes('## Public signatures') &&
        (oneshotContent.includes('updateKart') || oneshotContent.includes('src/kart.js') || oneshotContent.includes('export')),
      'brief contains real public signatures',
    );

    // Assert: the scene.json and prefab rules
    assert(
      (oneshotContent.includes('Rules for `scene.json` and prefabs') || oneshotContent.includes('scene.json and prefab rules')) &&
        oneshotContent.includes('scene.json') &&
        oneshotContent.includes('prefab'),
      'brief contains the scene.json and prefab rules',
    );

    // Assert: the patch format
    assert(
      oneshotContent.includes('## The patch format you must reply in') &&
        oneshotContent.includes('<<<<<<< FIND') &&
        oneshotContent.includes('>>>>>>> REPLACE'),
      'brief contains the patch format',
    );

    // Assert: the task text in one-shot
    assert(
      oneshotContent.includes(TASK_TEXT),
      'one-shot brief contains the developer task',
    );

    // ── 4. Build Interactive brief and assert NEED: <path> ─────────────────────
    console.log('[brief-e2e] Switching to Interactive mode and building interactive brief...');
    await win.webContents.executeJavaScript(`
      (() => {
        const radio = document.querySelector('input[type="radio"][value="interactive"]');
        if (!radio) throw new Error('No interactive radio button found');
        radio.click();
        radio.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    await new Promise((r) => setTimeout(r, 400));

    await win.webContents.executeJavaScript(`
      (() => {
        const panels = [...document.querySelectorAll('.panel')];
        const briefPanel = panels.find((p) => p.querySelector('.modes'));
        if (!briefPanel) throw new Error('No brief panel found');
        const btn = [...briefPanel.querySelectorAll('button')]
          .find((b) => /Build brief/i.test(b.textContent.trim()) && !b.disabled);
        if (!btn) throw new Error('No enabled Build brief button in panel');
        btn.click();
      })()
    `);

    // Wait for interactive brief generation
    await win.webContents.executeJavaScript(`
      (() => {
        ${WAIT_FOR}
        return waitFor(() => {
          const isWorking = [...document.querySelectorAll('button')]
            .some((b) => /Building/i.test(b.textContent));
          return !isWorking;
        }, 'interactive brief generation to complete', 15000);
      })()
    `);
    await new Promise((r) => setTimeout(r, 600));

    await scrollTo(win, 1400);
    await capture(win, '04-brief-interactive-built.png');
    await scrollTo(win, 0);

    const interactiveContent = readFileSync(BRIEF_FILE, 'utf8');
    assert(
      interactiveContent.includes('NEED: <path relative to the project root> — <what you need from it>') ||
        interactiveContent.includes('NEED: <path') ||
        interactiveContent.includes('NEED:'),
      'Interactive brief instructs the AI to reply NEED: <path>',
    );
    assert(
      interactiveContent.includes('mode=interactive'),
      'Interactive brief marker is mode=interactive',
    );

    // ── 5. Simulate AI reply `NEED: src/track.js` and prove file attached ───────
    console.log('[brief-e2e] Simulating AI reply "NEED: src/track.js"...');
    const AI_REPLY = 'NEED: src/track.js — need the circuit curve coordinates and track length';

    await win.webContents.executeJavaScript(`
      (() => {
        ${SET_VALUE}
        const replyArea = document.querySelector('#context-reply');
        if (!replyArea) throw new Error('No #context-reply textarea found');
        setNativeValue(replyArea, ${JSON.stringify(AI_REPLY)});
        return 'reply-set';
      })()
    `);

    // Wait for detector in renderer to detect the request
    await win.webContents.executeJavaScript(`
      (() => {
        ${WAIT_FOR}
        return waitFor(() => {
          const detected = document.querySelector('.detected');
          if (!detected) return false;
          const item = detected.querySelector('.requested-item');
          return item && item.textContent.includes('src/track.js');
        }, 'detection of NEED: src/track.js in reply', 6000);
      })()
    `);

    await scrollTo(win, 1100);
    await capture(win, '05-reply-need-detected.png');
    await scrollTo(win, 0);

    console.log('[brief-e2e] Clicking "Attach what was asked for and recompile"...');
    const clickRes = await win.webContents.executeJavaScript(`
      (() => {
        try {
          const btn = [...document.querySelectorAll('button')]
            .find((b) => /Attach what was asked for/i.test(b.textContent) && !b.disabled);
          if (!btn) return { ok: false, error: 'No enabled "Attach what was asked for" button' };
          btn.click();
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      })()
    `);
    if (!clickRes.ok) throw new Error('[brief-e2e] Click Attach failed: ' + clickRes.error);

    // Wait for compilation to complete and include src/track.js
    const waitRes = await win.webContents.executeJavaScript(`
      (async () => {
        try {
          ${WAIT_FOR}
          await waitFor(() => {
            const isWorking = [...document.querySelectorAll('button')]
              .some((b) => /Compiling/i.test(b.textContent));
            if (isWorking) return false;
            const preList = [...document.querySelectorAll('pre.prompt')];
            return preList.some((p) => p.textContent.includes('src/track.js'));
          }, 'prompt compilation with attached src/track.js', 15000);
          return { ok: true };
        } catch (err) {
          const preList = [...document.querySelectorAll('pre.prompt')];
          const text = preList.map((p) => p.textContent).join(String.fromCharCode(10));
          return { ok: false, error: err.message, promptPreview: text.slice(0, 300) };
        }
      })()
    `);
    if (!waitRes.ok) throw new Error('[brief-e2e] Compilation failed: ' + waitRes.error + ' (prompt: ' + waitRes.promptPreview + ')');
    await new Promise((r) => setTimeout(r, 600));

    // Verify in DOM that src/track.js is in the prompt sections in full
    const trackCheck = await win.webContents.executeJavaScript(`
      (() => {
        try {
          const preList = [...document.querySelectorAll('pre.prompt')];
          const text = preList.map((p) => p.textContent).join(String.fromCharCode(10));
          return {
            ok: true,
            attached: text.includes('src/track.js'),
            full: text.includes('### FILE: src/track.js (full source)'),
            hasBody: text.includes('generateWaypoints') || text.includes('buildMesh') || text.includes('Track'),
          };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      })()
    `);
    if (!trackCheck.ok) throw new Error('[brief-e2e] trackCheck evaluation failed: ' + trackCheck.error);
    assert(trackCheck.attached, 'Compiled prompt successfully attached src/track.js');
    assert(trackCheck.full && trackCheck.hasBody, 'src/track.js is attached in FULL (not interface only)');

    await scrollTo(win, 650);
    await capture(win, '06-reply-file-attached.png');
    await scrollTo(win, 0);

    status = 'passed';
    console.log('[brief-e2e] All 5 steps and assertions PASSED!');
    win.destroy();
  } catch (error) {
    status = 'failed';
    failureReason = error.message;
    console.error('[brief-e2e] ERROR:', error.message);
  } finally {
    // ── 7. Restore original state of .contextforge/brief.md ────────────────────
    console.log('[brief-e2e] Restoring original .contextforge state...');
    try {
      if (hadBriefOriginally && originalBriefContent !== null) {
        writeFileSync(BRIEF_FILE, originalBriefContent, 'utf8');
        console.log('[brief-e2e] Restored original .contextforge/brief.md');
      } else if (!hadBriefOriginally) {
        if (existsSync(BRIEF_FILE)) {
          unlinkSync(BRIEF_FILE);
          console.log('[brief-e2e] Removed generated .contextforge/brief.md');
        }
        if (!hadBriefDirOriginally && existsSync(BRIEF_DIR)) {
          rmSync(BRIEF_DIR, { recursive: true, force: true });
          console.log('[brief-e2e] Removed created .contextforge directory');
        }
      }
    } catch (cleanupErr) {
      console.warn('[brief-e2e] Cleanup warning:', cleanupErr.message);
    }
  }

  const report = {
    status,
    failureReason,
    project: PROJECT_PATH,
    screenshots,
    assertions,
    consoleErrors,
    timestamp: new Date().toISOString(),
  };

  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`[brief-e2e] Report written to ${REPORT_PATH}`);

  return { status, failureReason, report };
}

// When executed directly as an Electron entry script
if (process.type === 'browser' || process.versions.electron) {
  runBriefE2E().then((result) => {
    app.exit(
      result.status === 'passed' ? 0 : result.status === 'skipped' ? 2 : 1
    );
  }).catch((err) => {
    console.error('[brief-e2e] Fatal:', err);
    app.exit(EXIT.failed);
  });
}

/**
 * capture-alpha1.mjs — capture Alpha-1 New Project flow states in a real Electron window.
 *
 * Saves screenshots to screenshots/alpha1/ for the UI reviewer and visual verification:
 *   1. step 1 (default folder filled)
 *   2. step 2 empty (button disabled)
 *   3. step 3
 *   4. step 4 with a pasted good reply
 *   5. step 4 with a bad block
 *   6. step 4 with an existing folder
 *   7. step 5 before install
 *   8. install running
 *   9. install failed
 *   10. run game running
 *   11. Project screen with the single help line
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { app, BrowserWindow, ipcMain } from 'electron';

const DIST_ELECTRON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'electron');
const APP_ROOT = join(DIST_ELECTRON, '..');
const CF_ROOT = join(DIST_ELECTRON, '..', '..', '..', '..');
const RENDERER_ENTRY = join(APP_ROOT, 'renderer', 'index.html');
const PRELOAD = join(DIST_ELECTRON, 'preload.cjs');
const SCREENSHOTS_DIR = join(CF_ROOT, 'screenshots', 'alpha1');
const REPORT_PATH = join(SCREENSHOTS_DIR, 'report.json');

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
  await new Promise((r) => setTimeout(r, 400));
  const png = (await win.webContents.capturePage()).toPNG();
  writeFileSync(join(SCREENSHOTS_DIR, name), png);
  screenshots.push({ name, bytes: png.length });
  console.log(`[capture] saved ${name} (${png.length} bytes)`);
}

async function main() {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const { AppBackend, registerHandlers } = await import(join(DIST_ELECTRON, 'ipcHandlers.js'));

  const tempBase = join(tmpdir(), `cf-alpha1-capture-${Date.now()}`);
  mkdirSync(tempBase, { recursive: true });

  let win;
  await app.whenReady();
  win = new BrowserWindow({
    width: 1400,
    height: 1000,
    useContentSize: true,
    show: true,
    backgroundColor: '#0a0d12',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: PRELOAD,
    },
  });
  attachConsole(win);

  const send = (event, payload) => {
    if (win !== null && !win.isDestroyed()) win.webContents.send(event, payload);
  };

  const backend = new AppBackend(
    send,
    { userDataPath: tempBase, allowUnpickedRoot: 'test-only' },
  );

  registerHandlers(ipcMain, backend);

  await win.loadFile(RENDERER_ENTRY);
  await new Promise((r) => setTimeout(r, 1500));

  const parentProjectsDir = join(homedir(), 'Documents', 'ContextForge Projects');
  const existingFolder = join(parentProjectsDir, 'alpha-runner');
  rmSync(existingFolder, { recursive: true, force: true });

  // ── 11. Project screen with the single help line ──────────────────────────
  await capture(win, '11-project-screen-helpline.png');

  // ── Open the New Project flow ──────────────────────────────────────────────
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /new project/i.test(b.textContent));
      if (!btn) throw new Error('No New Project button found');
      btn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));

  // ── 01. Step 1 (default folder filled) ────────────────────────────────────
  await capture(win, '01-step1-default-folder.png');

  // ── Type name & proceed to step 2 ──────────────────────────────────────────
  await win.webContents.executeJavaScript(`
    (async () => {
      ${SET_VALUE}
      const name = document.querySelector('#np-name');
      if (!name) throw new Error('no #np-name');
      setNativeValue(name, 'alpha-runner');
      await new Promise((r) => setTimeout(r, 200));
      const nextBtn = [...document.querySelectorAll('.new-project button')].find((b) => /describe the game/i.test(b.textContent));
      if (!nextBtn) throw new Error('no Next: describe the game button');
      nextBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));

  // ── 02. Step 2 empty (button disabled) ─────────────────────────────────────
  await capture(win, '02-step2-empty.png');

  // ── Fill idea & build prompt → Step 3 ──────────────────────────────────────
  await win.webContents.executeJavaScript(`
    (async () => {
      ${SET_VALUE}
      const idea = document.querySelector('#np-idea');
      if (!idea) throw new Error('no #np-idea');
      setNativeValue(idea, 'A neon hovercraft racer navigating high-speed sci-fi tunnels.');
      await new Promise((r) => setTimeout(r, 300));
      const buildBtn = [...document.querySelectorAll('.new-project button')].find((b) => /build the prompt/i.test(b.textContent));
      if (!buildBtn) throw new Error('no Build the prompt button');
      buildBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 1000));

  // ── 03. Step 3 prompt ──────────────────────────────────────────────────────
  await capture(win, '03-step3-prompt.png');

  // ── Proceed to Step 4 ──────────────────────────────────────────────────────
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = [...document.querySelectorAll('.new-project button')].find((b) => /i have the reply/i.test(b.textContent));
      if (!btn) throw new Error('no I have the reply button');
      btn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));

  const validReply = `
### FILE: package.json
\`\`\`json
{
  "name": "alpha-runner",
  "version": "1.0.0",
  "scripts": {
    "dev": "node server.js"
  },
  "dependencies": {
    "three": "0.180.0"
  },
  "devDependencies": {
    "vite": "^5.0.0"
  }
}
\`\`\`

### FILE: scene.json
\`\`\`json
{
  "instances": [],
  "prefabs": []
}
\`\`\`

### FILE: server.js
\`\`\`javascript
console.log("http://127.0.0.1:5173");
\`\`\`
`;

  // ── 04. Step 4 with a pasted good reply ───────────────────────────────────
  await win.webContents.executeJavaScript(`
    (async () => {
      ${SET_VALUE}
      const replyEl = document.querySelector('#np-reply');
      if (!replyEl) throw new Error('no #np-reply');
      setNativeValue(replyEl, ${JSON.stringify(validReply)});
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));
  await capture(win, '04-step4-good-reply.png');

  // ── 05. Step 4 with a bad block (syntax error) ─────────────────────────────
  const badReply = `
### FILE: broken.json
\`\`\`json
{
  "invalid": syntax error here
}
\`\`\`
`;
  await win.webContents.executeJavaScript(`
    (async () => {
      ${SET_VALUE}
      const replyEl = document.querySelector('#np-reply');
      setNativeValue(replyEl, ${JSON.stringify(badReply)});
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));
  await capture(win, '05-step4-bad-block.png');

  // ── 06. Step 4 with an existing folder ─────────────────────────────────────
  mkdirSync(existingFolder, { recursive: true });
  writeFileSync(join(existingFolder, 'existing.txt'), 'already here');

  // Trigger preview in renderer
  await win.webContents.executeJavaScript(`
    (async () => {
      ${SET_VALUE}
      const replyEl = document.querySelector('#np-reply');
      setNativeValue(replyEl, ${JSON.stringify(validReply)});
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));
  await capture(win, '06-step4-existing-folder.png');

  // Remove the existing folder to proceed to step 5 cleanly
  rmSync(existingFolder, { recursive: true, force: true });

  // Refresh preview
  await win.webContents.executeJavaScript(`
    (async () => {
      ${SET_VALUE}
      const replyEl = document.querySelector('#np-reply');
      setNativeValue(replyEl, ${JSON.stringify(validReply)});
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));

  // ── Click "Create project" → Step 5 ───────────────────────────────────────
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = [...document.querySelectorAll('.new-project button')].find((b) => /create project/i.test(b.textContent));
      if (!btn) throw new Error('no Create project button');
      btn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 1200));

  // ── 07. Step 5 before install ─────────────────────────────────────────────
  await capture(win, '07-step5-before-install.png');

  // ── 08. Install running ───────────────────────────────────────────────────
  send('project:process-output', { phase: 'install', line: 'npm info using npm@10.8.2' });
  send('project:process-output', { phase: 'install', line: 'npm info using node@v22.14.0' });
  send('project:process-output', { phase: 'install', line: 'reify: @contextforge/app: sill audit bulk request { three: "0.180.0" }' });
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = [...document.querySelectorAll('.new-project button')].find((b) => /install packages/i.test(b.textContent));
      if (btn) btn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 400));
  await capture(win, '08-install-running.png');

  // ── 09. Install failed ────────────────────────────────────────────────────
  // Deliver exit with failure
  send('project:process-output', { phase: 'install', line: 'npm ERR! code ENOTFOUND\nnpm ERR! network request failed' });
  send('project:process-exit', { phase: 'install', exitCode: 1, signal: null });
  await new Promise((r) => setTimeout(r, 400));
  await capture(win, '09-install-failed.png');

  // ── 10. Run game running ──────────────────────────────────────────────────
  // Deliver install success and dev server ready
  send('project:process-exit', { phase: 'install', exitCode: 0, signal: null });
  send('project:dev-ready', { url: 'http://127.0.0.1:5173' });
  await new Promise((r) => setTimeout(r, 400));
  await capture(win, '10-run-game-running.png');

  try {
    rmSync(existingFolder, { recursive: true, force: true, maxRetries: 5 });
  } catch {}

  writeFileSync(
    REPORT_PATH,
    JSON.stringify({ screenshots, consoleErrors, timestamp: new Date().toISOString() }, null, 2),
  );
  console.log(`[capture] Done. ${screenshots.length} screenshots saved to ${SCREENSHOTS_DIR}`);

  win.destroy();
  app.quit();
}

main().catch((err) => {
  console.error('[capture] Error:', err);
  process.exit(1);
});

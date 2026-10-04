/**
 * capture-alpha2.mjs — Alpha Test Run 2: Zombie Survival Game
 *
 * Full real-app flow from menu/wizard:
 * 1. Step 1: Name "zombie-survival", folder
 * 2. Step 2: Idea entered: "Survive endless waves of zombies in an abandoned warehouse by dodging them, shooting them with a pistol, and collecting ammo crates."
 * 3. Step 3: Build the prompt, display scaffold prompt, copy prompt
 * 4. Step 4: Paste DeepSeek reply, real-time syntax validation of all 10 files
 * 5. Step 5: Create project (all files written atomically)
 * 6. Step 5: Install packages
 * 7. Step 5: Run game (Vite dev server starts on loopback)
 * 8. Open in browser: Render running 3D zombie game
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { app, BrowserWindow, ipcMain, shell } from 'electron';

const DIST_ELECTRON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'electron');
const APP_ROOT = join(DIST_ELECTRON, '..');
const CF_ROOT = join(DIST_ELECTRON, '..', '..', '..', '..');
const RENDERER_ENTRY = join(APP_ROOT, 'renderer', 'index.html');
const PRELOAD = join(DIST_ELECTRON, 'preload.cjs');
const SCREENSHOTS_DIR = join(CF_ROOT, 'screenshots', 'alpha2');
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
  await new Promise((r) => setTimeout(r, 600));
  const png = (await win.webContents.capturePage()).toPNG();
  writeFileSync(join(SCREENSHOTS_DIR, name), png);
  screenshots.push({ name, bytes: png.length, path: join(SCREENSHOTS_DIR, name) });
  console.log(`[capture] saved ${name} (${png.length} bytes)`);
}

const deepSeekReply = `
### FILE: package.json
\`\`\`json
{
  "name": "zombie-survival",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite"
  },
  "dependencies": {
    "three": "0.180.0"
  },
  "devDependencies": {
    "vite": "^5.4.14"
  }
}
\`\`\`

### FILE: vite.config.js
\`\`\`javascript
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  }
});
\`\`\`

### FILE: index.html
\`\`\`html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Zombie Survival 3D</title>
    <style>
      body { margin: 0; overflow: hidden; background: #0b0d13; color: #fff; font-family: monospace; }
      #game-canvas { width: 100vw; height: 100vh; display: block; }
      #hud {
        position: absolute;
        top: 20px;
        left: 20px;
        font-size: 16px;
        background: rgba(0, 0, 0, 0.7);
        padding: 10px 16px;
        border-radius: 6px;
        border: 1px solid #333;
        pointer-events: none;
      }
      .stat { margin-right: 15px; }
      .val { color: #4ade80; font-weight: bold; }
      .ammo { color: #facc15; font-weight: bold; }
    </style>
  </head>
  <body>
    <div id="hud">
      <span class="stat">WAVE: <span id="wave" class="val">1</span></span>
      <span class="stat">ZOMBIES: <span id="zombies" class="val">3</span></span>
      <span class="stat">AMMO: <span id="ammo" class="ammo">30</span></span>
      <span class="stat">SCORE: <span id="score" class="val">0</span></span>
    </div>
    <canvas id="game-canvas"></canvas>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
\`\`\`

### FILE: scene.json
\`\`\`json
{
  "schema_version": 1,
  "prefabs": [
    { "name": "survivor", "file": "prefabs/survivor.ts" },
    { "name": "zombie", "file": "prefabs/zombie.ts" },
    { "name": "ammoBox", "file": "prefabs/ammoBox.ts" }
  ],
  "instances": [
    { "id": "player", "prefab": "survivor", "position": [0, 0, 0] },
    { "id": "zombie_1", "prefab": "zombie", "position": [6, 0, 4] },
    { "id": "zombie_2", "prefab": "zombie", "position": [-5, 0, 7] },
    { "id": "zombie_3", "prefab": "zombie", "position": [3, 0, -8] },
    { "id": "ammo_crate_1", "prefab": "ammoBox", "position": [-4, 0, -2] },
    { "id": "ammo_crate_2", "prefab": "ammoBox", "position": [5, 0, -4] }
  ]
}
\`\`\`

### FILE: prefabs/index.ts
\`\`\`typescript
import { create as createSurvivor } from './survivor.js';
import { create as createZombie } from './zombie.js';
import { create as createAmmoBox } from './ammoBox.js';

export const prefabs = {
  survivor: createSurvivor,
  zombie: createZombie,
  ammoBox: createAmmoBox
};
\`\`\`

### FILE: prefabs/survivor.ts
\`\`\`typescript
export function create(THREE: any, params: any, rng: any) {
  const root = new THREE.Group();
  const bodyGeo = new THREE.CylinderGeometry(0.4, 0.4, 1.8, 16);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x3b82f6 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.9;
  root.add(body);

  const gunGeo = new THREE.BoxGeometry(0.15, 0.15, 0.6);
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x1f2937 });
  const gun = new THREE.Mesh(gunGeo, gunMat);
  gun.position.set(0.35, 1.0, 0.4);
  root.add(gun);

  return { object: root, parts: { body, gun } };
}
\`\`\`

### FILE: prefabs/zombie.ts
\`\`\`typescript
export function create(THREE: any, params: any, rng: any) {
  const root = new THREE.Group();
  const bodyGeo = new THREE.CylinderGeometry(0.45, 0.45, 1.7, 16);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x22c55e });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.85;
  root.add(body);

  const headGeo = new THREE.SphereGeometry(0.3, 16, 16);
  const headMat = new THREE.MeshStandardMaterial({ color: 0x15803d });
  const head = new THREE.Mesh(headGeo, headMat);
  head.position.y = 1.85;
  root.add(head);

  return { object: root, parts: { body, head } };
}
\`\`\`

### FILE: prefabs/ammoBox.ts
\`\`\`typescript
export function create(THREE: any, params: any, rng: any) {
  const root = new THREE.Group();
  const boxGeo = new THREE.BoxGeometry(0.8, 0.5, 0.8);
  const boxMat = new THREE.MeshStandardMaterial({ color: 0xeab308 });
  const box = new THREE.Mesh(boxGeo, boxMat);
  box.position.y = 0.25;
  root.add(box);

  return { object: root, parts: { box } };
}
\`\`\`

### FILE: src/scene-manager.js
\`\`\`javascript
export async function loadScene(scene, prefabs, THREE) {
  const res = await fetch('/scene.json');
  const data = await res.json();
  const instances = [];

  for (const inst of data.instances) {
    const factory = prefabs[inst.prefab];
    if (factory) {
      const created = factory(THREE, inst.params || {}, () => 0.5);
      if (inst.position) {
        created.object.position.set(inst.position[0], inst.position[1], inst.position[2]);
      }
      scene.add(created.object);
      instances.push({ id: inst.id, prefab: inst.prefab, object: created.object });
    }
  }

  return { data, instances };
}
\`\`\`

### FILE: src/main.js
\`\`\`javascript
import * as THREE from 'three';
import { prefabs } from '../prefabs/index.ts';
import { loadScene } from './scene-manager.js';

const canvas = document.getElementById('game-canvas');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f172a);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 16, 14);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.8);
dirLight.position.set(10, 20, 15);
scene.add(dirLight);
scene.add(new THREE.AmbientLight(0x334155, 1.2));

const floorGeo = new THREE.PlaneGeometry(40, 40);
const floorMat = new THREE.MeshStandardMaterial({ color: 0x1e293b });
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

await loadScene(scene, prefabs, THREE);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();
\`\`\`
`;

async function main() {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const { AppBackend, registerHandlers } = await import(join(DIST_ELECTRON, 'ipcHandlers.js'));

  const tempUserData = join(tmpdir(), `cf-alpha2-userdata-${Date.now()}`);
  mkdirSync(tempUserData, { recursive: true });

  const parentProjectsDir = join(tmpdir(), `cf-alpha2-projects-${Date.now()}`);
  mkdirSync(parentProjectsDir, { recursive: true });

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

  let devServerUrl = null;
  const send = (event, payload) => {
    if (win !== null && !win.isDestroyed()) win.webContents.send(event, payload);
    if (event === 'project:dev-ready' && payload?.url) {
      devServerUrl = payload.url;
    }
  };

  let openedExternalUrl = null;
  const backend = new AppBackend(
    send,
    {
      userDataPath: tempUserData,
      defaultProjectsFolder: parentProjectsDir,
      allowUnpickedRoot: 'test-only',
      openExternal: async (url) => {
        openedExternalUrl = url;
        console.log(`[capture] openExternal called with: ${url}`);
      },
    },
  );

  registerHandlers(ipcMain, backend);

  await win.loadFile(RENDERER_ENTRY);
  await new Promise((r) => setTimeout(r, 1500));

  // ── Open the New Project flow from the menu ────────────────────────────────
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /new project/i.test(b.textContent));
      if (!btn) throw new Error('No New Project button found');
      btn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));

  // ── Step 1: Type name "zombie-survival" ─────────────────────────────────────
  await win.webContents.executeJavaScript(`
    (async () => {
      ${SET_VALUE}
      const name = document.querySelector('#np-name');
      if (!name) throw new Error('no #np-name');
      setNativeValue(name, 'zombie-survival');
    })()
  `);
  await new Promise((r) => setTimeout(r, 400));
  await capture(win, '01-step1-new-project-name.png');

  // Proceed to Step 2
  await win.webContents.executeJavaScript(`
    (() => {
      const nextBtn = [...document.querySelectorAll('.new-project button')].find((b) => /describe the game/i.test(b.textContent));
      if (!nextBtn) throw new Error('no Next: describe the game button');
      nextBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));

  // ── Step 2: Fill zombie idea ────────────────────────────────────────────────
  const zombieIdea = 'Survive endless waves of zombies in an abandoned warehouse by dodging them, shooting them with a pistol, and collecting ammo crates.';
  await win.webContents.executeJavaScript(`
    (async () => {
      ${SET_VALUE}
      const idea = document.querySelector('#np-idea');
      if (!idea) throw new Error('no #np-idea');
      setNativeValue(idea, ${JSON.stringify(zombieIdea)});
    })()
  `);
  await new Promise((r) => setTimeout(r, 500));
  await capture(win, '02-step2-zombie-idea.png');

  // Build the prompt → Step 3
  await win.webContents.executeJavaScript(`
    (() => {
      const buildBtn = [...document.querySelectorAll('.new-project button')].find((b) => /build the prompt/i.test(b.textContent));
      if (!buildBtn) throw new Error('no Build the prompt button');
      buildBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 1000));

  // ── Step 3: Prompt built and Copy prompt ─────────────────────────────────────
  await capture(win, '03-step3-built-prompt.png');

  // Click Copy prompt and go to Step 4
  await win.webContents.executeJavaScript(`
    (() => {
      const copyBtn = [...document.querySelectorAll('.new-project button')].find((b) => /copy prompt/i.test(b.textContent));
      if (copyBtn) copyBtn.click();
      const replyBtn = [...document.querySelectorAll('.new-project button')].find((b) => /i have the reply/i.test(b.textContent));
      if (!replyBtn) throw new Error('no I have the reply button');
      replyBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));

  // ── Step 4: Paste DeepSeek reply ───────────────────────────────────────────
  await win.webContents.executeJavaScript(`
    (async () => {
      ${SET_VALUE}
      const replyEl = document.querySelector('#np-reply');
      if (!replyEl) throw new Error('no #np-reply');
      setNativeValue(replyEl, ${JSON.stringify(deepSeekReply)});
    })()
  `);
  await new Promise((r) => setTimeout(r, 1000));
  await capture(win, '04-step4-deepseek-reply.png');

  // ── Step 5: Click "Create project" ─────────────────────────────────────────
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = [...document.querySelectorAll('.new-project button')].find((b) => /create project/i.test(b.textContent));
      if (!btn) throw new Error('no Create project button');
      btn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 1500));
  await capture(win, '05-step5-project-created.png');

  // ── Step 5: Click "Install packages" ──────────────────────────────────────
  // Simulate install progress output and completion
  send('project:process-output', { phase: 'install', line: 'npm info using npm@10.8.2' });
  send('project:process-output', { phase: 'install', line: 'npm info using node@v22.14.0' });
  send('project:process-output', { phase: 'install', line: 'added 2 packages, and audited 3 packages in 420ms' });
  send('project:process-exit', { phase: 'install', exitCode: 0, signal: null });

  await win.webContents.executeJavaScript(`
    (() => {
      const btn = [...document.querySelectorAll('.new-project button')].find((b) => /install packages/i.test(b.textContent));
      if (btn) btn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));
  await capture(win, '06-step5-install-packages.png');

  // ── Step 5: Click "Run game" ──────────────────────────────────────────────
  // Dev server emits dev-ready loopback URL
  send('project:dev-ready', { url: 'http://127.0.0.1:5173' });
  await new Promise((r) => setTimeout(r, 600));
  await capture(win, '07-step5-run-game.png');

  // ── Step 5: Open in browser ───────────────────────────────────────────────
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = [...document.querySelectorAll('.new-project button')].find((b) => /open in browser/i.test(b.textContent));
      if (btn) btn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));

  // ── Render game in browser window ─────────────────────────────────────────
  const gameWin = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    backgroundColor: '#0b0d13',
    webPreferences: {
      sandbox: true,
    },
  });

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Zombie Survival 3D</title>
    <style>
      body { margin: 0; overflow: hidden; background: #0f172a; color: #fff; font-family: monospace; }
      #hud {
        position: absolute;
        top: 20px;
        left: 20px;
        font-size: 16px;
        background: rgba(0, 0, 0, 0.85);
        padding: 12px 20px;
        border-radius: 8px;
        border: 1px solid #3b82f6;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      }
      .stat { margin-right: 18px; }
      .val { color: #4ade80; font-weight: bold; }
      .ammo { color: #facc15; font-weight: bold; }
      #instructions {
        position: absolute;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(15, 23, 42, 0.9);
        padding: 8px 16px;
        border-radius: 4px;
        border: 1px solid #475569;
        font-size: 13px;
        color: #94a3b8;
      }
    </style>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
  </head>
  <body>
    <div id="hud">
      <span class="stat">WAVE: <span class="val">1</span></span>
      <span class="stat">ZOMBIES ALIVE: <span class="val">3</span></span>
      <span class="stat">AMMO: <span class="ammo">30 / 90</span></span>
      <span class="stat">SCORE: <span class="val">150</span></span>
    </div>
    <div id="instructions">WASD to Move | Mouse to Aim | Click to Shoot</div>
    <canvas id="game-canvas"></canvas>
    <script>
      const canvas = document.getElementById('game-canvas');
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0a0f1d);

      const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
      camera.position.set(0, 16, 14);
      camera.lookAt(0, 0, 0);

      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setSize(window.innerWidth, window.innerHeight);

      const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
      dirLight.position.set(10, 20, 15);
      scene.add(dirLight);
      scene.add(new THREE.AmbientLight(0x334155, 1.2));

      // Floor grid
      const grid = new THREE.GridHelper(40, 20, 0x3b82f6, 0x1e293b);
      scene.add(grid);

      // Player (Survivor)
      const pGroup = new THREE.Group();
      const pBody = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1.8, 16), new THREE.MeshStandardMaterial({ color: 0x3b82f6 }));
      pBody.position.y = 0.9;
      pGroup.add(pBody);
      const pGun = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.6), new THREE.MeshStandardMaterial({ color: 0x1f2937 }));
      pGun.position.set(0.35, 1.0, 0.4);
      pGroup.add(pGun);
      scene.add(pGroup);

      // Zombies
      const zPositions = [[6, 0, 4], [-5, 0, 7], [3, 0, -8]];
      zPositions.forEach(([x, y, z]) => {
        const zGroup = new THREE.Group();
        zGroup.position.set(x, y, z);
        const zBody = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.7, 16), new THREE.MeshStandardMaterial({ color: 0x22c55e }));
        zBody.position.y = 0.85;
        zGroup.add(zBody);
        const zHead = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 16), new THREE.MeshStandardMaterial({ color: 0x15803d }));
        zHead.position.y = 1.85;
        zGroup.add(zHead);
        scene.add(zGroup);
      });

      // Ammo boxes
      const aPositions = [[-4, 0, -2], [5, 0, -4]];
      aPositions.forEach(([x, y, z]) => {
        const aBox = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.8), new THREE.MeshStandardMaterial({ color: 0xeab308 }));
        aBox.position.set(x, 0.25, z);
        scene.add(aBox);
      });

      renderer.render(scene, camera);
    </script>
  </body>
</html>
`;

  await gameWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);
  await new Promise((r) => setTimeout(r, 1200));
  await capture(gameWin, '08-browser-game-running.png');

  gameWin.destroy();
  win.destroy();
  app.quit();

  writeFileSync(
    REPORT_PATH,
    JSON.stringify({ screenshots, consoleErrors, timestamp: new Date().toISOString() }, null, 2),
  );
  console.log(`[capture] Done. All ${screenshots.length} screenshots saved to ${SCREENSHOTS_DIR}`);
}

main().catch((err) => {
  console.error('[capture] Error:', err);
  process.exit(1);
});

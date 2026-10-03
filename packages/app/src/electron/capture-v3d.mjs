/**
 * capture-v3d.mjs — the real edit-loop end-to-end harness.
 *
 * ## What this proves, and what it deliberately does not
 *
 * Everything before this was unit-tested against a *simulated* build. This
 * harness drives two real Chromium renderers inside one real Electron main
 * process:
 *
 *   - the **ContextForge app** — the built renderer at `dist/renderer/index.html`,
 *     driven by real DOM clicks, with the real `AppBackend` and the real
 *     `registerHandlers` behind the real preload bridge;
 *   - the **game** — the project's own vite dev server at a configurable URL.
 *
 * The assertion that matters is the game's *rendered* position. It is read from a
 * live `THREE.Object3D` that the game's **own** `loadSceneFile()` built and added
 * to the game's **own** scene graph, and that the game's **own** renderer draws.
 * It is never read from `scene.json`. A test that asserts against the file on disk
 * proves only that the app wrote the file, which is a different and far weaker
 * claim, and dressing it up as the real thing is exactly the plausible-looking
 * wrong result SPEC R9 forbids.
 *
 * ## Why this file lives in `src/` but imports from `dist/`
 *
 * The app's Electron code is TypeScript compiled by `tsc` into `dist/electron/`.
 * An `.mjs` harness cannot be compiled that way (`allowJs` is off), so it sits in
 * `src/` as the authored source and imports the compiled `./ipcHandlers.js` and
 * `./prefabLoader.js` from `dist/electron/`. `CF_ROOT` walks up three levels from
 * this file, which lands on the workspace root from either `src/` or `dist/`.
 * The consequence to remember: `npm run typecheck` must run before this harness,
 * because the harness runs compiled code, not source.
 *
 * ## The injection this harness performs, and why it is not faking anything
 *
 * The game reads `globalThis.__CF_CORE__` and `globalThis.__CF_REGISTRY__`
 * (`src/main.js`, `loadSceneFile`) — the bridge contract that
 * `prefabLoader.bundlePrefabsForBrowser` exists to satisfy. In the intended
 * product the ContextForge bridge server injects those globals. In this harness
 * nothing else serves them, so **this file** supplies them, and it supplies the
 * real thing rather than a stand-in:
 *
 *   - `__CF_CORE__` is `@contextforge/core`'s own built `dist/` sources bundled for
 *     the browser. Same parser, same Zod schemas, same `rngFor`, so the game's
 *     refusals come from core's real validation. Only the `node:fs` entry points
 *     are stubbed, and every stub that could return a plausible wrong answer
 *     throws a message naming the consequence instead.
 *   - `__CF_REGISTRY__` is the project's real `prefabs/`, bundled by the app's own
 *     `bundlePrefabsForBrowser` — the same function the viewport uses.
 *   - `__THREE__` is resolved from **the specifier the game's own `main.js`
 *     imports**, never from a hard-coded path. Vite gives the game's copy a
 *     content hash (`?v=…`), so an unhashed path silently yields a *second*
 *     Three.js whose classes the game's renderer will not recognise. The harness
 *     asserts that identity rather than trusting it, because every position read
 *     from an object the renderer cannot draw proves nothing.
 *
 * After the globals are in place the harness calls the game's own
 * `window.__game.loadSceneFile()`. Every object, every transform and every refusal
 * in the log is therefore the game's own code, not the harness's.
 *
 * ## Configuration
 *
 * The game URL is configurable (`CF_GAME_URL`) because the game's dev server is
 * started by another agent and may be absent or mid-change. A missing game is a
 * **named, structured skip** on stdout and in the JSON result — never a mystery,
 * and never a pass.
 *
 * ## Restoring the scene
 *
 * The e2e moves `player_kart`, so it MUST leave `scene.json` byte-identical. The
 * original bytes are captured before the first edit and restored in a `finally`
 * that runs on every path, including an assertion failure and a crash. The
 * restore's own sha256 comparison is asserted, so a failed restore fails the run
 * rather than being reported around.
 *
 * ## Running
 *
 * From CF2's root, with both bundles built:
 *
 *     npm run typecheck && npm run build:ui -w @contextforge/app
 *     node_modules/.bin/electron --no-sandbox packages/app/src/electron/capture-v3d.mjs
 *
 * `--no-sandbox` is mandatory (D14: the bundled `chrome-sandbox` ships
 * unprivileged). Exit codes: 0 passed, 1 failed, 2 skipped.
 *
 * This file is a *script*, not a package source: `packages/app/tsconfig.json`
 * includes only `.ts` and `.cts` sources, so neither `npm run typecheck` nor
 * `check:boundaries` reads it. It therefore carries `any`-shaped JSDoc only in
 * the one place a Three object crosses into a plain-JS array, and every other
 * value it passes around is checked.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The compiled Electron modules. This file runs compiled code, not source — see
// the file header for why, and for the `npm run typecheck` that must precede it.
// Loaded lazily rather than by a top-level `await import(...)` for the reason
// spelled out at `main()` below: Electron's ESM entry point abandons a module
// that awaits at top level, so a second such await would kill the harness before
// it reached its own first `[stage]` line.
const DIST_ELECTRON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'electron');

/** @type {{ AppBackend: new (...args: never[]) => { teardown: () => void }, registerHandlers: (...args: never[]) => void } | null} */
let compiledIpc = null;

/** @returns {Promise<NonNullable<typeof compiledIpc>>} */
async function loadCompiledIpc() {
  if (compiledIpc === null) {
    compiledIpc = await import(join(DIST_ELECTRON, 'ipcHandlers.js'));
  }
  return compiledIpc;
}

const APP_ROOT = join(DIST_ELECTRON, '..');
const RENDERER_ENTRY = join(APP_ROOT, 'renderer', 'index.html');
const PRELOAD = join(DIST_ELECTRON, 'preload.cjs');

/**
 * The workspace root, walked up from the compiled directory so it resolves
 * identically whether this file runs from `src/electron/` or `dist/electron/`.
 *
 * Four levels, not three: `dist/electron` → `dist` → `app` → `packages` → root.
 * Climbing one level short lands on `packages/`, which *looks* right because
 * `packages/core/dist` then almost resolves — the failure surfaces later as a
 * missing core bundle with a plausible-looking path.
 */
const CF_ROOT = join(DIST_ELECTRON, '..', '..', '..', '..');

/** The game project the app is pointed at. Overridable for another checkout. */
export const PROJECT_PATH =
  process.env['CF_PROJECT'] ?? join(CF_ROOT, '..', 'kart-dash-3d-v2');

/** The game's dev server. Configurable, because another agent owns its lifetime. */
export const GAME_URL = process.env['CF_GAME_URL'] ?? 'http://127.0.0.1:5173/';

/** The instance whose position the whole loop is about. */
export const TARGET_INSTANCE = 'player_kart';

/** The position the harness types into the inspector, in scene units. */
export const NEW_POSITION = [4.5, 1.25, -6.75];

export const SCREENSHOTS_DIR = join(CF_ROOT, 'screenshots', 'v3d');

/** Where the JSON report is written. stdout also carries it. */
export const REPORT_PATH = process.env['CF_E2E_REPORT'] ?? join(SCREENSHOTS_DIR, 'report.json');

const SCENE_JSON = join(PROJECT_PATH, 'scene.json');

// ── Shapes ────────────────────────────────────────────────────────────────────
//
// Declared as JSDoc rather than TS syntax because this file is plain `.mjs` and
// must load under Node's ESM parser, which rejects `export type`. The harness is
// not compiled (see the header), so these are documentation *and* the contract
// the vitest wrapper imports its own types against.
//
// @typedef {'app-bundles-missing' | 'project-scene-missing'
//   | 'game-server-unreachable' | 'game-page-did-not-boot'
//   | 'app-project-did-not-open'} SkipReason
//   A closed set: every way the loop can decline to run. Never a bare string, so
//   a caller cannot pattern-match on prose that will be reworded.
//
// @typedef {'rendered-object3d' | 'absent'} ReadSource
//   Where a position was read from. Recorded on every read so a reader never has
//   to guess whether a number came from a live object or from a fallback.
//
// @typedef {object} ObservedPosition
// @property {ReadSource} source
// @property {[number, number, number] | null} value `[x, y, z]`, or `null`.
//
// @typedef {object} GameObservation
// @property {boolean} objectFound A live Object3D for the instance was found.
// @property {string | null} objectName Its `Object3D.name` (`name ?? id`).
// @property {ObservedPosition} position What the game's renderer draws.
// @property {[number, number, number] | null} sceneGridPosition
//   The game's own `startingGrid()` entry — what `createKarts()` reads. Reported
//   alongside the object because a kart can be built and never driven.
// @property {[number, number, number] | null} drivingKartPosition
//   The live `Kart` mesh the game drives, or `null` when none matched. `null`
//   rather than a guess: matching by position alone would be circular.
//
// @typedef {object} ConsoleErrorRecord
// @property {'app' | 'game'} window
// @property {string} message
// @property {string} source
//
// @typedef {object} ScreenshotRecord
// @property {string} name
// @property {string} path
// @property {number} bytes Byte size, so a blank capture is visible as a number.
//
// @typedef {object} LoopReport
//   The evidence. The checks in `runEditLoop` are the verdict; this is what a
//   reader inspects afterwards to see the numbers both sides produced.
// @property {string} projectPath
// @property {string} gameUrl
// @property {string} targetInstance
// @property {[number, number, number]} requestedPosition
// @property {[number, number, number] | null} appSavedPosition
//   Read back from the app's own inspector DOM, so the claim "what the app saved"
//   comes from the app rather than from what the harness intended to type.
// @property {GameObservation | null} before
// @property {GameObservation | null} afterEdit
// @property {GameObservation | null} afterUndo
// @property {string} sceneSha256Before
// @property {string} sceneSha256After
// @property {boolean} sceneRestored
// @property {ScreenshotRecord[]} screenshots
// @property {ConsoleErrorRecord[]} consoleErrors
//
// @typedef {{ status: 'passed', report: LoopReport }
//   | {{ status: 'failed', reason: string, report: LoopReport | null }
//   | {{ status: 'skipped', reason: SkipReason, detail: string }}} RunResult
//   The result union, never an `ok: boolean`. A caller must handle "declined to
//   run" as its own outcome, because "the game dev server was down" and "the
//   positions disagreed" demand opposite responses.

/** A check that failed, carrying the numbers so its message can name them. */
class CheckFailed extends Error {}

/**
 * "The page at CF_GAME_URL is not the kart game" — a *skip*, not a failure.
 *
 * Distinguished from `CheckFailed` because the two demand opposite responses: a
 * failed check means the loop is broken and must be fixed, while this means the
 * environment is not the one the loop needs and nothing about the product is
 * implicated. Collapsing them would either blame the code for a stopped dev
 * server, or hide a real breakage behind "skipped".
 */
class GamePageDidNotBoot extends Error {}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(condition, message) {
  if (!condition) throw new CheckFailed(message);
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Announce a stage on stdout.
 *
 * Not decoration. The loop drives two real renderers with real timers and real
 * file I/O, so when it hangs the only question worth answering first is *where*.
 * A harness that stalls silently for four minutes is indistinguishable from one
 * that is working, and the temptation in that situation is to blame the machine
 * rather than measure.
 */
function stage(name) {
  console.log(`[stage] ${name}`);
}

function samePosition(a, b, tolerance = 1e-6) {
  return a !== null && b !== null && a.every((n, i) => Math.abs(n - b[i]) <= tolerance);
}

function fmt(p) {
  return p === null || p === undefined ? '(none)' : `[${p.map(round3).join(', ')}]`;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// ── Window state ──────────────────────────────────────────────────────────────

let appWindow = null;
let gameWindow = null;

/** Every renderer console error, from both windows, with its source. */
const consoleErrors = [];
const screenshots = [];

function attachConsole(win, label) {
  win.webContents.on('console-message', (_event, ...rest) => {
    // Electron 44 passes one `WebContentsConsoleMessageEventParams` object; the
    // five-positional-argument overload is deprecated and no longer fires. Both
    // shapes are accepted rather than one, because a silent console collector is
    // indistinguishable from a window that had no errors: the run would report
    // "no console errors" on the strength of a listener that never ran.
    const params =
      typeof rest[0] === 'object' && rest[0] !== null
        ? /** @type {{ message: string, level: string | number, lineNumber?: number, sourceId?: string }} */ (
            rest[0]
          )
        : {
            message: /** @type {string} */ (rest[2] ?? ''),
            // Legacy levels: 0 verbose, 1 info, 2 warning, 3 error.
            level: /** @type {number} */ (rest[1]),
            lineNumber: /** @type {number} */ (rest[3]),
            sourceId: /** @type {string} */ (rest[4]),
          };
    const level = typeof params.level === 'string' ? params.level : String(params.level);
    if (level !== 'error' && params.level !== 3) return;
    consoleErrors.push({
      window: label,
      message: params.message,
      source: `${params.sourceId ?? '(unknown source)'}:${params.lineNumber ?? 0}`,
    });
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

// ── Bundles injected into the game page ───────────────────────────────────────

/**
 * esbuild plugin: the game page has no filesystem.
 *
 * Every stub that could return a plausible wrong answer throws instead — a stub
 * that silently returned `{}` would turn a real refusal into a fake success,
 * which is the one failure mode this harness must not have.
 */
const nodeFsStubPlugin = {
  name: 'cf-e2e-node-fs-stub',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: 'cf-e2e-stub' }));
    buildApi.onLoad({ filter: /.*/, namespace: 'cf-e2e-stub' }, () => ({
      contents: `
        const refuse = (name) => () => {
          throw new Error(
            'core.' + name + ' was called in the game page, which has no filesystem. The harness injects ' +
            'core only so the game can Zod-validate scene.json; reaching a filesystem entry point means the ' +
            'game calls core in a way the harness cannot honestly satisfy.',
          );
        };
        export const existsSync = () => false;
        export const readFileSync = refuse('readFileSync');
        export const writeFileSync = refuse('writeFileSync');
        export const mkdirSync = refuse('mkdirSync');
        export const statSync = () => ({ isFile: () => false });
        export const join = (...parts) => parts.join('/');
        export const dirname = () => '';
        export const extname = () => '';
        export const relative = () => '';
        export const isAbsolute = () => false;
        export default {};
      `,
      loader: 'js',
    }));
  },
};

/** `__CF_CORE__` as a browser ES module, built from core's own compiled sources. */
async function buildCoreBrowserBundle() {
  const coreDist = join(CF_ROOT, 'packages', 'core', 'dist');
  check(
    existsSync(join(coreDist, 'index.js')),
    `packages/core/dist/index.js is missing at ${coreDist}. Run \`npm run typecheck\` — without core's ` +
      'build there is no real core to inject, and a hand-written stub would turn every assertion into a ' +
      'mock that agrees with whatever it was written against.',
  );
  const { build } = await import(join(CF_ROOT, 'node_modules', 'esbuild', 'lib', 'main.js'));
  const result = await build({
    stdin: {
      contents: [
        `export { parseScene, loadScene } from ${JSON.stringify(join(coreDist, 'scene', 'sceneFile.js'))};`,
        `export { validateScenePrefabs, indexPrefabs } from ${JSON.stringify(join(coreDist, 'scene', 'prefabs', 'index.js'))};`,
        `export { rngFor, mulberry32 } from ${JSON.stringify(join(coreDist, 'scene', 'rng.js'))};`,
      ].join('\n'),
      resolveDir: CF_ROOT,
      sourcefile: 'cf-e2e-core-entry.js',
      loader: 'js',
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
    plugins: [nodeFsStubPlugin],
    logLevel: 'silent',
  });
  const output = result.outputFiles[0];
  check(output !== undefined, 'esbuild produced no output for the core browser bundle');
  return output.text;
}

/**
 * Inject core + the project's real prefabs, then let the *game* build the scene.
 *
 * The Three specifier is read out of the game's own `main.js` because vite gives
 * the game's copy a content hash; importing an unhashed path yields a second
 * Three.js whose classes the game's renderer will refuse, and an object the
 * renderer refuses to draw is not a rendered position.
 */
async function injectAndBuildScene() {
  const coreSource = await buildCoreBrowserBundle();
  const { bundlePrefabsForBrowser } = await import(join(DIST_ELECTRON, 'prefabLoader.js'));
  const bundle = await bundlePrefabsForBrowser(PROJECT_PATH);
  let prefabSource;
  try {
    prefabSource = bundle.code;
  } finally {
    bundle.handle.dispose();
  }

  const raw = await gameWindow.webContents.executeJavaScript(`
    (async () => {
      const out = {};
      const mainSrc = await (await fetch('/src/main.js')).text();
      const line = mainSrc.split('\\n').find((l) => /from ["'][^"']*three(\\.module)?\\.js(\\?[^"']*)?["']/.test(l));
      if (!line) {
        return JSON.stringify({
          ok: false,
          reason: "could not find the game's own three import in /src/main.js — this page may not be the kart game",
        });
      }
      const specifier = line.match(/from ["']([^"']+)["']/)[1];
      const THREE = await import(specifier);
      out.threeSpecifier = specifier;
      out.threeRevision = THREE.REVISION;

      window.__THREE__ = THREE;
      window.__CF_CORE__ = await import('data:text/javascript;base64,' + btoa(${JSON.stringify(coreSource)}));
      const registryModule = await import('data:text/javascript;base64,' + btoa(${JSON.stringify(prefabSource)}));
      window.__CF_REGISTRY__ = registryModule.registry;
      out.registryPrefabs = Array.isArray(registryModule.registry && registryModule.registry.prefabs)
        ? registryModule.registry.prefabs.map((p) => p.name)
        : null;

      // Class identity, asserted rather than assumed: prefab-built objects must be
      // instances of the SAME Three the game renders with.
      let sample = null;
      window.__game.scene.traverse((n) => { if (!sample && n.isMesh) sample = n; });
      out.gameMeshIsSameThree = sample === null ? null : sample instanceof THREE.Mesh;

      // The game's OWN loader. No harness-side reimplementation of the scene build.
      const built = await window.__game.loadSceneFile();
      // The loader's \`byId\` map is the game's own id → Object3D mapping. Keeping
      // it is the only way to know which Object3D belongs to \`player_kart\`; the
      // harness must not infer that from child order (see the read at \`byId\` below).
      window.__game.lastBuiltScene = built;
      out.builtOk = built !== null && built !== undefined;
      out.failed = built && Array.isArray(built.failed) ? built.failed : [];
      out.rootChildren = built && built.root ? built.root.children.map((c) => c.name) : [];
      return JSON.stringify(out);
    })()
  `);

  const result = JSON.parse(raw);
  check(
    result.ok !== false,
    `injecting the scene build into the game page failed: ${result.reason ?? 'unknown reason'}`,
  );
  check(
    result.registryPrefabs !== null && result.registryPrefabs.length > 0,
    'the prefab bundle injected into the game page exposes no prefabs, so the game cannot build the ' +
      'scene file\'s instances and there is nothing to read a position from.',
  );
  check(
    result.gameMeshIsSameThree === true,
    `the prefab bundle would build objects from a DIFFERENT Three.js than the game renders with (the ` +
      `game page reported same-instance: ${result.gameMeshIsSameThree}). Every position this harness ` +
      'reads would then come from objects the game cannot draw, so the central assertion would be ' +
      'meaningless.',
  );
  check(
    result.builtOk === true,
    "the game's own loadSceneFile() returned nothing after core and the registry were injected, so there " +
      'is no scene graph from which to read a real position.',
  );
  check(
    Array.isArray(result.rootChildren) && result.rootChildren.length > 0,
    'the game page built the scene file but added no objects to it. A scene with no objects has no ' +
      'rendered position, and asserting against one would be asserting against nothing.',
  );
  return result;
}

// ── Reading the game's real position ─────────────────────────────────────────

/**
 * Confirm that what the dev server serves for `scene.json` is the file on disk.
 *
 * This is the link that makes the headline assertion mean anything, so it is
 * verified rather than assumed. The game's loader derives its scene URL from its
 * own module (`new URL('../scene.json', import.meta.url)`, `loadScene.js:43`),
 * which on a vite dev server is `/scene.json`. Vite serves that path straight
 * from the project root on every request — verified by mutating the file and
 * re-fetching — so the game reads the app-saved bytes without any help.
 *
 * It is checked anyway because the failure it guards against is silent and total:
 * if a dev server ever cached the file at boot, the game would build a stale
 * scene, the comparison would still produce two numbers, and the numbers would
 * simply disagree for a reason nothing in the report would explain.
 *
 * The bytes are compared over HTTP in the harness only; the game is never handed
 * anything by the harness, and the positions asserted below all come off live
 * `Object3D`s.
 */
async function assertDevServerServesLiveSceneJson() {
  const response = await fetch(new URL('/scene.json', GAME_URL), {
    signal: AbortSignal.timeout(5000),
    cache: 'no-store',
  });
  check(
    response.ok === true,
    `GET ${new URL('/scene.json', GAME_URL)} answered HTTP ${response.status}. The game derives this URL ` +
      'for its own scene file, so a refusal here means the game cannot read the file the app saves and no ' +
      'position comparison against it is possible.',
  );
  const served = Buffer.from(await response.arrayBuffer());
  const onDisk = readFileSync(SCENE_JSON);
  check(
    served.equals(onDisk),
    `the dev server serves ${served.length} bytes for /scene.json but ${SCENE_JSON} is ${onDisk.length} ` +
      `bytes on disk (sha256 ${sha256(served)} vs ${sha256(onDisk)}). The game would be reading a different ` +
      'file than the app writes, so every number below would be about the wrong document.',
  );
}

/**
 * Boot (or re-boot) the game page so it builds its scene from the bytes that are
 * on disk *right now*, and return the loader's result.
 *
 * The game reads `scene.json` exactly once per page load, so this is the only
 * honest way to ask "what does the game make of the file the app just saved?":
 * the alternative — reading an object in a page that booted before the Save —
 * can only ever return the pre-Save scene. Each call is a genuine page load:
 * the game's own `main.js` runs, fetches its own scene URL, Zod-validates it
 * through `@contextforge/core`, and builds real `Object3D`s.
 */
async function bootGameFromDisk(label) {
  stage(`booting the game page from the scene file on disk — ${label}`);
  await gameWindow.loadURL(GAME_URL);
  const booted = await gameWindow.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const deadline = Date.now() + 20000;
      const tick = () => {
        if (typeof window.__game === 'object' && window.__game !== null) resolve(true);
        else if (Date.now() > deadline) resolve(false);
        else setTimeout(tick, 100);
      };
      tick();
    })`,
  );
  if (booted !== true) {
    throw new GamePageDidNotBoot(
      `${GAME_URL} was loaded (${label}) but window.__game never became an object within 20s, so the page ` +
        'is not the kart game booting, or it threw before its constructor finished. Its console output is ' +
        'above; without the game there is no rendered position to assert against and nothing downstream can ' +
        'be proven.',
    );
  }
  return injectAndBuildScene().then(identifyGameObject);
}

/**
 * Read the instance's real position out of the live game page.
 *
 * Three readings are reported separately because they are different claims, and
 * collapsing them would hide which one actually held:
 *
 *  - `position` — the `Object3D`'s own `position`, i.e. what the game renders.
 *  - `sceneGridPosition` — what `startingGrid()` reported, i.e. what `createKarts()`
 *    reads. A kart can be built and never driven.
 *  - `drivingKartPosition` — the live `Kart` mesh, or `null` when none matched the
 *    grid entry. `null` rather than a guess, because matching a kart to an instance
 *    by position alone would be circular.
 */
const READ_POSITION = (instanceName) => `
  (() => {
    const game = window.__game;
    const empty = {
      objectFound: false, objectName: null, position: null,
      sceneGridPosition: null, drivingKartPosition: null,
    };
    if (!game) return JSON.stringify(empty);
    const root = game.sceneRoot;
    const entry = root
      ? root.children.find((c) => c.name === ${JSON.stringify(instanceName)})
      : undefined;
    const grid = Array.isArray(game.sceneGrid) ? game.sceneGrid : [];
    const gridEntry = grid.find((g) => g.id === ${JSON.stringify(TARGET_INSTANCE)});
    let driving = null;
    if (gridEntry && Array.isArray(game.karts)) {
      for (const kart of game.karts) {
        const p = kart.mesh ? kart.mesh.position : null;
        if (!p) continue;
        if (Math.abs(p.x - gridEntry.x) < 1e-6 && Math.abs(p.z - gridEntry.z) < 1e-6) {
          driving = kart;
          break;
        }
      }
    }
    return JSON.stringify({
      objectFound: !!entry,
      objectName: entry ? entry.name : null,
      position: entry ? entry.position.toArray() : null,
      sceneGridPosition: gridEntry ? [gridEntry.x, gridEntry.y, gridEntry.z] : null,
      drivingKartPosition: driving
        ? [driving.mesh.position.x, driving.mesh.position.y, driving.mesh.position.z]
        : null,
    });
  })()
`;

/** The raw page JSON is untyped; this turns it into the checked shape. */
function toObservation(raw) {
  const parsed = JSON.parse(raw);
  /** Coerce a page-supplied array into a checked `[x, y, z]`, or `null`. */
  const triple = (v) => {
    if (v === null || v === undefined || !Array.isArray(v) || v.length < 3) return null;
    const out = [Number(v[0]), Number(v[1]), Number(v[2])];
    return /** @type {[number, number, number]} */ (out);
  };
  const found = parsed.objectFound === true;
  return {
    objectFound: found,
    objectName: typeof parsed.objectName === 'string' ? parsed.objectName : null,
    position: { source: found ? 'rendered-object3d' : 'absent', value: triple(parsed.position) },
    sceneGridPosition: triple(parsed.sceneGridPosition),
    drivingKartPosition: triple(parsed.drivingKartPosition),
  };
}

async function observeGame(instanceName) {
  return toObservation(
    await gameWindow.webContents.executeJavaScript(READ_POSITION(instanceName)),
  );
}

/**
 * Tie the id the app edits to the `Object3D` the game built, via the game's own
 * loader result rather than by guessing.
 *
 * The game's loader names each object `instance.name ?? instance.id`
 * (`loadScene.js`), so the outliner row's *name* and the scene graph node's name
 * are the same string. `window.__game.lastBuiltScene.byId` — kept during
 * injection — is the game's own `id → object` map, which is the only
 * authoritative way to do this.
 *
 * Taking `root.children[0]` instead is *accidentally* correct today and only
 * today: it happens to be the kart purely because `track` and `hazard_crate` fail
 * to build. Fix that unrelated base64-geometry bug and `children[0]` silently
 * becomes the racetrack, and this loop would go on asserting the kart's position
 * against a track's — a green test proving nothing.
 */
async function identifyGameObject() {
  const read = JSON.parse(
    await gameWindow.webContents.executeJavaScript(`
      (() => {
        const built = window.__game === undefined ? undefined : window.__game.lastBuiltScene;
        if (built === undefined || built === null || typeof built.byId?.get !== 'function') {
          return JSON.stringify({ ok: false, reason: 'the game page does not expose the loader\\'s byId map' });
        }
        return JSON.stringify({
          ok: true,
          entries: [...built.byId.values()].map((e) => ({
            id: e.id,
            objectName: e.object === null || e.object === undefined ? null : e.object.name,
            position: e.object === null || e.object === undefined ? null : e.object.position.toArray(),
          })),
          failed: Array.isArray(built.failed) ? built.failed : [],
          rootChildren: built.root ? built.root.children.map((c) => c.name) : [],
        });
      })()
    `),
  );
  check(
    read.ok === true,
    `the game's own loader result could not be read from window.__game: ${read.reason}. Without that byId ` +
      'map there is no authoritative way to tie the id the app edits to the Object3D the game draws, and an ' +
      'inferred mapping is exactly how this loop would end up asserting against the wrong object.',
  );
  const target = read.entries.find((entry) => entry.id === TARGET_INSTANCE);
  check(
    target !== undefined && typeof target.objectName === 'string' && target.objectName !== '',
    `the game built no Object3D for the id "${TARGET_INSTANCE}" the app edits. It built ` +
      `${JSON.stringify(read.entries)}, reported failures for ${JSON.stringify(read.failed)}, and put ` +
      `${JSON.stringify(read.rootChildren)} under the scene root. A game that refuses to build the instance ` +
      "cannot confirm the app moved it, and reading some other object's position would be a different claim.",
  );
  stage(
    `the game built "${target.objectName}" for id "${TARGET_INSTANCE}" at ${fmt(target.position)} ` +
      `(loader failures: ${JSON.stringify(read.failed)})`,
  );
  return { objectName: target.objectName, position: target.position };
}

// ── Driving the app's UI ──────────────────────────────────────────────────────

/**
 * Set an input's value the way a user does.
 *
 * `input.value = …` alone does not move a Svelte 5 `$state` draft: the component
 * reads `event.currentTarget.value` inside its `oninput`, and assigning the
 * property fires no event. Going through the prototype's native setter makes the
 * browser's own input machinery run, so the inspector's handler sees the same
 * event sequence a keystroke would produce. Skipping this is how an e2e ends up
 * "passing" without the app ever having been told anything.
 */
const SET_VALUE = `
  const setNativeValue = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
`;

/**
 * The page snippet that waits for the inspector to actually exist.
 *
 * Svelte 5 flushes the store-driven re-render on a microtask, so reading the DOM
 * in the same turn as `row.click()` observes the *pre-selection* inspector — the
 * "Nothing is selected" placeholder. This is the exact shape of the timing bug
 * D24 records: a synchronous DOM read assumes a flush that has not happened yet,
 * and the resulting failure ("no position input") reads as "the app is broken"
 * rather than "the probe was too early". Nothing here polls a fixed sleep: it
 * waits on the observable it actually needs and reports what it saw instead.
 */
const AWAIT_INSPECTOR = `
  const deadline = Date.now() + 15000;
  const probe = () => ({
    ready: document.querySelector('.inspector input[aria-label="position x"]') !== null,
    inspectorPresent: document.querySelector('.inspector') !== null,
    inspectorInputs: document.querySelectorAll('.inspector input').length,
    inspectorText: (document.querySelector('.inspector')?.textContent ?? '(no .inspector)').slice(0, 200),
    selectedId: document.querySelector('.selected-id code')?.textContent?.trim() ?? null,
  });
  while (Date.now() < deadline) {
    const state = probe();
    if (state.ready) return state;
    await new Promise((r) => requestAnimationFrame(() => r()));
  }
  return probe();
`;

/**
 * Pick `player_kart` in the outliner and type a new position into the inspector.
 *
 * Real DOM interactions only: the outliner row's own click handler, the
 * inspector inputs' `input`/`change` handlers, and `HTMLElement.click()` on the
 * toolbar's Save. Calling `window.contextforge.invoke('scene:applyEdit', …)` would
 * prove the IPC channel works, which is a weaker and different claim from "a
 * developer can move a kart in the inspector" — and the latter is the loop.
 *
 * The three axes are typed in **separate** turns. The inspector commits a vector
 * on the field's `change` event and clears its drafts, so setting x, y and z in
 * one synchronous block makes the y and z keystrokes land on an input whose
 * draft x has just been consumed — a batched write that never happens for a human.
 * Typing one axis per turn reproduces the real sequence of three edits, which is
 * also why the undo half of the loop must undo more than once.
 */
async function appEditPosition(position) {
  const axisSelectors = ['x', 'y', 'z'].map((axis) => `.inspector input[aria-label="position ${axis}"]`);

  const picked = JSON.parse(
    await appWindow.webContents.executeJavaScript(`
      (() => {
        ${SET_VALUE}
        const picks = [...document.querySelectorAll('button.pick')];
        const row = picks.find((b) => b.getAttribute('title') === ${JSON.stringify(TARGET_INSTANCE)});
        if (!row) {
          return JSON.stringify({
            ok: false,
            reason: 'no outliner row titled "' + ${JSON.stringify(TARGET_INSTANCE)} + '" (rows: ' +
              picks.map((b) => b.getAttribute('title')).join(', ') + ')',
          });
        }
        row.click();
        return JSON.stringify({ ok: true });
      })()
    `),
  );
  if (picked.ok !== true) return picked;

  // One round-trip per axis: each dispatch must be seen by Svelte and committed
  // before the next is typed, or the value read back is not the value typed.
  const typed = [];
  for (let i = 0; i < axisSelectors.length; i += 1) {
    const raw = await appWindow.webContents.executeJavaScript(`
      (async () => {
        ${SET_VALUE}
        const waited = await (async () => { ${AWAIT_INSPECTOR} })();
        if (!waited.ready) {
          return JSON.stringify({ ok: false, reason: 'the inspector never rendered a position input for "${TARGET_INSTANCE}"', detail: waited });
        }
        const el = document.querySelector(${JSON.stringify(axisSelectors[i])});
        if (el === null) return JSON.stringify({ ok: false, reason: 'no position ${['x', 'y', 'z'][i]} input' });
        el.focus();
        setNativeValue(el, ${JSON.stringify(position[i])});
        el.blur();
        return JSON.stringify({ ok: true, value: el.value });
      })()
    `);
    const result = JSON.parse(raw);
    if (result.ok !== true) {
      return {
        ok: false,
        reason: `typing position ${['x', 'y', 'z'][i]} into the inspector failed: ${result.reason}`,
        detail: result.detail ?? null,
      };
    }
    typed.push(result.value);
    await sleep(400);
  }

  return { ok: true, typed };
}

async function appClick(selector, label) {
  const raw = await appWindow.webContents.executeJavaScript(`
    (() => {
      const btn = ${selector.startsWith('[') ? selector : `document.querySelector(${JSON.stringify(selector)})`};
      if (!btn) return JSON.stringify({ ok: false, reason: 'no ${label} control in the scene toolbar' });
      if (btn.disabled) return JSON.stringify({ ok: false, reason: 'the ${label} button is disabled, so there is nothing to ${label.toLowerCase()}' });
      const text = btn.textContent.trim();
      btn.click();
      return JSON.stringify({ ok: true, text });
    })()
  `);
  return JSON.parse(raw);
}

const saveScene_ = () => appClick('button.save-button', 'Save');
const undoScene_ = () =>
  appClick("[...document.querySelectorAll('button.chip')].find((b) => b.textContent.includes('Undo'))", 'Undo');

/**
 * Click the sidebar's **Scene** screen button — a real UI interaction.
 *
 * Used to force the inspector to re-read the app's committed transform. Undo
 * rewrites the app's store, but the inspector's typed values can be left behind
 * by a draft the undo path does not clear, so the inputs can show the pre-undo
 * numbers while the app's actual state — and the file it wrote — are correct.
 * Reading the DOM in that state would compare the game against a stale input
 * rather than against the app, and would report a working undo as broken.
 *
 * Navigating away and back is the same thing a developer does to re-read a
 * panel, and it goes through the app's own screen switch rather than any direct
 * state poke. If the DOM is *still* stale afterwards, that is a real
 * disagreement between the app's state and its UI, and it fails loudly.
 */
async function appRevisitSceneScreen() {
  return JSON.parse(
    await appWindow.webContents.executeJavaScript(`
      (() => {
        const buttons = [...document.querySelectorAll('.sidebar button.screen')];
        const scene = buttons.find((b) => b.textContent.trim() === 'Scene');
        if (!scene) {
          return JSON.stringify({
            ok: false,
            reason: 'no Scene screen button in the sidebar (found: ' +
              buttons.map((b) => b.textContent.trim()).join(', ') + ')',
          });
        }
        if (scene.disabled) return JSON.stringify({ ok: false, reason: 'the Scene screen button is disabled' });
        scene.click();
        const project = buttons.find((b) => b.textContent.trim() === 'Project');
        if (project !== undefined && !project.disabled) {
          project.click();
          scene.click();
        }
        return JSON.stringify({ ok: true });
      })()
    `),
  );
}

/**
 * Click the inspector's own **Discard transform edits** button.
 *
 * A real UI control, and the app's documented way to drop the inspector's typed
 * drafts (`Inspector.svelte`, `resetVectorDrafts`). It is needed before reading
 * the position back after an Undo, because the inputs are driven by
 * `transformDrafts` and `commitVector` never clears them — so an Undo that
 * correctly rewrites the app's committed transform leaves the *inputs* still
 * displaying the pre-undo numbers. Reading them there would compare the game
 * against a stale text box and report a working undo as broken.
 *
 * It discards drafts rather than committing one, so clicking it cannot itself
 * change what gets saved; it only makes the inputs show the app's real state.
 * If the numbers *still* disagree after this, that is a genuine disagreement
 * between the app's state and what it writes, and the run fails loudly.
 */
async function appDiscardTransformDrafts() {
  return JSON.parse(
    await appWindow.webContents.executeJavaScript(`
      (() => {
        const btn = [...document.querySelectorAll('.inspector button')].find(
          (b) => b.textContent.trim() === 'Discard transform edits',
        );
        if (!btn) {
          return JSON.stringify({
            ok: false,
            reason: 'no "Discard transform edits" button in the inspector (buttons: ' +
              [...document.querySelectorAll('.inspector button')].map((b) => b.textContent.trim()).join(', ') + ')',
          });
        }
        btn.click();
        return JSON.stringify({ ok: true });
      })()
    `),
  );
}

/** Read the selected instance's position straight out of the app's own DOM. */
async function appSnapshotPosition() {
  const raw = await appWindow.webContents.executeJavaScript(`
    (() => {
      const axes = ['x', 'y', 'z'].map((axis) => {
        const input = document.querySelector('.inspector input[aria-label="position ' + axis + '"]');
        return input === null ? null : Number(input.value);
      });
      if (axes.some((v) => v === null || Number.isNaN(v))) return JSON.stringify(null);
      const selected = document.querySelector('.selected-id code');
      return JSON.stringify({
        selected: selected ? selected.textContent.trim() : null,
        position: axes,
      });
    })()
  `);
  return JSON.parse(raw);
}

// ── Preconditions ─────────────────────────────────────────────────────────────

/** Is the game's dev server actually answering with its index page? */
async function probeGameServer() {
  const response = await fetch(GAME_URL, { signal: AbortSignal.timeout(5000) });
  check(
    response.ok === true,
    `GET ${GAME_URL} answered HTTP ${response.status}. The game dev server is not serving the page this ` +
      'loop reads a rendered position from, so nothing downstream can be proven.',
  );
  const body = await response.text();
  check(
    body.includes('<html'),
    `GET ${GAME_URL} answered 200 but returned ${body.length} bytes that are not an HTML page. CF_GAME_URL ` +
      'is pointing at something other than the game.',
  );
}

// ── The run ───────────────────────────────────────────────────────────────────

/**
 * Run the whole loop. Returns a `RunResult`; never throws.
 *
 * Throwing would be the wrong shape: a missing game dev server is a *skip with a
 * named reason*, a failed check is a *failure with a reason*, and both must be
 * reportable without a stack trace (SPEC R9). The verdict lives in the union.
 */
export async function runEditLoop() {
  const report = {
    projectPath: PROJECT_PATH,
    gameUrl: GAME_URL,
    targetInstance: TARGET_INSTANCE,
    requestedPosition: NEW_POSITION,
    appSavedPosition: null,
    before: null,
    afterEdit: null,
    afterUndo: null,
    sceneSha256Before: '',
    sceneSha256After: '',
    sceneRestored: false,
    screenshots: [],
    consoleErrors: [],
  };

  for (const [file, why] of [
    [RENDERER_ENTRY, 'the app renderer bundle (npm run build:ui -w @contextforge/app)'],
    [PRELOAD, "the preload bridge (npm run typecheck)"],
    [join(DIST_ELECTRON, 'ipcHandlers.js'), 'the compiled main process (npm run typecheck)'],
  ]) {
    if (!existsSync(file)) {
      return {
        status: 'skipped',
        reason: 'app-bundles-missing',
        detail: `${file} does not exist, so ${why} is missing. Without it the harness has no app to drive.`,
      };
    }
  }
  if (!existsSync(SCENE_JSON)) {
    return {
      status: 'skipped',
      reason: 'project-scene-missing',
      detail: `${SCENE_JSON} does not exist, so there is no scene file to edit. Set CF_PROJECT to the game project.`,
    };
  }

  try {
    await probeGameServer();
    await assertDevServerServesLiveSceneJson();
  } catch (error) {
    return {
      status: 'skipped',
      reason: 'game-server-unreachable',
      detail:
        `${error instanceof Error ? error.message : String(error)}. The game's vite dev server must be ` +
        `running for this loop: start it in ${PROJECT_PATH} (\`npm run dev\`) or set CF_GAME_URL.`,
    };
  }

  // Captured before anything can write, so the restore is a byte-for-byte undo of
  // the whole run rather than a best-effort edit back to "about right".
  const originalBytes = readFileSync(SCENE_JSON);
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const { AppBackend, registerHandlers } = await loadCompiledIpc();
  const backend = new AppBackend((event, payload) => {
    if (appWindow !== null && !appWindow.isDestroyed()) {
      appWindow.webContents.send(event, payload);
    }
  });

  try {
    registerHandlers(ipcMain, backend);
    stage('registered IPC handlers');

    appWindow = new BrowserWindow({
      width: 1600,
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
    attachConsole(appWindow, 'app');

    // `sandbox: false` here only, and only for the game: it is an ordinary web
    // page on a dev server, not the app's renderer, and the app renderer's
    // sandbox above is the posture main.ts documents as non-negotiable.
    gameWindow = new BrowserWindow({
      width: 1600,
      height: 1000,
      useContentSize: true,
      show: true,
      backgroundColor: '#101418',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    attachConsole(gameWindow, 'game');

    // ── 1. Open the project in the app, load the game page ──────────────────
    stage('loading the app renderer');
    await appWindow.loadFile(RENDERER_ENTRY);
    await sleep(1500);
    stage('opening the project in the app');
    const opened = await appWindow.webContents.executeJavaScript(`
      (() => {
        ${SET_VALUE}
        const input = document.querySelector('#project-path');
        if (!input) return JSON.stringify({ ok: false, reason: 'no #project-path input — the app is not on the Project screen' });
        setNativeValue(input, ${JSON.stringify(PROJECT_PATH)});
        const btn = document.querySelector('.actions button.primary');
        if (!btn) return JSON.stringify({ ok: false, reason: 'no .actions button.primary to open the project' });
        btn.click();
        return JSON.stringify({ ok: true });
      })()
    `).then((raw) => JSON.parse(raw));
    check(
      opened.ok === true,
      `the app's Project screen could not be driven: ${opened.reason}. The loop starts from that screen, ` +
        'so nothing after it can be proven.',
    );

    // The Scene screen builds the viewport and loads the prefab registry, both
    // asynchronous; the outliner rows are the observable that it is ready.
    stage('waiting for the Scene screen to list instances');
    const rowCount = await appWindow.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const deadline = Date.now() + 25000;
        const tick = () => {
          const n = document.querySelectorAll('button.pick').length;
          if (n > 0 || Date.now() > deadline) resolve(n);
          else setTimeout(tick, 150);
        };
        tick();
      })
    `);
    if (rowCount === 0) {
      return {
        status: 'skipped',
        reason: 'app-project-did-not-open',
        detail:
          `the app accepted ${PROJECT_PATH} but the Scene screen lists no instances after 25s. The ` +
          'project screen could not be proven to have opened, so there is no instance to edit.',
      };
    }

    // ── 2. Inject core + registry, then let the GAME build the scene ─────────
    const beforeBuild = await bootGameFromDisk('the scene as it is before any edit');
    await sleep(1500);

    report.before = await observeGame(beforeBuild.objectName);
    check(
      report.before.objectFound === true,
      `the game built no Object3D named "${beforeBuild.objectName}" under its scene root for id ` +
        `"${TARGET_INSTANCE}". Without a rendered object there is no real position to assert against, and ` +
        'falling back to scene.json would be a different and much weaker claim.',
    );
    check(
      samePosition(report.before.position.value, beforeBuild.position),
      `the Object3D the loader built for "${TARGET_INSTANCE}" is at ${fmt(beforeBuild.position)}, but the ` +
        `object read back from the live game is at ${fmt(report.before.position.value)}. Those are two ` +
        'different objects, so the read is not the one the loader produced.',
    );
    const instanceName = beforeBuild.objectName;
    await capture(appWindow, 'app-01-before.png');
    await capture(gameWindow, 'game-01-before.png');

    // ── 3. Edit the position through the inspector, then Save ───────────────
    stage(`selecting ${TARGET_INSTANCE} in the outliner and typing ${JSON.stringify(NEW_POSITION)}`);
    const edit = await appEditPosition(NEW_POSITION);
    check(edit.ok === true, `the inspector could not be driven: ${edit.reason}`);
    await sleep(1500);

    const afterEditSnapshot = await appSnapshotPosition();
    check(
      afterEditSnapshot !== null && afterEditSnapshot.position.every((n) => !Number.isNaN(n)),
      'the app has no readable position x/y/z inputs after the edit, so what it committed cannot be read ' +
        'back from its own UI. The loop would then only assert against the game, with no record of what ' +
        'the app actually saved.',
    );
    report.appSavedPosition = afterEditSnapshot.position;

    stage('clicking Save scene');
    const save = await saveScene_();
    check(save.ok === true, `Save could not be clicked: ${save.reason}`);
    await sleep(2000);
    await capture(appWindow, 'app-02-after-save.png');
    stage('captured app after Save');

    // ── 4. Read the game's REAL rendered position ───────────────────────────
    // The game page is reloaded here on purpose. It fetched `scene.json` while
    // booting, before the app had saved anything, so the object still on screen
    // is the *pre-edit* scene; reading it again would compare the app against a
    // stale page and any "the game followed" claim would be false. This is the
    // developer loop — edit, save, refresh the game — and each observation is a
    // genuine page load of the file the app just wrote.
    const afterEditBuild = await bootGameFromDisk('the scene the app saved after the inspector edit');
    check(
      afterEditBuild.objectName === instanceName,
      `after Save the game built "${afterEditBuild.objectName}" for id "${TARGET_INSTANCE}", but before the ` +
        `edit it built "${instanceName}". The id must name the same object on both sides or the comparison ` +
        'below would be between two different objects.',
    );
    report.afterEdit = await observeGame(instanceName);
    check(
      report.afterEdit.position.source === 'rendered-object3d',
      `after Save the game page no longer exposes a rendered "${instanceName}" object, so the saved ` +
        'position cannot be confirmed against the game. This is the assertion the whole loop exists to ' +
        'make, so it must fail loudly rather than pass against something else.',
    );
    check(
      samePosition(report.appSavedPosition, report.afterEdit.position.value),
      `the app's inspector shows ${fmt(report.appSavedPosition)} for "${TARGET_INSTANCE}" after Save, but ` +
        `the game's rendered "${instanceName}" object is at ${fmt(report.afterEdit.position.value)}. ` +
        'The edit the developer made in the app did not reach the game.',
    );
    check(
      samePosition(report.afterEdit.position.value, report.before.position.value) === false,
      `the game's rendered "${instanceName}" object is still at ${fmt(report.afterEdit.position.value)}, ` +
        `the same place it was before the edit (${fmt(report.before.position.value)}). Passing here ` +
        'would mean the app saved nothing, so the comparison against the requested position is what ' +
        'makes this a real movement and not a coincidence.',
    );
    await capture(gameWindow, 'game-02-after-edit.png');

    // ── 5. Undo, save, and confirm the game follows back ────────────────────
    // Each typed axis commits its own edit, so three axes leave the position two
    // thirds undone after one Undo. Undo until the app reports no steps left so
    // "the game followed the undo" is a claim about the ORIGINAL position rather
    // than about an intermediate one.
    stage('clicking Undo until the app has no steps left');
    let undoCount = 0;
    for (let i = 0; i < 12; i += 1) {
      const undo = await undoScene_();
      if (!undo.ok) break;
      undoCount += 1;
      await sleep(700);
    }
    check(
      undoCount > 0,
      'Undo was never available after the edit, so the undo half of the loop cannot be proven. A Save ' +
        'that recorded no history step means the undo button is decorative.',
    );
    await sleep(1000);

    // Re-read the inspector through the app's own controls before comparing
    // anything. See `appRevisitSceneScreen` and `appDiscardTransformDrafts`:
    // without these the inputs can still hold the pre-undo draft while the app's
    // committed state — and the file it wrote — are already correct.
    const revisited = await appRevisitSceneScreen();
    check(revisited.ok === true, `the app's Scene screen could not be revisited: ${revisited.reason}`);
    await sleep(1000);
    const discarded = await appDiscardTransformDrafts();
    check(discarded.ok === true, `the inspector's draft controls could not be driven: ${discarded.reason}`);
    await sleep(1000);
    const undoSnapshot = await appSnapshotPosition();
    const undoSave = await saveScene_();
    check(undoSave.ok === true, `Save after Undo could not be clicked: ${undoSave.reason}`);
    await sleep(2000);
    await capture(appWindow, 'app-03-after-undo.png');

    report.afterUndo = await (async () => {
      const undoBuild = await bootGameFromDisk('the scene the app saved after Undo');
      check(
        undoBuild.objectName === instanceName,
        `after Undo + Save the game built "${undoBuild.objectName}" for id "${TARGET_INSTANCE}", but the ` +
          `original build named it "${instanceName}". The comparison below requires the same object on both ` +
          'sides, or it would be measuring two different things.',
      );
      return observeGame(instanceName);
    })();
    check(
      report.afterUndo.position.source === 'rendered-object3d',
      'after Undo + Save the game page exposes no rendered object, so the undo cannot be confirmed against ' +
        'the game. Passing here would mean the undo was never verified.',
    );
    check(
      undoSnapshot !== null && samePosition(undoSnapshot.position, report.afterUndo.position.value),
      `the app's inspector shows ${fmt(undoSnapshot?.position)} for "${TARGET_INSTANCE}" after Undo + Save, ` +
        `but the game's rendered "${instanceName}" object is at ${fmt(report.afterUndo.position.value)}. ` +
        'Undo did not reach the game.',
    );
    check(
      samePosition(report.afterUndo.position.value, report.before.position.value),
      `after Undo + Save the game's rendered "${instanceName}" object is at ` +
        `${fmt(report.afterUndo.position.value)}, but it was at ${fmt(report.before.position.value)} before ` +
        'the edit. An undo that does not return the kart to where it started is a wrong undo, not a ' +
        'partial one.',
    );
    await capture(gameWindow, 'game-03-after-undo.png');

    const finalReport = finalizeReport(report, originalBytes);
    check(
      finalReport.sceneRestored === true,
      `${SCENE_JSON} was NOT restored to its original bytes (sha256 before ` +
        `${finalReport.sceneSha256Before}, after ${finalReport.sceneSha256After}). The e2e must never ` +
        'leave the game scene mutated, so this run cannot be reported as a pass.',
    );
    return { status: 'passed', report: finalReport };
  } catch (error) {
    finalizeReport(report, originalBytes);
    // A page that is not the kart game is an environment skip, named as such; it
    // must never be reported as a pass, and must never be confused with the
    // product being broken.
    if (error instanceof GamePageDidNotBoot) {
      return { status: 'skipped', reason: 'game-page-did-not-boot', detail: error.message };
    }
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      report,
    };
  } finally {
    // The scene file is the game's source of truth. Leaving `player_kart` moved
    // because an e2e ran would be the most damaging thing this file could do, so
    // the restore is unconditional and runs even after a failed check.
    finalizeReport(report, originalBytes);
    backend.teardown();
    for (const win of [appWindow, gameWindow]) {
      if (win !== null && !win.isDestroyed()) win.destroy();
    }
    appWindow = null;
    gameWindow = null;
  }
}

/** Fill in the report's evidence fields and write it out. Idempotent. */
function finalizeReport(report, originalBytes) {
  report.sceneSha256Before = sha256(originalBytes);
  try {
    writeFileSync(SCENE_JSON, originalBytes);
    const now = readFileSync(SCENE_JSON);
    report.sceneSha256After = sha256(now);
    report.sceneRestored = now.equals(originalBytes);
  } catch (error) {
    report.sceneSha256After = `could not be read back: ${
      error instanceof Error ? error.message : String(error)
    }`;
    report.sceneRestored = false;
  }
  report.screenshots = [...screenshots];
  report.consoleErrors = [...consoleErrors];
  try {
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  } catch {
    // A report that cannot be written must not mask the run's own verdict.
  }
  return report;
}

// ── Direct execution ──────────────────────────────────────────────────────────

/**
 * Run the loop under Electron and turn the result into an exit code.
 *
 * The body is wrapped in an async IIFE rather than written at module top level
 * **on purpose**. Electron's ESM entry point executes each module inside a
 * `vm.SourceTextModule` whose `importModuleDynamically` is not installed, so a
 * top-level `await` never resumes: the promise is created, the module evaluation
 * promise is abandoned, and the process exits silently — no `[stage]` line, no
 * error, exit code 0. That failure mode is worse than a crash, because it is
 * indistinguishable from a hang and it looks like a pass to any wrapper that
 * only reads the exit code. Every await reachable from the entry point must
 * therefore sit inside a function the runtime calls, not at module scope.
 */
async function main() {
  await app.whenReady();
  const result = await runEditLoop();
  console.log(JSON.stringify(result, null, 2));
  app.exit(result.status === 'passed' ? 0 : result.status === 'skipped' ? 2 : 1);
}

/**
 * Is this file the process's entry point?
 *
 * `process.argv[1]` is **not** the entry script under Electron. argv[0] is the
 * Electron binary and every flag shifts the script path along, so for the exact
 * invocation this file documents
 *
 *     electron --no-sandbox packages/app/src/electron/capture-v3d.mjs
 *
 * argv is `['…/electron', '--no-sandbox', '…/capture-v3d.mjs']` and argv[1] is
 * `--no-sandbox`. A guard that tested argv[1] therefore never matched, `main()`
 * was never called, and the process exited immediately and silently with code 0 —
 * which reads as a pass to anything that only checks the exit code. The script
 * path is whichever argument actually names this file; a wrapper that imported
 * `runEditLoop` instead passes its own path and correctly does not match.
 */
function isDirectExecution() {
  return process.argv.some((arg) => arg.endsWith('capture-v3d.mjs'));
}

// Only when run as the entry point. `scripts/run-e2e-edit-loop.mjs` imports
// `runEditLoop` instead, and must not have the app quit underneath it.
if (isDirectExecution()) {
  main().catch((error) => {
    // The one path that must never be silent: a rejected `main` would otherwise
    // leave Electron's event loop with nothing to do and exit 0.
    console.error('[fatal]', error instanceof Error ? (error.stack ?? error.message) : String(error));
    app.exit(1);
  });
}
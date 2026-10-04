#!/usr/bin/env node
/**
 * scripts/smoke-package.mjs — load a game's prefabs from the PACKAGED app.
 *
 * ## Why this exists
 *
 * A packaging omission produces a build that SUCCEEDS and a package that fails at
 * runtime (D55). The unit suite cannot see that class of defect: `prefabLoader.test.ts`
 * imports the loader from the dev tree, where `node_modules` is one `..` hop away and
 * every native binary sits at a real path. Nothing in the dev tree tells you what the
 * app.asar is actually missing.
 *
 * This harness closes that gap. It extracts the built AppImage, then calls the
 * **packaged** `prefabLoader.js` — the file that shipped, not the one in `packages/app/dist`
 * — against a real game's prefabs, and reports the exact `reason` string for every
 * failure rather than a pass/fail boolean.
 *
 * ## It must run under Electron, not plain node
 *
 * A plain node process cannot read inside an asar at all:
 * `ENOTDIR: not a directory, open '.../app.asar/dist/electron/prefabLoader.js'`.
 * Electron patches `fs` for asar; node does not. So the harness re-executes itself with
 * the AppImage's own Electron binary and `ELECTRON_RUN_AS_NODE=1`. Using the *packaged*
 * Electron rather than the dev one is deliberate — the dev `node_modules/electron` may be
 * a different version than the one that shipped, and this is a test about the package.
 *
 * ## Exit status
 *
 * Non-zero when any prefab of the test game fails to load, EXCEPT the deliberate fixture.
 * `hazardCrate.ts` in kart-dash-3d-v2 throws on purpose to exercise the "a bad prefab is
 * a row, not a crash" path (SPEC R9), so its exact message is the allowed failure. Any
 * OTHER failure means the package cannot load prefabs, which is the defect this exists to
 * catch.
 *
 * Usage:
 *   node scripts/smoke-package.mjs [--appimage <path>] [--project <path>] [--keep]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);

/**
 * The one prefab failure that is correct.
 *
 * Matched on the message, not the name, so a renamed fixture file still fails this way
 * for the same reason. Anything else is a real failure.
 */
const EXPECTED_FAILURE_MESSAGE = 'Corrupted GLTF buffer';

function parseArgs(argv) {
  const opts = {
    appimage: null,
    project: null,
    keep: false,
    extractRoot: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--appimage') opts.appimage = argv[++i];
    else if (arg === '--project') opts.project = argv[++i];
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--extract-root') opts.extractRoot = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else die(`unknown argument: ${arg}`);
  }
  return opts;
}

function die(message, code = 1) {
  console.error(`smoke-package: ${message}`);
  process.exit(code);
}

/** The newest AppImage in `dist/`, or die naming what was looked for. */
function findAppImage() {
  const distDir = join(REPO_ROOT, 'dist');
  const found = spawnSync(
    'bash',
    ['-c', 'ls -t -- "$1"/*.AppImage 2>/dev/null | head -1', '_', distDir],
    { encoding: 'utf-8' },
  );
  const candidate = (found.stdout ?? '').trim();
  if (candidate === '' || !existsSync(candidate)) {
    die(
      `no *.AppImage in ${distDir}. Build one first: npm run dist:appimage\n` +
        `           (this harness tests the PACKAGE, so it cannot test a tree you have not built)`,
    );
  }
  return candidate;
}

/** Where the harness runs its inner half once Electron has been re-entered. */
function extractRootFor(appimage) {
  const parent = mkdtempSync(join(tmpdir(), 'cf-smoke-package-'));
  const dir = join(parent, 'sq');
  // `--appimage-extract` always writes ./squashfs-root, so it needs its own cwd.
  const made = mkdtempSync(join(tmpdir(), 'cf-smoke-extract-'));
  const result = spawnSync(appimage, ['--appimage-extract'], {
    cwd: made,
    encoding: 'utf-8',
    // The AppImage mounts itself via FUSE when it can; extract never needs it.
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '0' },
  });
  if (result.status !== 0) {
    die(
      `--appimage-extract failed (exit ${result.status}).\n` +
        `${result.stderr ?? ''}\n` +
        `           If this machine has no libfuse.so.2, extraction still works — but if it\n` +
        `           fails anyway, the file is not a readable AppImage.`,
      1,
    );
  }
  const root = join(made, 'squashfs-root');
  if (!existsSync(join(root, 'resources', 'app.asar'))) {
    die(`extracted tree has no resources/app.asar at ${root}`, 1);
  }
  void parent;
  return { root, made };
}

/**
 * The inner half: run the PACKAGED loader, from inside the extracted tree.
 *
 * Everything resolves relative to `import.meta.url`, which is inside the extracted tree,
 * so the `app.asar` path is the shipped one and nothing can silently fall back to the
 * dev tree in this repo.
 */
async function runInside(extractedRoot, projectRoot) {
  const asarBase = new URL('./resources/app.asar/', pathToFileURL(`${extractedRoot}/`)).href;

  let loader;
  try {
    loader = await import(new URL('dist/electron/prefabLoader.js', asarBase).href);
  } catch (error) {
    console.error(`FAIL: the packaged loader could not be imported from ${asarBase}`);
    console.error(`  ${error?.code ?? error?.name ?? 'Error'}: ${error?.message ?? String(error)}`);
    process.exit(2);
  }

  if (typeof loader.loadPrefabRegistry !== 'function') {
    die(`the packaged prefabLoader has no loadPrefabRegistry — it is the wrong build`, 2);
  }

  let result;
  try {
    result = await loader.loadPrefabRegistry(projectRoot);
  } catch (error) {
    // loadPrefabRegistry documents that it never throws, so this is itself a defect.
    console.error(`FAIL: loadPrefabRegistry threw, though it promises never to`);
    console.error(`  ${error?.stack ?? String(error)}`);
    process.exit(2);
  }

  const loaded = result.prefabs.map((p) => p.name).sort();
  const unexpected = [];
  const expected = [];

  for (const failure of result.failed) {
    if (String(failure.reason).includes(EXPECTED_FAILURE_MESSAGE)) expected.push(failure);
    else unexpected.push(failure);
  }

  console.log(`\npackage   ${asarBase}dist/electron/prefabLoader.js`);
  console.log(`project   ${projectRoot}`);
  console.log(`loaded    ${loaded.length ? loaded.join(', ') : '(none)'}`);
  console.log(`failed    ${result.failed.length} total — ${expected.length} expected, ${unexpected.length} unexpected`);

  if (expected.length > 0) {
    console.log('\nexpected failures (deliberate fixture, SPEC R9):');
    for (const f of expected) console.log(`  ✓ ${f.name}\n      ${f.reason.split('\n')[0]}`);
  }

  if (unexpected.length > 0) {
    console.log('\nUNEXPECTED failures — printing each reason verbatim:');
    for (const f of unexpected) {
      console.log(`\n  ✗ ${f.name}`);
      console.log(`    file:   ${f.file}`);
      // The whole reason, not the first line: the first line of a `spawn ENOTDIR` or a
      // `Cannot find module` is generic, and the frame that names the real path is the
      // evidence someone needs. Truncating here would hide the defect.
      for (const line of String(f.reason).split('\n')) console.log(`    ${line}`);
    }
    console.log('');
    process.exit(1);
  }

  if (loaded.length === 0) {
    console.error('\nFAIL: every prefab failed to load and none was the deliberate fixture.');
    process.exit(1);
  }

  console.log(`\nOK: ${loaded.length} prefab(s) loaded from the packaged tree, only the fixture failed.\n`);
  process.exit(0);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('usage: node scripts/smoke-package.mjs [--appimage <path>] [--project <path>] [--keep]');
    return;
  }

  const appimage = resolvePath(opts.appimage ?? findAppImage());
  const project = resolvePath(opts.project ?? join(REPO_ROOT, '..', 'kart-dash-3d-v2'));

  if (!existsSync(project)) {
    die(
      `test game not found at ${project}.\n` +
        `           kart-dash-3d-v2 is a SIBLING of this repo; pass --project <path> to override.`,
    );
  }

  const { root, made } = opts.extractRoot
    ? { root: resolvePath(opts.extractRoot), made: null }
    : extractRootFor(appimage);

  if (opts.extractRoot) {
    console.error(`using an already-extracted tree: ${root}`);
  }

  // The extracted Electron binary. Using the shipped one means this harness measures the
  // package, not whatever Electron happens to be in the dev node_modules.
  const electron = join(root, 'contextforge');
  if (!existsSync(electron)) {
    die(`no Electron binary at ${electron} — the AppImage is not a runnable package`, 2);
  }

  const innerScript = join(root, 'cf-smoke-inner.mjs');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    innerScript,
    [
      // Re-enter this module under Electron, now that we are inside the extracted tree.
      `import { pathToFileURL } from 'node:url';`,
      `const me = pathToFileURL(${JSON.stringify(fileURLToPath(import.meta.url))}).href;`,
      `await import(me + '?inner=1');`,
      '',
    ].join('\n'),
    'utf-8',
  );

  // No `--no-sandbox` here: with ELECTRON_RUN_AS_NODE this is a plain node process, and
  // node rejects the Electron-only flag outright ("bad option"). The sandbox only exists
  // when Chromium runs, which it does not here.
  const result = spawnSync(electron, [innerScript], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CF_SMOKE_INNER: '1',
      CF_SMOKE_ROOT: root,
      CF_SMOKE_PROJECT: project,
    },
  });

  if (!opts.keep && made !== null) {
    rmSync(made, { recursive: true, force: true });
  } else if (opts.keep) {
    console.error(`kept the extracted tree at ${made}`);
  }

  // propagate the inner exit status so CI sees the real verdict
  process.exit(result.status === null ? 2 : result.status);
}

// ── entry ─────────────────────────────────────────────────────────────────────

if (process.env.CF_SMOKE_INNER === '1') {
  await runInside(process.env.CF_SMOKE_ROOT, process.env.CF_SMOKE_PROJECT);
} else {
  await main();
}

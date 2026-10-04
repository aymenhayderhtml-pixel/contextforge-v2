/**
 * The packaged esbuild must be RUNNABLE, not merely present.
 *
 * ## The defect
 *
 * Every prefab in the packaged AppImage showed `prefab failed` while the dev tree loaded
 * all of them. The cause was `spawn ENOTDIR`: esbuild is not a pure library, it
 * `child_process.spawn`s a real executable located through `require.resolve`, and inside
 * an asar that path is not a file on disk. Electron patches `fs` for asar but not
 * `child_process`, so the spawn failed identically for every prefab.
 *
 * Every existing test missed this because they all import the loader from the **dev tree**,
 * where the resolved binary is a real file. D55 already records that a build can succeed
 * and the package still fail; this is the mechanical version of that lesson.
 *
 * ## What this file proves, and what it deliberately does not
 *
 * A full end-to-end reproduction needs a real Electron process reading a real
 * `resources/app.asar`. That is exactly what `scripts/smoke-package.mjs` does against the
 * built AppImage, and it is the authoritative check: it fails on the broken package and
 * passes on the fixed one.
 *
 * Reimplementing that here by hand-building a fake app directory is a trap the first
 * draft of this file fell into repeatedly — it produced a passing test that measured
 * nothing, four different ways, each of which looked like a clean green run:
 *
 *  - an asar loose in `/tmp`, which Electron does not patch at all (it only patches paths
 *    under its own `process.resourcesPath`);
 *  - `process.execPath` as the "Electron" binary, which under vitest is **node**;
 *  - `ELECTRON_RUN_AS_NODE=1`, which turns Electron back into node;
 *  - a synchronous `createRequire`, because Electron does not patch the sync CJS loader,
 *    so it fails before ever reaching the spawn.
 *
 * So the division of labour is deliberate:
 *
 *  - **Here:** the path rewrite is correct, it stays narrow, and every `build()` call site
 *    actually invokes it. Those are the things that regress through an ordinary edit, and
 *    they are cheap and deterministic to check.
 *  - **`npm run smoke:package`:** that esbuild really does run from a packaged tree.
 *
 * A test that cannot honestly reach the packaged code path is worse than no test, because
 * it is a green tick over an unmeasured claim.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
// test/packaging -> test -> app -> packages -> repo root
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const APP_ROOT = join(REPO_ROOT, 'packages', 'app');
const SOURCE = join(APP_ROOT, 'src', 'electron', 'prefabLoader.ts');
const LOADER_DIST = join(APP_ROOT, 'dist', 'electron', 'prefabLoader.js');

const require_ = createRequire(import.meta.url);

/** The platform package esbuild resolves for the machine running the tests. */
const PLATFORM_PKG = `@esbuild/${process.platform}-${process.arch}`;

describe('esbuild runs from the packaged tree', () => {
  describe('unpackedAsarPath', () => {
    it('rewrites the archive segment to its unpacked twin', async () => {
      const { unpackedAsarPath } = await import(LOADER_DIST);
      expect(
        unpackedAsarPath(
          '/opt/app/resources/app.asar/node_modules/@esbuild/linux-x64/bin/esbuild',
        ),
      ).toBe('/opt/app/resources/app.asar.unpacked/node_modules/@esbuild/linux-x64/bin/esbuild');
    });

    it('leaves a dev-tree path exactly alone', async () => {
      const { unpackedAsarPath } = await import(LOADER_DIST);
      // Every path the dev tree can resolve is one this returns null for, so esbuild's
      // own resolution stays untouched there.
      expect(unpackedAsarPath('/repo/node_modules/esbuild/bin/esbuild')).toBeNull();
      expect(unpackedAsarPath(join(HERE, 'noop.js'))).toBeNull();
    });

    it('does not match a path that merely contains the archive name', async () => {
      const { unpackedAsarPath } = await import(LOADER_DIST);
      // `app.asar.bak` is a different directory. Rewriting it would point esbuild at a
      // sibling that need not exist, turning a working setup into ENOENT.
      expect(unpackedAsarPath('/tmp/app.asar.bak/node_modules/esbuild')).toBeNull();
      // A bare relative path has no leading separator, so there is no segment to match.
      expect(unpackedAsarPath('app.asar/node_modules/x')).toBeNull();
      expect(unpackedAsarPath('')).toBeNull();
    });

    it('rewrites the LAST archive segment when a path contains more than one', async () => {
      const { unpackedAsarPath } = await import(LOADER_DIST);
      // Not a realistic layout, but it pins which occurrence wins: rewriting the first
      // would leave the second, still-inside-the-archive segment in the path.
      expect(unpackedAsarPath('/a/app.asar/b/app.asar/node_modules/x')).toBe(
        '/a/app.asar/b/app.asar.unpacked/node_modules/x',
      );
    });
  });

  describe('the binary it resolves is executable', () => {
    it('finds a real, executable esbuild binary for this platform', () => {
      // If this throws, the fix cannot work here and the reason must be the missing
      // binary — not a confusing spawn error three layers down.
      const binary = require_.resolve(`${PLATFORM_PKG}/bin/esbuild`);
      expect(existsSync(binary), `esbuild binary missing at ${binary}`).toBe(true);
      // A real ELF binary: the property `spawn` needs, and the reason the packaged
      // failure was ENOTDIR rather than a module-resolution failure.
      expect(readFileSync(binary).subarray(0, 4).toString('binary')).toBe('\u007fELF');
    });
  });

  describe('every build() call site applies the fix', () => {
    const source = readFileSync(SOURCE, 'utf-8');

    it('guards each esbuild build() call', () => {
      // Two today: bundleEntry (node platform) and bundlePrefabsForBrowser (browser
      // platform). A third added later without the guard would reintroduce the
      // packaged-only failure this file documents, so the count is pinned rather than
      // assumed.
      const buildCalls = [...source.matchAll(/await build\(\{/g)];
      expect(buildCalls.length).toBe(2);

      // Counting the guard alone would pass with both calls unguarded, so each call is
      // checked for a guard between its enclosing `try {` and the call itself.
      for (const call of buildCalls) {
        const before = source.slice(0, call.index);
        const tryStart = before.lastIndexOf('try {');
        expect(tryStart, 'an esbuild build() call is not inside a try block').toBeGreaterThan(
          -1,
        );
        const region = source.slice(tryStart, call.index);
        expect(
          region,
          'an esbuild build() call is not preceded by ensureEsbuildBinaryIsExecutable()',
        ).toContain('ensureEsbuildBinaryIsExecutable();');
      }
    });

    it('resolves the platform package for the running machine, not a hardcoded one', () => {
      // A literal `linux-x64` would silently produce a wrong-but-resolvable path on
      // another platform, and this packaged-only failure would return there first.
      expect(source).toContain('`@esbuild/${process.platform}-${process.arch}/bin/esbuild`');
    });
  });

  describe('the fix does not leak in the dev tree', () => {
    it('forces no binary path when there is no archive', async () => {
      const { forcedEsbuildBinaryPath } = await import(LOADER_DIST);
      // Nothing set it in this process: the dev tree has no `.asar` segment, so the
      // helper returns early and ESBUILD_BINARY_PATH stays unset for later esbuild calls.
      expect(forcedEsbuildBinaryPath()).toBeNull();
    });
  });

  it('points at the end-to-end check that does reach a packaged tree', () => {
    // A pointer, not a gate. `npm run smoke:package` is the check that fails on the
    // broken package and passes on the fixed one; it needs a built AppImage, so it cannot
    // be part of the unit suite. Recording that here stops the next reader assuming this
    // file covers it — or that `verify` does.
    const script = join(REPO_ROOT, 'scripts', 'smoke-package.mjs');
    expect(existsSync(script), `${script} is missing`).toBe(true);
    const text = readFileSync(script, 'utf-8');
    // The harness must key its allowed failure on the fixture's MESSAGE, not its name,
    // so a renamed fixture cannot turn a real failure into a silent pass.
    expect(text).toContain('EXPECTED_FAILURE_MESSAGE');
    expect(text).toContain('Corrupted GLTF buffer');
  });
});

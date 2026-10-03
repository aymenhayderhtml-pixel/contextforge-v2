/**
 * packages/app/test/standalone/tmp-import-probe.test.ts
 *
 * Proves the built `@contextforge/core` output is loadable by *absolute path*
 * from outside the package — which is what the Electron main process does when
 * it reaches into a project's real prefabs. A relative-path success would not
 * prove it, so the path here is absolute and derived from this file's own
 * location rather than hardcoded to one developer's machine.
 *
 * Requires `npm run typecheck` first: it imports from `core/dist`.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ENTRY = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'core',
  'dist',
  'scene',
  'sceneFile.js',
);

describe('absolute-path import probe', () => {
  it('loads core/dist by absolute file URL', async () => {
    expect(
      existsSync(ENTRY),
      `${ENTRY} is missing — run \`npm run typecheck\` to build core's dist.`,
    ).toBe(true);

    const m = await import(/* @vite-ignore */ pathToFileURL(ENTRY).href);
    expect(typeof m.validateScene).toBe('function');
  });
});
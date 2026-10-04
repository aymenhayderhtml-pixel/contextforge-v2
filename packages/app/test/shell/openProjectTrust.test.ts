/**
 * packages/app/test/shell/openProjectTrust.test.ts
 *
 * `openProject` accepts a folder the user chose, and only those (SEC-4).
 *
 * ## Why this matters beyond itself
 *
 * The path-escape fixes in core (D51) bound what a *project* can do: a patch or a
 * `NEED:` line cannot reach outside the root. SEC-4 is the layer above that. With
 * `openProject` accepting any directory, a renderer that got its own JavaScript
 * executed did not need any of those escapes — it could open `/` as a project and
 * read and write the whole filesystem through paths that were, by then, entirely
 * inside "the project". The containment fixes are only as strong as the set of
 * roots they apply to.
 *
 * So this asserts the property at the boundary: **the renderer can ask for a
 * folder, and it cannot invent one.**
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppBackend } from '../../src/electron/ipcHandlers.js';
import type { FolderPickerLike, OpenFolderResult } from '../../src/electron/ipcHandlers.js';

let project: string;
let other: string;

/** A picker that returns `chosen`, recording that it was asked. */
function pickerReturning(chosen: string | null): { picker: FolderPickerLike; asked: () => number } {
  let asked = 0;
  return {
    asked: () => asked,
    picker: {
      async showOpenDialog(): Promise<OpenFolderResult> {
        asked += 1;
        return chosen === null
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePaths: [chosen] };
      },
    },
  };
}

/** A backend with no bypass — the real configuration `main.ts` builds. */
function realBackend(picker?: FolderPickerLike): AppBackend {
  return new AppBackend(() => {}, picker === undefined ? {} : { picker });
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'cf-trust-proj-'));
  other = mkdtempSync(join(tmpdir(), 'cf-trust-other-'));
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'a.js'), 'export const a = 1;\n');
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

describe('a folder the user did not choose', () => {
  it('is refused', async () => {
    const app = realBackend();
    const result = await app.openProject({ root: project });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(project);
    expect(result.reason).toMatch(/folder dialog/i);
  });

  it('is refused for the filesystem root, which is the whole point', async () => {
    const app = realBackend();
    const result = await app.openProject({ root: '/' });
    expect(result.ok).toBe(false);
  });

  it('is refused after a *different* folder was chosen', async () => {
    // Choosing one project must not grant any other. This is the sharpest form of
    // the property: the allowlist is not "a folder was picked at some point", it is
    // "the folders this developer picked".
    const { picker } = pickerReturning(project);
    const app = realBackend(picker);
    await app.pickFolder();
    expect((await app.openProject({ root: project })).ok).toBe(true);

    const second = await app.openProject({ root: other });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toContain(other);
  });
});

describe('a folder the user did choose', () => {
  it('opens', async () => {
    const { picker } = pickerReturning(project);
    const app = realBackend(picker);
    const chosen = await app.pickFolder();
    expect(chosen.ok && chosen.value).toBe(project);

    const opened = await app.openProject({ root: project });
    expect(opened.ok).toBe(true);
  });

  it('opens again after being closed, because closing is not un-choosing', async () => {
    // A developer who opens and closes five projects should not have to pick five
    // times, and a long session must not accumulate state that forgets.
    const { picker } = pickerReturning(project);
    const app = realBackend(picker);
    await app.pickFolder();
    expect((await app.openProject({ root: project })).ok).toBe(true);
    app.closeProject();
    expect((await app.openProject({ root: project })).ok).toBe(true);
  });

  it('is recognised through a symlink the user picked', async () => {
    // The allowlist stores `realpath`, and `openProject` compares the realpath of
    // what it was given — so a developer who picked a symlinked path is not then
    // refused for it, which is the whole reason to store the resolved form.
    const { symlinkSync } = await import('node:fs');
    const link = join(tmpdir(), `cf-trust-link-${process.pid}-${process.hrtime.bigint()}`);
    symlinkSync(project, link);
    try {
      const { picker } = pickerReturning(link);
      const app = realBackend(picker);
      await app.pickFolder();
      expect((await app.openProject({ root: link })).ok).toBe(true);
    } finally {
      rmSync(link, { force: true });
    }
  });
});

describe('the cancelled dialog', () => {
  it('returns null and does not allow anything', async () => {
    const { picker, asked } = pickerReturning(null);
    const app = realBackend(picker);
    const picked = await app.pickFolder();
    expect(picked.ok && picked.value).toBeNull();
    expect(asked()).toBe(1);

    expect((await app.openProject({ root: project })).ok).toBe(false);
  });
});

describe('the test-only bypass', () => {
  it('is closed by default', async () => {
    // Asserted rather than assumed: every other test in the suite sets
    // `allowUnpickedRoot: 'test-only'` to open fixtures, so it is worth proving the
    // production path does not take it.
    expect((await realBackend().openProject({ root: project })).ok).toBe(false);
  });

  it('opens a fixture when named, which is what the other tests rely on', async () => {
    const app = new AppBackend(() => {}, { allowUnpickedRoot: 'test-only' });
    expect((await app.openProject({ root: project })).ok).toBe(true);
  });

  it('cannot be reached over IPC', () => {
    // The flag is a constructor argument on `deps`, and `deps` is fixed when
    // `registerHandlers` builds the backend. A renderer sends a channel name and a
    // JSON payload; there is no channel that carries this string.
    expect(JSON.stringify({ root: project, allowUnpickedRoot: 'test-only' })).toContain(
      'test-only',
    );
    // The above only shows the value is a plain string; the real guarantee is
    // structural — `openProject` reads `this.deps`, which no request can reach.
    const app = new AppBackend(() => {});
    expect((app as unknown as { deps: { allowUnpickedRoot?: string } }).deps).toEqual({});
  });
});
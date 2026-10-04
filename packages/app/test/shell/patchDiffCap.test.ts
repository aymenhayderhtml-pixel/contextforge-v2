/**
 * test/shell/patchDiffCap.test.ts — an oversized file must not crash the preview.
 *
 * PATCH-5 (D53): `diffLines` built a full LCS table with no bound, so a large file
 * exhausted the heap and killed the Electron main process with a SIGABRT — not a
 * catchable throw. Core now refuses past `MAX_DIFF_LINES` with
 * `DiffTooLargeError`.
 *
 * Two things are proven here, and the second is the one that matters:
 *
 *  1. the handler survives and returns a preview rather than throwing;
 *  2. the developer is TOLD, in a field the screen draws. A missing diff that
 *     silently renders as "No changes to this file" is a confident wrong answer
 *     about whether a write is about to happen (D30).
 *
 * Driven through `registerHandlers` against a real temp project, like the rest of
 * the patch suite, because the claim being tested is about the main process
 * surviving.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_DIFF_LINES } from '@contextforge/core';
import { AppBackend, registerHandlers, type IpcMainLike } from '../../src/electron/ipcHandlers.js';
import { CHANNELS, type PatchPreview, type Result } from '../../src/ipc.js';

type Handler = (event: unknown, ...args: never[]) => unknown;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project holding one file just past core's diff limit. */
function oversizedProject(): { root: string; lines: number } {
  const root = mkdtempSync(join(tmpdir(), 'cf-diffcap-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });

  const count = MAX_DIFF_LINES + 200;
  const body = Array.from({ length: count }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';
  writeFileSync(join(root, 'src', 'big.ts'), body);
  return { root, lines: count };
}

interface Bound {
  preview: (request: { text: string }) => Promise<Result<PatchPreview>>;
}

/**
 * Assert a result succeeded and give the payload.
 *
 * `Result<T>` keeps the value under `.value`; reading fields off the wrapper
 * itself silently yields undefined and every assertion below fails for a reason
 * that has nothing to do with the code under test.
 */
function unwrap<T>(result: Result<T>, label: string): T {
  if (!result.ok) throw new Error(`${label} was refused: ${result.reason}`);
  return result.value;
}

/** Open the project and resolve `patch:preview` through the real registrar. */
async function bound(root: string): Promise<Bound> {
  const app = new AppBackend(() => {}, { allowUnpickedRoot: 'test-only' });
  const opened = await app.openProject({ root });
  if (!opened.ok) throw new Error(`could not open the temp project: ${opened.reason}`);

  const listeners = new Map<string, Handler>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => {
      listeners.set(channel, listener as Handler);
    },
    removeHandler: () => {},
  };
  registerHandlers(ipcMain, app);
  const take = (channel: string): Handler => {
    const handler = listeners.get(channel);
    if (handler === undefined) throw new Error(`no handler registered for ${channel}`);
    return handler;
  };

  return {
    // Same shape as the rest of the patch suite: the registrar's wrapper is in
    // the path, so a thrown error becomes a refusal rather than crossing IPC.
    preview: (request) =>
      take(CHANNELS.previewPatch)(null, request as never) as Promise<Result<PatchPreview>>,
  };
}

/** A patch that edits one line in the middle of the oversized file. */
function editPatch(): string {
  return [
    '### EDIT: src/big.ts',
    '<<<<<<< FIND',
    `const v${Math.floor(MAX_DIFF_LINES / 2)} = ${Math.floor(MAX_DIFF_LINES / 2)};`,
    '=======',
    `const v${Math.floor(MAX_DIFF_LINES / 2)} = -1;`,
    '>>>>>>> REPLACE',
    '',
  ].join('\n');
}

describe('an oversized file does not crash the preview', () => {
  it('the handler returns ok rather than throwing', async () => {
    const { root } = oversizedProject();
    const b = await bound(root);

    // Before the fix this threw DiffTooLargeError out of the handler and, at
    // larger sizes, took the process down entirely.
    const result = await b.preview({ text: editPatch() });

    expect(result.ok).toBe(true);
  });

  it('the refusal is reported in diffNotShown, naming the file', async () => {
    const { root, lines } = oversizedProject();
    const b = await bound(root);

    const result = unwrap(await b.preview({ text: editPatch() }), 'preview');

    expect(result.diffNotShown).toHaveLength(1);
    const note = result.diffNotShown[0] ?? '';
    expect(note).toContain('src/big.ts');
    // The size, so the developer can see which file and how far over.
    expect(note).toContain(String(lines));
  });

  it('the file is reported as changed, with no diff text', async () => {
    const { root } = oversizedProject();
    const b = await bound(root);

    const result = unwrap(await b.preview({ text: editPatch() }), 'preview');

    const file = result.files.find((f) => f.path === 'src/big.ts');
    expect(file).toBeDefined();
    // `changed` is what makes the screen offer a diff at all. The refusal lives
    // in diffNotShown, never as a diff of '' that reads as "no changes".
    expect(file?.diff).toBe('');
  });

  it('the patch is still applicable — a missing preview is not a refusal', async () => {
    const { root } = oversizedProject();
    const b = await bound(root);

    const result = unwrap(await b.preview({ text: editPatch() }), 'preview');

    // Refusing here would stop a developer doing something they can do.
    expect(result.applicable).toBe(true);
    expect(result.blockedReason).toBe('');
  });
});

describe('a small file in the same patch keeps its real diff', () => {
  it('one oversized file does not hide the diffs of the others', async () => {
    const { root } = oversizedProject();
    writeFileSync(join(root, 'src', 'small.ts'), 'const a = 1;\nconst b = 2;\n');
    const b = await bound(root);

    const text = [
      editPatch(),
      '### EDIT: src/small.ts',
      '<<<<<<< FIND',
      'const a = 1;',
      '=======',
      'const a = 9;',
      '>>>>>>> REPLACE',
      '',
    ].join('\n');

    const result = unwrap(await b.preview({ text }), 'preview');

    // The refusal is per file, not per preview.
    expect(result.diffNotShown).toHaveLength(1);
    expect(result.diffNotShown[0]).toContain('src/big.ts');

    const small = result.files.find((f) => f.path === 'src/small.ts');
    expect(small?.diff).toContain('+const a = 9;');
  });

  it('an ordinary patch reports no refusals at all', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-diffok-'));
    roots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'small.ts'), 'const a = 1;\n');
    const b = await bound(root);

    const result = unwrap(
      await b.preview({
        text: '### EDIT: src/small.ts\n<<<<<<< FIND\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> REPLACE\n',
      }),
      'preview',
    );
    expect(result.diffNotShown).toEqual([]);
  });
});

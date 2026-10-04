/**
 * test/shell/patchDrift.test.ts — the whole path from a pasted reply to bytes
 * on disk, for the patches an AI actually writes.
 *
 * ## Why this file exists separately from patchScreen.test.ts
 *
 * That suite pins the channels, the reason strings and the all-or-nothing
 * write. This one pins a single property across the **whole** path — preview,
 * apply, and the file on disk — for a patch whose FIND text does not match the
 * file byte for byte. The defect it guards (D52) lived in core's finder and was
 * invisible to every status-only assertion: `applyEditBlocks` returned
 * `success: true`, the pre-save syntax check called the result valid, and the
 * file on disk had two statements in it twice.
 *
 * So the load-bearing assertion in every test here is `readFileSync` on the
 * project directory afterwards. Not the result message — the bytes.
 *
 * ## What each case is
 *
 *  1. **Blank-line drift, end to end.** An ordinary top-level file, blank lines
 *     between statements, a FIND pasted without them. The result must be the
 *     file with the one line changed and **no duplicated tail**.
 *  2. **The negative direction.** The same drift with a body the file does not
 *     contain must be *refused*, and nothing written — a matcher that accepts
 *     everything would pass case 1 as well.
 *  3. **Preview and apply agree.** The preview the developer approves is the
 *     bytes that land. If they diverge, the Patch screen is a lie.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearHistory } from '@contextforge/core';
import { AppBackend, registerHandlers, type IpcMainLike } from '../../src/electron/ipcHandlers.js';
import {
  CHANNELS,
  type HistoryActionOutcome,
  type PatchApplyResult,
  type PatchPreview,
  type Result,
} from '../../src/ipc.js';

const temporaries: string[] = [];

afterEach(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tempProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'cf-drift-'));
  temporaries.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content, 'utf-8');
  }
  return root;
}

const read = (root: string, path: string): string => readFileSync(join(root, path), 'utf-8');

type Handler = (event: unknown, ...args: never[]) => unknown;

interface Bound {
  root: string;
  preview: (request: { text: string }) => Promise<Result<PatchPreview>>;
  apply: (request: { text: string; applyAnyway?: boolean }) => Promise<Result<PatchApplyResult>>;
  undo: () => Promise<Result<{ success: boolean; error?: string }>>;
}

async function bound(files: Record<string, string>): Promise<Bound> {
  const root = tempProject(files);
  clearHistory(root);

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
    root,
    preview: (request) =>
      take(CHANNELS.previewPatch)(null, request as never) as Promise<Result<PatchPreview>>,
    apply: (request) =>
      take(CHANNELS.applyPatch)(null, request as never) as Promise<Result<PatchApplyResult>>,
    // `HistoryActionOutcome`, not `{success}`. The handler answers with a snapshot
    // and the stack counters; a refusal comes back as `ok:false` and `ok()` below
    // throws with its sentence. Casting this to `{success}` is what made the first
    // draft of the undo test assert `undefined` and fail for the wrong reason.
    undo: () =>
      take(CHANNELS.undo)(null, {} as never) as Promise<Result<HistoryActionOutcome>>,
  };
}

function ok<T>(result: Result<T>, label: string): T {
  if (!result.ok) throw new Error(`${label} was refused: ${result.reason}`);
  return result.value;
}

/** How many times `needle` occurs in `text`. */
const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** An ordinary file: top-level statements, blank lines between them. */
const ORIGINAL = [
  'const config = load();',
  '',
  'const engine = new Engine(config);',
  '',
  'engine.start();',
  '',
  'engine.tick();',
  '',
  'engine.stop();',
  '',
].join('\n');

/** The same statements as an AI quotes them back: no blank lines. */
const FIND_WITHOUT_BLANKS = [
  'const config = load();',
  'const engine = new Engine(config);',
  'engine.start();',
  'engine.tick();',
  'engine.stop();',
].join('\n');

function driftedPatch(): string {
  return [
    '### EDIT: game.js',
    '<<<<<<< FIND',
    FIND_WITHOUT_BLANKS,
    '=======',
    FIND_WITHOUT_BLANKS.replace('engine.start();', 'engine.start({ autoplay: false });'),
    '>>>>>>> REPLACE',
  ].join('\n');
}

describe('a patch with blank-line drift leaves a clean file', () => {
  it('applies one change and duplicates nothing', async () => {
    const { root, apply } = await bound({ 'game.js': ORIGINAL });

    const applied = ok(await apply({ text: driftedPatch() }), 'apply');
    expect(applied.applied).toBe(1);
    expect(applied.files).toEqual(['game.js']);

    // THE assertion. Every statement appears exactly once. Before the span fix
    // this file grew by two statements, so `engine.tick()` and `engine.stop()`
    // ran twice on every start — and every gate had reported success.
    const after = read(root, 'game.js');
    expect(count(after, 'engine.start({ autoplay: false });')).toBe(1);
    expect(count(after, 'engine.tick();')).toBe(1);
    expect(count(after, 'engine.stop();')).toBe(1);
    expect(after.split('\n').filter((line) => line === 'engine.tick();')).toHaveLength(1);
    expect(after.split('\n').filter((line) => line === 'engine.stop();')).toHaveLength(1);

    // And the developer's blank-line spacing is untouched: the patch never
    // mentioned it, so the file keeps it.
    expect(after).toBe(ORIGINAL.replace('engine.start();', 'engine.start({ autoplay: false });'));
  });

  it('the preview shows exactly the bytes that land', async () => {
    const { root, preview, apply } = await bound({ 'game.js': ORIGINAL });

    const planned = ok(await preview({ text: driftedPatch() }), 'preview');
    expect(planned.applicable).toBe(true);
    expect(planned.blockedReason).toBe('');
    expect(planned.files).toHaveLength(1);
    const file = planned.files[0];
    expect(file?.path).toBe('game.js');
    // A non-empty diff is what the developer is approving. An empty one with
    // `applicable: true` is the CRLF no-op the audit found.
    expect(file?.diff).not.toBe('');

    ok(await apply({ text: driftedPatch() }), 'apply');

    // If these diverge the developer approved one thing and got another.
    const after = read(root, 'game.js');
    expect(count(after, 'engine.tick();')).toBe(1);
    expect(after).toContain('engine.start({ autoplay: false });');
  });

  it('the file is still valid JavaScript after the drift is patched', async () => {
    const { root, apply } = await bound({ 'game.js': ORIGINAL });
    ok(await apply({ text: driftedPatch() }), 'apply');

    // The pre-save check already ran and passed, but a duplicated tail is also
    // valid JavaScript — which is why the byte assertions above, and not this
    // one, are the ones that catch the defect.
    const { validateContentSyntax } = await import('@contextforge/core');
    expect(validateContentSyntax('game.js', read(root, 'game.js')).valid).toBe(true);
  });

  it('one Undo restores the file byte for byte', async () => {
    const { root, apply, undo } = await bound({ 'game.js': ORIGINAL });
    ok(await apply({ text: driftedPatch() }), 'apply');
    expect(read(root, 'game.js')).not.toBe(ORIGINAL);

    // `ok()` throws on a refusal, so reaching here IS the success assertion. The
    // outcome carries no `success` field.
    const undone = ok(await undo(), 'undo');
    expect(undone.paths).toContain('game.js');
    expect(undone.canRedo).toBe(true);

    // The developer's original file, exactly. Not "close to it".
    expect(read(root, 'game.js')).toBe(ORIGINAL);
  });
});

describe('the negative direction: drift alone is not enough to match', () => {
  it('refuses a block whose body the file does not contain, and writes nothing', async () => {
    const { root, apply } = await bound({ 'game.js': ORIGINAL });

    // Same shape, same declarations, a body the file has never seen. A matcher
    // loose enough to accept this would also accept anything, and case 1 above
    // would prove nothing.
    const find = [
      'const config = load();',
      'const engine = new Engine(config);',
      'engine.start({ autoplay: true, retries: 0 });',
      'engine.tick();',
      'engine.stop();',
    ].join('\n');

    const patch = [
      '### EDIT: game.js',
      '<<<<<<< FIND',
      find,
      '=======',
      find.replace('engine.tick();', 'engine.tick(16);'),
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = await apply({ text: patch });

    // A refusal crosses IPC as `ok: false` with the reason as a sentence. The
    // sentence names the block and says why — `could not be resolved` is the
    // wording the block resolver uses, and matching on a looser phrase than that
    // would let the test pass on a refusal that named nothing.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/could not be resolved/);
    expect(result.reason).toContain('game.js');

    // Not one byte changed. The developer's file is exactly what it was.
    expect(read(root, 'game.js')).toBe(ORIGINAL);
  });

  it('refuses an empty FIND, naming the block, and writes nothing', async () => {
    const { root, preview, apply } = await bound({ 'game.js': ORIGINAL });

    const patch = [
      '### EDIT: game.js',
      '<<<<<<< FIND',
      '',
      '=======',
      'INSERTED AT THE TOP',
      '>>>>>>> REPLACE',
    ].join('\n');

    // The preview is where the developer is told, so the sentence is asserted
    // there as well as on apply.
    const planned = ok(await preview({ text: patch }), 'preview');
    expect(planned.applicable).toBe(false);
    expect(planned.failedBlocks).toHaveLength(1);
    expect(planned.failedBlocks[0]?.reason).toMatch(/FIND is empty/);

    const result = await apply({ text: patch });
    expect(result.ok).toBe(false);

    // The prepend this used to perform.
    expect(read(root, 'game.js')).toBe(ORIGINAL);
  });

  it('refuses two blocks that contradict each other, and writes neither', async () => {
    const source = 'const a = 1;\nconst b = 2;\n';
    const { root, apply } = await bound({ 'a.js': source });

    const patch = [
      '### EDIT: a.js',
      '<<<<<<< FIND',
      'const a = 1;',
      '=======',
      'const a = 100;',
      '>>>>>>> REPLACE',
      '',
      '### EDIT: a.js',
      '<<<<<<< FIND',
      'const a = 1;',
      'const b = 2;',
      '=======',
      'const a = 1;',
      'const b = 200;',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = await apply({ text: patch });

    // All-or-nothing (D5): a patch that contradicts itself writes nothing at
    // all, rather than landing half of each block.
    expect(result.ok).toBe(false);
    expect(read(root, 'a.js')).toBe(source);
  });
});

describe('a CRLF project is patched in CRLF', () => {
  it('writes the change and keeps every line ending CRLF', async () => {
    const original = 'const a = 1;\r\nconst b = 2;\r\n';
    const { root, apply } = await bound({ 'win.js': original });

    const patch = [
      '### EDIT: win.js',
      '<<<<<<< FIND',
      'const a = 1;',
      'const b = 2;',
      '=======',
      'const a = 99;',
      'const b = 2;',
      '>>>>>>> REPLACE',
    ].join('\n');

    ok(await apply({ text: patch }), 'apply');

    const after = read(root, 'win.js');
    expect(after).toBe('const a = 99;\r\nconst b = 2;\r\n');
    // A mixed-ending file is a corrupted file, and no lone LF may survive.
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

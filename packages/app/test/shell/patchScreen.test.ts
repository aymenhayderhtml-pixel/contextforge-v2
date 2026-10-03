/**
 * test/shell/patchScreen.test.ts — the Patch screen, the three channels, and
 * what happens to a developer's bytes.
 *
 * ## What is proven here
 *
 * The three channels are driven through `registerHandlers` against a **real temp
 * project**, so every assertion about "nothing was written" is made by reading
 * the bytes on disk afterwards. Nothing here mocks the filesystem, because the
 * whole claim of this area is about what does and does not reach it.
 *
 * The cases that matter, in the order they appear below:
 *
 *  1. **A broken `### EDIT:` block.** Its FIND text is not in the file at all.
 *     The preview must name the file, the block number, and core's reason.
 *  2. **An ambiguous anchor.** The FIND text *is* in the file — three times.
 *     Core refuses to guess (D3) and the refusal must arrive with its match
 *     count intact, because "matched 3 times" is the whole instruction to the
 *     developer: ask the AI for more surrounding lines.
 *  3. **A multi-file patch.** One `### FILE:` plus an `### EDIT:` across three
 *     files. One Apply writes all three and records **exactly one** history
 *     step, and one Undo restores every file to its pre-patch bytes — including
 *     deleting the file the patch created.
 *
 * Plus the two properties that make the above trustworthy: a syntax error names
 * the file and the line, and **nothing at all** is written when any block fails.
 *
 * ## Why the exact reason strings are asserted
 *
 * `PatchPreview.failedBlocks[].reason` is documented as core's sentence, verbatim.
 * A paraphrase ("couldn't apply") is what this screen exists to eliminate, so
 * the literal strings are pinned here. If core ever rewords its refusal, this
 * test fails loudly and the screen's copy has to be re-checked against the new
 * wording — which is the point.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearHistory } from '@contextforge/core';
import { AppBackend, registerHandlers, type IpcMainLike } from '../../src/electron/ipcHandlers.js';
import {
  CHANNELS,
  type PatchApplyResult,
  type PatchHistoryEntry,
  type PatchPreview,
  type Result,
} from '../../src/ipc.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const temporaries: string[] = [];

afterEach(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A temp project, plus a read-back for asserting bytes.
 *
 * Every write in this file goes through this helper, so a test can never
 * accidentally address the real repository: the paths are all under a
 * `mkdtempSync` directory that is removed after each test.
 */
function tempProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'cf-patch-'));
  temporaries.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content, 'utf-8');
  }
  return root;
}

const read = (root: string, path: string): string => readFileSync(join(root, path), 'utf-8');

/** Core's exact refusal for a FIND text that is not in the file. */
const REASON_NOT_FOUND = 'could not find exact FIND text';

/** A registered handler, as the renderer would reach it. */
type Handler = (event: unknown, ...args: never[]) => unknown;

/**
 * Whether the registrar can be exercised yet.
 *
 * `registerHandlers` refuses to register **anything** unless every channel in
 * `CHANNELS` has a handler — it throws before the first `ipcMain.handle` — so a
 * test that goes through it is only runnable once the Brief area has landed its
 * two channels. That is a real ordering constraint between areas of this step,
 * not a defect in this one, so it is probed here rather than assumed.
 *
 * Every behavioural test below calls the backend methods directly, which is the
 * same code the registered closures delegate to; only the last describe block,
 * which asserts *registration*, is skipped while the registrar is unavailable.
 */
const REGISTRAR_READY: boolean = ((): boolean => {
  try {
    registerHandlers({ handle: () => {}, removeHandler: () => {} }, new AppBackend(() => {}));
    return true;
  } catch {
    return false;
  }
})();

interface Bound {
  app: AppBackend;
  root: string;
  preview: (request: { text: string }) => Promise<Result<PatchPreview>>;
  apply: (request: { text: string; applyAnyway?: boolean }) => Promise<Result<PatchApplyResult>>;
  history: () => Promise<Result<{ entries: PatchHistoryEntry[]; canUndo: boolean; canRedo: boolean }>>;
}

/**
 * Open a temp project and resolve the three patch channels.
 *
 * When the registrar is available the handlers are reached through it, so the
 * registrar's own guarantees are in the path: every channel bound, and a thrown
 * error becoming a refusal rather than an exception crossing IPC. When it is not
 * (see `REGISTRAR_READY`) the backend methods are called directly — the same code
 * those closures delegate to, minus the wrapper.
 */
async function bound(files: Record<string, string>): Promise<Bound> {
  const root = tempProject(files);
  // Core's history is a process-wide map keyed by project path, and the paths are
  // fresh per test — but clearing removes any doubt about ordering.
  clearHistory(root);

  const app = new AppBackend(() => {});
  const opened = await app.openProject({ root });
  if (!opened.ok) throw new Error(`could not open the temp project: ${opened.reason}`);

  if (!REGISTRAR_READY) {
    return {
      app,
      root,
      preview: (request) => Promise.resolve(app.previewPatch(request)),
      apply: (request) => Promise.resolve(app.applyPatch(request)),
      history: () => Promise.resolve(app.patchHistory()),
    };
  }

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
    app,
    root,
    preview: (request) => take(CHANNELS.previewPatch)(null, request as never) as Promise<Result<PatchPreview>>,
    apply: (request) =>
      take(CHANNELS.applyPatch)(null, request as never) as Promise<Result<PatchApplyResult>>,
    history: () => take(CHANNELS.patchHistory)(null, {} as never) as never,
  };
}

/** Assert a result succeeded and give the value. */
function ok<T>(result: Result<T>, label: string): T {
  if (!result.ok) throw new Error(`${label} was refused: ${result.reason}`);
  return result.value;
}

// ── The fixtures the AI replies are aimed at ────────────────────────────────

/**
 * A project with one file holding a snippet that occurs **three times**.
 *
 * That repetition is deliberate and is the whole of the ambiguity test: the same
 * call appears in three classes, so core's finder matches it three times and
 * refuses (D3) rather than picking the first.
 */
function ambiguousProject(): Record<string, string> {
  return {
    'src/player.js': [
      'export class Player {',
      '  update(dt) {',
      '    const speed = 5;',
      '    this.position += speed * dt;',
      '  }',
      '  render() {',
      '    const speed = 5;',
      '    this.draw(speed);',
      '  }',
      '  reset() {',
      '    const speed = 5;',
      '    this.position = 0;',
      '  }',
      '}',
      '',
    ].join('\n'),
    'src/enemy.js': ['export class Enemy {', '  update(dt) {', '    this.step(dt);', '  }', '}', ''].join('\n'),
  };
}

/** A `### EDIT:` block aimed at a snippet that is not in the file. */
function missingAnchorReply(): string {
  return [
    'Here is the fix.',
    '',
    '### EDIT: src/enemy.js',
    '<<<<<<< FIND',
    'this.step(dt);',
    'this.charge(dt * 2);',
    '=======',
    'this.step(dt);',
    'this.charge(dt * 2);',
    '>>>>>>> REPLACE',
    '',
  ].join('\n');
}

/** A `### EDIT:` block whose FIND text appears three times. */
function ambiguousReply(): string {
  return [
    'Sure — bumping the speed.',
    '',
    '### EDIT: src/player.js',
    '<<<<<<< FIND',
    'const speed = 5;',
    '=======',
    'const speed = 25;',
    '>>>>>>> REPLACE',
    '',
  ].join('\n');
}

/** The ambiguous fixture's bytes before any patch, for the undo assertions. */
function prePatch(root: string): Record<string, string | null> {
  return {
    'src/player.js': read(root, 'src/player.js'),
    'src/enemy.js': read(root, 'src/enemy.js'),
    'src/spawn.js': existsSync(join(root, 'src/spawn.js')) ? read(root, 'src/spawn.js') : null,
  };
}

// ── 1. A broken block ───────────────────────────────────────────────────────

describe('patch:preview — a broken EDIT block', () => {
  it('names the file, the block index, and core’s reason', async () => {
    const b = await bound(ambiguousProject());

    const preview = ok(await b.preview({ text: missingAnchorReply() }), 'preview');

    expect(preview.failedBlocks).toHaveLength(1);
    const failure = preview.failedBlocks[0];
    expect(failure?.path).toBe('src/enemy.js');
    // 1-based, because core numbers blocks that way and the developer counts
    // blocks by hand.
    expect(failure?.index).toBe(1);
    expect(failure?.find).toContain('this.step(dt);');
    // Verbatim. This is the string the screen renders, and it is the difference
    // between "the AI forgot a line" and "we do not know which lines you meant".
    expect(failure?.reason).toBe(REASON_NOT_FOUND);
  });

  it('is not applicable, so Apply stays disabled', async () => {
    const b = await bound(ambiguousProject());

    const preview = ok(await b.preview({ text: missingAnchorReply() }), 'preview');

    expect(preview.applicable).toBe(false);
    expect(preview.blockedReason).toContain('src/enemy.js');
    expect(preview.blockedReason).toContain('edit block 1');
    expect(preview.blockedReason).toContain(REASON_NOT_FOUND);
  });

  it('refuses to write, and the block did not even name a file the patch changes', async () => {
    const b = await bound(ambiguousProject());
    const before = read(b.root, 'src/enemy.js');

    const applied = await b.apply({ text: missingAnchorReply() });

    expect(applied.ok).toBe(false);
    // Bytes, not a return value: the claim is about the disk.
    expect(read(b.root, 'src/enemy.js')).toBe(before);
  });
});

// ── 2. A missing anchor (ambiguous) ─────────────────────────────────────────

describe('patch:preview — an ambiguous FIND is refused, not guessed', () => {
  it('surfaces the refusal with its match count intact', async () => {
    const b = await bound(ambiguousProject());

    const preview = ok(await b.preview({ text: ambiguousReply() }), 'preview');

    expect(preview.failedBlocks).toHaveLength(1);
    const failure = preview.failedBlocks[0];
    expect(failure?.path).toBe('src/player.js');
    expect(failure?.index).toBe(1);
    // The count is the instruction. Without it, "ambiguous" is a dead end; with
    // it, the developer can say "that line appears three times, here is more
    // context" and get a patch that applies.
    expect(failure?.reason).toBe('matched 3 times');
    expect(preview.applicable).toBe(false);
  });

  it('does not quietly patch the first of the three matches', async () => {
    const b = await bound(ambiguousProject());
    const before = read(b.root, 'src/player.js');

    await b.apply({ text: ambiguousReply() });

    // The failure mode D3 exists to prevent: core picking one of five identical
    // snippets and the developer finding out when the game misbehaves.
    expect(read(b.root, 'src/player.js')).toBe(before);
  });

  it('cannot be overridden — applyAnyway is for the syntax gate, not for a guess', async () => {
    const b = await bound(ambiguousProject());
    const before = read(b.root, 'src/player.js');

    const applied = await b.apply({ text: ambiguousReply(), applyAnyway: true });

    expect(applied.ok).toBe(false);
    expect(read(b.root, 'src/player.js')).toBe(before);

    const preview = ok(await b.preview({ text: ambiguousReply() }), 'preview');
    expect(preview.canApplyAnyway).toBe(false);
  });
});

// ── 3. A multi-file patch ───────────────────────────────────────────────────

describe('patch:apply — a multi-file patch is one transaction', () => {
  const reply = [
    'I added a new module and retuned the two that use it.',
    '',
    '### FILE: src/spawn.js',
    '```js',
    'export function spawn() {',
    '  return { kind: "crate" };',
    '}',
    '```',
    '',
    '### EDIT: src/player.js',
    '<<<<<<< FIND',
    '    const speed = 5;',
    '    this.position += speed * dt;',
    '=======',
    '    const speed = 12;',
    '    this.position += speed * dt;',
    '>>>>>>> REPLACE',
    '',
    '### EDIT: src/enemy.js',
    '<<<<<<< FIND',
    '    this.step(dt);',
    '=======',
    '    this.step(dt * 1.5);',
    '>>>>>>> REPLACE',
    '',
  ].join('\n');

  /** The fixture's bytes before the patch, for the undo assertion. */
  function prePatch(root: string): Record<string, string | null> {
    return {
      'src/player.js': read(root, 'src/player.js'),
      'src/enemy.js': read(root, 'src/enemy.js'),
      'src/spawn.js': existsSync(join(root, 'src/spawn.js')) ? read(root, 'src/spawn.js') : null,
    };
  }

  it('previews a diff per file and marks the created one', async () => {
    const b = await bound(ambiguousProject());

    const preview = ok(await b.preview({ text: reply }), 'preview');

    expect(preview.blockCount).toBe(3);
    expect(preview.files.map((f) => f.path).sort()).toEqual([
      'src/enemy.js',
      'src/player.js',
      'src/spawn.js',
    ]);
    const spawn = preview.files.find((f) => f.path === 'src/spawn.js');
    expect(spawn?.created).toBe(true);
    expect(spawn?.diff).toContain('+export function spawn()');
    // A diff against the file on disk *now*, not against a cached copy.
    const player = preview.files.find((f) => f.path === 'src/player.js');
    expect(player?.diff).toContain('-    const speed = 5;');
    expect(player?.diff).toContain('+    const speed = 12;');
    expect(preview.applicable).toBe(true);
    expect(preview.files.every((f) => f.syntax.valid)).toBe(true);
  });

  it('writes every file and records exactly one history step', async () => {
    const b = await bound(ambiguousProject());

    const applied = ok(await b.apply({ text: reply }), 'apply');

    expect(applied.files.sort()).toEqual(['src/enemy.js', 'src/player.js', 'src/spawn.js']);
    expect(applied.created).toEqual(['src/spawn.js']);
    expect(applied.applied).toBe(2);
    expect(applied.undoCount).toBe(1);

    expect(read(b.root, 'src/player.js')).toContain('const speed = 12;');
    expect(read(b.root, 'src/enemy.js')).toContain('this.step(dt * 1.5);');
    expect(read(b.root, 'src/spawn.js')).toContain('export function spawn()');

    // The assertion the whole area turns on: three files, one Undo.
    const history = ok(await b.history(), 'history');
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]?.patchId).toBe('PATCH #001');
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
  });

  it('undoes every file in one step, including deleting the file it created', async () => {
    const b = await bound(ambiguousProject());
    const before = prePatch(b.root);

    ok(await b.apply({ text: reply }), 'apply');
    // Undo and redo live on the scene channels: one history per project, so the
    // Patch screen must not keep its own.
    const undone = await b.app.undo();
    expect(undone.ok).toBe(true);

    // Bytes, for every file the patch touched.
    expect(read(b.root, 'src/player.js')).toBe(before['src/player.js']);
    expect(read(b.root, 'src/enemy.js')).toBe(before['src/enemy.js']);
    // `before: null` means "did not exist", so undo removes it rather than
    // leaving a zero-length file behind.
    expect(existsSync(join(b.root, 'src/spawn.js'))).toBe(false);

    const history = ok(await b.history(), 'history');
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
  });

  it('redo restores the whole patch, and re-applying the same reply is a no-op', async () => {
    const b = await bound(ambiguousProject());

    ok(await b.apply({ text: reply }), 'apply');
    const applied = read(b.root, 'src/player.js');
    ok(await b.app.undo(), 'undo');
    ok(await b.app.redo(), 'redo');
    expect(read(b.root, 'src/player.js')).toBe(applied);

    // Pasting the same answer twice is the normal way this screen is used, and
    // it must report "already applied" rather than refusing.
    const second = await b.apply({ text: reply });
    expect(second.ok).toBe(false);
    const preview = ok(await b.preview({ text: reply }), 'preview');
    expect(preview.alreadyApplied).toBe(2);
    expect(preview.applicable).toBe(false);
    expect(preview.blockedReason).toContain('already present');
  });

  it('re-previewing after an Apply reports nothing left to change', async () => {
    const b = await bound(ambiguousProject());
    ok(await b.apply({ text: reply }), 'apply');

    const preview = ok(await b.preview({ text: reply }), 'preview');

    // Every diff is empty now, which is what "the patch landed" looks like from
    // this screen. The screen re-previews after every Apply, so this is the state
    // the developer will actually be looking at.
    expect(preview.files.every((file) => file.diff === '')).toBe(true);
    expect(preview.applicable).toBe(false);
  });
});

// ── The syntax gate ─────────────────────────────────────────────────────────

describe('patch:apply — a syntax error names the file and the line', () => {
  const brokenJs = [
    '### FILE: src/broken.js',
    '```js',
    'export function go() {',
    '  return 1;',
    '```',
    '',
  ].join('\n');

  it('reports the file and the line, and offers the override', async () => {
    const b = await bound(ambiguousProject());

    const preview = ok(await b.preview({ text: brokenJs }), 'preview');

    const file = preview.files[0];
    expect(file?.path).toBe('src/broken.js');
    expect(file?.syntax.valid).toBe(false);
    expect(file?.syntaxFailed).toBe(true);
    // Tree-sitter's first ERROR node sits on the unclosed brace — line 2, where
    // the function's body was opened — not on line 3, which is inside it. The
    // exact number is core's, and asserting it pins the line the screen shows
    // rather than accepting any number.
    expect(file?.syntax.line).toBe(2);
    expect(file?.syntax.message).toContain('syntax error');
    expect(preview.applicable).toBe(false);
    expect(preview.canApplyAnyway).toBe(true);
    expect(preview.blockedReason).toContain('src/broken.js');
    expect(preview.blockedReason).toContain('line 2');
  });

  it('writes nothing without the explicit override', async () => {
    const b = await bound(ambiguousProject());

    const applied = await b.apply({ text: brokenJs });

    expect(applied.ok).toBe(false);
    expect(existsSync(join(b.root, 'src/broken.js'))).toBe(false);
  });

  it('writes it when the override is asked for, which is never the default', async () => {
    const b = await bound(ambiguousProject());

    const applied = ok(await b.apply({ text: brokenJs, applyAnyway: true }), 'apply anyway');

    expect(applied.files).toEqual(['src/broken.js']);
    expect(read(b.root, 'src/broken.js')).toContain('export function go()');
    // And it is one undoable step like any other patch.
    expect(ok(await b.history(), 'history').entries).toHaveLength(1);
  });
});

// ── Nothing is written when any block fails ──────────────────────────────────

describe('all-or-nothing (D5)', () => {
  it('leaves every file byte-identical when one block of a multi-file patch fails', async () => {
    const b = await bound(ambiguousProject());
    const before = prePatch(b.root);

    // Two good blocks and one that cannot resolve. Core must refuse the whole
    // thing: a developer who sees two files change and no third has no way to
    // know which half of the AI's answer landed.
    const partial = [
      '### FILE: src/spawn.js',
      '```js',
      'export function spawn() {',
      '  return 1;',
      '}',
      '```',
      '',
      '### EDIT: src/player.js',
      '<<<<<<< FIND',
      '    const speed = 5;',
      '    this.position += speed * dt;',
      '=======',
      '    const speed = 12;',
      '    this.position += speed * dt;',
      '>>>>>>> REPLACE',
      '',
      '### EDIT: src/enemy.js',
      '<<<<<<< FIND',
      'this.teleport(dt);',
      '=======',
      'this.teleport(dt * 2);',
      '>>>>>>> REPLACE',
      '',
    ].join('\n');

    const applied = await b.apply({ text: partial });

    expect(applied.ok).toBe(false);
    expect(read(b.root, 'src/player.js')).toBe(before['src/player.js']);
    expect(read(b.root, 'src/enemy.js')).toBe(before['src/enemy.js']);
    // The file that *would* have been created does not exist. A half-applied
    // patch that leaves a new file behind is exactly the state a developer
    // cannot reason about.
    expect(existsSync(join(b.root, 'src/spawn.js'))).toBe(false);
    // And no undo step that would appear to do nothing.
    expect(ok(await b.history(), 'history').entries).toHaveLength(0);
  });

  it('refuses a path that climbs out of the project, and writes nothing', async () => {
    const b = await bound(ambiguousProject());

    const escape = [
      '### FILE: ../../../etc/cron.d/pwn',
      '```sh',
      '* * * * * root echo hi',
      '```',
      '',
    ].join('\n');

    const applied = await b.apply({ text: escape });

    // Refused, not sanitised: rewriting the path would write a file the AI did
    // not name, which is worse than saying no (SPEC R3).
    expect(applied.ok).toBe(false);
    if (applied.ok) throw new Error('expected a refusal');
    expect(applied.reason).toContain('Invalid file path in patch');
    expect(existsSync(join(b.root, 'src/spawn.js'))).toBe(false);
  });

  it('refuses a reply with no patch blocks, saying what it expected', async () => {
    const b = await bound(ambiguousProject());

    const applied = await b.apply({ text: 'Sure! I changed the player speed for you.' });

    expect(applied.ok).toBe(false);
    if (applied.ok) throw new Error('expected a refusal');
    expect(applied.reason).toContain('### FILE:');
    expect(applied.reason).toContain('### EDIT:');
    expect(applied.reason.endsWith('.')).toBe(true);
  });

  it('refuses everything, including a preview, when no project is open', async () => {
    const app = new AppBackend(() => {});

    const preview = await app.previewPatch({ text: '### FILE: a.js\n```\n1;\n```\n' });
    const applied = await app.applyPatch({ text: '### FILE: a.js\n```\n1;\n```\n' });
    const history = app.patchHistory();

    for (const result of [preview, applied, history]) expect(result.ok).toBe(false);
    if (preview.ok) throw new Error('expected a refusal');
    expect(preview.reason).toContain('No project is open');
  });
});

// ── The history channel ─────────────────────────────────────────────────────

describe('patch:history', () => {
  it('is empty for a project nothing has been applied to', async () => {
    const b = await bound(ambiguousProject());

    const history = ok(await b.history(), 'history');

    expect(history.entries).toEqual([]);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });

  it('lists the steps newest first, with the files each one touched', async () => {
    const b = await bound(ambiguousProject());
    const first = ok(
      await b.apply({
        text: '### EDIT: src/enemy.js\n<<<<<<< FIND\n    this.step(dt);\n=======\n    this.step(dt * 2);\n>>>>>>> REPLACE\n',
      }),
      'apply 1',
    );
    const second = ok(
      await b.apply({
        text: '### EDIT: src/enemy.js\n<<<<<<< FIND\n    this.step(dt * 2);\n=======\n    this.step(dt * 3);\n>>>>>>> REPLACE\n',
      }),
      'apply 2',
    );

    const history = ok(await b.history(), 'history');

    expect(history.entries.map((e) => e.patchId)).toEqual([second.patchId, first.patchId]);
    expect(history.entries[0]?.files).toEqual(['src/enemy.js']);
    expect(history.entries[0]?.description).toContain('src/enemy.js');
    expect(history.canUndo).toBe(true);
  });
});

// ── Registration ────────────────────────────────────────────────────────────

describe.skipIf(!REGISTRAR_READY)('registration of the three patch channels', () => {
  it('binds each one under its own name in CHANNELS', () => {
    const listeners = new Map<string, Handler>();
    registerHandlers(
      {
        handle: (channel, listener) => {
          listeners.set(channel, listener as Handler);
        },
        removeHandler: () => {},
      },
      new AppBackend(() => {}),
    );

    // Not asserted by name alone: a handler bound to the wrong channel is a UI
    // that waits forever, and `registerHandlers` throwing on a channel nobody
    // declared is the other half of the same check.
    expect(listeners.get(CHANNELS.previewPatch)).toBeTypeOf('function');
    expect(listeners.get(CHANNELS.applyPatch)).toBeTypeOf('function');
    expect(listeners.get(CHANNELS.patchHistory)).toBeTypeOf('function');
  });

  it('turns a synchronous throw in a handler into a refusal, not an exception', async () => {
    const b = await bound(ambiguousProject());
    const listeners = new Map<string, Handler>();
    registerHandlers(
      {
        handle: (channel, listener) => {
          listeners.set(channel, listener as Handler);
        },
        removeHandler: () => {},
      },
      b.app,
    );

    const preview = listeners.get(CHANNELS.previewPatch);
    expect(preview).toBeTypeOf('function');
    // A non-string `text` reaches the handler from a renderer bug or a hostile
    // preload. It must arrive at the renderer as a sentence, not as a rejected
    // promise carrying a stack-trace message (SPEC R9).
    await expect(preview?.(null, { text: 42 } as never)).resolves.toMatchObject({ ok: false });
  });
});
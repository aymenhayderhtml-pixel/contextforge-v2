/**
 * Ported from v1 `server/history-test.js`.
 *
 * The HTTP-endpoint tests from v1 are not ported: they exercise an Express route,
 * which belongs to the app shell (Step 4), not to core. The behaviours they
 * covered — record/undo/redo, undoing a file creation, multi-file transactions,
 * the 20-step cap — are covered here against the same functions directly.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_HISTORY_STEPS,
  captureAndWrite,
  clearHistory,
  getHistoryStatus,
  normalizeProjectPath,
  recordHistoryStep,
  redo,
  undo,
} from '../../src/history/history.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'cf-history-'));
  clearHistory(projectDir);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  clearHistory(projectDir);
});

describe('recordHistoryStep / undo / redo', () => {
  it('records a step, undoes it, and redoes it', () => {
    writeFileSync(join(projectDir, 'hello.txt'), 'initial content', 'utf-8');
    writeFileSync(join(projectDir, 'hello.txt'), 'modified content', 'utf-8');

    const step = recordHistoryStep(projectDir, 'Changed hello.txt', [
      { path: 'hello.txt', before: 'initial content', after: 'modified content' },
    ]);

    expect(step?.patchId).toBe('PATCH #001');

    let status = getHistoryStatus(projectDir);
    expect(status.canUndo).toBe(true);
    expect(status.canRedo).toBe(false);
    expect(status.undoCount).toBe(1);

    expect(undo(projectDir).success).toBe(true);
    expect(readFileSync(join(projectDir, 'hello.txt'), 'utf-8')).toBe('initial content');

    status = getHistoryStatus(projectDir);
    expect(status.canUndo).toBe(false);
    expect(status.canRedo).toBe(true);
    expect(status.redoCount).toBe(1);

    expect(redo(projectDir).success).toBe(true);
    expect(readFileSync(join(projectDir, 'hello.txt'), 'utf-8')).toBe('modified content');

    status = getHistoryStatus(projectDir);
    expect(status.canUndo).toBe(true);
    expect(status.canRedo).toBe(false);
  });

  it('undoes creation of a new file by deleting it, and redoes it by recreating it', () => {
    writeFileSync(join(projectDir, 'new-file.js'), 'console.log("hello");', 'utf-8');

    recordHistoryStep(projectDir, 'Created new-file.js', [
      { path: 'new-file.js', before: null, after: 'console.log("hello");' },
    ]);
    expect(existsSync(join(projectDir, 'new-file.js'))).toBe(true);

    undo(projectDir);
    expect(existsSync(join(projectDir, 'new-file.js'))).toBe(false);

    redo(projectDir);
    expect(existsSync(join(projectDir, 'new-file.js'))).toBe(true);
    expect(readFileSync(join(projectDir, 'new-file.js'), 'utf-8')).toBe('console.log("hello");');
  });

  it('undoes deletion of a file by restoring it', () => {
    writeFileSync(join(projectDir, 'gone.js'), 'original', 'utf-8');
    rmSync(join(projectDir, 'gone.js'));

    recordHistoryStep(projectDir, 'Deleted gone.js', [
      { path: 'gone.js', before: 'original', after: null },
    ]);

    expect(existsSync(join(projectDir, 'gone.js'))).toBe(false);
    undo(projectDir);
    expect(readFileSync(join(projectDir, 'gone.js'), 'utf-8')).toBe('original');
  });

  it('treats a multi-file change as one transaction', () => {
    writeFileSync(join(projectDir, 'a.js'), 'var a = 1;', 'utf-8');
    writeFileSync(join(projectDir, 'b.js'), 'var b = 2;', 'utf-8');
    writeFileSync(join(projectDir, 'a.js'), 'var a = 10;', 'utf-8');
    writeFileSync(join(projectDir, 'b.js'), 'var b = 20;', 'utf-8');

    const step = recordHistoryStep(projectDir, 'Updated 2 files', [
      { path: 'a.js', before: 'var a = 1;', after: 'var a = 10;' },
      { path: 'b.js', before: 'var b = 2;', after: 'var b = 20;' },
    ]);

    expect(step?.metadata['filesCount']).toBe(2);
    expect(step?.metadata['paths']).toEqual(['a.js', 'b.js']);

    // One undo restores both files.
    undo(projectDir);
    expect(readFileSync(join(projectDir, 'a.js'), 'utf-8')).toBe('var a = 1;');
    expect(readFileSync(join(projectDir, 'b.js'), 'utf-8')).toBe('var b = 2;');
    expect(getHistoryStatus(projectDir).undoCount).toBe(0);
  });

  it('caps the undo stack at 20 steps and drops the oldest', () => {
    for (let i = 1; i <= 25; i++) {
      recordHistoryStep(projectDir, `Step ${i}`, [
        { path: 'counter.txt', before: `val ${i - 1}`, after: `val ${i}` },
      ]);
    }
    const status = getHistoryStatus(projectDir);
    expect(status.undoCount).toBe(MAX_HISTORY_STEPS);
    // The oldest dropped step is "Step 1", so undoing 20 times exhausts the
    // stack; the 21st has nothing left.
    for (let i = 0; i < MAX_HISTORY_STEPS; i++) {
      expect(undo(projectDir).success).toBe(true);
    }
    expect(undo(projectDir).success).toBe(false);
  });

  it('reports "nothing to undo" on an empty history', () => {
    const result = undo(projectDir);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Nothing to undo');
  });

  it('reports "nothing to redo" when there is no redo branch', () => {
    const result = redo(projectDir);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Nothing to redo');
  });

  it('clears the redo branch when a new change is recorded', () => {
    recordHistoryStep(projectDir, 'First', [
      { path: 'a.txt', before: '1', after: '2' },
    ]);
    undo(projectDir);
    expect(getHistoryStatus(projectDir).canRedo).toBe(true);

    recordHistoryStep(projectDir, 'Second', [
      { path: 'a.txt', before: '1', after: '3' },
    ]);
    expect(getHistoryStatus(projectDir).canRedo).toBe(false);
  });

  it('records nothing when no file actually changed', () => {
    const step = recordHistoryStep(projectDir, 'No-op', [
      { path: 'a.txt', before: 'same', after: 'same' },
    ]);
    expect(step).toBeNull();
    expect(getHistoryStatus(projectDir).undoCount).toBe(0);
  });

  it('records nothing when given an empty file list', () => {
    expect(recordHistoryStep(projectDir, 'Nothing', [])).toBeNull();
  });

  it('keeps histories separate per project', () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'cf-history-other-'));
    try {
      recordHistoryStep(projectDir, 'A', [{ path: 'x.txt', before: '1', after: '2' }]);
      expect(getHistoryStatus(projectDir).undoCount).toBe(1);
      expect(getHistoryStatus(otherDir).undoCount).toBe(0);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('describes the next undo and redo', () => {
    recordHistoryStep(projectDir, 'Change speed', [
      { path: 'a.txt', before: '1', after: '2' },
    ]);
    const status = getHistoryStatus(projectDir);
    expect(status.nextUndoDesc).toBe('PATCH #001: Change speed');
    expect(status.nextRedoDesc).toBe('');
    expect(status.recentTransactions).toHaveLength(1);
  });
});

describe('captureAndWrite', () => {
  it('returns a change record and writes the files', () => {
    writeFileSync(join(projectDir, 'a.txt'), 'old', 'utf-8');

    const changes = captureAndWrite(projectDir, new Map([['a.txt', 'new']]));

    expect(changes).toEqual([{ path: 'a.txt', before: 'old', after: 'new' }]);
    expect(readFileSync(join(projectDir, 'a.txt'), 'utf-8')).toBe('new');
  });

  it('records before: null for a file that does not exist yet', () => {
    const changes = captureAndWrite(projectDir, new Map([['new.txt', 'content']]));
    expect(changes).toEqual([{ path: 'new.txt', before: null, after: 'content' }]);
    expect(readFileSync(join(projectDir, 'new.txt'), 'utf-8')).toBe('content');
  });

  it('omits files whose content is unchanged', () => {
    writeFileSync(join(projectDir, 'a.txt'), 'same', 'utf-8');
    const changes = captureAndWrite(projectDir, new Map([['a.txt', 'same']]));
    expect(changes).toEqual([]);
  });

  it('creates parent directories for a nested path', () => {
    const changes = captureAndWrite(projectDir, new Map([['deep/nested/a.txt', 'x']]));
    expect(changes).toHaveLength(1);
    expect(readFileSync(join(projectDir, 'deep/nested/a.txt'), 'utf-8')).toBe('x');
  });

  it('feeds directly into undo: capture, write, record, undo', () => {
    writeFileSync(join(projectDir, 'game.js'), 'speed = 5;\n', 'utf-8');

    const changes = captureAndWrite(projectDir, new Map([['game.js', 'speed = 25;\n']]));
    recordHistoryStep(projectDir, 'Change speed', changes);

    expect(readFileSync(join(projectDir, 'game.js'), 'utf-8')).toBe('speed = 25;\n');
    undo(projectDir);
    expect(readFileSync(join(projectDir, 'game.js'), 'utf-8')).toBe('speed = 5;\n');
  });
});

describe('normalizeProjectPath', () => {
  it('collapses equivalent spellings to one key', () => {
    expect(normalizeProjectPath('/tmp/proj')).toBe(normalizeProjectPath('/tmp/proj/'));
    expect(normalizeProjectPath('/tmp/./proj')).toBe(normalizeProjectPath('/tmp/proj'));
  });

  it('strips surrounding quotes a patch header may leave behind', () => {
    expect(normalizeProjectPath('"/tmp/proj"')).toBe('/tmp/proj');
    expect(normalizeProjectPath("'/tmp/proj'")).toBe('/tmp/proj');
  });

  it('returns empty for an empty input', () => {
    expect(normalizeProjectPath('')).toBe('');
    expect(normalizeProjectPath('   ')).toBe('');
  });

  it('makes undo work through a trailing slash', () => {
    mkdirSync(join(projectDir, 'sub'), { recursive: true });
    writeFileSync(join(projectDir, 'sub', 'a.txt'), '1', 'utf-8');

    recordHistoryStep(projectDir, 'X', [{ path: 'sub/a.txt', before: '1', after: '2' }]);
    const viaSlash = undo(`${projectDir}/`);
    expect(viaSlash.success).toBe(true);
  });
});

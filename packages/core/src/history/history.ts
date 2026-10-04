/**
 * history/history.ts — Transactional undo/redo, 20 steps deep.
 *
 * A patch that touches four files is **one** undo step, not four. The developer
 * thinks of it as one action ("apply the AI's answer"), and four separate
 * undos would leave them in a state they never asked for and could not reason
 * about. So a step records a set of file changes and moves through history as a
 * unit.
 *
 * Three details carry the weight:
 *
 *  - **`before: null` means "did not exist".** Undo deletes the file; redo
 *    recreates it with the recorded content. Creating a file and deleting it are
 *    the same edge case as editing one, and getting it wrong loses work.
 *  - **The cap is 20 and it drops the oldest.** Twenty is enough to walk back a
 *    long AI conversation and small enough that the in-memory snapshot cost
 *    stays trivial.
 *  - **A new change clears the redo branch.** Recording after an undo discards
 *    the redo stack, which is what every editor does and what prevents a redo
 *    from resurrecting state that no longer has a coherent history.
 *
 * History is in-memory and per project path. It is not persisted: undo is meant
 * to recover from the last few minutes of mistakes, and writing history to disk
 * would put a second copy of the user's source code on their disk.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveInsideRoot } from '../fs/resolveInsideRoot.js';

/** How many steps the undo stack holds. */
export const MAX_HISTORY_STEPS = 20;

/** One file's change within a transaction. */
export interface FileChange {
  /** Project-relative path. */
  path: string;
  /** Content before the transaction, or null if the file did not exist. */
  before: string | null;
  /** Content after the transaction, or null if the file was deleted. */
  after: string | null;
}

/** One undoable transaction. */
export interface HistoryStep {
  /** Monotonic id, unique within the history. */
  id: number;
  /** Human-facing label, e.g. "PATCH #003". */
  patchId: string;
  timestamp: number;
  description: string;
  files: FileChange[];
  metadata: Record<string, unknown>;
}

/** Extra data a caller can attach to a step. */
export interface HistoryMetadata {
  [key: string]: unknown;
}

/** The result of an undo or redo. */
export interface HistoryActionResult {
  success: boolean;
  error?: string;
  patchId?: string;
  description?: string;
  /** Files written or deleted by the action. */
  paths: string[];
  canUndo: boolean;
  canRedo: boolean;
  undoCount: number;
  redoCount: number;
}

/** A read-only view of the history. */
export interface HistoryStatus {
  canUndo: boolean;
  canRedo: boolean;
  undoCount: number;
  redoCount: number;
  /** e.g. "PATCH #004: Change player speed", or "" when there is nothing to undo. */
  nextUndoDesc: string;
  nextRedoDesc: string;
  /** The most recent few steps, newest last. */
  recentTransactions: Array<{
    patchId: string;
    description: string;
    files: string[];
    timestamp: number;
  }>;
}

interface History {
  undoStack: HistoryStep[];
  redoStack: HistoryStep[];
  patchCounter: number;
  nextId: number;
}

const histories = new Map<string, History>();

/**
 * Normalise a project path to the key histories are stored under.
 *
 * Resolving collapses `/a/b`, `/a/./b` and `/a/b/` to one key, so undo does not
 * silently do nothing because the caller passed a differently-spelled path.
 */
export function normalizeProjectPath(projectPath: string): string {
  if (typeof projectPath !== 'string') return '';
  let cleaned = projectPath.trim();

  // Models sometimes wrap the path in quotes inside a patch header.
  if (
    (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
    (cleaned.startsWith('"') && cleaned.endsWith('"'))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  return cleaned === '' ? '' : resolve(cleaned).replaceAll('\\', '/');
}

function getHistory(key: string): History | null {
  if (key === '') return null;
  let history = histories.get(key);
  if (!history) {
    history = { undoStack: [], redoStack: [], patchCounter: 0, nextId: 1 };
    histories.set(key, history);
  }
  return history;
}

/**
 * Record a transaction.
 *
 * Returns null when there is nothing to record: no files, or every file already
 * had the requested content. Recording a no-op step would let the developer
 * press undo and have nothing visibly happen, which erodes trust in the button.
 *
 * `now` is injected so tests get stable ids and timestamps (SPEC R8).
 */
export function recordHistoryStep(
  projectPath: string,
  description: string,
  files: readonly FileChange[],
  metadata: HistoryMetadata = {},
  now: number = Date.now(),
): HistoryStep | null {
  const key = normalizeProjectPath(projectPath);
  const history = getHistory(key);
  if (!history || files.length === 0) return null;

  const changed = files.filter((file) => file.before !== file.after);
  if (changed.length === 0) return null;

  history.patchCounter += 1;
  const patchId = `PATCH #${String(history.patchCounter).padStart(3, '0')}`;

  const step: HistoryStep = {
    id: history.nextId++,
    patchId,
    timestamp: now,
    description:
      description ||
      `Modified ${changed.length} file${changed.length === 1 ? '' : 's'}`,
    files: changed,
    metadata: {
      ...metadata,
      filesCount: changed.length,
      paths: changed.map((file) => file.path),
    },
  };

  history.undoStack.push(step);
  if (history.undoStack.length > MAX_HISTORY_STEPS) {
    history.undoStack.shift();
  }
  // Any new change invalidates the redo branch.
  history.redoStack = [];

  return step;
}

/**
 * Snapshot files, then write new content, and return the change record.
 *
 * This is the sequence the Patch screen uses so that undo has a `before` value
 * for every file it touches. Reading happens before any write, so a mid-way
 * failure cannot leave the record describing content that was never on disk.
 */
export function captureAndWrite(
  projectRoot: string,
  updates: ReadonlyMap<string, string>,
): FileChange[] {
  const changes: FileChange[] = [];

  for (const [path, after] of updates) {
    // Containment, before the read. An update key that leaves the project is not
    // a change to record — it is a request to write a file the project does not
    // own, and recording it would put it on the undo stack where pressing Undo
    // would perform it (audit NEW-4).
    const inside = resolveInsideRoot(projectRoot, path);
    if (!inside.ok) continue;

    const before = existsSync(inside.value.absolutePath)
      ? readFileSync(inside.value.absolutePath, 'utf-8')
      : null;

    if (before === after) continue;

    changes.push({ path: inside.value.relativePath, before, after });
  }

  for (const change of changes) {
    writeProjectFile(projectRoot, change.path, change.after);
  }

  return changes;
}

/**
 * Write a file, creating parent directories. `null` content deletes the file.
 *
 * **The single choke point for every history write.** `captureAndWrite`, `undo`
 * and `redo` all come through here, so the containment decision below is the
 * only one there is: a recorded path that resolves outside the project is
 * skipped rather than written, whether it arrived from a patch plan or from a
 * step recorded minutes ago.
 *
 * A refusal is silent here on purpose. This function's callers either return the
 * step's paths to a developer who is looking at a Problems panel, or are inside
 * an undo of a transaction that is already described; the sentence that matters
 * is produced where the path first arrives, and `resolveInsideRoot` is what
 * refuses it there. What is *not* allowed is a second implementation of
 * containment — that is what audit NEW-4 was.
 */
function writeProjectFile(
  projectRoot: string,
  relativePath: string,
  content: string | null,
): void {
  const inside = resolveInsideRoot(projectRoot, relativePath);
  if (!inside.ok) return;

  const absolutePath = inside.value.absolutePath;

  if (content === null) {
    if (existsSync(absolutePath)) rmSync(absolutePath, { force: true });
    return;
  }

  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf-8');
}

/** Undo the most recent transaction. */
export function undo(projectPath: string): HistoryActionResult {
  const key = normalizeProjectPath(projectPath);
  const history = getHistory(key);

  if (!history || history.undoStack.length === 0) {
    return { success: false, error: 'Nothing to undo', paths: [], ...emptyStatus(history) };
  }

  const step = history.undoStack.pop();
  if (!step) {
    return { success: false, error: 'Nothing to undo', paths: [], ...emptyStatus(history) };
  }

  const paths: string[] = [];
  for (const file of step.files) {
    // `before: null` means the file did not exist: undoing a creation deletes it.
    writeProjectFile(key, file.path, file.before);
    paths.push(file.path);
  }

  history.redoStack.push(step);

  return {
    success: true,
    patchId: step.patchId,
    description: step.description,
    paths,
    canUndo: history.undoStack.length > 0,
    canRedo: true,
    undoCount: history.undoStack.length,
    redoCount: history.redoStack.length,
  };
}

/** Redo the most recently undone transaction. */
export function redo(projectPath: string): HistoryActionResult {
  const key = normalizeProjectPath(projectPath);
  const history = getHistory(key);

  if (!history || history.redoStack.length === 0) {
    return { success: false, error: 'Nothing to redo', paths: [], ...emptyStatus(history) };
  }

  const step = history.redoStack.pop();
  if (!step) {
    return { success: false, error: 'Nothing to redo', paths: [], ...emptyStatus(history) };
  }

  const paths: string[] = [];
  for (const file of step.files) {
    writeProjectFile(key, file.path, file.after);
    paths.push(file.path);
  }

  history.undoStack.push(step);

  return {
    success: true,
    patchId: step.patchId,
    description: step.description,
    paths,
    canUndo: true,
    canRedo: history.redoStack.length > 0,
    undoCount: history.undoStack.length,
    redoCount: history.redoStack.length,
  };
}

/** Current undo/redo availability and the most recent transactions. */
export function getHistoryStatus(projectPath: string): HistoryStatus {
  const key = normalizeProjectPath(projectPath);
  const history = getHistory(key);
  if (!history) return emptyStatus(null);

  const nextUndo = history.undoStack[history.undoStack.length - 1];
  const nextRedo = history.redoStack[history.redoStack.length - 1];

  return {
    canUndo: history.undoStack.length > 0,
    canRedo: history.redoStack.length > 0,
    undoCount: history.undoStack.length,
    redoCount: history.redoStack.length,
    nextUndoDesc: nextUndo ? `${nextUndo.patchId}: ${nextUndo.description}` : '',
    nextRedoDesc: nextRedo ? `${nextRedo.patchId}: ${nextRedo.description}` : '',
    recentTransactions: history.undoStack.slice(-5).map((step) => ({
      patchId: step.patchId,
      description: step.description,
      files: step.files.map((file) => file.path),
      timestamp: step.timestamp,
    })),
  };
}

/** Discard a project's history. */
export function clearHistory(projectPath: string): void {
  const key = normalizeProjectPath(projectPath);
  if (key !== '') histories.delete(key);
}

function emptyStatus(history: History | null): HistoryStatus {
  return {
    canUndo: false,
    canRedo: false,
    undoCount: history?.undoStack.length ?? 0,
    redoCount: history?.redoStack.length ?? 0,
    nextUndoDesc: '',
    nextRedoDesc: '',
    recentTransactions: [],
  };
}

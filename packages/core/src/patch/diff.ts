/**
 * patch/diff.ts — A line diff for the Patch screen's preview.
 *
 * The Patch screen shows the developer what will change *before* it happens, so
 * the diff has to be readable rather than merely correct. This is a
 * longest-common-subsequence line diff with a fixed context window — the same
 * shape `git diff` produces, and the same shape v1 emitted.
 *
 * It is a plain LCS diff rather than Myers: patches are small (an AI's answer is
 * typically tens of lines), and LCS is a dozen lines of code that cannot be
 * subtly wrong. At the scale where Myers would matter, the developer would be
 * looking at a wrong patch long before the diff algorithm became the problem.
 */

/** One line of a diff. */
export interface DiffChunk {
  type: 'add' | 'delete' | 'context';
  /** The text of the line. */
  line: string;
  /** 1-based line number in the "before" text; null for additions. */
  beforeLine: number | null;
  /** 1-based line number in the "after" text; null for deletions. */
  afterLine: number | null;
}

/** Lines of context kept around each change. */
export const DEFAULT_CONTEXT_LINES = 2;

/** A full diff, split into hunks so unchanged regions can be collapsed. */
export interface DiffHunk {
  /** The 1-based line number in the "before" text where this hunk starts. */
  beforeStart: number;
  /** The 1-based line number in the "after" text where this hunk starts. */
  afterStart: number;
  chunks: DiffChunk[];
}

/**
 * Compute the line-level diff between two texts.
 *
 * Returns one hunk per changed region. When nothing differs the result is empty,
 * which the Patch screen renders as "no changes".
 */
export function generateUnifiedDiff(
  before: string,
  after: string,
  contextLines: number = DEFAULT_CONTEXT_LINES,
): DiffHunk[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  const operations = diffLines(beforeLines, afterLines);

  const changedIndices = operations
    .map((op, index) => (op.type === 'context' ? -1 : index))
    .filter((index) => index !== -1);

  if (changedIndices.length === 0) return [];

  // Group changed operations into hunks, merging ones separated by no more than
  // twice the context window (otherwise they would overlap).
  const hunks: DiffHunk[] = [];
  let hunkStart = Math.max(0, (changedIndices[0] ?? 0) - contextLines);
  let hunkEnd = Math.min(
    operations.length - 1,
    (changedIndices[0] ?? 0) + contextLines,
  );

  for (const index of changedIndices.slice(1)) {
    const candidateStart = Math.max(0, index - contextLines);
    const candidateEnd = Math.min(operations.length - 1, index + contextLines);

    if (candidateStart <= hunkEnd + 1) {
      hunkEnd = Math.max(hunkEnd, candidateEnd);
    } else {
      hunks.push(buildHunk(operations, hunkStart, hunkEnd));
      hunkStart = candidateStart;
      hunkEnd = candidateEnd;
    }
  }
  hunks.push(buildHunk(operations, hunkStart, hunkEnd));

  return hunks;
}

/** Flatten a diff into every chunk, for callers that do not show hunks. */
export function generateFlatDiff(
  before: string,
  after: string,
  contextLines: number = DEFAULT_CONTEXT_LINES,
): DiffChunk[] {
  return generateUnifiedDiff(before, after, contextLines).flatMap((h) => h.chunks);
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** One step of the line diff. */
interface Operation {
  type: 'add' | 'delete' | 'context';
  line: string;
  beforeLine: number | null;
  afterLine: number | null;
}

/**
 * Longest-common-subsequence diff.
 *
 * The `table[i][j]` entry is the LCS length of `before[i..]` and `after[j..]`,
 * built backwards so the walk can emit operations in forward order.
 */
function diffLines(before: string[], after: string[]): Operation[] {
  const rows = before.length;
  const cols = after.length;

  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0),
  );

  for (let i = rows - 1; i >= 0; i--) {
    const row = table[i];
    const nextRow = table[i + 1];
    if (!row || !nextRow) continue;

    for (let j = cols - 1; j >= 0; j--) {
      row[j] =
        before[i] === after[j]
          ? (nextRow[j + 1] ?? 0) + 1
          : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const operations: Operation[] = [];
  let i = 0;
  let j = 0;

  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      operations.push({ type: 'context', line: before[i] ?? '', beforeLine: i + 1, afterLine: j + 1 });
      i++;
      j++;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      operations.push({ type: 'delete', line: before[i] ?? '', beforeLine: i + 1, afterLine: null });
      i++;
    } else {
      operations.push({ type: 'add', line: after[j] ?? '', beforeLine: null, afterLine: j + 1 });
      j++;
    }
  }

  while (i < rows) {
    operations.push({ type: 'delete', line: before[i] ?? '', beforeLine: i + 1, afterLine: null });
    i++;
  }
  while (j < cols) {
    operations.push({ type: 'add', line: after[j] ?? '', beforeLine: null, afterLine: j + 1 });
    j++;
  }

  return operations;
}

function buildHunk(operations: Operation[], start: number, end: number): DiffHunk {
  const chunks = operations.slice(start, end + 1);

  const firstBefore = chunks.find((c) => c.beforeLine !== null)?.beforeLine ?? 0;
  const firstAfter = chunks.find((c) => c.afterLine !== null)?.afterLine ?? 0;

  return { beforeStart: firstBefore, afterStart: firstAfter, chunks };
}

/**
 * Render a diff as a unified-diff style string.
 *
 * Used for the clipboard path and for writing a `.patch` file next to the
 * project, so a developer can hand the same change to a different AI or to `git`.
 */
export function formatUnifiedDiff(
  filePath: string,
  before: string,
  after: string,
): string {
  const hunks = generateUnifiedDiff(before, after);
  if (hunks.length === 0) return '';

  const isNewFile = before.length === 0;
  const isDeletedFile = after.length === 0;

  const lines: string[] = [
    isNewFile ? '--- /dev/null' : `--- a/${filePath}`,
    isDeletedFile ? '+++ /dev/null' : `+++ b/${filePath}`,
  ];

  for (const hunk of hunks) {
    const beforeCount = hunk.chunks.filter((c) => c.type !== 'add').length;
    const afterCount = hunk.chunks.filter((c) => c.type !== 'delete').length;
    const beforeStart = beforeCount === 0 ? 0 : hunk.beforeStart;
    const afterStart = afterCount === 0 ? 0 : hunk.afterStart;
    lines.push(`@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`);

    for (const chunk of hunk.chunks) {
      const prefix = chunk.type === 'add' ? '+' : chunk.type === 'delete' ? '-' : ' ';
      lines.push(`${prefix}${chunk.line}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

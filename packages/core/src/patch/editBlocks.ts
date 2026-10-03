/**
 * patch/editBlocks.ts — Parse and apply `### EDIT:` surgical patches.
 *
 * The format an AI is asked to produce:
 *
 *     ### EDIT: src/player.js
 *     <<<<<<< FIND
 *       const speed = 5;
 *     =======
 *       const speed = 25;
 *     >>>>>>> REPLACE
 *
 * Three properties matter more than the parsing tolerance:
 *
 *  1. **Nothing is written unless the whole file can be written.** Every block
 *     for a file is applied to an in-memory copy; the pre-check runs; only then
 *     is anything written. A partially-applied patch is worse than a rejected
 *     one, because the developer cannot tell which half landed.
 *  2. **An ambiguous snippet is refused, not guessed** (see `finder.ts`).
 *  3. **Re-applying a patch is a no-op.** Developers paste the same AI answer
 *     twice; the second paste should report "already applied" rather than
 *     reporting a failure or duplicating the change.
 *
 * The marker regexes are deliberately forgiving — models emit `### EDIT:`,
 * `**EDIT:**`, `PATCH:` and wrap the diff in a code fence. Forgiving *parsing*
 * does not mean forgiving *matching*: the snippet is still located precisely.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findTargetMatch } from './finder.js';
import { validateContentSyntax, type SyntaxCheckResult } from './syntaxCheck.js';

/** One parsed `### EDIT:` block. */
export interface EditBlock {
  path: string;
  find: string;
  replace: string;
}

/** How one block was resolved. */
export interface AppliedEdit {
  path: string;
  index: number;
}

export interface FailedEdit {
  path: string;
  index: number;
  find: string;
  reason: string;
  /** True when the block overlapped an earlier block in the same file. */
  isOverlapping?: boolean;
}

/** The outcome of applying a patch. */
export interface EditApplyResult {
  success: boolean;
  /** Blocks whose FIND text was located and replaced. */
  applied: AppliedEdit[];
  /** Blocks whose replacement was already present. */
  alreadyApplied: AppliedEdit[];
  /** Blocks that could not be resolved. */
  failed: FailedEdit[];
  /** Files written to disk. */
  files: string[];
  /** True when some blocks applied and others did not. */
  partial: boolean;
  /** Set when the syntax pre-check refused the write. */
  preCheckFailed?: boolean;
  /** True when the caller may retry with `applyAnyway`. */
  canApplyAnyway?: boolean;
  syntaxError?: SyntaxCheckResult;
  error?: string;
}

/** Options controlling application. */
export interface ApplyOptions {
  /**
   * Write even when the syntax pre-check fails.
   * The Patch screen offers this as an explicit "apply anyway" after showing
   * the error; it is never the default.
   */
  applyAnyway?: boolean;
  /** Skip the syntax pre-check entirely. For trusted internal writes. */
  preCheckSyntax?: boolean;
}

/**
 * Marker pattern for a block header.
 *
 * Accepts `### EDIT:`, `## EDIT:`, `**EDIT:**`, `EDIT:`, `PATCH:`, `UPDATE:`
 * and `FILE:` — the same set v1 accepted, because refusing to read a patch
 * because the model wrote `**EDIT:**` helps nobody.
 */
const HEADER_PATTERN =
  /(?:^|\n)[ \t]*(?:\*\*)?(?:#{1,6}[ \t]*)?(?:\*\*)?(?:EDIT|FILE|UPDATE|PATCH):[ \t]*[`*"']*([^\r\n*`"']+)[`*"']*(?:\*\*)?[ \t]*\r?\n(?:[ \t]*```[^\r\n]*\r?\n)?[ \t]*<{3,7}[ \t]*(?:FIND|SEARCH)[^\r\n]*\r?\n([\s\S]*?)\r?\n[ \t]*={3,7}[^\r\n]*\r?\n([\s\S]*?)\r?\n[ \t]*>{3,7}(?:[ \t]*REPLACE)?[^\r\n]*(?:\r?\n[ \t]*```)?/gi;

/** Parse `### EDIT:` blocks out of an AI response. */
export function parseEditBlocks(text: string): EditBlock[] {
  if (typeof text !== 'string' || text === '') return [];

  const blocks: EditBlock[] = [];
  HEADER_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = HEADER_PATTERN.exec(text)) !== null) {
    const rawPath = (match[1] ?? '').trim().replace(/^[`*_]+|[`*_]+$/g, '').trim();
    const find = match[2] ?? '';
    const replace = match[3] ?? '';
    if (rawPath === '') continue;
    blocks.push({ path: rawPath, find, replace });
  }

  return blocks;
}

/**
 * Normalise a patch path to a project-relative id.
 *
 * Returns null for a path that escapes the project root. An AI that emits
 * `../../etc/passwd` must not be able to steer a write outside the project —
 * the developer never sees the raw path, only the rendered diff.
 */
export function normalizePatchPath(rawPath: string): string | null {
  const normalized = rawPath
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .trim();

  if (normalized === '') return null;

  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null; // traversal: refuse the whole path
    segments.push(segment);
  }

  return segments.length > 0 ? segments.join('/') : null;
}

/**
 * Apply `### EDIT:` blocks to files under `projectRoot`.
 *
 * Returns a result describing what happened; it does not throw for a patch that
 * simply did not apply, because the Patch screen needs to show the developer
 * which blocks failed. It throws only for a misuse — no blocks in the text, or a
 * path that escapes the project.
 */
export function applyEditBlocks(
  projectRoot: string,
  responseText: string,
  options: ApplyOptions = {},
): EditApplyResult {
  if (!projectRoot || !existsSync(projectRoot)) {
    throw new Error(`Project folder not found: "${projectRoot}"`);
  }

  const blocks = parseEditBlocks(responseText);
  if (blocks.length === 0) {
    throw new Error(
      "Zero blocks found matching the '### EDIT: <path>' format.\n\n" +
        'Expected format:\n' +
        '### EDIT: relative/path/to/file.ext\n' +
        '<<<<<<< FIND\n' +
        '<exact original code snippet>\n' +
        '=======\n' +
        '<replacement code>\n' +
        '>>>>>>> REPLACE',
    );
  }

  const byFile = groupByFile(blocks);
  const applied: AppliedEdit[] = [];
  const alreadyApplied: AppliedEdit[] = [];
  const failed: FailedEdit[] = [];
  /** Files ready to be written, still in memory. */
  const prepared: PreparedWrite[] = [];

  for (const [path, fileBlocks] of byFile) {
    const absolutePath = join(projectRoot, path);

    if (!existsSync(absolutePath)) {
      fileBlocks.forEach((_, index) => {
        failed.push({
          path,
          index: index + 1,
          find: '',
          reason: `Target file "${path}" does not exist in the project.`,
        });
      });
      continue;
    }

    const initialContent = readFileSync(absolutePath, 'utf-8');
    const outcome = applyToContent(path, initialContent, fileBlocks);
    applied.push(...outcome.applied);
    alreadyApplied.push(...outcome.alreadyApplied);
    failed.push(...outcome.failed);

    if (outcome.content !== initialContent) {
      prepared.push({ path, absolutePath, content: outcome.content });
    }
  }

  // The pre-check runs on the final content of every file, after all of that
  // file's blocks are applied. Checking intermediate states would reject a
  // patch that legitimately passes through invalid syntax (renaming a
  // declaration, then updating its callers).
  const runPreCheck = options.preCheckSyntax !== false && !options.applyAnyway;
  if (runPreCheck && prepared.length > 0) {
    for (const write of prepared) {
      const check = validateContentSyntax(write.path, write.content);
      if (!check.valid) {
        return {
          success: false,
          preCheckFailed: true,
          canApplyAnyway: true,
          applied: [],
          alreadyApplied,
          failed,
          files: [],
          partial: false,
          syntaxError: check,
          error:
            `Pre-save syntax check failed for "${write.path}": ${check.message}. ` +
            'Nothing was written to disk.',
        };
      }
    }
  }

  for (const write of prepared) {
    mkdirSync(dirname(write.absolutePath), { recursive: true });
    writeFileSync(write.absolutePath, write.content, 'utf-8');
  }

  if (applied.length === 0) {
    if (alreadyApplied.length > 0 && failed.length === 0) {
      const fileList = [...byFile.keys()].join(', ');
      return {
        success: true,
        applied,
        alreadyApplied,
        failed,
        files: [],
        partial: false,
        error:
          `All ${alreadyApplied.length} edit block(s) are already present in ${fileList} ` +
          '(no changes needed).',
      };
    }

    const first = failed[0];
    if (!first) {
      throw new Error('Patch produced no edits and no failures; this is a bug.');
    }
    return {
      success: false,
      applied,
      alreadyApplied,
      failed,
      files: [],
      partial: false,
      error:
        `In file "${first.path}" (edit block ${first.index}): could not apply.\n` +
        `--------------------\n${first.find}\n--------------------\n` +
        (first.reason.includes('matched')
          ? 'The snippet must be uniquely identifiable. Ask the AI to include more surrounding lines.'
          : 'Ask the AI to regenerate the patch with more surrounding context.'),
    };
  }

  const writtenFiles = prepared.map((w) => w.path);
  return {
    success: true,
    applied,
    alreadyApplied,
    failed,
    files: writtenFiles,
    partial: failed.length > 0,
  };
}

interface PreparedWrite {
  path: string;
  absolutePath: string;
  content: string;
}

/** Group blocks by file, preserving their order within each file. */
function groupByFile(blocks: EditBlock[]): Map<string, EditBlock[]> {
  const byFile = new Map<string, EditBlock[]>();
  for (const block of blocks) {
    const path = normalizePatchPath(block.path);
    if (path === null) {
      throw new Error(
        `Invalid file path in patch: "${block.path}". ` +
          'Paths must stay inside the project directory.',
      );
    }
    const existing = byFile.get(path);
    if (existing) existing.push(block);
    else byFile.set(path, [block]);
  }
  return byFile;
}

/**
 * Apply one file's blocks to its content, returning the new content.
 *
 * Blocks are applied in sequence to an evolving buffer, so block 2 sees the
 * result of block 1. When block N's FIND text no longer matches the buffer, the
 * original content is consulted: if the FIND matched *before* block 1 ran, then
 * the block overlaps an earlier one, and that is reported as such rather than
 * as "text not found" — the two need different fixes from the AI.
 */
function applyToContent(
  path: string,
  initialContent: string,
  blocks: EditBlock[],
): { content: string; applied: AppliedEdit[]; alreadyApplied: AppliedEdit[]; failed: FailedEdit[] } {
  let content = initialContent;
  const applied: AppliedEdit[] = [];
  const alreadyApplied: AppliedEdit[] = [];
  const failed: FailedEdit[] = [];
  /** Blocks applied so far in this file, for re-anchoring. */
  const appliedHere: { find: string; replace: string }[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) continue;
    const index = i + 1;

    let match = findTargetMatch(content, block.find);

    if (!match.success && appliedHere.length > 0) {
      const originalMatch = findTargetMatch(initialContent, block.find);

      if (originalMatch.success) {
        // The block targets text an earlier block rewrote. Substitute the
        // earlier replacements into this block's FIND text and retry against
        // the current buffer — that is the common "two edits to one function"
        // case, and refusing it would make the AI produce longer patches.
        let reanchored = block.find;
        for (const previous of appliedHere) {
          if (reanchored.includes(previous.find)) {
            reanchored = reanchored.replace(previous.find, previous.replace);
          }
        }

        if (reanchored !== block.find) {
          const retry = findTargetMatch(content, reanchored);
          if (retry.success) match = retry;
        }

        if (!match.success) {
          failed.push({
            path,
            index,
            find: block.find,
            isOverlapping: true,
            reason:
              `Overlapping edit block: block ${index} targets text rewritten by an ` +
              'earlier block in this patch.',
          });
          continue;
        }
      }
    }

    if (match.success) {
      content = content.replace(match.target, block.replace);
      applied.push({ path, index });
      appliedHere.push({ find: block.find, replace: block.replace });
      continue;
    }

    // Not found. If the replacement is already in the file, this patch was
    // applied before and reporting it as a failure would be misleading.
    const trimmedReplace = block.replace.trim();
    const alreadyThere =
      (block.replace.length > 0 && content.includes(block.replace)) ||
      (trimmedReplace.length > 10 && content.includes(trimmedReplace));

    if (alreadyThere) {
      alreadyApplied.push({ path, index });
    } else {
      failed.push({ path, index, find: block.find, reason: match.reason });
    }
  }

  return { content, applied, alreadyApplied, failed };
}

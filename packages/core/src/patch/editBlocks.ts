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
import { dirname } from 'node:path';
import { resolveInsideRootOrThrow } from '../fs/resolveInsideRoot.js';
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
 * Normalise a patch path to a project-relative id. **Lexical only.**
 *
 * Returns null for a path with a `..` segment, an absolute path (stripped, not
 * refused — see below) or an empty result.
 *
 * ## Not the containment check — do not use it as one
 *
 * This function is still exported because it is the documented normaliser, but
 * neither patch engine calls it any more. It cannot see a symlink: `normalize`
 * returns `src/link.js` whether `src/link.js` is a real file or a link to
 * `/etc/passwd`, and both spellings come back identical. Every read and write
 * goes through `resolveInsideRoot` (`fs/resolveInsideRoot.ts`), which asks the
 * filesystem. See D51.
 *
 * The one behaviour worth naming because it is surprising: a leading `/` is
 * **stripped**, so `/etc/cron.d/pwn` becomes `etc/cron.d/pwn` *inside* the
 * project rather than being refused. That is inert — `resolveInsideRoot`
 * refuses an absolute path outright now, so this function is no longer on any
 * path to a write — but it was recorded in the audit as a deviation from
 * `ipc.ts`'s "refused, not sanitised" and it stayed true until D51 removed the
 * call.
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

  const byFile = groupByFile(projectRoot, blocks);
  const applied: AppliedEdit[] = [];
  const alreadyApplied: AppliedEdit[] = [];
  const failed: FailedEdit[] = [];
  /** Files ready to be written, still in memory. */
  const prepared: PreparedWrite[] = [];

  for (const [path, fileBlocks] of byFile) {
    // The absolute path is the one `groupByFile` already proved is inside the
    // root. Re-resolving here would be a second answer to the same question, and
    // two answers is how the two drift apart.
    const absolutePath = resolveInsideRootOrThrow(projectRoot, path).absolutePath;

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
        adviceFor(first),
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

/**
 * The one sentence of advice that fits a block's reason.
 *
 * The reason already says what went wrong — including for an empty FIND, which
 * the finder names explicitly. Repeating "ask for more context" on top of that
 * is noise, so the generic sentence is only offered when the reason gave the
 * developer nothing they can act on.
 */
function adviceFor(failure: FailedEdit): string {
  if (failure.reason.includes('matched')) {
    return 'The snippet must be uniquely identifiable. Ask the AI to include more surrounding lines.';
  }
  if (failure.find.trim() === '') {
    return '';
  }
  return 'Ask the AI to regenerate the patch with more surrounding context.';
}

/**
 * Build the text that actually replaces `target`.
 *
 * Three corrections the AI's replacement cannot know about, each read off the
 * region being replaced rather than guessed:
 *
 *  - **Indentation.** The reply has none; the region has the developer's.
 *  - **Line endings.** The reply is almost always LF; the developer's file may
 *    be CRLF. Writing the reply verbatim into a CRLF file leaves mixed
 *    endings, which git renders as a whole-file rewrite and every Windows tool
 *    in the project then disagrees about.
 *  - **Blank lines inside the region.** A FIND written by an AI has no blank
 *    lines, because the reply it came from had none. The region's own spacing
 *    is the developer's, and it is recoverable: where the located target has a
 *    blank line and the replacement has the corresponding code line, that blank
 *    line is restored after it. Applied to the whole region, so a patch that
 *    rewrites five statements keeps the file's shape instead of compacting it.
 *
 * Without these the engine writes code that is *valid and wrong*: a statement
 * at the wrong depth, or a file with two line-ending conventions, both of which
 * compile and both of which the developer did not ask for.
 *
 * Nothing is invented. If the counts do not line up, or the replacement has no
 * corresponding line to hang a blank line on, that correction is skipped and the
 * replacement is written as given — an imperfect edit the developer can see in
 * the diff, which is a different thing from a silent one.
 */
function replacementFor(replacement: string, target: string, fileContent: string): string {
  const usesCrlf = fileContent.includes('\r\n');
  const withEol = usesCrlf ? replacement.replace(/(?<!\r)\n/g, '\r\n') : replacement;
  return restoreBlankLines(reapplyIndent(withEol, target), target);
}

/**
 * Re-apply the region's indentation to a replacement that lost it.
 *
 * An AI quoting code from memory reliably drops the leading whitespace of every
 * line, and writing that verbatim moves a statement out of its block: valid
 * JavaScript, wrong code. The indentation is recoverable, because the region
 * being replaced still has it.
 *
 * Only a line that is *entirely* without leading whitespace is re-indented, and
 * only by the indentation of the region's own first line — which is the common
 * depth, since a FIND is quoted from inside one block. A line the AI did
 * indent, or a relative change in depth between two lines, is left exactly as
 * written. Nothing is guessed beyond "these lines belong at the region's depth".
 */
function reapplyIndent(replacement: string, target: string): string {
  const eol = replacement.includes('\r\n') ? '\r\n' : '\n';
  const targetFirst = target.split(eol)[0] ?? '';
  const indent = /^[\t ]*/.exec(targetFirst)?.[0] ?? '';
  if (indent === '') return replacement;

  return replacement
    .split(eol)
    .map((line) => (line.length > 0 && !/^[\t ]/.test(line) ? indent + line : line))
    .join(eol);
}

/**
 * Re-insert the located region's blank lines into the replacement.
 *
 * Blank lines are matched by position among the region's **non-blank** lines:
 * line 3 of the region was blank, so the third non-blank line of the
 * replacement gets a blank line after it. The counts must agree on both sides
 * or nothing is changed, because a partial application would move a developer's
 * spacing rather than preserve it.
 */
function restoreBlankLines(replacement: string, target: string): string {
  const usesCrlf = replacement.includes('\r\n');
  const eol = usesCrlf ? '\r\n' : '\n';
  const split = (text: string): string[] => text.split(eol);

  const targetLines = split(target);
  const replacementLines = split(replacement);

  const targetNonBlank = targetLines.filter((line) => line.trim() !== '');
  const replacementNonBlank = replacementLines.filter((line) => line.trim() !== '');

  if (targetNonBlank.length !== replacementNonBlank.length) return replacement;

  // After which non-blank line in the target does a blank line sit?
  const blankAfter = new Set<number>();
  let seen = -1;
  for (const line of targetLines) {
    if (line.trim() === '') {
      if (seen >= 0) blankAfter.add(seen);
    } else {
      seen += 1;
    }
  }
  if (blankAfter.size === 0) return replacement;

  const out: string[] = [];
  let index = -1;
  for (const line of replacementLines) {
    out.push(line);
    if (line.trim() === '') continue;
    index += 1;
    if (blankAfter.has(index)) out.push('');
  }

  // The replacement's own trailing newline must not become a second one.
  while (out.length > 1 && out[out.length - 1] === '' && replacementLines[replacementLines.length - 1] === '') {
    out.pop();
  }

  return out.join(eol);
}

/** One earlier block in the same file, as re-anchoring needs to see it. */
interface EarlierBlock {
  find: string;
  replace: string;
}

/**
 * Whether this block would put back the value an earlier block replaced.
 *
 * The signature is the whole question, asked three ways:
 *
 *  1. Does the region about to be overwritten still contain the earlier block's
 *     **replacement**? If not, this block is not touching that change at all,
 *     and nothing is being reverted. (The common two-edits-one-function case
 *     lands here and is allowed.)
 *  2. Does the earlier block's **replacement** text still contain the old value
 *     it replaced — while this block's replacement keeps the old value? That is
 *     block 2 restating pre-block-1 code: a net revert.
 *  3. As a last resort — a single-line earlier block whose old value no longer
 *     appears anywhere in the region — does this block's replacement reinsert
 *     that exact old line? The textual signal is gone by then, so this is the
 *     case where "did this change anything an earlier block changed" can only be
 *     answered by looking at what the block writes back.
 *
 * Returning true refuses the block. It is a refusal, not a guess: D3 applies to
 * every pass, and a patch that silently reverses half of itself is the worst
 * answer this engine can give.
 */
function matchRegionHasOldValue(
  region: string,
  earlier: EarlierBlock,
  thisBlockReplace: string,
): boolean {
  const newValue = earlier.replace.trim();
  const oldValue = earlier.find.trim();

  if (newValue === '' || oldValue === '') return false;

  // 1. Untouched by the earlier block.
  if (!region.includes(earlier.replace)) return false;

  // 2. The earlier replacement is still the new value, so re-anchoring had to
  //    work. If this block keeps the old value anywhere, it reverses.
  if (!thisBlockReplace.includes(oldValue)) return false;

  const indexOfLine = (text: string, line: string): number =>
    text.split('\n').findIndex((candidate) => candidate.trim() === line);

  if (thisBlockReplace.includes(earlier.replace)) return true;

  if (indexOfLine(newValue, oldValue) !== -1) return true;

  // 3. Textual signal exhausted: a one-line edit whose old line is gone from the
  //    region. Only then look at what the block writes back.
  if (earlier.find.split('\n').length === 1 && !region.includes(earlier.find)) {
    return thisBlockReplace.split('\n').some((line) => line.trim() === oldValue);
  }

  return false;
}

/**
 * The refusal sentence for a block that reverses an earlier one. Names the block
 * the developer has to look at, and says plainly what happened.
 */
function netReverseReason(index: number, earlier: EarlierBlock): string {
  const oldLine = earlier.find.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
  return (
    `Edit block ${index} would undo an earlier block in this patch: its replacement still ` +
    `contains the original line "${oldLine}", which an earlier block in this same patch ` +
    'already changed. Both blocks cannot be right. Nothing was written for this block — ' +
    'ask the AI for one patch that makes the change once.'
  );
}

/**
 * Does `block` contradict or undo something an earlier block already did?
 *
 * Two shapes, both seen in practice:
 *
 *  - **Undoing.** This block's FIND is (or contains) what an earlier block WROTE.
 *    Applying both leaves the file exactly as it started, while reporting two
 *    successful edits.
 *  - **Both targeting the original.** Two blocks whose FINDs overlap each other.
 *    The first applies; the second then matches the already-changed text or is
 *    silently dropped, so one of the two requested changes never happens.
 *
 * Returns the earlier block's index when there is a clash, or `null`.
 */
function findOverlap(
  appliedHere: readonly { find: string; replace: string }[],
  block: EditBlock,
): number | null {
  for (let i = 0; i < appliedHere.length; i += 1) {
    const previous = appliedHere[i];
    if (previous === undefined) continue;

    // This block wants to replace what the previous one wrote.
    if (block.find.includes(previous.find) || previous.replace.includes(block.find)) {
      return i + 1;
    }
    // Two FINDs that overlap each other: both cannot be applied to one region.
    if (overlappingText(previous.find, block.find)) {
      return i + 1;
    }
  }
  return null;
}

/**
 * Do two snippets share a line that is specific enough to identify a place?
 *
 * One *non-blank, distinctive* line in common is the signal. A line like `}` or
 * `});` appears in nearly every function and would make every pair of blocks in a
 * file look like a clash, refusing patches that are perfectly disjoint.
 */
function overlappingText(a: string, b: string): boolean {
  const linesOf = (text: string): Set<string> =>
    new Set(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length >= 12 && !/^[)}\];,]+$/.test(line)),
    );
  const left = linesOf(a);
  for (const line of linesOf(b)) {
    if (left.has(line)) return true;
  }
  return false;
}

/** The refusal sentence for a block whose re-anchor could not be resolved. */
function overlappingReason(index: number, clashesWith?: number): string {
  if (clashesWith !== undefined) {
    return (
      `Edit block ${index} contradicts edit block ${clashesWith} in this same file: one ` +
      'of them rewrites text the other also touches, so they cannot both be right. ' +
      'Nothing was written for this block — ask the AI for one patch that makes each ' +
      'change once.'
    );
  }
  return (
    `Overlapping edit block: block ${index} targets text rewritten by an ` +
    'earlier block in this patch.'
  );
}

/**
 * Replace the first occurrence of `target` with `replacement`.
 *
 * `target` is what the finder located, and the finder only reports success when
 * that exact text occurs exactly once — so a plain `replace` would be equivalent
 * today. It is written as an index-and-slice rather than `String.replace` for
 * one reason: a **literal**, pattern-free replacement. `$&`, `$1` and `$'` in an
 * AI's replacement text are matched against the *replacement* string of
 * `String.replace`, so a patch containing `$&` loses the matched text, silently.
 * The developer never asked for that, and a fix applied is worse than a patch
 * refused.
 */
function replaceOnce(content: string, target: string, replacement: string): string {
  if (target === '') return content;
  const index = content.indexOf(target);
  if (index === -1) return content;
  return content.slice(0, index) + replacement + content.slice(index + target.length);
}

interface PreparedWrite {
  path: string;
  absolutePath: string;
  content: string;
}

/**
 * Group blocks by file, preserving their order within each file.
 *
 * `projectRoot` is threaded in because grouping is now a *containment*
 * decision, not a string tidy-up: the grouped key is the path core will open,
 * and that is decided by `resolveInsideRoot` (see `fs/resolveInsideRoot.ts`).
 * A symlinked file inside the project resolves outside it, and this is where
 * that is caught — before a single byte is read.
 */
function groupByFile(projectRoot: string, blocks: EditBlock[]): Map<string, EditBlock[]> {
  const byFile = new Map<string, EditBlock[]>();
  for (const block of blocks) {
    const path = resolveInsideRootOrThrow(projectRoot, block.path).relativePath;
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

    /**
     * PATCH-7: refuse a block that overlaps one already applied to this file.
     *
     * Checked **before** the match, because the damage is not that the second block
     * fails to apply — it is that it applies *cleanly* and undoes the first. Two
     * blocks swapping `a` 1 -> 2 -> 1 both find their FIND, both apply, both
     * report success, and the file ends in a state neither block asked for. Two
     * blocks both targeting the original are worse: the first wins and the second
     * is silently dropped, so a change the AI asked for never lands.
     *
     * The rule is deliberately blunt. Any overlap — same lines, or one block's
     * replacement text inside another's FIND — refuses the whole patch. A cleverer
     * rule would have to decide which of two contradictory edits the developer
     * wanted, and D3 is explicit that an ambiguous patch is refused, never guessed.
     */
    const clash = findOverlap(appliedHere, block);
    if (clash !== null) {
      failed.push({
        path,
        index,
        find: block.find,
        isOverlapping: true,
        reason: overlappingReason(index, clash),
      });
      continue;
    }

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
            reanchored = replaceOnce(reanchored, previous.find, previous.replace);
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
            reason: overlappingReason(index),
          });
          continue;
        }
      }
    }

    if (match.success) {
      // **A block must not put back what an earlier block removed.**
      //
      // The re-anchoring above exists so that block 2 can find its text *after*
      // block 1 rewrote it. That is safe only while block 2's replacement still
      // reflects block 1's change. If it does not — if it carries the
      // pre-block-1 value — the two blocks combine into a silent revert of
      // block 1, and both used to report "applied" (D52).
      //
      // Checked **before** the write, on the region this block is about to
      // replace, because afterwards there is nothing left to compare against —
      // and because a refusal that has already written is not a refusal.
      const reverting = appliedHere.find((previous) =>
        matchRegionHasOldValue(match.target, previous, block.replace),
      );

      if (reverting !== undefined) {
        failed.push({
          path,
          index,
          find: block.find,
          isOverlapping: true,
          reason: netReverseReason(index, reverting),
        });
        continue;
      }

      const before = content;
      content = replaceOnce(content, match.target, replacementFor(block.replace, match.target, content));

      if (content === before) {
        // The write changed nothing. Two reasons, and they must be told apart.
        //
        // **Already applied** is the common one: the same reply pasted twice.
        // The replacement is sitting right there, so this block did its job on
        // an earlier paste.
        //
        // **Could not write** is the engine's own failure: the finder said
        // success and the replace found nothing to replace. Reporting that as
        // applied is how a CRLF file learned to answer "applied" while every
        // byte stayed put (D52).
        const trimmed = block.replace.trim();
        const present =
          (block.replace.length > 0 && content.includes(block.replace)) ||
          (trimmed.length > 10 && content.includes(trimmed));

        if (present) {
          alreadyApplied.push({ path, index });
        } else {
          failed.push({
            path,
            index,
            find: block.find,
            reason:
              'located the FIND text but could not write the replacement: the target text was ' +
              'not present in the file it was located in. Nothing was written for this block.',
          });
        }
        continue;
      }

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

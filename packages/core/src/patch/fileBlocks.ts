/**
 * patch/fileBlocks.ts — Parse and write `### FILE:` blocks.
 *
 * The format an AI is asked to produce when creating or replacing a whole file:
 *
 *     ### FILE: src/player.js
 *     ```
 *     export class Player { ... }
 *     ```
 *
 * Used by the scaffolder (creating new files) and by "replace file" edits. It is
 * deliberately the blunt instrument: `editBlocks.ts` is the one to reach for
 * when touching existing code, because a whole-file write discards anything the
 * AI failed to reproduce.
 *
 * As with edit blocks, nothing is written until every file passes the syntax
 * pre-check.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validateContentSyntax, type SyntaxCheckResult } from './syntaxCheck.js';
import { normalizePatchPath } from './editBlocks.js';

/** One parsed `### FILE:` block. */
export interface FileBlock {
  path: string;
  content: string;
}

/** The outcome of writing `### FILE:` blocks. */
export interface FileWriteResult {
  success: boolean;
  /** Files written to disk. */
  files: string[];
  /** Files that did not previously exist. */
  created: string[];
  /** Files that already existed and were overwritten. */
  overwritten: string[];
  preCheckFailed?: boolean;
  canApplyAnyway?: boolean;
  syntaxError?: SyntaxCheckResult;
  error?: string;
}

/** Options controlling the write. */
export interface FileWriteOptions {
  /** Write even when the syntax pre-check fails. */
  applyAnyway?: boolean;
  /** Skip the syntax pre-check. */
  preCheckSyntax?: boolean;
}

/**
 * Marker pattern for a `### FILE:` header followed by a fenced code block.
 *
 * The fallback pass below handles a response that was truncated mid-block, where
 * the closing fence never arrives — a real occurrence when a model hits its
 * output limit, and losing the whole patch over it would be unhelpful.
 */
const FILE_PATTERN =
  /(?:^|\n)[ \t]*(?:\*\*)?(?:#{1,6}[ \t]*)?(?:\*\*)?FILE:[ \t]*([^\r\n*`"']+)[`*"']*(?:\*\*)?[ \t]*\r?\n[ \t]*```[^\r\n]*\r?\n([\s\S]*?)\r?\n[ \t]*```/gi;

/** The same, with the closing fence optional. */
const FILE_PATTERN_TRUNCATED =
  /(?:^|\n)[ \t]*(?:\*\*)?(?:#{1,6}[ \t]*)?(?:\*\*)?FILE:[ \t]*([^\r\n*`"']+)[`*"']*(?:\*\*)?[ \t]*\r?\n[ \t]*```[^\r\n]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*```|$)/gi;

/** Parse `### FILE:` blocks out of an AI response. */
export function parseFileBlocks(text: string): FileBlock[] {
  if (typeof text !== 'string' || text === '') return [];

  const blocks: FileBlock[] = [];
  collect(FILE_PATTERN, text, blocks);

  if (blocks.length === 0) {
    collect(FILE_PATTERN_TRUNCATED, text, blocks);
  }

  return blocks;
}

function collect(pattern: RegExp, text: string, into: FileBlock[]): void {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const rawPath = (match[1] ?? '').trim().replace(/^[`*_]+|[`*_]+$/g, '').trim();
    if (rawPath === '') continue;
    into.push({ path: rawPath, content: match[2] ?? '' });
  }
}

/**
 * Write `### FILE:` blocks into the project.
 *
 * Throws when the text contains no blocks, when a path escapes the project
 * root, or when the project folder does not exist. Returns a result for the
 * other outcomes so the caller can render them.
 */
export function writeFileBlocks(
  projectRoot: string,
  responseText: string,
  options: FileWriteOptions = {},
): FileWriteResult {
  if (!projectRoot || !existsSync(projectRoot)) {
    throw new Error(`Project folder not found: "${projectRoot}"`);
  }

  const blocks = parseFileBlocks(responseText);
  if (blocks.length === 0) {
    throw new Error(
      "Zero files found matching the '### FILE: <path>' format.\n\n" +
        'Expected format:\n' +
        '### FILE: relative/path/to/file.ext\n' +
        '```\n' +
        '<full file contents>\n' +
        '```\n\n' +
        'Ask the AI to reformat its response with ### FILE: blocks.',
    );
  }

  // Resolve and reject unsafe paths before touching the filesystem.
  const resolved = blocks.map((block) => {
    const path = normalizePatchPath(block.path);
    if (path === null) {
      throw new Error(
        `Invalid file path in patch: "${block.path}". ` +
          'Paths must stay inside the project directory.',
      );
    }
    return { path, content: block.content, absolutePath: join(projectRoot, path) };
  });

  const runPreCheck = options.preCheckSyntax !== false && !options.applyAnyway;
  if (runPreCheck) {
    for (const file of resolved) {
      const check = validateContentSyntax(file.path, file.content);
      if (!check.valid) {
        return {
          success: false,
          files: [],
          created: [],
          overwritten: [],
          preCheckFailed: true,
          canApplyAnyway: true,
          syntaxError: check,
          error:
            `Pre-save syntax check failed for "${file.path}": ${check.message}. ` +
            'Nothing was written to disk.',
        };
      }
    }
  }

  const created: string[] = [];
  const overwritten: string[] = [];

  for (const file of resolved) {
    if (existsSync(file.absolutePath)) overwritten.push(file.path);
    else created.push(file.path);

    mkdirSync(dirname(file.absolutePath), { recursive: true });
    writeFileSync(file.absolutePath, file.content, 'utf-8');
  }

  return {
    success: true,
    files: resolved.map((f) => f.path),
    created,
    overwritten,
  };
}

/**
 * Read a file's current content, for building an undo record.
 * Returns null when the file does not exist.
 */
export function readFileOrNull(projectRoot: string, relativePath: string): string | null {
  const absolutePath = join(projectRoot, relativePath);
  try {
    return readFileSync(absolutePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * patch/syntaxCheck.ts — Pre-save syntax verification, in memory.
 *
 * A patch is validated *before* anything reaches disk. That ordering is the
 * point: by the time a broken file is written, the developer has lost the good
 * version unless they reach undo, and an AI will confidently explain the broken
 * code as intended. Refusing first is cheaper than apologising later.
 *
 * JS/TS and GDScript are checked with tree-sitter, reusing the grammars the
 * extractor already loads (SPEC R5). JSON is checked with `JSON.parse`.
 *
 * GDScript deserves a note. tree-sitter reports the position of the first ERROR
 * node directly, which is more precise than v1's hand-written delimiter scanner
 * and, unlike that scanner, cannot false-flag a hex colour, a Windows path or a
 * triple-quoted docstring — the three cases v1's tests had to pin down
 * individually.
 *
 * One GDScript case the grammar does not catch: `func f()` with no body parses
 * as a valid `function_definition` even though Godot rejects it, so the missing
 * trailing colon is detected separately from the tree (see `gdscript.ts`).
 */

import { extname } from 'node:path';
import { findFunctionsMissingBody } from '../parse/gdscript.js';
import { tryParse } from '../parse/grammars.js';

/** The result of checking one file's content. */
export type SyntaxCheckResult =
  | { valid: true; file: string }
  | { valid: false; file: string; message: string; line: number | null };

/** Extensions this checker understands. */
const JS_LIKE = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);
const GD = '.gd';
const JSON_EXT = '.json';

/**
 * Check a file's content without writing it.
 *
 * A file whose type has no checker is reported valid: refusing to save a
 * `.tscn` or a `.md` because core has no parser for it would make the patch
 * engine unusable, and the Project screen re-extracts those files anyway.
 */
export function validateContentSyntax(
  filePath: string,
  content: string,
): SyntaxCheckResult {
  if (typeof filePath !== 'string' || typeof content !== 'string') {
    return { valid: true, file: String(filePath) };
  }

  const extension = extname(filePath).toLowerCase();

  if (JS_LIKE.has(extension) || extension === GD) {
    const outcome = tryParse(content, filePath);
    if (outcome.ok) {
      // The GDScript grammar treats `func f()` with no body as valid, so the
      // missing-colon case has to be checked separately.
      if (extension === GD) {
        const bodyless = findFunctionsMissingBody(content, filePath);
        const line = bodyless[0];
        if (line !== undefined) {
          return {
            valid: false,
            file: filePath,
            message:
              `GDScript syntax error: statement on line ${line} is missing a body — ` +
              "a func declaration needs a trailing ':' and an indented block",
            line,
          };
        }
      }
      return { valid: true, file: filePath };
    }
    return {
      valid: false,
      file: filePath,
      message: describeSyntaxError(extension, outcome.message),
      line: outcome.line,
    };
  }

  if (extension === JSON_EXT) {
    try {
      JSON.parse(content);
    } catch (error) {
      return {
        valid: false,
        file: filePath,
        message: `JSON syntax error: ${error instanceof Error ? error.message : String(error)}`,
        line: jsonErrorLine(content, error),
      };
    }
    return { valid: true, file: filePath };
  }

  return { valid: true, file: filePath };
}

/** Prefix the engine's own message so the error names the language. */
function describeSyntaxError(extension: string, message: string): string {
  const language = extension === GD ? 'GDScript' : 'JavaScript/TypeScript';
  return `${language} syntax error: ${message}`;
}

/**
 * Best-effort line number for a JSON parse error.
 *
 * `JSON.parse` reports a character position in recent V8 builds ("at position
 * 42"); turning that into a line lets the Patch screen jump to it.
 */
function jsonErrorLine(content: string, error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const match = /at position (\d+)/.exec(error.message);
  if (!match?.[1]) return null;

  const offset = Number.parseInt(match[1], 10);
  if (!Number.isFinite(offset) || offset < 0 || offset > content.length) return null;

  return content.slice(0, offset).split('\n').length;
}

/** Check several files, returning the first failure. */
export function validateAllSyntax(
  files: readonly { path: string; content: string }[],
): SyntaxCheckResult {
  for (const file of files) {
    const result = validateContentSyntax(file.path, file.content);
    if (!result.valid) return result;
  }
  return { valid: true, file: files[0]?.path ?? '' };
}

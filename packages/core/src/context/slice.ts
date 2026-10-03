/**
 * context/slice.ts — read the exact lines a patch must match.
 *
 * v1's `outline.js` was a brace-counting line scanner: it walked raw lines
 * looking for `class` and `function` keywords and tracked `{`/`}` depth. It
 * broke on any object literal spanning a line, on a string containing a brace,
 * and on a regular-expression literal — all of which appear in ordinary game
 * code. The idea (send the *failing function*, verbatim) is right; the
 * extraction is what was wrong.
 *
 * Here the slice comes from the syntax tree, so the function that is sliced is
 * the function that exists. A slice is always **verbatim from disk**, because
 * the whole contract with the AI is that its `FIND` block will match
 * character-for-character.
 */

import type Parser from 'tree-sitter';
import { parseSource } from '../parse/grammars.js';
import type { GrammarName } from '../parse/grammars.js';

/** A verbatim slice of a file, with the line numbers the AI needs. */
export interface Slice {
  /** Project-relative path. */
  file: string;
  /** The function's name, or `null` for a module-level slice. */
  symbol: string;
  /** 1-indexed, inclusive. */
  startLine: number;
  /** 1-indexed, inclusive. */
  endLine: number;
  /** The exact text, byte for byte, including the original indentation. */
  text: string;
  /** The whole file, when the slice was a fallback. */
  isWholeFile: boolean;
}

/** Languages a slice can be taken from. */
const SLICE_GRAMMARS = new Set<GrammarName>(['javascript', 'typescript', 'tsx', 'gdscript']);

/** One named function found in a file. */
export interface FunctionLocation {
  name: string;
  startLine: number;
  endLine: number;
  /** How deeply nested, so the innermost match can be preferred. */
  depth: number;
}

/**
 * List every function in a file, with its line span.
 *
 * Walked from the tree rather than matched from text, so a `function` inside a
 * comment or a string is not a function (SPEC R5). Ordered by start line, which
 * makes two runs over one file identical (SPEC R8).
 */
export function findFunctions(source: string, filePath: string): FunctionLocation[] {
  const grammar = grammarOf(filePath);
  if (grammar === null || !SLICE_GRAMMARS.has(grammar)) return [];

  const { tree } = parseSource(source, filePath);
  const found: FunctionLocation[] = [];

  const visit = (node: Parser.SyntaxNode, depth: number): void => {
    const name = functionName(node);
    if (name !== null) {
      found.push({
        name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        depth,
      });
    }
    for (const child of node.namedChildren) visit(child, depth + 1);
  };

  visit(tree.rootNode, 0);
  return found.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

/** The grammar that applies, or null when the file has none. */
function grammarOf(filePath: string): GrammarName | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.gd')) return 'gdscript';
  if (lower.endsWith('.tsx')) return 'tsx';
  if (/\.(m|c)?[jt]sx?$/.test(lower)) return /\.(m|c)?tsx$/.test(lower) ? 'tsx' : 'javascript';
  return null;
}

/** A node's function name, or null when it is not a function definition. */
function functionName(node: Parser.SyntaxNode): string | null {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration':
    case 'function_definition': {
      // `function_definition` is the node type in BOTH the JS and the GDScript
      // grammar — the GDScript one is `func name(...):` — so this case covers
      // both. Guessing `function_signature` instead, as an earlier draft did,
      // silently returns nothing for every Godot file.
      const name = node.childForFieldName('name');
      return name ? name.text : null;
    }
    case 'method_definition': {
      const name = node.childForFieldName('name');
      return name ? name.text : null;
    }
    case 'arrow_function':
    case 'function_expression': {
      // Only named when assigned (`const f = () => {}`), because an anonymous
      // one has no name to slice by and guessing one invents context.
      const parent = node.parent;
      if (parent === null) return null;
      if (parent.type === 'variable_declarator') {
        const name = parent.childForFieldName('name');
        return name ? name.text : null;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Extract the function containing `line`, verbatim.
 *
 * Prefers the **innermost** function covering the line: an error inside a
 * method of a class is fixed by seeing the method, not the whole class. Ties
 * (two functions starting on one line) break on the shorter span, then on the
 * name, so the result is deterministic.
 */
export function sliceFunctionAtLine(
  source: string,
  filePath: string,
  line: number,
): Slice | null {
  const functions = findFunctions(source, filePath);
  if (functions.length === 0) return null;

  const containing = functions
    .filter((fn) => fn.startLine <= line && line <= fn.endLine)
    .sort(
      (a, b) =>
        b.depth - a.depth ||
        a.endLine - a.startLine - (b.endLine - b.startLine) ||
        a.name.localeCompare(b.name),
    );

  const chosen = containing[0];
  if (chosen === undefined) return null;

  return sliceByLines(source, filePath, chosen.startLine, chosen.endLine, chosen.name, false);
}

/**
 * Extract a named function, verbatim.
 *
 * The innermost match wins for the same reason as above. Returns null when no
 * such function exists — which is a real answer, not a failure: the compiler
 * reports that the named symbol was not found rather than attaching the wrong
 * function and letting the AI patch something it was never shown.
 */
export function sliceFunctionByName(
  source: string,
  filePath: string,
  name: string,
): Slice | null {
  const functions = findFunctions(source, filePath);
  const matches = functions
    .filter((fn) => fn.name === name)
    .sort((a, b) => b.depth - a.depth || a.startLine - b.startLine);

  const chosen = matches[0];
  if (chosen === undefined) return null;

  return sliceByLines(source, filePath, chosen.startLine, chosen.endLine, chosen.name, false);
}

/** A window of lines centred on `line`. */
export function sliceAroundLine(
  source: string,
  filePath: string,
  line: number,
  contextLines = 5,
): Slice | null {
  const lines = source.split('\n');
  if (lines.length === 0) return null;

  const target = Math.min(Math.max(line, 1), lines.length);
  const start = Math.max(1, target - contextLines);
  const end = Math.min(lines.length, target + contextLines);

  return {
    file: filePath,
    symbol: '',
    startLine: start,
    endLine: end,
    text: lines.slice(start - 1, end).join('\n'),
    isWholeFile: false,
  };
}

/** The entire file as a slice. Used when nothing more specific is known. */
export function sliceWholeFile(source: string, filePath: string): Slice {
  const lines = source.split('\n');
  return {
    file: filePath,
    symbol: '',
    startLine: 1,
    endLine: lines.length,
    text: source,
    isWholeFile: true,
  };
}

/** Build a slice from an explicit 1-indexed inclusive line range. */
function sliceByLines(
  source: string,
  filePath: string,
  startLine: number,
  endLine: number,
  symbol: string,
  isWholeFile: boolean,
): Slice {
  const lines = source.split('\n');
  return {
    file: filePath,
    symbol,
    startLine,
    endLine,
    // No trimming: leading indentation is part of the text the AI must
    // reproduce, and trimming it is how a patch silently fails to match.
    text: lines.slice(startLine - 1, endLine).join('\n'),
    isWholeFile,
  };
}

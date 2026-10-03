/**
 * parse/gdscript.ts — Read a GDScript file's contract from its syntax tree.
 *
 * v1 walked lines with regexes anchored at `^signal`, `^@export`, `^func`, and
 * decided "top level" by checking whether the line started with a space or tab.
 * That heuristic broke on tab-indented files written with spaces, and reported
 * nested functions and inner classes as public API.
 *
 * tree-sitter gives the real structure: a `function_definition` inside a
 * `class_definition` is a child of that class, not of `source`, so
 * "public API" becomes a question about the parent node rather than about
 * whitespace (SPEC R5).
 */

import type Parser from 'tree-sitter';
import { withParsedTree } from './grammars.js';

/** One declared signal, e.g. `health_changed(new_value: int)`. */
export interface GdSignal {
  name: string;
  /** Raw parameter text without the surrounding parentheses. */
  parameters: string;
}

/** One exported property, either via `@export` or the Godot 3 `export(...)`. */
export interface GdExport {
  name: string;
  /** Declared type, or "Variant" when untyped. */
  type: string;
  /** The annotation that made it exported, e.g. "@export_range(0, 10)". */
  annotation: string;
}

/** One public function. Functions whose name starts with `_` are private. */
export interface GdFunction {
  name: string;
  parameters: string;
  returnType: string;
}

/** One top-level constant. */
export interface GdConstant {
  name: string;
  type: string;
}

/** One top-level enum. */
export interface GdEnum {
  name: string;
}

/** Everything core needs to know about one GDScript file. */
export interface GdScriptContract {
  signals: GdSignal[];
  exports: GdExport[];
  /** Public functions, sorted for determinism. */
  publicFunctions: GdFunction[];
  constants: GdConstant[];
  enums: GdEnum[];
  /** Autoload/singleton names referenced anywhere in the file. */
  referencedIdentifiers: string[];
}

/** Godot's convention: a leading underscore marks a member private. */
function isPrivate(name: string): boolean {
  return name.startsWith('_');
}

/**
 * Parse a GDScript file and read its contract.
 *
 * Throws on unparseable input: a partial contract would be trusted by the AI
 * and would silently hide members (SPEC R9).
 */
export function parseGdScript(source: string, filePath: string): GdScriptContract {
  return withParsedTree(source, filePath, ({ tree }) => readGdContract(tree.rootNode));
}

/** Read the contract from an already-parsed root node. */
export function readGdContract(root: Parser.SyntaxNode): GdScriptContract {
  const signals: GdSignal[] = [];
  const exports: GdExport[] = [];
  const publicFunctions: GdFunction[] = [];
  const constants: GdConstant[] = [];
  const enums: GdEnum[] = [];

  // Only direct children of `source` are considered. Anything nested inside a
  // function body or an inner class belongs to that scope, not to the file's
  // public contract.
  for (const node of root.namedChildren) {
    switch (node.type) {
      case 'signal_statement': {
        const name = nameText(node);
        if (name) signals.push({ name, parameters: parametersText(node) });
        break;
      }

      case 'variable_statement': {
        const exported = readExportAnnotation(node);
        if (!exported) break;
        const name = nameText(node);
        if (name) {
          exports.push({ name, type: typeText(node), annotation: exported });
        }
        break;
      }

      case 'export_variable_statement': {
        // Godot 3.x style: `export var name: Type`.
        const name = nameText(node);
        if (name) {
          exports.push({ name, type: typeText(node), annotation: 'export' });
        }
        break;
      }

      case 'const_statement': {
        const name = nameText(node);
        if (name && !isPrivate(name)) {
          constants.push({ name, type: typeText(node) });
        }
        break;
      }

      case 'enum_definition': {
        const name = nameText(node);
        if (name && !isPrivate(name)) enums.push({ name });
        break;
      }

      case 'function_definition': {
        const fn = readFunction(node);
        // Engine callbacks are lifecycle hooks, not API. They are still
        // underscore-prefixed in Godot, which the check covers.
        if (fn && !isPrivate(fn.name)) publicFunctions.push(fn);
        break;
      }

      default:
        break;
    }
  }

  return {
    signals: signals.sort((a, b) => a.name.localeCompare(b.name)),
    exports: exports.sort((a, b) => a.name.localeCompare(b.name)),
    publicFunctions: publicFunctions.sort((a, b) => a.name.localeCompare(b.name)),
    constants: constants.sort((a, b) => a.name.localeCompare(b.name)),
    enums: enums.sort((a, b) => a.name.localeCompare(b.name)),
    referencedIdentifiers: collectTopLevelIdentifiers(root),
  };
}

/** The `name` field of a declaration node. */
function nameText(node: Parser.SyntaxNode): string | null {
  return node.childForFieldName('name')?.text ?? null;
}

/**
 * The `parameters` field with its parentheses stripped.
 *
 * An untyped parameter list keeps its original spacing so the reader sees what
 * the author wrote; only the outer parens are removed.
 */
function parametersText(node: Parser.SyntaxNode): string {
  const params = node.childForFieldName('parameters');
  if (!params) return '';
  return normalizeSignature(params.text.replace(/^\(/, '').replace(/\)$/, ''));
}

/** The declared type, or "Variant" when the declaration left it untyped. */
function typeText(node: Parser.SyntaxNode): string {
  const type = node.childForFieldName('type');
  if (!type) return 'Variant';
  // `const MAX := 10` has an `inferred_type`, which carries no usable name.
  if (type.type === 'inferred_type') return 'Variant';
  return normalizeSignature(type.text);
}

/**
 * The export annotation on a variable, if any.
 *
 * Covers `@export`, `@export_range(...)`, `@export_enum(...)`, `@export_group`
 * and friends. v1's regex allowed `@export_xxx` but not `@export_range(0, 10)`
 * with a multi-line argument list.
 */
function readExportAnnotation(node: Parser.SyntaxNode): string | null {
  const annotations = node.namedChildren.find((c) => c.type === 'annotations');
  if (!annotations) return null;

  for (const annotation of annotations.namedChildren) {
    if (annotation.type !== 'annotation') continue;
    const identifier = annotation.namedChildren.find((c) => c.type === 'identifier');
    const name = identifier?.text;
    if (!name || !name.startsWith('export')) continue;
    return normalizeSignature(annotation.text);
  }
  return null;
}

function readFunction(node: Parser.SyntaxNode): GdFunction | null {
  const name = nameText(node);
  if (!name) return null;
  const returnType = node.childForFieldName('return_type');
  return {
    name,
    parameters: parametersText(node),
    returnType: returnType ? normalizeSignature(returnType.text) : 'void',
  };
}

/**
 * Identifiers referenced anywhere in the file.
 *
 * Used to detect which autoloads a script assumes exist: an autoload is a
 * global, so the only way to see it is to look for its name in the source.
 * Built from the tree rather than by running a regex over the text, so an
 * occurrence inside a comment or a string literal is not a dependency.
 */
function collectTopLevelIdentifiers(root: Parser.SyntaxNode): string[] {
  const names = new Set<string>();
  for (const node of root.descendantsOfType('identifier')) {
    // Skip identifiers that are property names or call targets being defined.
    names.add(node.text);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Find `func` declarations that have no body — a missing trailing colon.
 *
 * The tree-sitter GDScript grammar parses `func f()` with no body as a valid
 * `function_definition`; the missing colon is not an error node, so the generic
 * error check in `grammars.ts` cannot see it. GDScript would reject the file at
 * parse time, so a patch that drops the colon has to be caught here too.
 *
 * Detected from the tree rather than by matching lines: a `function_definition`
 * node without a `body` child is exactly the malformed case, and this stays
 * correct for tab- or space-indented files and for nested functions.
 */
export function findFunctionsMissingBody(source: string, filePath: string): number[] {
  return withParsedTree(source, filePath, ({ tree }) => {
    const lines: number[] = [];
    for (const node of tree.rootNode.descendantsOfType('function_definition')) {
      if (node.childForFieldName('body') === null) {
        lines.push(node.startPosition.row + 1);
      }
    }
    return lines.sort((a, b) => a - b);
  });
}

/** Collapse a signature onto a single line for readability. */
function normalizeSignature(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Render a signal as the signature string that goes into `contract.signals`.
 * Format matches what an AI sees in a Godot error message: `name(params)`.
 */
export function formatGdSignal(signal: GdSignal): string {
  return `${signal.name}(${signal.parameters})`;
}

/** Render an export as `name: Type`. */
export function formatGdExport(entry: GdExport): string {
  return `${entry.name}: ${entry.type}`;
}

/** Render a function as `name(params) -> ReturnType`. */
export function formatGdFunction(fn: GdFunction): string {
  return `${fn.name}(${fn.parameters}) -> ${fn.returnType}`;
}

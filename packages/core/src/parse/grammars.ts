/**
 * parse/grammars.ts — tree-sitter grammar loading (SPEC R5).
 *
 * v2 parses JS, TS and GDScript with real syntax trees. This module owns the
 * lifecycle of the native parsers so the rest of core never touches the
 * `tree-sitter` binding directly.
 *
 * Why native and not `web-tree-sitter`:
 *  - the prebuilt wasm grammar set has no GDScript grammar, and Godot is half
 *    of this app's target engines;
 *  - mixing a 0.25 runtime with 0.27-era grammars fails to load with an opaque
 *    "dylink metadata" error, so the wasm path couples core to an ABI-matched
 *    pair that has to be kept in step by hand.
 * The wasm runtime is the right tool for the renderer (Step 3), where only
 * JS/TS/JSON grammars are needed.
 *
 * Grammar modules are loaded lazily and cached per process: constructing a
 * parser and loading a grammar costs far more than parsing a small file, so
 * paying it once per grammar is the whole difference.
 */

import Parser from 'tree-sitter';
import JavaScriptModule from 'tree-sitter-javascript';
import TypeScriptModule from 'tree-sitter-typescript';
import GDScriptModule from 'tree-sitter-gdscript';

/** Languages core can parse. */
export type GrammarName = 'javascript' | 'typescript' | 'tsx' | 'gdscript';

/**
 * The shape every `tree-sitter-*` grammar package's default export has:
 * a wrapper whose `language` field is the native handle.
 */
interface GrammarPackageExport {
  name?: string;
  language: unknown;
  nodeTypeInfo?: unknown;
}

/**
 * `tree-sitter-typescript` exports two named grammars through a single
 * CommonJS `export =` object. Unwrap both, once, here.
 */
interface TypeScriptGrammars {
  typescript: GrammarPackageExport;
  tsx: GrammarPackageExport;
}

function isGrammarExport(value: unknown): value is GrammarPackageExport {
  return (
    typeof value === 'object' &&
    value !== null &&
    'language' in value &&
    (value as { language: unknown }).language !== undefined
  );
}

function asGrammarExport(
  value: unknown,
  packageName: string,
): GrammarPackageExport {
  const record = value as Record<string, unknown> | null | undefined;
  // Some packages nest the handle under `.default` after interop.
  for (const candidate of [record?.['language'], record?.['default'], record]) {
    if (isGrammarExport(candidate)) return candidate;
  }
  throw new Error(
    `${packageName} did not expose a tree-sitter grammar handle. ` +
      'Check that the installed version matches package.json.',
  );
}

function resolveTypeScriptGrammars(moduleValue: unknown): TypeScriptGrammars {
  const record = moduleValue as Record<string, unknown> | null | undefined;
  const typescript = record?.['typescript'];
  const tsx = record?.['tsx'];
  if (!typescript || !tsx) {
    throw new Error(
      'tree-sitter-typescript did not expose the "typescript" and "tsx" grammars. ' +
        'Check that the installed version matches package.json.',
    );
  }
  return {
    typescript: asGrammarExport(typescript, 'tree-sitter-typescript'),
    tsx: asGrammarExport(tsx, 'tree-sitter-typescript'),
  };
}

/**
 * A native grammar handle, keyed by language name.
 *
 * Values are the grammar *wrapper* objects rather than their inner `.language`
 * handles: `Parser.setLanguage` reads the wrapper's `nodeTypeInfo` when it needs
 * a node type by index, so passing the bare handle throws deep inside the
 * binding with an unhelpful "Cannot read properties of undefined". The upstream
 * `.d.ts` types these wrappers structurally, which is why the cast is here.
 */
type NativeGrammars = Record<GrammarName, Parser.Language>;

let cached: NativeGrammars | null = null;

/** Load and cache every grammar. Cheap after the first call. */
function loadGrammars(): NativeGrammars {
  if (cached) return cached;

  const ts = resolveTypeScriptGrammars(TypeScriptModule);

  cached = {
    javascript: asGrammarExport(
      JavaScriptModule,
      'tree-sitter-javascript',
    ) as Parser.Language,
    typescript: ts.typescript as Parser.Language,
    tsx: ts.tsx as Parser.Language,
    gdscript: asGrammarExport(GDScriptModule, 'tree-sitter-gdscript') as Parser.Language,
  };
  return cached;
}

/**
 * One parser per language, reused across calls.
 *
 * Constructing a `Parser` and calling `setLanguage` costs roughly 150ms —
 * measured at 19s to extract a 109-node project when a fresh parser was built
 * per file, versus well under a second when reused. The native parser holds a
 * single language at a time, so one instance per language is all that is needed.
 *
 * A parser is not thread-safe, and core runs single-threaded; Vitest uses fork
 * workers, so each worker process owns its own set.
 */
const parserCache = new Map<GrammarName, Parser>();

function getParser(grammarName: GrammarName): Parser {
  const existing = parserCache.get(grammarName);
  if (existing) return existing;

  const parser = new Parser();
  parser.setLanguage(loadGrammars()[grammarName]);
  parserCache.set(grammarName, parser);
  return parser;
}

/**
 * Choose the grammar for a file path.
 *
 * `.mjs`/`.cjs` are JavaScript with a different module system, which the
 * JavaScript grammar handles; `.mts`/`.cts` are TypeScript.
 */
export function grammarForPath(filePath: string): GrammarName | null {
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return null;
  switch (lower.slice(dot)) {
    case '.js':
    case '.mjs':
    case '.cjs':
    case '.jsx':
      return 'javascript';
    case '.ts':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.tsx':
      return 'tsx';
    case '.gd':
      return 'gdscript';
    default:
      return null;
  }
}

/** A parsed tree plus the grammar that produced it. */
export interface ParsedTree {
  tree: Parser.Tree;
  grammar: GrammarName;
}

/**
 * Run `use` with a parsed tree.
 *
 * A thin wrapper that makes the parse-then-read shape explicit at every call
 * site. Tree memory is reclaimed by the garbage collector — the 0.22 native
 * binding exposes no explicit `delete` — so nothing needs releasing here.
 */
export function withParsedTree<T>(
  source: string,
  filePath: string,
  use: (parsed: ParsedTree) => T,
): T {
  return use(parseSource(source, filePath));
}

/**
 * Parse source text into a tree.
 *
 * Throws with the file path and the reason when the text cannot be parsed — the
 * syntax pre-check, which must inspect broken input, uses `tryParse` instead.
 */
export function parseSource(source: string, filePath: string): ParsedTree {
  const outcome = tryParse(source, filePath);
  if (!outcome.ok) {
    throw new Error(`Failed to parse "${filePath}": ${outcome.message}`);
  }
  return outcome.tree;
}

/** Outcome of a parse that is allowed to fail. */
export type ParseOutcome =
  | { ok: true; tree: ParsedTree }
  | { ok: false; message: string; line: number | null };

/**
 * Parse without throwing, for callers that must inspect broken input.
 *
 * A tree is always produced by tree-sitter, but a root containing `ERROR`
 * nodes means the text is not valid in this language. That is reported as a
 * failure rather than returned: extracting a contract from a half-broken tree
 * would hand an AI a confident, wrong answer (SPEC R9).
 */
export function tryParse(source: string, filePath: string): ParseOutcome {
  const grammarName = grammarForPath(filePath);
  if (grammarName === null) {
    return {
      ok: false,
      message: `No tree-sitter grammar for "${filePath}"`,
      line: null,
    };
  }

  let parser: Parser;
  try {
    parser = getParser(grammarName);
  } catch (error) {
    return {
      ok: false,
      message: `Could not initialise tree-sitter: ${describe(error)}`,
      line: null,
    };
  }

  let tree: Parser.Tree;
  try {
    tree = parser.parse(source);
  } catch (error) {
    return { ok: false, message: describe(error), line: null };
  }

  const first = findFirstDefect(tree.rootNode);

  if (first) {
    const message = first.isMissing
      ? `Syntax error: missing ${describeMissing(first)}`
      : `Syntax error near "${first.text.slice(0, 60).replace(/\n/g, ' ')}"`;
    return { ok: false, message, line: first.startPosition.row + 1 };
  }

  // `hasError` can still be true with no ERROR/MISSING node reachable from the
  // root; report it without a position rather than claiming success.
  if (tree.rootNode.hasError) {
    return { ok: false, message: 'Syntax error', line: null };
  }

  return { ok: true, tree: { tree, grammar: grammarName } };
}

/**
 * Find the earliest ERROR or MISSING node under `root`.
 *
 * A manual walk over `children` rather than `descendantsOfType`, because that
 * API does not surface MISSING nodes: for `return a + ;` the tree contains
 * `binary_expression(identifier, '+', identifier)` where the second operand is a
 * zero-width insertion with `isMissing === true` but an ordinary `identifier`
 * type, so searching for the type "MISSING" returns nothing. Only a walk that
 * visits every child sees it.
 *
 * The walk is depth-first in source order and returns as soon as a defect is
 * found, so a valid file costs one full traversal and a broken one stops early.
 *
 * `node.children` is read ONCE per node into a local, and that is the whole fix.
 * In the tree-sitter Node binding `.children` is not a property that returns a
 * cached array — every read MATERIALISES fresh SyntaxNode objects for the entire
 * subtree. The loop below used to read it twice (once for `.length`, once per
 * index), and since a node's cost was proportional to its own subtree size, the
 * sum over siblings went quadratic: the audit measured 23.6 s for an 80 KB
 * generated module where `parser.parse` alone is 5 ms, and 3.09x time for a 2x
 * input. That runs on the main thread, so one generated file froze the whole app
 * — every IPC channel, the watchers and the UI behind them.
 *
 * Hoisting it does not change which node is found: same nodes, same order, same
 * first-defect-wins result (D53).
 */
function findFirstDefect(root: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const stack: Parser.SyntaxNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) break;

    if (node.type === 'ERROR' || node.isMissing) {
      return node;
    }

    // Read once. See above.
    const children = node.children;
    // Pushed in reverse so children are visited left to right.
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child) stack.push(child);
    }
  }

  return null;
}

/**
 * Name the token a MISSING node stands in for.
 *
 * tree-sitter records the expected token as the MISSING node's own `type` — for
 * an unclosed function that node has `type === '}'` and zero width. Reading it
 * from there is the only version that is actually correct.
 *
 * It used to be read from the nearest named sibling *before* the insertion,
 * which is a different question entirely. For `function greet() {\n const a = 1;`
 * the preceding sibling is `lexical_declaration`, so an unclosed function was
 * reported as "missing lexical_declaration" — a sentence describing the last
 * thing that happened to parse rather than the thing that is absent. The same
 * bug rendered an unclosed `if` as "missing if_statement", and because the
 * renderer translated the sibling's type, the message shown to a developer
 * ("expected a return statement") could name a construct that was not missing
 * at all. A wrong diagnosis is worse than none: it sends the AI's next turn,
 * and the developer's, looking in the wrong file.
 *
 * Internal grammar names are mapped to plain words; the raw name is kept for
 * anything unrecognised rather than dropped, so an unfamiliar token still
 * reports something better than "token".
 */
function describeMissing(node: Parser.SyntaxNode): string {
  const type = node.type.trim();
  if (type === '' || type === 'ERROR') return 'token';
  return PLAIN_NODE_NAMES.get(type) ?? type;
}

/** Grammar node names that read as jargon in a one-line user-facing message. */
const PLAIN_NODE_NAMES = new Map<string, string>([
  ['identifier', 'a name or identifier'],
  ['statement_block', 'a block of code { ... }'],
  ['binary_expression', 'an expression'],
  ['call_expression', 'a function call'],
  ['return_statement', 'a return statement'],
]);

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Direct named children of `node` whose type is in `types`. */
export function childrenOfType(
  node: Parser.SyntaxNode,
  types: ReadonlySet<string>,
): Parser.SyntaxNode[] {
  return node.namedChildren.filter((child) => types.has(child.type));
}

/** The text of a node's named field, if the field is present. */
export function fieldText(
  node: Parser.SyntaxNode,
  fieldName: string,
): string | undefined {
  const field = node.childForFieldName(fieldName);
  return field ? field.text : undefined;
}

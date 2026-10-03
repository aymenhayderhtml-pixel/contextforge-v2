/**
 * parse/js.ts — Read a JS/TS module's contract and imports from its syntax tree.
 *
 * v1 did this with line-by-line regexes (`^export function`, `^export {`), which
 * silently missed:
 *   - `export\n  function foo()`      (declaration on the next line)
 *   - `export { a, b as c }`          (named re-export with aliasing)
 *   - `export * from './x.js'`        (star re-export)
 *   - a comment line reading "// export function fake()"
 *   - `const x = {}; export { x };`  (indirect export)
 * All of those are answered here by walking `export_statement` nodes (SPEC R5).
 */

import type Parser from 'tree-sitter';
import { withParsedTree } from './grammars.js';

/** One import specifier resolved to a project-relative path. */
export interface JsImport {
  /** Raw specifier as written, e.g. "./utils.js". */
  specifier: string;
  /** Imported binding names, with aliases as `original as alias`. */
  names: string[];
  /** True for `import * as ns` / bare side-effect imports. */
  isNamespaceOrSideEffect: boolean;
}

/** One export specifier read from the tree. */
export interface JsExport {
  /**
   * What was exported. `default_function` / `default_class` are distinct from
   * `function` / `class` because the reader needs to see that the binding is the
   * module's default, not a named export.
   */
  kind:
    | 'function'
    | 'class'
    | 'const'
    | 'let'
    | 'var'
    | 'default_function'
    | 'default_class'
    | 'default'
    | 'specifier';
  /** Binding name, or the alias in `original as alias`. */
  name: string;
  /** Present when the export declared a parameter list. */
  parameters?: string;
  /** Present when the export declared a return type. */
  returnType?: string;
}

/** Everything core needs to know about one JS/TS module. */
export interface JsModuleContract {
  imports: JsImport[];
  exports: JsExport[];
  /** String literals that look like asset paths. */
  assetRefs: string[];
}

/** Extensions treated as asset files when referenced from a string literal. */
const ASSET_EXTENSIONS = new Set([
  '.glb', '.gltf', '.obj', '.fbx',
  '.png', '.jpg', '.jpeg', '.svg', '.webp',
  '.wav', '.ogg', '.mp3',
  '.ktx', '.hdr',
]);

/**
 * Parse a module and read its contract.
 *
 * Throws if the source cannot be parsed: a module with a broken contract is
 * worse than no contract, because the AI will trust it (SPEC R9).
 */
export function parseJsModule(source: string, filePath: string): JsModuleContract {
  return withParsedTree(source, filePath, ({ tree }) => readJsContract(tree.rootNode));
}

/** Read the contract from an already-parsed root node. */
export function readJsContract(root: Parser.SyntaxNode): JsModuleContract {
  const imports: JsImport[] = [];
  const exports: JsExport[] = [];

  for (const statement of root.namedChildren) {
    switch (statement.type) {
      case 'import_statement':
        imports.push(...readImportStatement(statement));
        break;
      case 'export_statement':
        exports.push(...readExportStatement(statement));
        break;
      default:
        break;
    }
  }

  imports.push(...collectDynamicImports(root));

  return {
    imports,
    exports: dedupeExports(exports),
    assetRefs: collectAssetRefs(root),
  };
}

/**
 * Find `import('./x')` calls.
 *
 * A dynamic import is a real dependency — lazy-loading a module still couples
 * the two files, and an AI that renames the module has to know. v1 resolved
 * imports with `madge`, which also caught these, so this keeps parity.
 */
function collectDynamicImports(root: Parser.SyntaxNode): JsImport[] {
  const found: JsImport[] = [];
  const seen = new Set<string>();

  for (const call of root.descendantsOfType('call_expression')) {
    const callee = call.childForFieldName('function');
    // The callee node type for `import(...)` is "import"; `require(...)` is a
    // plain identifier. Both are module loads.
    const isDynamicImport = callee?.type === 'import';
    const isRequire = callee?.type === 'identifier' && callee.text === 'require';
    if (!isDynamicImport && !isRequire) continue;

    const args = call.childForFieldName('arguments');
    const first = args?.namedChildren[0];
    if (!first || first.type !== 'string') continue;

    const specifier = stripQuotes(first.text);
    if (seen.has(specifier)) continue;
    seen.add(specifier);
    found.push({ specifier, names: [], isNamespaceOrSideEffect: true });
  }

  return found;
}

function readImportStatement(node: Parser.SyntaxNode): JsImport[] {
  const source = node.childForFieldName('source');
  const specifier = source ? stripQuotes(source.text) : null;
  if (specifier === null) return [];

  const names: string[] = [];
  let isNamespaceOrSideEffect = true;

  // The clause is not under a named field in the tree-sitter JS grammar, so it
  // is found by type. A statement with no clause is a side-effect import.
  const clause = node.namedChildren.find((child) => child.type === 'import_clause');
  if (clause) {
    isNamespaceOrSideEffect = false;
    for (const spec of clause.namedChildren) {
      if (spec.type === 'identifier') {
        names.push(spec.text);
      } else if (spec.type === 'namespace_import') {
        const alias = spec.namedChildren.find((c) => c.type === 'identifier');
        if (alias) names.push(`* as ${alias.text}`);
      } else if (spec.type === 'named_imports') {
        for (const item of spec.namedChildren) {
          if (item.type !== 'import_specifier') continue;
          const imported = item.childForFieldName('name');
          const aliasNode = item.childForFieldName('alias');
          if (!imported) continue;
          names.push(
            aliasNode ? `${imported.text} as ${aliasNode.text}` : imported.text,
          );
        }
      }
    }
  }

  return [{ specifier, names, isNamespaceOrSideEffect }];
}

/**
 * True when an `export_statement` uses the `default` keyword.
 *
 * `default` is an unnamed token, so it never appears in `namedChildren`; it has
 * to be looked for among all children.
 */
function isDefaultExport(node: Parser.SyntaxNode): boolean {
  return node.children.some((child) => child.type === 'default');
}

function readExportStatement(node: Parser.SyntaxNode): JsExport[] {
  const results: JsExport[] = [];
  const declaration = node.childForFieldName('declaration');
  const source = node.childForFieldName('source');
  const isDefault = isDefaultExport(node);

  // export ... from './x' — re-export; the declaration lives in the other file.
  if (source) {
    for (const spec of node.namedChildren) {
      if (spec.type === 'export_clause') {
        for (const item of spec.namedChildren) {
          if (item.type === 'export_specifier') {
            const alias = item.childForFieldName('alias');
            const name = item.childForFieldName('name');
            results.push({
              kind: 'specifier',
              name: alias ? `${name?.text} as ${alias.text}` : (name?.text ?? item.text),
            });
          }
        }
      } else if (spec.type === 'namespace_export') {
        results.push({ kind: 'specifier', name: '*' });
      }
    }
    if (results.length === 0) {
      // `export * from './x'` with nothing else.
      results.push({ kind: 'specifier', name: '*' });
    }
    return results;
  }

  if (declaration) {
    switch (declaration.type) {
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = declaration.childForFieldName('name')?.text ?? 'anonymous';
        const fn = describeFunction(declaration);
        results.push({
          kind: isDefault ? 'default_function' : 'function',
          name,
          ...fn,
        });
        return results;
      }
      case 'class_declaration': {
        const name = declaration.childForFieldName('name')?.text ?? 'anonymous';
        results.push({ kind: isDefault ? 'default_class' : 'class', name });
        return results;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        const kind = declaration.type === 'lexical_declaration'
          ? (declaration.text.trimStart().startsWith('const') ? 'const' : 'let')
          : 'var';
        for (const declarator of declaration.namedChildren) {
          if (declarator.type !== 'variable_declarator') continue;
          for (const name of declaredNames(declarator)) {
            results.push({ kind: isDefault ? 'default' : kind, name });
          }
        }
        return results;
      }
      default:
        // `export default 42` and similar: the exported thing is the value.
        if (isDefault) {
          results.push({ kind: 'default', name: describeExpression(declaration) });
        }
        return results;
    }
  }

  // export { a, b as c }  |  export default <expression>
  for (const spec of node.namedChildren) {
    if (spec.type === 'export_clause') {
      for (const item of spec.namedChildren) {
        if (item.type !== 'export_specifier') continue;
        const nameNode = item.childForFieldName('name');
        const alias = item.childForFieldName('alias');
        const label = alias
          ? `${nameNode?.text ?? item.text} as ${alias.text}`
          : (nameNode?.text ?? item.text);
        results.push({ kind: isDefault ? 'default' : 'specifier', name: label });
      }
      continue;
    }
    if (isDefault && spec.type !== 'export_clause') {
      // `export default v` — the exported value sits in the `value` field.
      results.push({ kind: 'default', name: describeExpression(spec) });
    }
  }
  return results;
}

/**
 * Names bound by a variable declarator.
 *
 * Handles destructuring, so `export const { a, b } = cfg` reports both bindings.
 * v1's `(\w+)` capture returned the literal text `{` for that declaration.
 */
function declaredNames(declarator: Parser.SyntaxNode): string[] {
  const nameNode = declarator.childForFieldName('name');
  if (!nameNode) return [];
  if (nameNode.type === 'identifier') return [nameNode.text];

  const names: string[] = [];
  for (const ident of nameNode.descendantsOfType('shorthand_property_identifier_pattern')) {
    names.push(ident.text);
  }
  for (const ident of nameNode.descendantsOfType('object_pattern')) {
    for (const shorthand of ident.namedChildren) {
      if (shorthand.type === 'shorthand_property_identifier_pattern') names.push(shorthand.text);
    }
  }
  for (const pair of nameNode.descendantsOfType('pair_pattern')) {
    const key = pair.namedChildren.find((c) => c.type === 'property_identifier');
    if (key) names.push(key.text);
  }
  if (names.length === 0) names.push(nameNode.text.replace(/[{}[\]]/g, '').trim());
  return names.filter((n) => n.length > 0);
}

/**
 * Collapse a parameter list onto one line.
 *
 * These strings are read by an AI, so a signature split across three lines is
 * noise; it also keeps signatures comparable between files that format
 * differently.
 */
function normalizeSignature(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function describeFunction(node: Parser.SyntaxNode): {
  parameters?: string;
  returnType?: string;
} {
  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('return_type');
  return {
    ...(params
      ? { parameters: normalizeSignature(params.text.replace(/^\(|\)$/g, '')) }
      : {}),
    ...(returnType
      ? { returnType: normalizeSignature(returnType.text.replace(/^:\s*/, '')) }
      : {}),
  };
}

function describeExpression(node: Parser.SyntaxNode): string {
  if (node.type === 'function' || node.type === 'function_expression') {
    const name = node.childForFieldName('name')?.text ?? 'anonymous';
    return `function ${name}`;
  }
  if (node.type === 'arrow_function') return 'arrow function';
  if (node.type === 'class') return 'class';
  return node.text.replace(/\s+/g, ' ').slice(0, 40);
}

/**
 * Collect string literals that reference asset files.
 *
 * Only `string` nodes are visited, so an asset path inside a comment is not a
 * dependency — the behaviour v1 got wrong with a bare regex over the source.
 */
function collectAssetRefs(root: Parser.SyntaxNode): string[] {
  const found = new Set<string>();
  for (const node of root.descendantsOfType('string')) {
    const raw = stripQuotes(node.text);
    for (const candidate of splitConcatenated(raw)) {
      const ext = extensionOf(candidate);
      if (ext !== null && ASSET_EXTENSIONS.has(ext)) {
        found.add(candidate);
      }
    }
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

/**
 * A call may concatenate the path, e.g. `loadModel('models/' + name + '.glb')`.
 * When a fragment ends with an asset extension we keep it as a dependency; this
 * is deliberately conservative — a partial path is still worth showing to the
 * AI as an asset it may not swap.
 */
function splitConcatenated(raw: string): string[] {
  return [raw];
}

function extensionOf(path: string): string | null {
  const withoutQuery = path.split(/[?#]/)[0] ?? path;
  const dot = withoutQuery.lastIndexOf('.');
  if (dot <= 0) return null;
  return withoutQuery.slice(dot).toLowerCase();
}

function stripQuotes(text: string): string {
  return text.replace(/^['"`]/, '').replace(/['"`]$/, '');
}

/**
 * Render a parsed export as the human-readable signature string that goes into
 * `contract.exports`. These strings are what an AI reads, so they are formatted
 * for reading rather than for round-tripping.
 */
export function formatJsExport(entry: JsExport): string {
  switch (entry.kind) {
    case 'function': {
      const params = entry.parameters ?? '';
      const ret = entry.returnType ? ` -> ${entry.returnType}` : '';
      return `function ${entry.name}(${params})${ret}`;
    }
    case 'class':
      return `class ${entry.name}`;
    case 'const':
    case 'let':
    case 'var':
      return `${entry.kind} ${entry.name}`;
    case 'default_function': {
      const params = entry.parameters ?? '';
      const ret = entry.returnType ? ` -> ${entry.returnType}` : '';
      return `default function ${entry.name}(${params})${ret}`;
    }
    case 'default_class':
      return `default class ${entry.name}`;
    case 'default':
      return `default ${entry.name}`;
    case 'specifier':
      return entry.name;
    default:
      return entry.name;
  }
}

/**
 * Collapse exports that describe the same binding.
 *
 * `export const dup = 1;` followed by `export { dup };` is one exported name
 * described twice, not two exports. Matching is on the *binding name* rather
 * than the rendered signature, so `const dup` and `dup` collapse while
 * `const load` and `function load` stay distinct.
 */
function dedupeExports(exports: JsExport[]): JsExport[] {
  const seen = new Set<string>();
  const result: JsExport[] = [];
  for (const entry of exports) {
    const key = bindingKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

/**
 * The identity of an exported binding.
 *
 * A bare specifier (`dup`) and a declaration of the same name
 * (`const dup`) share a key, so the first one seen wins — and declarations are
 * seen first because `export const ...` is encountered before any later
 * `export {}` clause in source order.
 *
 * A default export is keyed separately: `export const v = {}` followed by
 * `export default v` describes one value under two names (the named binding and
 * the default), and collapsing them would hide the default from the consumer.
 */
function bindingKey(entry: JsExport): string {
  if (entry.kind === 'specifier') {
    // "b as c" exports the local name `b` under the public name `c`.
    const aliasMatch = /^(.+)\s+as\s+(.+)$/.exec(entry.name);
    return aliasMatch ? `alias:${aliasMatch[1]}` : `name:${entry.name}`;
  }
  if (entry.kind.startsWith('default')) {
    return `default:${entry.name}`;
  }
  return `name:${entry.name}`;
}

/** Build the `contract.exports` array for a module from its parsed exports. */
export function jsContractExports(contract: JsModuleContract): string[] {
  return contract.exports.map(formatJsExport).sort((a, b) => a.localeCompare(b));
}

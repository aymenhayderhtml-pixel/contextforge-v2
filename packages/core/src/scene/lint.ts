/**
 * scene/lint.ts — enforce the prefab contract structurally (SPEC R7, §6.4).
 *
 * A prefab is supposed to be a pure function. Relying on the type signature to
 * keep it pure fails in the only way that matters: an AI writes `Math.random()`
 * into a prefab, the scene looks fine, and the project is no longer
 * reproducible. So each rule is checked by **reading the syntax tree**, not by
 * matching text.
 *
 * Five rules, each with a reason worth stating:
 *
 * | Rule | Why it is an error |
 * | --- | --- |
 * | `no-this` | State reached through a receiver survives between calls; the prefab is not a function of its arguments. |
 * | `no-dom-global` | `window`/`document` means the prefab only works in a browser, so core could never test it. |
 * | `no-scene-add` | The prefab would place itself, so it could never be placed twice or composed by the caller. |
 * | `no-math-random` | Unseeded randomness makes the scene non-reproducible and non-diffable. |
 * | `no-module-mutable-state` | A module-level `let` is shared by every instance: the second crate in a scene inherits the first's state. |
 *
 * **Why a tree, not a regex** (SPEC R5): `this` appears in a comment, in a
 * string, and as the first word of a sentence in a doc comment on every
 * prefab. A regex cannot tell those apart from an expression, so it either
 * false-flags every documented prefab or misses the real case. Walking nodes
 * knows the difference. The same applies to `Math.random` inside a comment, and
 * to a file that mentions `window` in prose.
 */

import { tryParse } from '../parse/grammars.js';

/** The rules the lint enforces, for code that is not itself broken. */
export const PREFAB_RULES = [
  'no-this',
  'no-dom-global',
  'no-scene-add',
  'no-math-random',
  'no-module-mutable-state',
] as const;

/**
 * Every rule the lint can report, including `parse-error`.
 *
 * `parse-error` is not a purity rule — it is the case where purity could not be
 * checked at all, and it is reported under the same shape so one render path
 * handles every outcome. A prefab that does not parse is not a passing prefab
 * (SPEC R9), so it cannot be left out of the union.
 */
export const LINT_RULES = [...PREFAB_RULES, 'parse-error'] as const;

/** One rule's name. */
export type PrefabRule = (typeof PREFAB_RULES)[number];

/** Any rule the lint can report. */
export type LintRule = (typeof LINT_RULES)[number];

/** One violation, located precisely enough to fix by hand. */
export interface LintViolation {
  rule: LintRule;
  /** 1-indexed line. */
  line: number;
  /** 1-indexed column. */
  column: number;
  /** What the code did, quoted. */
  text: string;
  message: string;
}

/** The result of linting one file. */
export interface LintResult {
  file: string;
  ok: boolean;
  violations: LintViolation[];
}

/** A one-line explanation of each rule, for `npm run lint:prefabs` output. */
export const PREFAB_RULE_REASONS: Record<PrefabRule, string> = {
  'no-this': 'prefab state must be passed in and returned, not reached through a receiver',
  'no-dom-global': 'a prefab must be pure; window/document make it untestable outside a browser',
  'no-scene-add': 'the caller composes the result; a prefab that adds itself cannot be placed twice',
  'no-math-random': 'randomness must be seeded so the scene is reproducible; use the injected rng',
  'no-module-mutable-state':
    'a module-level let is shared by every instance; state belongs to the create() call',
};

/** Globals that would make a prefab non-pure or non-headless. */
const DOM_GLOBALS = new Set(['window', 'document', 'navigator', 'localStorage', 'HTMLElement']);

/** Shortest node type we care about reporting. */
const MIN_REPORTED_LENGTH = 12;

/**
 * Lint one prefab source file.
 *
 * Returns violations rather than throwing: a prefab that breaks the contract is
 * a normal lint outcome, and a lint that throws on bad input cannot report more
 * than one problem at a time.
 *
 * A source that does not parse is reported as such. Silently passing an
 * unparseable file would be the worst possible answer — it looks like a clean
 * prefab (SPEC R9).
 */
export function lintPrefabSource(source: string, filePath: string): LintResult {
  const outcome = tryParse(source, filePath);

  if (!outcome.ok) {
    // Reporting an unparseable file as clean would be the worst possible
    // answer: it looks like a passing prefab (SPEC R9). A syntax error is
    // itself a lint failure.
    return {
      file: filePath,
      ok: false,
      violations: [
        {
          rule: 'parse-error',
          line: outcome.line ?? 1,
          column: 1,
          text: '',
          message:
            'prefab does not parse, so its purity cannot be checked: ' +
            outcome.message +
            ' (fix the syntax error; a prefab that does not compile is not a valid prefab)',
        },
      ],
    };
  }

  const violations = walkForViolations(outcome.tree.tree.rootNode);
  return { file: filePath, ok: violations.length === 0, violations };
}

/**
 * The rules, applied to an already-parsed root node.
 *
 * Exposed separately so a caller that already has a tree (the prefab linter
 * over a project, the Step 3 viewer) does not re-parse.
 */
export function lintPrefabTree(root: SyntaxNodeLike): LintViolation[] {
  return walkForViolations(root);
}

/**
 * The slice of a tree-sitter node this lint needs.
 *
 * Declared structurally rather than importing the binding, so the lint's own
 * tests can drive it with a stub and the package keeps no hard dependency on
 * the native module for this file.
 */
interface SyntaxNodeLike {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  namedChildren: SyntaxNodeLike[];
  childForFieldName(fieldName: string): SyntaxNodeLike | null;
  children: SyntaxNodeLike[];
}

function walkForViolations(root: SyntaxNodeLike): LintViolation[] {
  const violations: LintViolation[] = [];

  walk(root, null);

  return violations.sort(
    (a, b) => a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule),
  );

  function walk(node: SyntaxNodeLike, parent: SyntaxNodeLike | null): void {
    const violation = check(node, parent);
    if (violation) violations.push(violation);

    for (const child of node.namedChildren) {
      walk(child, node);
    }
  }

  function check(node: SyntaxNodeLike, parent: SyntaxNodeLike | null): LintViolation | null {
    switch (node.type) {
      // ── no-this ────────────────────────────────────────────────────────────
      // `this` as an expression. A class *declaration* is not a violation: a
      // prefab may legitimately build a small helper class whose methods take
      // everything they need. What is forbidden is reading receiver state.
      case 'this':
        return at(node, 'no-this', '`this` reads state through a receiver — pass state in and return it instead');

      // ── no-module-mutable-state ────────────────────────────────────────────
      // Only at the top level of the module. A `let` inside a function is
      // local state, which is exactly where state belongs.
      case 'lexical_declaration':
      case 'variable_declaration': {
        if (parent !== null && parent.type === 'program') {
          // The declaration keyword (`let` / `var` / `const`) is an anonymous
          // first child, not a named `kind` field — `childForFieldName('kind')`
          // returns null here and would silently pass every declaration.
          const keyword = node.children[0]?.text;
          if (keyword === 'let' || keyword === 'var') {
            return at(
              node,
              'no-module-mutable-state',
              `module-level ${keyword} is shared by every instance of this prefab — declare it inside create()`,
            );
          }
        }
        return null;
      }

      // ── no-math-random ─────────────────────────────────────────────────────
      // Matched structurally as a member call, so a *string* or *comment*
      // containing "Math.random" is not a violation and a computed
      // `globalThis.Math.random()` is still caught by the identifier check
      // below.
      case 'member_expression': {
        const object = node.childForFieldName('object');
        if (object?.type === 'identifier' && object.text === 'Math') {
          const property = node.childForFieldName('property');
          if (property?.text === 'random') {
            return at(node, 'no-math-random', 'Math.random() is unseeded — use the injected rng so the scene is reproducible');
          }
        }
        return null;
      }

      case 'identifier': {
        // ── no-dom-global ────────────────────────────────────────────────────
        if (DOM_GLOBALS.has(node.text)) {
          return at(node, 'no-dom-global', `\`${node.text}\` is a DOM global — a prefab must be pure and headless`);
        }
        return null;
      }

      // ── no-scene-add ───────────────────────────────────────────────────────
      // `x.add(...)` where x is named scene, or the explicit `scene.add`.
      // Named rather than any `.add(`: `group.add(mesh)` is how a prefab builds
      // its own hierarchy, and flagging that would make the rule unusable.
      case 'call_expression': {
        const functionNode = node.childForFieldName('function');
        if (functionNode?.type === 'member_expression') {
          const object = functionNode.childForFieldName('object');
          const property = functionNode.childForFieldName('property');
          if (
            object?.type === 'identifier' &&
            object.text === 'scene' &&
            (property?.text === 'add' || property?.text === 'attach')
          ) {
            return at(
              node,
              'no-scene-add',
              'a prefab returns its object; the caller adds it to the scene',
            );
          }
        }
        return null;
      }

      default:
        return null;
    }
  }

  function at(node: SyntaxNodeLike, rule: LintRule, message: string): LintViolation {
    const text = node.text.length > MIN_REPORTED_LENGTH
      ? `${node.text.slice(0, MIN_REPORTED_LENGTH)}…`
      : node.text;
    return {
      rule,
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      text,
      message,
    };
  }
}

/** Render a lint result as the lines `npm run lint:prefabs` prints. */
export function formatLintResult(result: LintResult): string {
  if (result.ok) return `${result.file}: clean`;

  const lines = [`${result.file}: ${result.violations.length} violation(s)`];
  for (const violation of result.violations) {
    lines.push(
      `  ${violation.line}:${violation.column}  ${violation.rule}  ${violation.message}\n` +
        `      ${violation.text}`,
    );
  }
  return lines.join('\n');
}

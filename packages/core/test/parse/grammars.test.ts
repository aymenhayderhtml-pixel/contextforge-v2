import { describe, expect, it } from 'vitest';
import { grammarForPath, tryParse } from '../../src/parse/grammars.js';

/**
 * These tests guard the layer everything else in SPEC R5 stands on. If tree-sitter
 * silently stops loading, the extractors would return empty graphs that look
 * like a project with no dependencies — a confidently wrong answer.
 */
describe('grammarForPath', () => {
  it('maps source extensions to grammars', () => {
    expect(grammarForPath('src/main.js')).toBe('javascript');
    expect(grammarForPath('src/main.mjs')).toBe('javascript');
    expect(grammarForPath('src/view.tsx')).toBe('tsx');
    expect(grammarForPath('scripts/Player.gd')).toBe('gdscript');
  });

  it('returns null for files with no grammar', () => {
    expect(grammarForPath('scene.tscn')).toBeNull();
    expect(grammarForPath('README')).toBeNull();
  });
});

describe('tryParse', () => {
  it('parses JavaScript into a real tree', () => {
    const outcome = tryParse(
      "import { a } from './a.js';\nexport function go() { return a; }\n",
      'main.js',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.tree.grammar).toBe('javascript');
    expect(outcome.tree.tree.rootNode.type).toBe('program');
    expect(outcome.tree.tree.rootNode.descendantsOfType('import_statement')).toHaveLength(1);
  });

  it('parses TypeScript, so `export const x: number = 1` is a typed declaration', () => {
    const outcome = tryParse('export const x: number = 1;\n', 'a.ts');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.tree.grammar).toBe('typescript');
    expect(outcome.tree.tree.rootNode.descendantsOfType('type_annotation')).toHaveLength(1);
  });

  it('parses GDScript', () => {
    const outcome = tryParse(
      'extends Node\nsignal died()\n@export var speed: float = 5.0\n',
      'Player.gd',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.tree.grammar).toBe('gdscript');
    expect(outcome.tree.tree.rootNode.descendantsOfType('signal_statement')).toHaveLength(1);
  });

  it('reports a syntax error with a line number instead of returning a partial tree', () => {
    const outcome = tryParse('function ok() {}\nfunction broken( {\n', 'bad.js');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/syntax error/i);
    expect(outcome.line).toBe(2);
  });

  it('reports files with no grammar rather than guessing', () => {
    const outcome = tryParse('[gd_scene format=3]', 'Level1.tscn');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/no tree-sitter grammar/i);
  });

  /**
   * The MISSING-node name is the whole diagnosis, so these pin the actual
   * absent token. The unclosed-function case used to report
   * "missing lexical_declaration" — the last thing that parsed, not the thing
   * that is missing — because the name was read from the preceding sibling
   * instead of from the MISSING node's own type.
   */
  it('names the absent brace when a function is never closed', () => {
    const outcome = tryParse('function greet() {\n  const a = 1;\n', 'greet.js');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('missing }');
    // The exact regression: the preceding sibling's type must not leak in.
    expect(outcome.message).not.toContain('lexical_declaration');
    expect(outcome.line).toBe(2);
  });

  it('names the absent brace when an if block is never closed', () => {
    const outcome = tryParse('function f() {\n  if (x) {\n    doThing();\n}\n', 'f.js');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('missing }');
    expect(outcome.message).not.toContain('if_statement');
  });

  it('names the absent closing parenthesis rather than the last thing that parsed', () => {
    const outcome = tryParse('function f() {\n  call(a, b;\n}\n', 'f.js');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('missing )');
  });

  it('falls back to the surrounding text for an ERROR node, which has no expected token', () => {
    // A truncated object literal is an ERROR node, not a MISSING one, so there
    // is no absent token to name and quoting the offending text is the honest
    // report rather than inventing one.
    const outcome = tryParse('const o = { a: 1, b: 2\n', 'o.js');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('near');
    expect(outcome.message).toContain('a: 1');
  });

  it('names the absent operand for `return a + ;`', () => {
    const outcome = tryParse('function f() {\n  return a + ;\n}\n', 'f.js');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Plain words, not the grammar's internal `identifier`.
    expect(outcome.message).toContain('missing a name or identifier');
    expect(outcome.message).not.toContain('missing identifier');
  });
});

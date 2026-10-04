/**
 * Ported from v1 `server/patch-reliability-test.js` (T077/T078/T079) and the
 * edit-block parsing in `server/project-init.js`.
 *
 * Behaviour preserved: whitespace/formatting drift tolerance, ambiguous-snippet
 * refusal, overlapping block re-anchoring, idempotent re-application, and the
 * pre-save syntax check refusing broken code before it reaches disk.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findTargetMatch } from '../../src/patch/finder.js';
import { applyEditBlocks, parseEditBlocks } from '../../src/patch/editBlocks.js';
import { parseFileBlocks, writeFileBlocks } from '../../src/patch/fileBlocks.js';
import { validateContentSyntax } from '../../src/patch/syntaxCheck.js';
import { formatUnifiedDiff, generateFlatDiff } from '../../src/patch/diff.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cf-patch-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function writeFile(relativePath: string, content: string): void {
  const absolute = join(testDir, relativePath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content, 'utf-8');
}

function readFile(relativePath: string): string {
  return readFileSync(join(testDir, relativePath), 'utf-8');
}

describe('parseEditBlocks', () => {
  it('parses a standard ### EDIT: block', () => {
    const blocks = parseEditBlocks(
      [
        '### EDIT: src/player.js',
        '<<<<<<< FIND',
        '  const speed = 5;',
        '=======',
        '  const speed = 25;',
        '>>>>>>> REPLACE',
      ].join('\n'),
    );
    expect(blocks).toEqual([
      { path: 'src/player.js', find: '  const speed = 5;', replace: '  const speed = 25;' },
    ]);
  });

  it('accepts the marker variants models actually emit', () => {
    const variants = [
      '### EDIT: a.js',
      '## EDIT: a.js',
      '**EDIT:** a.js',
      'EDIT: a.js',
      'PATCH: a.js',
      'UPDATE: a.js',
      '### EDIT: `a.js`',
    ];
    for (const header of variants) {
      const blocks = parseEditBlocks(
        `${header}\n<<<<<<< FIND\nold\n=======\nnew\n>>>>>>> REPLACE`,
      );
      expect(blocks, `failed for header: ${header}`).toHaveLength(1);
      expect(blocks[0]?.path).toBe('a.js');
    }
  });

  it('accepts SEARCH/REPLACE marker spellings and an enclosing code fence', () => {
    const blocks = parseEditBlocks(
      [
        '### EDIT: a.js',
        '```js',
        '<<<<<<< SEARCH',
        'old',
        '=======',
        'new',
        '>>>>>>>',
        '```',
      ].join('\n'),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ path: 'a.js', find: 'old', replace: 'new' });
  });

  it('parses several blocks for the same file', () => {
    const blocks = parseEditBlocks(
      [
        '### EDIT: a.js',
        '<<<<<<< FIND',
        'one',
        '=======',
        'two',
        '>>>>>>> REPLACE',
        '',
        '### EDIT: a.js',
        '<<<<<<< FIND',
        'three',
        '=======',
        'four',
        '>>>>>>> REPLACE',
      ].join('\n'),
    );
    expect(blocks).toHaveLength(2);
  });

  it('returns nothing for prose with no marker', () => {
    expect(parseEditBlocks('I have updated the speed value for you.')).toEqual([]);
  });
});

describe('applyEditBlocks', () => {
  it('applies a block to existing code', () => {
    writeFile('src/player.js', 'export function move() {\n  const speed = 5;\n  return speed;\n}\n');

    const result = applyEditBlocks(
      testDir,
      [
        '### EDIT: src/player.js',
        '<<<<<<< FIND',
        '  const speed = 5;',
        '=======',
        '  const speed = 25;',
        '>>>>>>> REPLACE',
      ].join('\n'),
    );

    expect(result.success).toBe(true);
    expect(result.applied).toHaveLength(1);
    expect(readFile('src/player.js')).toContain('const speed = 25;');
  });

  it('applies several non-conflicting blocks to one file in sequence', () => {
    writeFile(
      'src/combat.js',
      [
        'export function handleAttack(player, target) {',
        '  const damage = player.attack;',
        '  target.health -= damage;',
        '  return target.health > 0;',
        '}',
      ].join('\n'),
    );

    const result = applyEditBlocks(
      testDir,
      [
        '### EDIT: src/combat.js',
        '<<<<<<< FIND',
        '  const damage = player.attack;',
        '=======',
        '  const damage = Math.max(1, player.attack - target.defense);',
        '>>>>>>> REPLACE',
        '',
        '### EDIT: src/combat.js',
        '<<<<<<< FIND',
        '  target.health -= damage;',
        '  return target.health > 0;',
        '=======',
        '  target.health -= damage;',
        '  return { alive: target.health > 0, damage };',
        '>>>>>>> REPLACE',
      ].join('\n'),
    );

    expect(result.success).toBe(true);
    const updated = readFile('src/combat.js');
    expect(updated).toContain('Math.max(1, player.attack - target.defense)');
    expect(updated).toContain('alive: target.health > 0');
  });

  it('refuses an ambiguous snippet instead of guessing', () => {
    writeFile('a.js', ['const x = 1;', 'const y = 2;', 'this.reset();', 'this.reset();'].join('\n'));

    const result = applyEditBlocks(
      testDir,
      ['### EDIT: a.js', '<<<<<<< FIND', 'this.reset();', '=======', 'this.stop();', '>>>>>>> REPLACE'].join('\n'),
    );

    expect(result.success).toBe(false);
    expect(result.failed[0]?.reason).toMatch(/matched 2 times/);
    // Untouched: the file still has both calls.
    expect(readFile('a.js')).toContain('this.reset();\nthis.reset();');
  });

  it('reports a block whose FIND text does not exist', () => {
    writeFile('a.js', 'const a = 1;\n');

    const result = applyEditBlocks(
      testDir,
      ['### EDIT: a.js', '<<<<<<< FIND', 'const missing = 9;', '=======', 'const other = 9;', '>>>>>>> REPLACE'].join('\n'),
    );

    expect(result.success).toBe(false);
    expect(result.failed[0]?.reason).toMatch(/could not find/);
  });

  it('reports a block targeting a file that does not exist', () => {
    const result = applyEditBlocks(
      testDir,
      ['### EDIT: nope.js', '<<<<<<< FIND', 'a', '=======', 'b', '>>>>>>> REPLACE'].join('\n'),
    );
    expect(result.success).toBe(false);
    expect(result.failed[0]?.reason).toMatch(/does not exist/);
  });

  it('is idempotent when the same patch is pasted twice', () => {
    writeFile('a.js', 'const speed = 5;\n');
    const patch = [
      '### EDIT: a.js',
      '<<<<<<< FIND',
      'const speed = 5;',
      '=======',
      'const speed = 25;',
      '>>>>>>> REPLACE',
    ].join('\n');

    expect(applyEditBlocks(testDir, patch).success).toBe(true);
    const second = applyEditBlocks(testDir, patch);

    expect(second.success).toBe(true);
    expect(second.applied).toHaveLength(0);
    expect(second.alreadyApplied).toHaveLength(1);
    expect(readFile('a.js')).toBe('const speed = 25;\n');
  });

  it('applies to several files in one patch', () => {
    writeFile('a.js', 'const a = 1;\n');
    writeFile('b.js', 'const b = 2;\n');

    const result = applyEditBlocks(
      testDir,
      [
        '### EDIT: a.js',
        '<<<<<<< FIND',
        'const a = 1;',
        '=======',
        'const a = 10;',
        '>>>>>>> REPLACE',
        '',
        '### EDIT: b.js',
        '<<<<<<< FIND',
        'const b = 2;',
        '=======',
        'const b = 20;',
        '>>>>>>> REPLACE',
      ].join('\n'),
    );

    expect(result.success).toBe(true);
    expect([...result.files].sort()).toEqual(['a.js', 'b.js']);
    expect(readFile('a.js')).toBe('const a = 10;\n');
    expect(readFile('b.js')).toBe('const b = 20;\n');
  });

  it('refuses a path that escapes the project root', () => {
    writeFile('a.js', 'const a = 1;\n');
    // The wording is `resolveInsideRoot`'s (D51), not a bare errno: it names the
    // path and says why. The old expectation matched /directory traversal/ from a
    // message that no longer exists, so this test was asserting a string rather
    // than a behaviour.
    expect(() =>
      applyEditBlocks(
        testDir,
        ['### EDIT: ../escape.js', '<<<<<<< FIND', 'a', '=======', 'b', '>>>>>>> REPLACE'].join('\n'),
      ),
    ).toThrow(/"\.\.\/escape\.js".*climbs out of the project/i);
  });

  it('refuses a path that a symlink redirects outside the root', () => {
    // The lexical check cannot see this one: `link/owned.js` contains no `..` and
    // is not absolute. It is SEC-3, and `realpath` is the only thing that sees it.
    const outside = mkdtempSync(join(tmpdir(), 'cf-outside-'));
    symlinkSync(outside, join(testDir, 'link'));
    try {
      // `writeFileBlocks`, not `applyEditBlocks` — a `### FILE:` block is parsed
      // and written by the other half of the patch engine.
      expect(() =>
        writeFileBlocks(
          testDir,
          ['### FILE: link/owned.js', '```js', 'export const x = 1;', '```'].join('\n'),
        ),
      ).toThrow(/link\/owned\.js.*resolves outside the project/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('throws when the text has no EDIT blocks', () => {
    writeFile('a.js', 'const a = 1;\n');
    expect(() => applyEditBlocks(testDir, 'no markers here')).toThrow(/Zero blocks/);
  });
});

describe('findTargetMatch', () => {
  const source = [
    'export class Player {',
    '  constructor(name, speed) {',
    '    this.name = name;',
    '    this.speed = speed;',
    '  }',
    '',
    '  update(delta) {',
    '    this.move(delta);',
    '  }',
    '}',
  ].join('\n');

  it('matches an exact snippet', () => {
    const result = findTargetMatch(source, '  update(delta) {\n    this.move(delta);\n  }');
    expect(result.success).toBe(true);
  });

  it('matches across internal whitespace drift', () => {
    const result = findTargetMatch(
      source,
      ['  constructor( name,   speed ) {', '    this.name = name;', '    this.speed = speed;', '  }'].join('\n'),
    );
    expect(result.success).toBe(true);
  });

  it('matches across blank-line drift', () => {
    const result = findTargetMatch(
      source,
      ['    this.speed = speed;', '  }', '  update(delta) {'].join('\n'),
    );
    expect(result.success).toBe(true);
  });

  it('matches a snippet pasted with line-number prefixes', () => {
    const result = findTargetMatch(source, ['> 7 |   update(delta) {', '> 8 |     this.move(delta);', '> 9 |   }'].join('\n'));
    expect(result.success).toBe(true);
  });

  it('matches ignoring trailing whitespace', () => {
    const result = findTargetMatch(source, '  update(delta) {   \n    this.move(delta);\n  }');
    expect(result.success).toBe(true);
  });

  it('refuses a snippet that matches more than once', () => {
    const duplicated = ['const x = 1;', 'const x = 1;'].join('\n');
    const result = findTargetMatch(duplicated, 'const x = 1;');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toMatch(/matched 2 times/);
  });

  it('reports not-found for a snippet that does not exist', () => {
    const result = findTargetMatch(source, 'function absent() {}');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toMatch(/could not find/);
  });

  it('normalizes CRLF so a Windows file is patchable', () => {
    const crlf = 'const a = 1;\r\nconst b = 2;\r\n';
    const result = findTargetMatch(crlf, 'const b = 2;');
    expect(result.success).toBe(true);
    if (result.success) expect(result.target).not.toContain('\r');
  });
});

describe('validateContentSyntax', () => {
  it('accepts valid JavaScript', () => {
    expect(validateContentSyntax('a.js', 'export const x = 1;\nexport function f(a) { return a; }').valid).toBe(true);
  });

  it('rejects invalid JavaScript and reports the error line', () => {
    const result = validateContentSyntax('a.js', 'export const x = 1;\nexport function f(a) { return a + ; }');
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.message).toMatch(/JavaScript\/TypeScript syntax error/);
    expect(result.line).toBe(2);
  });

  it('rejects invalid TypeScript', () => {
    const result = validateContentSyntax('a.ts', 'const x: number = ;\n');
    expect(result.valid).toBe(false);
  });

  it('accepts valid GDScript', () => {
    const gd = [
      'extends Node',
      'var health: int = 100',
      'func take_damage(amount: int) -> void:',
      '\tif health > 0:',
      '\t\thealth -= amount',
    ].join('\n');
    expect(validateContentSyntax('player.gd', gd).valid).toBe(true);
  });

  it('rejects GDScript with a missing trailing colon', () => {
    const result = validateContentSyntax('player.gd', 'extends Node\nfunc take_damage(amount: int)\n');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.message).toMatch(/missing a body/);
      expect(result.line).toBe(2);
    }
  });

  it('rejects GDScript with an unclosed delimiter', () => {
    const result = validateContentSyntax('player.gd', 'extends Node\nfunc _ready():\n\tvar arr = [1, 2, 3\n');
    expect(result.valid).toBe(false);
  });

  it('rejects GDScript with an unterminated string', () => {
    const result = validateContentSyntax('player.gd', 'extends Node\nvar s = "unterminated\n');
    expect(result.valid).toBe(false);
  });

  it('accepts hex colours with trailing comments', () => {
    const gd = [
      'extends Node',
      'const THEME_COLOR: String = "#ff00ff" # Neon magenta accent',
      'func _ready() -> void:',
      '\tpass',
    ].join('\n');
    expect(validateContentSyntax('colors.gd', gd).valid).toBe(true);
  });

  it('accepts Windows paths with backslashes', () => {
    const gd = [
      'extends Node',
      'var save_path: String = "C:\\Users\\player\\games\\save.dat"',
      'func _ready() -> void:',
      '\tpass',
    ].join('\n');
    expect(validateContentSyntax('paths.gd', gd).valid).toBe(true);
  });

  it('accepts a triple-quoted docstring containing delimiters and fake signatures', () => {
    const gd = [
      'extends Node',
      'var doc: String = """',
      'Multi-line docstring block.',
      '# This hash is inside a string, not a real comment.',
      'func fake_signature():',
      'Unbalanced (delimiters [inside strings',
      '"""',
      'func _ready() -> void:',
      '\tpass',
    ].join('\n');
    expect(validateContentSyntax('docs.gd', gd).valid).toBe(true);
  });

  it('validates JSON and reports a line', () => {
    expect(validateContentSyntax('scene.json', '{"a": 1}').valid).toBe(true);
    const result = validateContentSyntax('scene.json', '{\n  "a": 1,,\n}');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.message).toMatch(/JSON syntax error/);
  });

  it('passes through files it has no checker for', () => {
    expect(validateContentSyntax('Level1.tscn', 'anything at all').valid).toBe(true);
    expect(validateContentSyntax('notes.md', '# Title').valid).toBe(true);
  });
});

describe('pre-save syntax check integration', () => {
  it('refuses to write a patch that would break a file', () => {
    writeFile('src/player.js', 'export function move() {\n  return "moving";\n}\n');
    const original = readFile('src/player.js');

    const brokenPatch = [
      '### EDIT: src/player.js',
      '<<<<<<< FIND',
      '  return "moving";',
      '=======',
      '  return + ;',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = applyEditBlocks(testDir, brokenPatch, { applyAnyway: false });

    expect(result.success).toBe(false);
    expect(result.preCheckFailed).toBe(true);
    expect(result.canApplyAnyway).toBe(true);
    expect(result.syntaxError?.line).toBe(2);
    // The file on disk must be untouched.
    expect(readFile('src/player.js')).toBe(original);
  });

  it('writes the broken patch when the caller explicitly applies anyway', () => {
    writeFile('src/player.js', 'export function move() {\n  return "moving";\n}\n');
    const brokenPatch = [
      '### EDIT: src/player.js',
      '<<<<<<< FIND',
      '  return "moving";',
      '=======',
      '  return + ;',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = applyEditBlocks(testDir, brokenPatch, { applyAnyway: true });

    expect(result.success).toBe(true);
    expect(readFile('src/player.js')).toContain('return + ;');
  });

  it('leaves no file written when a multi-file patch has one broken file', () => {
    writeFile('good.js', 'const a = 1;\n');
    writeFile('bad.js', 'const b = 1;\n');
    const goodBefore = readFile('good.js');
    const badBefore = readFile('bad.js');

    const result = applyEditBlocks(
      testDir,
      [
        '### EDIT: good.js',
        '<<<<<<< FIND',
        'const a = 1;',
        '=======',
        'const a = 2;',
        '>>>>>>> REPLACE',
        '',
        '### EDIT: bad.js',
        '<<<<<<< FIND',
        'const b = 1;',
        '=======',
        'const b = ;',
        '>>>>>>> REPLACE',
      ].join('\n'),
    );

    expect(result.success).toBe(false);
    expect(result.preCheckFailed).toBe(true);
    expect(result.syntaxError?.file).toBe('bad.js');
    // All-or-nothing: the valid file must not be written either.
    expect(readFile('good.js')).toBe(goodBefore);
    expect(readFile('bad.js')).toBe(badBefore);
  });
});

describe('file blocks', () => {
  it('parses a ### FILE: block', () => {
    const blocks = parseFileBlocks(
      ['### FILE: src/new.js', '```js', 'export const x = 1;', '```'].join('\n'),
    );
    expect(blocks).toEqual([{ path: 'src/new.js', content: 'export const x = 1;' }]);
  });

  it('parses a block whose closing fence is missing at the end of the text', () => {
    const blocks = parseFileBlocks('### FILE: src/new.js\n```js\nexport const x = 1;');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe('export const x = 1;');
  });

  it('creates a new file', () => {
    const result = writeFileBlocks(
      testDir,
      ['### FILE: src/new.js', '```', 'export const x = 1;', '```'].join('\n'),
    );
    expect(result.success).toBe(true);
    expect(result.created).toEqual(['src/new.js']);
    expect(readFile('src/new.js')).toBe('export const x = 1;');
  });

  it('overwrites an existing file', () => {
    writeFile('src/old.js', 'old content');
    const result = writeFileBlocks(
      testDir,
      ['### FILE: src/old.js', '```', 'new content', '```'].join('\n'),
    );
    expect(result.overwritten).toEqual(['src/old.js']);
    expect(readFile('src/old.js')).toBe('new content');
  });

  it('refuses a file that would not parse', () => {
    const result = writeFileBlocks(
      testDir,
      ['### FILE: bad.js', '```', 'const x = ;', '```'].join('\n'),
    );
    expect(result.success).toBe(false);
    expect(result.preCheckFailed).toBe(true);
    expect(existsSync(join(testDir, 'bad.js'))).toBe(false);
  });

  it('throws when the text has no FILE blocks', () => {
    expect(() => writeFileBlocks(testDir, 'nothing here')).toThrow(/Zero files/);
  });
});

describe('diff', () => {
  it('produces a delete and an add for a modified line', () => {
    const diff = generateFlatDiff('line 1\nline 2\nline 3\nline 4', 'line 1\nline 2 modified\nline 3\nline 4');
    const deletes = diff.filter((c) => c.type === 'delete');
    const adds = diff.filter((c) => c.type === 'add');
    const contexts = diff.filter((c) => c.type === 'context');

    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.line).toBe('line 2');
    expect(adds).toHaveLength(1);
    expect(adds[0]?.line).toBe('line 2 modified');
    expect(contexts.length).toBeGreaterThanOrEqual(2);
  });

  it('reports no changes when the texts are equal', () => {
    expect(generateFlatDiff('a\nb', 'a\nb')).toEqual([]);
  });

  it('formats a unified diff with hunk headers', () => {
    const text = formatUnifiedDiff('a.js', 'one\ntwo\n', 'one\nTWO\n');
    expect(text).toContain('--- a/a.js');
    expect(text).toContain('+++ b/a.js');
    expect(text).toContain('@@');
    expect(text).toContain('-two');
    expect(text).toContain('+TWO');
  });

  it('formats new-file diffs as @@ -0,0 +1,N @@ with no removed line', () => {
    const newContent = 'export function hello() {\n  return 42;\n}\n';
    const text = formatUnifiedDiff('src/newFile.ts', '', newContent);
    expect(text).toContain('--- /dev/null');
    expect(text).toContain('+++ b/src/newFile.ts');
    expect(text).toContain('@@ -0,0 +1,3 @@');
    expect(text).not.toContain('\n-');
    expect(text).toContain('+export function hello() {');
    expect(text).toContain('+  return 42;');
    expect(text).toContain('+}');
  });
});

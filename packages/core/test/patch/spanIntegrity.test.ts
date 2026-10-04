/**
 * patch/spanIntegrity.test.ts — the block must replace the region it located.
 *
 * **Every test in this file reads the file back off disk.** A status-only test
 * cannot see the defect this file exists for: `applyEditBlocks` reported
 * `success: true` for a patch that duplicated two statements in the
 * developer's source and stripped every blank line, and the syntax pre-check
 * called the result valid. Both gates agreed with a corrupt file, so the only
 * witness is the bytes.
 *
 * The names here are behaviour, not audit numbers. See D52.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEditBlocks } from '../../src/patch/editBlocks.js';
import { findTargetMatch } from '../../src/patch/finder.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-span-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): void {
  writeFileSync(join(dir, name), content, 'utf-8');
}

/** The bytes on disk. The only witness that matters in this file. */
function read(name: string): string {
  return readFileSync(join(dir, name), 'utf-8');
}

function block(find: string, replace: string): string {
  return ['### EDIT: a.js', '<<<<<<< FIND', find, '=======', replace, '>>>>>>> REPLACE'].join('\n');
}

describe('a matched block replaces the whole region it located', () => {
  it('a FIND with the blank lines dropped leaves no duplicated tail', () => {
    const onDisk = [
      'const config = load();',
      '',
      'const engine = new Engine(config);',
      '',
      'engine.start();',
      '',
      'engine.tick();',
      '',
      'engine.stop();',
      '',
    ].join('\n');
    write('a.js', onDisk);

    // The AI pasted the statements with no blank lines between them. It cannot
    // know the developer's spacing, and it is not asked to reproduce it.
    const find =
      'const config = load();\nconst engine = new Engine(config);\nengine.start();\nengine.tick();\nengine.stop();';
    const replace = find.replace('engine.start();', 'engine.start({ autoplay: false });');

    const result = applyEditBlocks(dir, block(find, replace), { preCheckSyntax: false });
    expect(result.success).toBe(true);

    // The end-to-end assertion: every statement appears exactly once, and the
    // file is not longer than it was. Before the span fix this file grew by two
    // statements, so `engine.tick()` and `engine.stop()` ran twice on start.
    const after = read('a.js');
    const count = (needle: string): number => after.split(needle).length - 1;
    expect(count('engine.start({ autoplay: false });')).toBe(1);
    expect(count('engine.tick();')).toBe(1);
    expect(count('engine.stop();')).toBe(1);
    expect(after.split('\n').filter((line) => line === 'engine.tick();')).toHaveLength(1);

    // And the developer's blank-line spacing survives, because a patch block
    // cannot restate it and must not destroy it either.
    expect(after).toBe(onDisk.replace('engine.start();', 'engine.start({ autoplay: false });'));
  });

  it('the located region is longer than the FIND, and all of it is replaced', () => {
    const file = [
      'function f() {',
      '  const a = 1;',
      '',
      '  const b = 2;',
      '',
      '  const c = 3;',
      '  return a + b + c;',
      '}',
    ].join('\n');
    const find = '  const a = 1;\n  const b = 2;\n  const c = 3;\n  return a + b + c;';
    const replace = find.replace('return a + b + c;', 'return a + b + c + 100;');

    write('a.js', file);
    const result = applyEditBlocks(dir, block(find, replace), { preCheckSyntax: false });
    expect(result.success).toBe(true);

    // `target` covers the file's region — six lines, blank ones included — and
    // not the four lines the snippet happens to have.
    const match = findTargetMatch(file, find);
    expect(match.success).toBe(true);
    if (match.success) {
      expect(match.target.split('\n')).toHaveLength(6);
      expect(match.target).toContain('return a + b + c;');
    }

    // The whole region goes, including its blank lines — they are part of what
    // was replaced — and the replacement is written in the region's shape, so
    // the file keeps the developer's spacing.
    expect(read('a.js')).toBe(
      [
        'function f() {',
        '  const a = 1;',
        '',
        '  const b = 2;',
        '',
        '  const c = 3;',
        '  return a + b + c + 100;',
        '}',
      ].join('\n'),
    );
  });

  it('a blank line the patch never mentioned is not dropped', () => {
    const onDisk = 'function f() {\n  const a = 1;\n\n  return a;\n}\n';
    write('a.js', onDisk);

    const result = applyEditBlocks(
      dir,
      block('  const a = 1;\n  return a;', '  const a = 1;\n  return a + 1;'),
      { preCheckSyntax: false },
    );

    expect(result.success).toBe(true);
    expect(read('a.js')).toBe('function f() {\n  const a = 1;\n\n  return a + 1;\n}\n');
  });
});

describe('a CRLF file is patched in CRLF', () => {
  it('writes the replacement and keeps every line ending', () => {
    const onDisk = 'const a = 1;\r\nconst b = 2;\r\n';
    write('a.js', onDisk);

    const result = applyEditBlocks(
      dir,
      block('const a = 1;\nconst b = 2;', 'const a = 99;\nconst b = 2;'),
      { preCheckSyntax: false },
    );

    expect(result.success).toBe(true);
    const after = read('a.js');
    expect(after).toBe('const a = 99;\r\nconst b = 2;\r\n');
    // Not one lone LF anywhere: a mixed-ending file is a corrupted file.
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('a single-line FIND on a CRLF file is written through', () => {
    const onDisk = 'const a = 1;\r\nconst b = 2;\r\n';
    write('a.js', onDisk);

    const result = applyEditBlocks(dir, block('const b = 2;', 'const b = 3;'), {
      preCheckSyntax: false,
    });

    expect(result.success).toBe(true);
    expect(read('a.js')).toBe('const a = 1;\r\nconst b = 3;\r\n');
  });

  it('a block that writes nothing is refused, never reported applied', () => {
    // The engine's own invariant, stated as a test: a block is "applied" only
    // if the file changed. This is the check that stops a future normalisation
    // bug from answering "applied" while every byte stays put.
    const onDisk = 'const a = 1;\r\nconst b = 2;\r\n';
    write('a.js', onDisk);

    // A FIND that resolves to nothing is not a match, so this must be refused.
    const result = applyEditBlocks(dir, block('const zz = 9;', 'const zz = 10;'), {
      preCheckSyntax: false,
    });

    expect(result.success).toBe(false);
    expect(result.applied).toEqual([]);
    expect(read('a.js')).toBe(onDisk);
  });
});

describe('an empty FIND is refused by name', () => {
  it('writes nothing and says which block and why', () => {
    const onDisk = 'const x = 1;\nconst y = 2;\n';
    write('a.js', onDisk);

    const patch = [
      '### EDIT: a.js',
      '<<<<<<< FIND',
      '',
      '=======',
      'INSERTED',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = applyEditBlocks(dir, patch, { preCheckSyntax: false });

    expect(result.success).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toMatch(/FIND is empty/);
    expect(result.files).toEqual([]);

    // The prepend this used to perform, byte for byte.
    expect(read('a.js')).toBe(onDisk);
  });

  it('a whitespace-only FIND is refused too', () => {
    const onDisk = 'const x = 1;\n';
    write('a.js', onDisk);

    const patch = [
      '### EDIT: a.js',
      '<<<<<<< FIND',
      '   ',
      '=======',
      'INSERTED',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = applyEditBlocks(dir, patch, { preCheckSyntax: false });
    expect(result.success).toBe(false);
    expect(read('a.js')).toBe(onDisk);
  });

  it('an empty REPLACE is still a legal deletion', () => {
    // The refusal is on FIND alone. Deleting a block is how a developer asks
    // for text to go away, and refusing it would leave the engine unable to
    // remove anything.
    const onDisk = 'const x = 1;\nconst y = 2;\n';
    write('a.js', onDisk);

    const result = applyEditBlocks(dir, block('const x = 1;\n', ''), { preCheckSyntax: false });
    expect(result.success).toBe(true);
    expect(read('a.js')).toBe('const y = 2;\n');
  });
});

describe('the loosest passes refuse rather than guess', () => {
  it('refuses a block that shares only its first and last line with the file', () => {
    const file = [
      'function h() {',
      '  start();',
      '  middle();',
      '  somethingElse();',
      '  end();',
      '}',
    ].join('\n');
    const find = 'function h() {\n  start();\n  middle();\n  different();\n  end();\n}';

    const match = findTargetMatch(file, find);
    expect(match.success).toBe(false);
    if (!match.success) expect(match.occurrences).toBe(0);
  });

  it('refuses a block whose declarations match but whose body does not', () => {
    // Same three variable names, completely different body. The variable-anchor
    // pass used to accept this on the strength of the names alone.
    const file = [
      'function g() {',
      '  const a = 99;',
      '  const b = 98;',
      '  const c = 97;',
      '  return a;',
      '}',
    ].join('\n');
    const find = '  const a = 1;\n  const b = 2;\n  const c = 3;\n  return a + b + c;';

    const match = findTargetMatch(file, find);
    expect(match.success).toBe(false);
    if (!match.success) expect(match.occurrences).toBe(0);
  });

  it('still matches a block that only drifted in whitespace', () => {
    // The pass exists for this. Requiring full agreement must not mean
    // requiring byte equality, or it would be the `trim` pass again.
    const file = [
      'function g() {',
      '  const a = 1;',
      '  const b = 2;',
      '  const c = 3;',
      '  return a + b + c;',
      '}',
    ].join('\n');
    const find = 'function g() {\n  const a = 1;\n\n  const b = 2;\n\n  const c = 3;\n  return a + b + c;\n}';

    const match = findTargetMatch(file, find);
    expect(match.success).toBe(true);
  });

  it('reports a real count when two regions anchor identically', () => {
    const file = [
      'const a = 1;',
      'const b = 2;',
      'const c = 3;',
      '',
      'const a = 1;',
      'const b = 2;',
      'const c = 3;',
      '',
    ].join('\n');
    const find = 'const a = 1;\nconst b = 2;\nconst c = 3;';

    const match = findTargetMatch(file, find);
    expect(match.success).toBe(false);
    // The count is of real matches, not of candidate starts.
    if (!match.success) {
      expect(match.occurrences).toBe(2);
      expect(match.reason).toMatch(/matched 2 times/);
    }
  });
});

describe('two blocks may not reverse each other', () => {
  const patch = [
    '### EDIT: a.js',
    '<<<<<<< FIND',
    'const a = 1;',
    '=======',
    'const a = 100;',
    '>>>>>>> REPLACE',
    '',
    '### EDIT: a.js',
    '<<<<<<< FIND',
    'const a = 1;',
    'const b = 2;',
    '=======',
    'const a = 1;',
    'const b = 200;',
    '>>>>>>> REPLACE',
  ].join('\n');

  it('refuses the block that would undo the first, leaving the first intact', () => {
    const onDisk = 'const a = 1;\nconst b = 2;\n';
    write('a.js', onDisk);

    const result = applyEditBlocks(dir, patch, { preCheckSyntax: false });

    // Block 1 is a coherent edit on its own and has already been applied by the
    // time block 2 is recognised as its reversal. Block 2 is refused, with the
    // reason naming it, so the developer is told the patch contradicts itself
    // instead of discovering it by diffing.
    expect(result.applied).toEqual([{ path: 'a.js', index: 1 }]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.index).toBe(2);
    expect(result.failed[0]?.isOverlapping).toBe(true);
    // Names BOTH blocks, because the developer has to know which two to reconcile.
    expect(result.failed[0]?.reason).toMatch(/block 2 contradicts edit block 1/);
    expect(result.partial).toBe(true);

    // The whole point: block 1's change is not silently reversed. Before this
    // check both blocks reported "applied" and the file read `const a = 1;`.
    expect(read('a.js')).toBe('const a = 100;\nconst b = 2;\n');
  });

  it('still allows two edits to the same region when the second carries the first through', () => {
    // The legitimate overlap: block 2 rewrites the same block and keeps
    // block 1's value. Refusing this would make the AI emit longer patches for
    // every second edit to one function.
    const onDisk = 'function f() {\n  const a = 1;\n  const b = 2;\n}\n';
    write('a.js', onDisk);

    const twoBlocks = [
      '### EDIT: a.js',
      '<<<<<<< FIND',
      'const a = 1;',
      '=======',
      'const a = 100;',
      '>>>>>>> REPLACE',
      '',
      '### EDIT: a.js',
      '<<<<<<< FIND',
      'const a = 100;\nconst b = 2;',
      '=======',
      'const a = 100;\nconst b = 200;',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = applyEditBlocks(dir, twoBlocks, { preCheckSyntax: false });

    expect(result.failed).toEqual([]);
    expect(result.applied).toHaveLength(2);
    expect(read('a.js')).toBe('function f() {\n  const a = 100;\n  const b = 200;\n}\n');
  });

  it('re-applying the same patch twice is still a no-op', () => {
    const onDisk = 'const a = 1;\nconst b = 2;\n';
    write('a.js', onDisk);
    const single = block('const a = 1;', 'const a = 100;');

    expect(applyEditBlocks(dir, single, { preCheckSyntax: false }).success).toBe(true);
    expect(read('a.js')).toBe('const a = 100;\nconst b = 2;\n');

    const second = applyEditBlocks(dir, single, { preCheckSyntax: false });
    expect(second.success).toBe(true);
    expect(second.alreadyApplied).toHaveLength(1);
    expect(read('a.js')).toBe('const a = 100;\nconst b = 2;\n');
  });
});

describe('the replacement is written literally', () => {
  it('a `$&` in the replacement does not stand for the matched text', () => {
    const onDisk = 'const a = 1;\n';
    write('a.js', onDisk);

    const result = applyEditBlocks(dir, block('const a = 1;', 'log("$&");'), {
      preCheckSyntax: false,
    });

    expect(result.success).toBe(true);
    expect(read('a.js')).toBe('log("$&");\n');
  });
});

describe('two blocks that both target the same original line', () => {
  // The shape that lost a change silently: block 1 rewrites the line, block 2's
  // FIND is that same original, so it matches the already-changed text (or is
  // dropped) and one of the two requested edits never happens.
  it('refuses the second and keeps the first', () => {
    write('a.js', 'const a = 1;\nconst b = 2;\n');
    const patch = [
      '### EDIT: a.js',
      '<<<<<<< FIND',
      'const a = 1;',
      '=======',
      'const a = 100;',
      '>>>>>>> REPLACE',
      '### EDIT: a.js',
      '<<<<<<< FIND',
      'const a = 1;',
      '=======',
      'const a = 200;',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = applyEditBlocks(dir, patch, { preCheckSyntax: false });
    expect(result.applied).toEqual([{ path: 'a.js', index: 1 }]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.index).toBe(2);
    expect(result.failed[0]?.isOverlapping).toBe(true);
    // The bytes, not just the status: the developer's file keeps block 1's change
    // and block 2's is simply not there.
    expect(read('a.js')).toBe('const a = 100;\nconst b = 2;\n');
  });

  it('still applies two blocks on genuinely different lines', () => {
    // The control. A blunt overlap rule that refuses anything sharing a file would
    // make every multi-block patch impossible, and this is what stops that.
    write('a.js', 'const a = 1;\n\nconst b = 2;\n\nconst c = 3;\n');
    const patch = [
      '### EDIT: a.js',
      '<<<<<<< FIND',
      'const a = 1;',
      '=======',
      'const a = 9;',
      '>>>>>>> REPLACE',
      '### EDIT: a.js',
      '<<<<<<< FIND',
      'const c = 3;',
      '=======',
      'const c = 8;',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = applyEditBlocks(dir, patch, { preCheckSyntax: false });
    expect(result.failed).toEqual([]);
    expect(result.applied).toEqual([
      { path: 'a.js', index: 1 },
      { path: 'a.js', index: 2 },
    ]);
    expect(read('a.js')).toBe('const a = 9;\n\nconst b = 2;\n\nconst c = 8;\n');
  });

  it('still applies two blocks whose shared line is just a closing brace', () => {
    // Why the overlap test requires a *distinctive* shared line. `}` appears in
    // every function; treating it as an overlap signal refuses disjoint patches.
    write('a.js', 'function one() {\n  return 1;\n}\n\nfunction two() {\n  return 2;\n}\n');
    const patch = [
      '### EDIT: a.js',
      '<<<<<<< FIND',
      'function one() {',
      '  return 1;',
      '}',
      '=======',
      'function one() {',
      '  return 11;',
      '}',
      '>>>>>>> REPLACE',
      '### EDIT: a.js',
      '<<<<<<< FIND',
      'function two() {',
      '  return 2;',
      '}',
      '=======',
      'function two() {',
      '  return 22;',
      '}',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = applyEditBlocks(dir, patch, { preCheckSyntax: false });
    expect(result.failed).toEqual([]);
    expect(read('a.js')).toBe(
      'function one() {\n  return 11;\n}\n\nfunction two() {\n  return 22;\n}\n',
    );
  });
});

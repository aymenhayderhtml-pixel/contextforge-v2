/**
 * context/compiler.test.ts — ranking, slicing and the handoff prompt.
 *
 * The three properties asserted here are the ones that, if broken, make the
 * compiler worse than useless:
 *
 *  - **the slice is verbatim** — an AI's `FIND` block only applies if the text
 *    it was given is byte-identical to the file;
 *  - **nothing is invented** — a symbol that is not in the prompt is a symbol
 *    the AI must not use, and a missing file is reported rather than skipped;
 *  - **it is deterministic** — the same input twice gives the same prompt
 *    (SPEC R8), or two AIs get different context for the same bug.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractFileReferences, rankRelevantFiles, tokenize } from '../../src/context/rank.js';
import {
  findFunctions,
  sliceFunctionAtLine,
  sliceFunctionByName,
  sliceWholeFile,
} from '../../src/context/slice.js';
import { compileContext, strictPatchContract } from '../../src/context/compiler.js';
import { extractJsProject } from '../../src/extract/js.js';
import { buildManifest } from '../../src/graph/manifest.js';

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'cf-ctx-'));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

/** Write a file into the fake project, creating directories. */
function write(relativePath: string, contents: string): void {
  const absolute = join(project, relativePath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, contents, 'utf-8');
}

const TRACK_JS = `import { buildMesh } from './mesh.js';

const TRACK_LENGTH = 100;

export function loadTrack(name) {
  const segments = buildMesh(name);
  return { name, segments, length: TRACK_LENGTH };
}

export class TrackManager {
  constructor(seed) {
    this.seed = seed;
    this.tracks = [];
  }

  update(delta) {
    for (const track of this.tracks) {
      track.position += delta * track.speed;
    }
  }
}
`;

const MESH_JS = `export function buildMesh(name) {
  return { name, geometry: 'box' };
}

export function disposeMesh(mesh) {
  mesh.geometry = null;
}
`;

const PLAYER_GD = `extends CharacterBody2D

signal died

@export var speed: float = 300.0

func take_damage(amount: int) -> void:
\tdied.emit()
\tvelocity = Vector2.ZERO
`;

describe('extractFileReferences', () => {
  it('finds a path and line from a browser stack trace', () => {
    const logs = `TypeError: x is not a function
    at updateDelta (http://localhost:5173/src/player.js:42:11)
    at tick (http://localhost:5173/src/loop.js:10:3)`;
    const refs = extractFileReferences(logs);
    expect(refs[0]).toEqual({ file: 'src/player.js', line: 42, order: 0 });
    expect(refs[1]).toEqual({ file: 'src/loop.js', line: 10, order: 1 });
  });

  it('strips a Godot res:// prefix', () => {
    const refs = extractFileReferences(
      `SCRIPT ERROR: Invalid get index at: res://scripts/Player.gd:27\nStack: res://scripts/Main.gd:12`,
    );
    expect(refs[0]).toEqual({ file: 'scripts/Player.gd', line: 27, order: 0 });
    expect(refs[1]?.file).toBe('scripts/Main.gd');
  });

  it('normalises Windows separators', () => {
    const refs = extractFileReferences('at C:\\game\\src\\player.js:5:1');
    expect(refs[0]?.file).toBe('C:/game/src/player.js');
  });

  it('ignores a non-source extension', () => {
    expect(extractFileReferences('loading texture.png at 12:00')).toEqual([]);
  });

  it('deduplicates the same reference', () => {
    const refs = extractFileReferences('a.js:1 then again a.js:1 then a.js:2');
    expect(refs.map((r) => r.line)).toEqual([1, 2]);
  });
});

describe('tokenize', () => {
  it('drops stop words and short tokens', () => {
    expect(tokenize('The player is not moving when the crate hits the wall')).toEqual([
      'player',
      'moving',
      'crate',
      'hits',
      'wall',
    ]);
  });
});

describe('rankRelevantFiles', () => {
  it('ranks the error origin above the rest of the stack', () => {
    write('src/player.js', TRACK_JS);
    write('src/loop.js', TRACK_JS);

    const ranked = rankRelevantFiles({
      logs: 'at updateDelta (src/player.js:42:11)\nat tick (src/loop.js:10:3)',
      issue: 'the player breaks',
    });

    expect(ranked[0]?.file).toBe('src/player.js');
    expect(ranked[0]?.score).toBe(100);
    expect(ranked[0]?.line).toBe(42);
    expect(ranked[1]?.file).toBe('src/loop.js');
    expect(ranked[1]?.score).toBe(95);
  });

  it('gives every file a reason', () => {
    const ranked = rankRelevantFiles({ logs: 'at tick (src/loop.js:10:3)', issue: '' });
    expect(ranked[0]?.reason).toContain('Error origin at line 10');
    expect(ranked[0]?.isTop).toBe(true);
  });

  it('skips a path that does not exist in the project', () => {
    const ranked = rankRelevantFiles({
      logs: 'at x (src/ghost.js:1:1)',
      issue: '',
      exists: (f) => f !== 'src/ghost.js',
    });
    expect(ranked).toEqual([]);
  });

  it('is deterministic for identical input', () => {
    const input = { logs: 'at a (x.js:1:1) at b (y.js:2:2)', issue: 'a thing breaks' };
    expect(rankRelevantFiles(input)).toEqual(rankRelevantFiles(input));
  });

  it('boosts a symbol the description names', () => {
    write('src/mesh.js', MESH_JS);
    // The manifest is built *after* the file is written: extracting first gives
    // an empty graph, and the failure reads as "the ranker is broken".
    const manifest = buildManifest(project, extractJsProject(project), '2026-01-01T00:00:00.000Z');
    const ranked = rankRelevantFiles({ logs: '', issue: 'buildMesh returns nothing', manifest });
    const mesh = ranked.find((r) => r.file.endsWith('mesh.js'));
    expect(mesh?.score).toBe(80);
    expect(mesh?.reason).toContain('buildMesh');
  });
});

describe('findFunctions', () => {
  it('finds top-level and method functions with their spans', () => {
    write('src/track.js', TRACK_JS);
    const functions = findFunctions(TRACK_JS, 'src/track.js');
    const names = functions.map((f) => f.name);
    expect(names).toContain('loadTrack');
    expect(names).toContain('update');

    const update = functions.find((f) => f.name === 'update');
    // Line 16 is `  update(delta) {` in the fixture — read from the tree, not
    // counted by eye.
    expect(update?.startLine).toBe(16);
    expect(update?.endLine).toBe(20);
  });

  it('finds GDScript functions', () => {
    const functions = findFunctions(PLAYER_GD, 'scripts/Player.gd');
    expect(functions.map((f) => f.name)).toEqual(['take_damage']);
  });

  it('does not treat a function keyword in a comment as a function', () => {
    // The v1 failure: a regex reported a commented-out export as real API.
    const source = `// export function fake() {}\n/* function alsoFake() {} */\nexport function real() { return 1; }`;
    const names = findFunctions(source, 'a.js').map((f) => f.name);
    expect(names).toEqual(['real']);
  });

  it('returns nothing for a file with no grammar', () => {
    expect(findFunctions('[gd_scene load_steps=2]', 'scenes/Level.tscn')).toEqual([]);
  });
});

describe('sliceFunctionAtLine', () => {
  it('returns the function containing the line, verbatim', () => {
    const slice = sliceFunctionAtLine(TRACK_JS, 'src/track.js', 20);
    expect(slice?.symbol).toBe('update');
    expect(slice?.text).toBe(
      `  update(delta) {
    for (const track of this.tracks) {
      track.position += delta * track.speed;
    }
  }`,
    );
  });

  it('prefers the innermost function containing the line', () => {
    // An error inside a method must show the method, not the whole class.
    const slice = sliceFunctionAtLine(TRACK_JS, 'src/track.js', 20);
    expect(slice?.text).not.toContain('constructor');
  });

  it('is byte-identical to the file content', () => {
    // The whole contract: an AI's FIND block must match exactly.
    const slice = sliceFunctionAtLine(TRACK_JS, 'src/track.js', 6);
    const lines = TRACK_JS.split('\n');
    expect(slice?.text).toBe(lines.slice((slice?.startLine ?? 1) - 1, slice?.endLine).join('\n'));
    expect(TRACK_JS).toContain(slice?.text);
  });

  it('preserves leading indentation exactly', () => {
    const slice = sliceFunctionAtLine(TRACK_JS, 'src/track.js', 20);
    expect(slice?.text.startsWith('  update(')).toBe(true);
  });

  it('returns null when no function covers the line', () => {
    expect(sliceFunctionAtLine(TRACK_JS, 'src/track.js', 1)).toBeNull();
  });
});

describe('sliceFunctionByName', () => {
  it('slices a named function', () => {
    const slice = sliceFunctionByName(TRACK_JS, 'src/track.js', 'loadTrack');
    expect(slice?.startLine).toBe(5);
    expect(slice?.text).toContain('buildMesh(name)');
  });

  it('returns null for a name that does not exist', () => {
    // Reporting "not found" is what stops the compiler attaching the wrong
    // function and the AI patching something it was never shown.
    expect(sliceFunctionByName(TRACK_JS, 'src/track.js', 'nope')).toBeNull();
  });
});

describe('compileContext', () => {
  beforeEach(() => {
    write('src/track.js', TRACK_JS);
    write('src/mesh.js', MESH_JS);
    write('scripts/Player.gd', PLAYER_GD);
  });

  it('slices the failing function into the prompt', () => {
    const result = compileContext({
      projectRoot: project,
      logs: 'TypeError\n    at updateDelta (src/track.js:20:3)',
      issue: 'the track does not move',
    });

    expect(result.prompt).toContain('update(delta)');
    expect(result.prompt).toContain('track.position += delta * track.speed;');
    expect(result.sections.some((s) => s.kind === 'slice' && s.symbol === 'update')).toBe(true);
  });

  it('includes the strict patch contract, including the CONTEXT INSUFFICIENT loop', () => {
    const result = compileContext({ projectRoot: project, logs: 'src/track.js:20:3' });
    expect(result.prompt).toContain('### EDIT:');
    expect(result.prompt).toContain('CONTEXT INSUFFICIENT:');
    expect(result.prompt).toContain('character for character');
  });

  it('gives the signatures of files it does not slice', () => {
    const result = compileContext({
      projectRoot: project,
      logs: 'at update (src/track.js:20:3)',
      issue: '',
    });
    // mesh.js appears as an import of the target, so it is a candidate.
    expect(result.prompt).toContain('buildMesh');
  });

  it('reports a symbol it could not find instead of guessing', () => {
    const result = compileContext({
      projectRoot: project,
      targetFile: 'src/track.js',
      issue: 'the call to nonexistentHelper() returns nothing',
    });

    expect(result.hasGaps).toBe(true);
    expect(result.gaps.join()).toContain('nonexistentHelper');
    expect(result.gaps.join()).toContain('loadTrack');
  });

  it('does not treat "undefined" or keywords in error messages as function names', () => {
    const result = compileContext({
      projectRoot: project,
      targetFile: 'src/track.js',
      logs: 'TypeError: Cannot read properties of undefined (reading \'speed\')',
      issue: 'something crashed on undefined (reading \'speed\')',
    });

    expect(result.gaps.join()).not.toContain('No function named "undefined"');
    expect(result.prompt).not.toContain('No function named "undefined"');
  });

  it('extracts real function name when preceded by undefined error strings', () => {
    const result = compileContext({
      projectRoot: project,
      targetFile: 'src/track.js',
      logs: 'TypeError: Cannot read properties of undefined (reading \'loadTrack\')\n    at loadTrack (src/track.js:5:1)',
      issue: 'crash in loadTrack',
    });

    expect(result.gaps.join()).not.toContain('No function named "undefined"');
    expect(result.prompt).toContain('loadTrack(name)');
    expect(result.sections.some((s) => s.symbol === 'loadTrack')).toBe(true);
  });

  it('never claims to have attached a file it could not read', () => {
    const result = compileContext({
      projectRoot: project,
      targetFile: 'src/does-not-exist.js',
      issue: 'something',
    });
    expect(result.hasGaps).toBe(true);
    expect(result.gaps.join()).toContain('does not exist');
    expect(result.prompt).toContain('NOT ATTACHED');
  });

  it('is deterministic', () => {
    const options = {
      projectRoot: project,
      logs: 'at update (src/track.js:20:3)',
      issue: 'the track does not move',
    };
    expect(compileContext(options).prompt).toBe(compileContext(options).prompt);
  });

  it('reports a saving over sending whole files', () => {
    const result = compileContext({
      projectRoot: project,
      logs: 'at update (src/track.js:20:3)',
      issue: 'the track does not move',
    });
    expect(result.chars).toBeLessThan(result.fullChars);
    expect(result.savingsPercent).toBeGreaterThan(0);
  });

  it('works on a Godot project too', () => {
    const result = compileContext({
      projectRoot: project,
      logs: 'SCRIPT ERROR at: res://scripts/Player.gd:8',
      issue: 'take_damage does nothing',
    });
    expect(result.prompt).toContain('take_damage');
    expect(result.prompt).toContain('Godot 4.x (GDScript)');
  });

  it('names the game and states the engine', () => {
    const result = compileContext({ projectRoot: project, logs: 'src/track.js:20:3', issue: 'check engine' });
    expect(result.prompt).toContain('ISSUE:');
    expect(result.prompt).toMatch(/using (Godot 4\.x|HTML5)/);
  });

  it('omits ISSUE section when issue is empty, never sending placeholder text', () => {
    const result = compileContext({ projectRoot: project, logs: 'src/track.js:20:3', issue: '' });
    expect(result.prompt).not.toContain('ISSUE:');
    expect(result.prompt).not.toContain('[Describe what is wrong]');
  });

  it('attaches a file in full when requested by AI (NEED / CONTEXT INSUFFICIENT), even if over 200 lines (src/track.js)', () => {
    // Generate a >200-line version of src/track.js
    const bigTrack = Array.from(
      { length: 70 },
      (_, i) => `export function segment_${i}() {\n  return ${i} * 10;\n}`,
    ).join('\n');
    write('src/track.js', bigTrack);
    expect(bigTrack.split('\n').length).toBeGreaterThan(200);

    // AI replies with NEED: src/track.js in logs
    const result = compileContext({
      projectRoot: project,
      targetFile: 'src/mesh.js',
      logs: 'NEED: src/track.js — need track curvature',
      issue: 'render track',
    });

    const trackSection = result.sections.find((s) => s.file === 'src/track.js');
    expect(trackSection).toBeDefined();
    expect(trackSection?.kind).toBe('full');
    expect(result.prompt).toContain('### FILE: src/track.js (full source)');
    expect(result.prompt).toContain('Requested files: src/track.js');
    expect(result.prompt).not.toContain('RUNTIME OUTPUT:\n```\nNEED:');
  });

  it('shows requested files as a separate line not in RUNTIME OUTPUT, and details size in budget warning', () => {
    write(
      'src/track.js',
      'export function getTrack() {\n  return { length: 500, curves: [1, 2, 3] };\n}\n',
    );
    const result = compileContext({
      projectRoot: project,
      targetFile: 'src/mesh.js',
      logs: 'Runtime crash in game loop\nNEED: src/track.js — need track curvature',
      issue: 'render track',
      maxChars: 400, // force over budget
    });

    // 1. Separate 'Requested files' line, not inside RUNTIME OUTPUT
    expect(result.prompt).toContain('Requested files: src/track.js');
    expect(result.prompt).toContain('RUNTIME OUTPUT:\n```\nRuntime crash in game loop\n```');
    expect(result.prompt).not.toContain('RUNTIME OUTPUT:\n```\nRuntime crash in game loop\nNEED:');

    // 2. Budget warning says files attached because requested, and lists size per file
    expect(result.hasGaps).toBe(true);
    const budgetGap = result.gaps.find((g) => g.includes('over the 400 budget'));
    expect(budgetGap).toBeDefined();
    expect(budgetGap).toContain('Files attached because they were requested: src/track.js (');
    expect(budgetGap).toMatch(/src\/track\.js \(\d+ chars\)/);
  });

  it('falls back to the whole file for a small file with no line', () => {
    const result = compileContext({
      projectRoot: project,
      targetFile: 'src/mesh.js',
      issue: 'this file is wrong',
    });
    expect(result.prompt).toContain('disposeMesh');
    expect(result.sections.some((s) => s.kind === 'full')).toBe(true);
  });

  it('sends only the interface for a large file with no line', () => {
    // A 300-line file with no error line must not be dumped; the outline plus
    // a reported gap is the honest answer.
    // Distinct names, so no symbol in the description matches and the
    // whole-file fallback is genuinely the only option left.
    // 80 blocks of 3 lines is 240 lines — comfortably past the 200-line
    // threshold, so the fallback really is the only option left.
    const big = Array.from(
      { length: 80 },
      (_, i) => `export function fn${i}() {\n  return ${i};\n}`,
    ).join('\n');
    write('src/big.js', big);
    expect(big.split('\n').length).toBeGreaterThan(200);
    const result = compileContext({
      projectRoot: project,
      targetFile: 'src/big.js',
      issue: 'something in there is not right',
    });
    expect(result.prompt).not.toContain(big);
    expect(result.hasGaps).toBe(true);
    expect(result.gaps.join()).toContain('only its signatures were sent');
    // The section is marked as an interface, not a body — the AI must be able
    // to tell "here is everything" from "here is only what I could narrow to".
    expect(result.sections.some((s) => s.file === 'src/big.js' && s.kind === 'signatures')).toBe(
      true,
    );
  });

  it('does not throw when the project has no context at all', () => {
    const empty = mkdtempSync(join(tmpdir(), 'cf-empty-'));
    try {
      const result = compileContext({ projectRoot: empty, issue: '' });
      expect(result.prompt).toContain('SURGICAL PATCH CONTRACT');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('strictPatchContract', () => {
  it('states every rule that makes a patch apply', () => {
    const contract = strictPatchContract();
    expect(contract).toContain('FIND');
    expect(contract).toContain('REPLACE');
    expect(contract).toContain('CONTEXT INSUFFICIENT');
    expect(contract).toContain('DO NOT INVENT');
    expect(contract).toContain('### EDIT:');
    expect(contract).toContain('### FILE:');
  });
});

describe('sliceWholeFile', () => {
  it('returns the file unchanged', () => {
    write('a.js', TRACK_JS);
    const slice = sliceWholeFile(TRACK_JS, 'a.js');
    expect(slice.text).toBe(TRACK_JS);
    expect(slice.isWholeFile).toBe(true);
  });
});

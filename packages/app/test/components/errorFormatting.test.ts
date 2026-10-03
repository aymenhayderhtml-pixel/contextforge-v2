/**
 * packages/app/test/components/errorFormatting.test.ts
 *
 * Tests for error formatting and instance scoping (ContextForge v2 Step 3b).
 */

import { describe, expect, it } from 'vitest';
import { createAppError } from '../../src/errors.js';
import type { PrefabFailure, SceneSnapshot } from '../../src/ipc.js';
import {
  collectProjectProblems,
  extractDetails,
  extractShortLine,
  formatErrorDetails,
  formatErrorShort,
  formatPrefabFailure,
  scopeErrorsToInstance,
  toAppError,
  translateSyntaxError,
} from '../../src/renderer/errorFormatting.js';

describe('formatPrefabFailure', () => {
  it('formats failure as one short line and preserves file in details', () => {
    const failure: PrefabFailure = {
      name: 'hazardCrate',
      file: 'models/hazardCrate.glb',
      reason: 'Corrupted GLTF buffer',
    };
    const err = formatPrefabFailure(failure);
    expect(err.short).toBe('hazardCrate failed to load: Corrupted GLTF buffer');
    expect(err.details).toBe('File: models/hazardCrate.glb');
    expect(err.scope).toBe('project');
  });
});

describe('extractShortLine & extractDetails', () => {
  it('extracts single line summary and separates stack trace', () => {
    const raw = `hazardCrate failed to load: Corrupted GLTF buffer\n  at loadGLTF (loader.ts:42)\n  at parse (parser.ts:15)`;
    expect(extractShortLine(raw)).toBe('hazardCrate failed to load: Corrupted GLTF buffer');
    expect(extractDetails(raw)).toBe('at loadGLTF (loader.ts:42)\n  at parse (parser.ts:15)');
  });

  it('handles single line with no details', () => {
    const raw = 'Simple error message';
    expect(extractShortLine(raw)).toBe('Simple error message');
    expect(extractDetails(raw)).toBeUndefined();
  });
});

describe('toAppError', () => {
  it('preserves an existing AppError', () => {
    const original = createAppError({
      id: 'custom-id',
      scope: 'instance',
      instanceId: 'crate_1',
      short: 'crate failed to spawn',
      details: 'Stack trace line 1',
    });
    const result = toAppError(original);
    expect(result).toBe(original);
  });

  it('converts native Error into AppError', () => {
    const err = new Error('Mesh parsing failed');
    const appErr = toAppError(err, { scope: 'instance', instanceId: 'crate_1' });
    expect(appErr.short).toBe('Mesh parsing failed');
    expect(appErr.scope).toBe('instance');
    expect(appErr.instanceId).toBe('crate_1');
    expect(appErr.details).toContain('Error: Mesh parsing failed');
  });

  it('converts raw string with param path into field-scoped AppError', () => {
    const raw = 'instances[1].params.width must be at least 0';
    const appErr = toAppError(raw);
    expect(appErr.scope).toBe('field');
    expect(appErr.fieldPath).toBe('width');
    expect(appErr.short).toBe('instances[1].params.width must be at least 0');
  });
});

describe('formatErrorShort & formatErrorDetails', () => {
  it('formats AppError', () => {
    const appErr = createAppError({
      scope: 'instance',
      short: 'hazardCrate failed to load: Corrupted GLTF buffer',
      details: 'at loadGLTF (loader.ts:10)',
    });
    expect(formatErrorShort(appErr)).toBe('hazardCrate failed to load: Corrupted GLTF buffer');
    expect(formatErrorDetails(appErr)).toBe('at loadGLTF (loader.ts:10)');
  });

  it('formats PrefabFailure', () => {
    const failure: PrefabFailure = {
      name: 'coin',
      file: 'coin.ts',
      reason: 'Syntax error',
    };
    expect(formatErrorShort(failure)).toBe('coin failed to load: Syntax error');
    expect(formatErrorDetails(failure)).toBe('File: coin.ts');
  });
});

describe('scopeErrorsToInstance', () => {
  it('includes errors matching the selected instanceId and excludes other instances', () => {
    const err1 = createAppError({
      scope: 'instance',
      instanceId: 'crate_1',
      short: 'crate_1 failed to spawn',
    });
    const err2 = createAppError({
      scope: 'instance',
      instanceId: 'crate_2',
      short: 'crate_2 failed to spawn',
    });
    const fieldErr1 = createAppError({
      scope: 'field',
      instanceId: 'crate_1',
      fieldPath: 'width',
      short: 'width must be at least 0',
    });
    const projectErr = createAppError({
      scope: 'project',
      short: 'project has invalid settings',
    });

    const scoped = scopeErrorsToInstance([err1, err2, fieldErr1, projectErr], 'crate_1');
    expect(scoped).toHaveLength(2);
    expect(scoped.map((e) => e.short)).toEqual([
      'crate_1 failed to spawn',
      'width must be at least 0',
    ]);
  });

  it('excludes raw strings that explicitly name another instance', () => {
    const string1 = 'instance "crate_2" has invalid transform';
    const string2 = 'instances[0].params.speed must be a finite number';
    const scoped = scopeErrorsToInstance([string1, string2], 'crate_1', 0);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.short).toBe('instances[0].params.speed must be a finite number');
  });
});

describe('collectProjectProblems', () => {
  it('collects problems from snapshot.problems, failed prefabs, and missing prefabs', () => {
    const snapshot: Partial<SceneSnapshot> = {
      problems: ['Scene contains duplicate id "crate"'],
      prefabs: {
        prefabs: [{ name: 'crate', description: '', paramsJsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
        failed: [
          { name: 'hazardCrate', file: 'models/hazardCrate.glb', reason: 'Corrupted GLTF buffer' },
        ],
      },
      scene: {
        name: 'main',
        instances: [
          { id: 'c1', prefab: 'crate', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
          { id: 'm1', prefab: 'ghost_prefab', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        ],
      },
    };

    const problems = collectProjectProblems({ snapshot: snapshot as SceneSnapshot });
    expect(problems).toHaveLength(3);

    // 1. Failed prefab
    expect(problems.some((p) => p.short === 'hazardCrate failed to load: Corrupted GLTF buffer')).toBe(true);
    // 2. Missing prefab
    expect(problems.some((p) => p.short.includes('ghost_prefab'))).toBe(true);
    // 3. Snapshot problem
    expect(problems.some((p) => p.short === 'Scene contains duplicate id "crate"')).toBe(true);
  });
});

describe('translateSyntaxError', () => {
  /**
   * The message shows the token tree-sitter actually named. It used to be
   * paraphrased into "a { is never closed" / "expected a name or identifier",
   * which was a second guess layered over the parser's answer: for an unclosed
   * function the two disagreed and the sentence named something that was not
   * missing at all. Naming the token is both shorter and more truthful.
   */
  it('shows the missing token as the parser reported it, with the line', () => {
    const raw = 'JavaScript/TypeScript syntax error: Syntax error: missing }';
    const result = translateSyntaxError(raw, 3);
    expect(result.plain).toBe('Line 3: missing }');
    expect(result.raw).toBe(raw);
    expect(result.line).toBe(3);
  });

  it('shows a missing closing parenthesis as a parenthesis, not a brace', () => {
    const raw = 'JavaScript/TypeScript syntax error: Syntax error: missing )';
    const result = translateSyntaxError(raw, 5);
    expect(result.plain).toBe('Line 5: missing )');
  });

  it('shows a missing closing bracket as a bracket', () => {
    const raw = 'JavaScript/TypeScript syntax error: Syntax error: missing ]';
    const result = translateSyntaxError(raw, 8);
    expect(result.plain).toBe('Line 8: missing ]');
  });

  it('shows a missing semicolon as a semicolon', () => {
    const raw = 'JavaScript/TypeScript syntax error: Syntax error: missing ;';
    const result = translateSyntaxError(raw, 14);
    expect(result.plain).toBe('Line 14: missing ;');
  });

  it('shows a missing comma and a missing colon as themselves', () => {
    expect(translateSyntaxError('Syntax error: missing ,', 9).plain).toBe('Line 9: missing ,');
    expect(translateSyntaxError('Syntax error: missing :', 9).plain).toBe('Line 9: missing :');
  });

  /**
   * The regression that motivated this: an unclosed function was reported by
   * core as "missing lexical_declaration", and the old translation table turned
   * some missing-token sentences into "expected a return statement". A missing
   * brace must never be described as a missing return statement.
   */
  it('never describes a missing brace as anything but a brace', () => {
    const result = translateSyntaxError('Syntax error: missing }', 3);
    expect(result.plain).not.toContain('return statement');
    expect(result.plain).toContain('missing }');
  });

  it('keeps a quoted token unquoted', () => {
    expect(translateSyntaxError('Syntax error: missing "}"', 3).plain).toBe('Line 3: missing }');
  });

  it('shows a plain-word missing token without re-jargoning it', () => {
    // Core emits "missing a name or identifier" for a MISSING identifier; the
    // renderer leaves that phrase alone rather than shortening it.
    const raw = 'JavaScript/TypeScript syntax error: Syntax error: missing a name or identifier';
    const result = translateSyntaxError(raw, 2);
    expect(result.plain).toBe('Line 2: missing a name or identifier');
  });

  it('shortens the grammar name identifier to plain words', () => {
    // An older core, or an ERROR path, can still say "missing identifier".
    expect(translateSyntaxError('Syntax error: missing identifier', 2).plain).toBe(
      'Line 2: missing a name or identifier',
    );
  });

  it('falls back to quoting the offending text when no token is named', () => {
    // An ERROR node carries no expected token. The snippet is nested-quoted,
    // which the `near "..."` reader cannot fully unwrap, so the honest report
    // is the text itself rather than a guessed imbalance.
    const result = translateSyntaxError('Syntax error near "function f() {', 2);
    expect(result.plain).toBe('Line 2: Syntax error near "function f() {');
  });

  it('translates GDScript missing body error into plain words', () => {
    const raw = "GDScript syntax error: statement on line 5 is missing a body — a func declaration needs a trailing ':' and an indented block";
    const result = translateSyntaxError(raw, 5);
    expect(result.plain).toBe("Line 5: statement is missing a body (needs a ':' and an indented block)");
    expect(result.raw).toBe(raw);
  });

  it('translates JSON unexpected token error', () => {
    const raw = 'JSON syntax error: Unexpected token } in JSON at position 10';
    const result = translateSyntaxError(raw, 3);
    expect(result.plain).toBe('Line 3: unexpected } in JSON');
  });

  it('extracts line number from message if not provided explicitly', () => {
    const raw = 'Syntax error on line 42: missing }';
    const result = translateSyntaxError(raw, null);
    expect(result.plain).toBe('Line 42: missing }');
    expect(result.line).toBe(42);
  });
});


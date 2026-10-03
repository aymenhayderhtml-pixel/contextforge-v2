/**
 * scene/template.test.ts — the project generator and its refusal.
 *
 * The refusal tests matter more than the happy path. A generator that produces
 * a plausible project from a half-filled brief does not fail visibly — it
 * produces a project that runs, and an AI fills in the rest from its own
 * assumptions. That is precisely the context loss this app exists to prevent, so
 * "refuses until the idea is filled in" is asserted directly.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkBrief,
  generateProject,
  IncompleteBriefError,
  type GameBrief,
} from '../../src/scene/template.js';
import { loadScene, validateScene } from '../../src/scene/sceneFile.js';
import { lintPrefabSource } from '../../src/scene/lint.js';

const GOOD_BRIEF: GameBrief = {
  name: 'star-crawler',
  idea: 'The player pilots a small ship around a ring of planets, collecting fuel canisters.',
  seed: 99,
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-tpl-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('checkBrief', () => {
  it('accepts a filled-in brief', () => {
    expect(checkBrief(GOOD_BRIEF)).toEqual([]);
  });

  it('rejects a missing name', () => {
    expect(checkBrief({ ...GOOD_BRIEF, name: '' }).join()).toContain('`name` is required');
  });

  it('rejects a missing idea', () => {
    expect(checkBrief({ ...GOOD_BRIEF, idea: '' }).join()).toContain('`idea` is required');
  });

  it('rejects an idea too short to be useful', () => {
    // Long enough to not be a recognised placeholder, short enough to be useless.
    const problems = checkBrief({ ...GOOD_BRIEF, idea: 'a space shooter' });
    expect(problems.join()).toContain('too short');
  });

  it('rejects a placeholder idea', () => {
    expect(checkBrief({ ...GOOD_BRIEF, idea: 'TODO' }).join()).toContain('placeholder');
  });

  it('rejects a name that is not a folder name', () => {
    expect(checkBrief({ ...GOOD_BRIEF, name: 'my game/../etc' }).join()).toContain('plain folder name');
  });

  it('lists every problem, not just the first', () => {
    expect(checkBrief({ name: '', idea: '' })).toHaveLength(2);
  });
});

describe('generateProject refuses an incomplete brief', () => {
  it('throws rather than generating', () => {
    let caught: unknown;
    try {
      generateProject(dir, { name: 'thing', idea: '' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IncompleteBriefError);
    expect((caught as IncompleteBriefError).missing.join()).toContain('idea');
  });

  it('writes nothing when it refuses', () => {
    // The dangerous outcome would be a half-written project: a scene with no
    // prefabs, which fails at load with a far less obvious message.
    expect(() => generateProject(dir, { name: 'thing', idea: 'x' })).toThrow();
    expect(existsSync(join(dir, 'scene.json'))).toBe(false);
  });

  it('explains why, in terms of the consequence', () => {
    let message = '';
    try {
      generateProject(dir, { name: 'thing' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('game brief is incomplete');
    expect(message).toContain('the wrong game');
  });
});

describe('generateProject produces a working project', () => {
  it('writes every expected file', () => {
    const result = generateProject(dir, GOOD_BRIEF);
    expect(result.files.sort()).toEqual(
      [
        'AI_RULES.md',
        'README.md',
        'loadScene.ts',
        'prefabs/cube.ts',
        'prefabs/index.ts',
        'scene.json',
      ].sort(),
    );
    for (const file of result.files) {
      expect(existsSync(join(dir, file))).toBe(true);
    }
  });

  it('writes a scene.json that validates and loads', () => {
    generateProject(dir, GOOD_BRIEF);
    const scene = loadScene(join(dir, 'scene.json'));
    expect(scene).not.toBeNull();
    expect(validateScene(scene).valid).toBe(true);
    expect(scene?.instances.length).toBeGreaterThan(0);
  });

  it('places only prefabs that the registry defines', () => {
    // Rule 1 is only true if this holds: a scene referencing an unregistered
    // prefab could not be built, and the rule would be decorative.
    generateProject(dir, GOOD_BRIEF);
    const scene = loadScene(join(dir, 'scene.json'));
    const registrySource = readFileSync(join(dir, 'prefabs/index.ts'), 'utf-8');
    const defined = new Set(
      [...registrySource.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1] ?? ''),
    );
    defined.add('cube'); // exported from cube.ts

    for (const instance of scene?.instances ?? []) {
      expect(defined.has(instance.prefab)).toBe(true);
    }
  });

  it('carries the idea into the AI rules file', () => {
    generateProject(dir, GOOD_BRIEF);
    const rules = readFileSync(join(dir, 'AI_RULES.md'), 'utf-8');
    expect(rules).toContain(GOOD_BRIEF.idea);
    expect(rules).toContain('Every object in the scene must be a prefab');
    expect(rules).toContain('All scene placement goes in `scene.json`');
    // The refusal loop has to be stated, or an AI guesses instead of asking.
    expect(rules).toContain('CONTEXT INSUFFICIENT');
  });

  it('states the two rules in the README too', () => {
    generateProject(dir, GOOD_BRIEF);
    const readme = readFileSync(join(dir, 'README.md'), 'utf-8');
    expect(readme).toContain('Every object is a prefab');
    expect(readme).toContain('All placement is in `scene.json`');
  });

  it('ships a cube prefab that passes the prefab lint', () => {
    // A template that teaches a rule it violates is worse than no template.
    generateProject(dir, GOOD_BRIEF);
    const cubeSource = readFileSync(join(dir, 'prefabs/cube.ts'), 'utf-8');
    const result = lintPrefabSource(cubeSource, 'prefabs/cube.ts');
    expect(result.violations.map((v) => `${v.line}:${v.rule}`)).toEqual([]);
  });

  it('ships a loader that contains no placements', () => {
    // Rule 2 as a mechanical property: the loader must not hard-code a
    // position. `SCENE_PATH` and the camera setup are the only numbers, and
    // they are not placements.
    generateProject(dir, GOOD_BRIEF);
    const loader = readFileSync(join(dir, 'loadScene.ts'), 'utf-8');
    expect(loader).toContain('loadScene(');
    // No `position.set(` with literal numbers — every position comes from
    // `instance.transform`.
    expect(loader).not.toMatch(/position\.set\(\s*-?\d/);
  });

  it('uses the brief seed, so two runs of the same brief match', () => {
    const a = generateProject(join(dir, 'a'), GOOD_BRIEF);
    const b = generateProject(join(dir, 'b'), GOOD_BRIEF);
    expect(readFileSync(join(a.root, 'scene.json'), 'utf-8')).toBe(
      readFileSync(join(b.root, 'scene.json'), 'utf-8'),
    );
    expect(loadScene(join(a.root, 'scene.json'))?.seed).toBe(99);
  });
});

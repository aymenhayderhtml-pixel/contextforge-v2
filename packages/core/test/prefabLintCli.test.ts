/**
 * prefabLintCli.test.ts — `npm run lint:prefabs` actually fails.
 *
 * The unit suite in `test/scene/lint.test.ts` proves the *lint function* flags
 * each rule. This proves the *command* does, and specifically that it exits
 * non-zero — because a linter that prints violations and exits 0 is the
 * difference between a CI gate and a suggestion nobody reads (SPEC R9).
 *
 * The check is only real if a clean run and a violating run give different exit
 * codes, so both are asserted here against the real script.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const linter = join(repoRoot, 'scripts', 'lint-prefabs.mjs');

/** Run the linter over one directory. Never throws: the exit code is the result. */
function lint(dir: string): { output: string; code: number } {
  try {
    const stdout = execFileSync('node', [linter, dir], { cwd: repoRoot, encoding: 'utf-8' });
    return { output: stdout, code: 0 };
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; status?: number };
    return { output: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
}

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cf-lintcli-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Write one prefab into its own directory and lint it. */
function lintSource(name: string, source: string): { output: string; code: number } {
  const dir = join(scratch, name.replace(/[^a-z0-9]/gi, '_'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'prefab.ts'), source, 'utf-8');
  return lint(dir);
}

describe('lint:prefabs — a clean prefab passes', () => {
  it('exits 0 and says clean', () => {
    const { code, output } = lintSource('good', `
export const paramsSchema = null;
export function create(three, params, rng) {
  const mesh = new three.Mesh();
  mesh.position.x = rng.range(-1, 1);
  return { object: mesh, parts: { body: mesh } };
}
`);
    expect(code).toBe(0);
    expect(output).toContain('clean');
  });
});

describe('lint:prefabs — every rule fails the command', () => {
  // One case per SPEC R7 rule. Each asserts the non-zero exit *and* that the
  // named rule appears, so a rule that silently stops being detected fails here
  // rather than passing because "something" was flagged.
  const cases: Array<[string, string, string]> = [
    [
      'no-this',
      'no-this',
      `export function create(three) {
  const self = this;
  return { object: new three.Object3D(), parts: { self } };
}`,
    ],
    [
      'no-scene-add',
      'no-scene-add',
      `export function create(three, params, rng, scene) {
  const mesh = new three.Mesh();
  scene.add(mesh);
  return { object: mesh, parts: {} };
}`,
    ],
    [
      'no-math-random',
      'no-math-random',
      `export function create(three) {
  const x = Math.random();
  return { object: new three.Object3D(), parts: { x } };
}`,
    ],
    [
      'no-module-mutable-state',
      'no-module-mutable-state',
      `let placed = 0;
export function create(three) {
  placed += 1;
  return { object: new three.Object3D(), parts: { placed } };
}`,
    ],
    [
      'no-dom-global',
      'no-dom-global',
      `export function create(three) {
  return { object: new three.Object3D(), parts: { w: window } };
}`,
    ],
  ];

  it.each(cases)('exits non-zero for %s', (_rule, expectedName, source) => {
    const { code, output } = lintSource(`bad-${expectedName}`, source);
    expect(code).toBe(1);
    expect(output).toContain(expectedName);
    expect(output).toMatch(/violation\(s\)/);
  });

  it('reports a prefab that does not parse as a failure, not a pass', () => {
    // A file the lint could not read must never report clean: that is the one
    // outcome that looks like success while nothing was checked.
    const { code, output } = lintSource('broken', 'export function create( { return');
    expect(code).toBe(1);
    expect(output).toContain('parse-error');
  });
});

describe('lint:prefabs — operational behaviour', () => {
  it('exits 2 with a message when the path does not exist', () => {
    const { code, output } = lint(join(scratch, 'no-such-directory'));
    expect(code).toBe(2);
    expect(output).toContain('no such path');
  });

  it('exits 0 when the directory holds no prefab sources', () => {
    // "Nothing to check" is not a violation; failing here would make the gate
    // unusable on a freshly generated project with no prefabs yet.
    const dir = join(scratch, 'empty');
    mkdirSync(dir, { recursive: true });
    const { code, output } = lint(dir);
    expect(code).toBe(0);
    expect(output).toContain('no prefab sources');
  });
});

/**
 * boundaryCheck.test.ts — the boundary checker itself.
 *
 * `check:boundaries` is the only mechanical enforcement of SPEC R3/R4, which
 * makes it load-bearing: if it stops detecting a violation, core can quietly
 * import Three.js or `electron` and every headless guarantee goes with it.
 *
 * This suite exists because that happened. A fix for one false positive — a
 * generated `loadScene.ts` inside a template literal being read as core's own
 * import of Three.js — blanked quoted strings before the import scan, which
 * reduced `from 'three'` to `from ""` and made the import check detect
 * **nothing at all**. The repository stayed green for that entire period.
 *
 * So both directions are asserted here, on the real script:
 *
 *  - every forbidden import form is still detected;
 *  - generated source inside a template literal is still *not* flagged.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const checker = join(repoRoot, 'scripts', 'check-boundaries.mjs');

/**
 * A file dropped inside core, so the checker sees it.
 *
 * The checker only walks `packages/core/src`, so a temp dir outside the repo
 * would be invisible to it. The probe is removed after every run.
 */
const probePath = join(repoRoot, 'packages', 'core', 'src', 'boundary-probe.ts');

/** Run the checker and return its combined output plus exit code. */
function run(): { output: string; code: number } {
  try {
    const stdout = execFileSync('node', [checker], { cwd: repoRoot, encoding: 'utf-8' });
    return { output: stdout, code: 0 };
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; status?: number };
    return { output: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
}

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cf-boundary-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(probePath, { force: true });
});

/** Write the probe, run the checker, and clean up. */
function checkWith(source: string): { output: string; code: number } {
  mkdirSync(dirname(probePath), { recursive: true });
  writeFileSync(probePath, source, 'utf-8');
  try {
    return run();
  } finally {
    rmSync(probePath, { force: true });
  }
}

describe('check:boundaries on the real repository', () => {
  it('passes, because core stays headless', () => {
    const { code, output } = run();
    expect(output).toContain('0 violations');
    expect(code).toBe(0);
  });
});

describe('check:boundaries still detects forbidden imports', () => {
  // Each of these was silently missed when the string-masking fix over-applied.
  // They are listed individually rather than in a loop so a failure names the
  // exact import form that regressed.
  const cases: Array<[string, string]> = [
    ['a named import of three', "import { Scene } from 'three';"],
    ['a namespace import of three', "import * as THREE from 'three';"],
    ['a default import of three', "import THREE from 'three';"],
    ['an import of electron', "import { app } from 'electron';"],
    ['a require of svelte', "const svelte = require('svelte');"],
    ['an import of @contextforge/app', "import { screen } from '@contextforge/app';"],
    ['a dynamic import of three', "const t = await import('three');"],
    ['a dynamic import of electron', "const e = await import('electron');"],
  ];

  it.each(cases)('flags %s', (_label, source) => {
    const { code, output } = checkWith(source);
    expect(code).toBe(1);
    expect(output).toContain('boundary-probe.ts');
    expect(output).toMatch(/imports (forbidden|UI-layer) package/);
  });
});

describe('check:boundaries still detects DOM globals', () => {
  it.each(['window', 'document', 'localStorage', 'HTMLElement'])('flags %s', (name) => {
    const { code, output } = checkWith(
      `export function f(): void {\n  ${name}.toString();\n}\n`,
    );
    expect(code).toBe(1);
    expect(output).toContain(`DOM global "${name}"`);
  });

  it('does not flag a DOM global named in a comment or a string', () => {
    // The false positive the original masking was written to avoid — and the one
    // whose fix must not cost real detection.
    const { code } = checkWith(
      `// The window is irrelevant: core is headless.\n` +
        `/** A document is not attached to a scene. */\n` +
        `export const note = 'this string mentions window and document';\n`,
    );
    expect(code).toBe(0);
  });
});

describe('check:boundaries does not flag generated source', () => {
  it('ignores an import inside a template literal', () => {
    // The template generator emits a whole module that imports Three.js. That
    // is a *generated* project, not core, and reporting it would make the
    // checker fail on correct code.
    const { code, output } = checkWith(
      'export function emit(): string {\n' +
        "  return `\n" +
        "import * as THREE from 'three';\n" +
        "import { app } from 'electron';\n" +
        'export function go(): void { window.alert(THREE); }\n' +
        '`;\n' +
        '}\n',
    );
    expect(code).toBe(0);
    expect(output).toContain('0 violations');
  });
});
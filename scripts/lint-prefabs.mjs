#!/usr/bin/env node
/**
 * scripts/lint-prefabs.mjs — `npm run lint:prefabs` (SPEC §6.4).
 *
 * Lints every prefab in the repository against the five rules in SPEC R7, using
 * core's tree-sitter lint. Two sources are checked:
 *
 *  - `packages/core/src/scene/prefabs/**` — core's own prefab modules;
 *  - any `prefabs/` directory given as an argument — a *generated* project's
 *    prefabs, which is where an AI's violations actually land.
 *
 * Enforcing this mechanically rather than by convention is the point of R7: a
 * prefab that calls `Math.random()` compiles, runs, looks correct, and silently
 * makes every scene non-reproducible. Nothing else would ever report it.
 *
 * Exits non-zero with a file:line list when anything is flagged, so a CI gate
 * is possible without reading the output (SPEC R9).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Core is imported from its built output because it is ESM with native
// grammars; running `npm run lint:prefabs` without a build would otherwise fail
// with a module-resolution error that says nothing useful.
const coreEntry = join(repoRoot, 'packages', 'core', 'dist', 'scene', 'lint.js');

let lintPrefabSource, formatLintResult;
try {
  ({ lintPrefabSource, formatLintResult } = await import(coreEntry));
} catch (error) {
  console.error(
    'lint:prefabs — could not load the lint from core.\n' +
      'Run "npm run build" first (core must be built; it uses native grammars).\n\n' +
      `${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

/** Roots to lint: core's own prefabs, plus anything passed on the command line. */
const roots = process.argv.slice(2);
const targets = roots.length > 0 ? roots : [join(repoRoot, 'packages', 'core', 'src', 'scene', 'prefabs')];

/** Source extensions a prefab can be written in. */
const PREFAB_EXTENSIONS = new Set(['.ts', '.js', '.mjs']);

function isIgnoredDir(name) {
  return name === 'node_modules' || name === 'dist' || name.startsWith('.');
}

function collectFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // A path that does not exist is reported by the caller, not silently empty.
    return out;
  }

  for (const entry of entries) {
    if (isIgnoredDir(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else {
      const dot = entry.name.lastIndexOf('.');
      const extension = dot === -1 ? '' : entry.name.slice(dot);
      if (PREFAB_EXTENSIONS.has(extension)) out.push(full);
    }
  }
  return out;
}

const files = [];
for (const target of targets) {
  const absolute = resolve(target);
  if (!statSync(absolute, { throwIfNoEntry: false })) {
    console.error(`lint:prefabs — no such path: ${target}`);
    process.exit(2);
  }
  collectFiles(absolute, files);
}

if (files.length === 0) {
  console.log(`lint:prefabs — no prefab sources found in ${targets.join(', ')}.`);
  process.exit(0);
}

let violationCount = 0;
for (const file of files.sort()) {
  const source = readFileSync(file, 'utf-8');
  const result = lintPrefabSource(source, relative(repoRoot, file));
  violationCount += result.violations.length;
  console.log(formatLintResult(result));
}

if (violationCount > 0) {
  console.error(
    `\nlint:prefabs — ${violationCount} violation(s) across ${files.length} prefab file(s).\n` +
      'A prefab must be a pure function (SPEC R7): no `this`, no module-level\n' +
      'mutable state, no `scene.add`, no `Math.random`, no DOM globals.',
  );
  process.exit(1);
}

console.log(`\nlint:prefabs — ${files.length} prefab file(s) clean.`);
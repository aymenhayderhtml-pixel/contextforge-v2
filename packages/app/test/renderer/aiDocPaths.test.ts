/**
 * packages/app/test/renderer/aiDocPaths.test.ts
 *
 * Every file path mentioned in `AI.md` exists.
 *
 * ## Why
 *
 * `AI.md` is the first thing an agent reads. A path in it that has stopped
 * existing sends the agent to a file that is not there, and it will either waste
 * turns or — worse — conclude the feature was removed and "fix" something that was
 * never broken. That failure is silent: the suite is green, because nothing checks
 * the document.
 *
 * So the document is checked like code. The rule it enforces is the same one the
 * repo applies everywhere else: a claim nobody checked is the same defect as a
 * message nobody verified.
 *
 * ## What counts as a path
 *
 * Backtick-quoted spans that look like repository paths and end in a known code
 * or documentation extension, optionally with a line number. Deliberately narrow:
 * a loose match would flag prose, and a check that cries wolf gets deleted.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const AI_MD = join(ROOT, 'AI.md');

/** Extensions a backticked span must end in to be treated as a path. */
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.svelte', '.mjs', '.cjs', '.js', '.cts', '.mts', '.json', '.md', '.py',
]);

/**
 * `kart-dash-3d-v2` is a sibling of this repo, not inside it. Its paths are real
 * but resolving them from `ROOT` would land one directory too high, so they are
 * checked against the parent on the assumption the sibling layout is the norm.
 */
const SIBLING = 'kart-dash-3d-v2';

function readDoc(): string {
  return readFileSync(AI_MD, 'utf8');
}

/**
 * Paths from backticked spans, with any `:line` suffix removed.
 *
 * Both `a/b.ts` and `a/b.ts:42` appear, and the line number must not be part of
 * the path or every `file:line` reference would fail.
 *
 * **Three shorthand forms are skipped**, because they name a file but do not
 * contain one:
 *
 * - `scene/{edits,sceneFile}.ts` — a brace group naming several files
 * - `core/test/graph/*.test.ts` — a glob
 * - `ProjectScreen.svelte` — a bare filename with no directory
 *
 * Skipping is the right call for the first two: they are *lists*, and a list that
 * is checked has to have every element resolved, which means the check would
 * silently pass if the directory were empty. The third is more debatable, and it
 * is skipped because AI.md uses bare filenames in prose about screens; the
 * directory-qualified forms in the same document are what carry the guarantee.
 */
function pathsIn(doc: string): string[] {
  const found = new Set<string>();
  for (const match of doc.matchAll(/`([^`\n]+)`/g)) {
    const raw = (match[1] ?? '').trim();
    if (/[{*?]/.test(raw)) continue; // brace group, glob, or optional segment
    // Strip a trailing `:123` or `:12-34` line reference.
    const withoutLine = raw.replace(/:\d+(?:-\d+)?$/, '');
    if (!CODE_EXTENSIONS.has(extnameOf(withoutLine))) continue;
    // A bare filename carries no directory, so it cannot be resolved against the
    // repo without a search. Skipped rather than guessed.
    if (!withoutLine.includes('/')) continue;
    found.add(withoutLine);
  }
  return [...found];
}

function extnameOf(p: string): string {
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const name = slash < 0 ? p : p.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

describe('AI.md', () => {
  it('exists at the repository root', () => {
    expect(existsSync(AI_MD)).toBe(true);
  });

  it('mentions at least twenty paths, so the check is not vacuous', () => {
    // If the extraction ever stops matching, every other test here would pass on
    // an empty list — which is a green suite proving nothing.
    expect(pathsIn(readDoc()).length).toBeGreaterThanOrEqual(20);
  });

  it('points only at files that exist', () => {
    const doc = readDoc();
    const missing: string[] = [];

    for (const path of pathsIn(doc)) {
      // `core/src/...` and `app/src/...` are abbreviations the doc uses for
      // `packages/core/src/...` and `packages/app/src/...`.
      const candidates = [
        join(ROOT, path),
        join(ROOT, 'packages', path),
        join(ROOT, 'packages', 'core', path),
        join(ROOT, 'packages', 'app', path),
        join(ROOT, 'docs', path),
        join(ROOT, 'scripts', path),
        join(ROOT, dirname(ROOT), path),
      ];
      if (!candidates.some((c) => existsSync(c))) missing.push(path);
    }

    expect(
      missing,
      `AI.md points at ${missing.length} path(s) that do not exist: ${missing.join(', ')}. ` +
        'Either the file moved or AI.md is stale. Fix AI.md, not the test.',
    ).toEqual([]);
  });

  it('does not name the test game in a way that invites editing it', () => {
    // The rule exists so an agent does not "fix" something in a read-only project.
    // If the path check resolves it, the read-only warning must still be present.
    expect(readDoc()).toContain(SIBLING);
    expect(readDoc().toLowerCase()).toContain('read-only');
  });
});

describe('the path extraction', () => {
  it('finds a plain path', () => {
    expect(pathsIn('see `packages/core/src/index.ts` for details')).toContain(
      'packages/core/src/index.ts',
    );
  });

  it('strips a line number', () => {
    expect(pathsIn('read `packages/app/vite.config.ts:78`')).toContain(
      'packages/app/vite.config.ts',
    );
  });

  it('ignores prose and non-code spans', () => {
    const doc = 'use `npm run verify` and the `scope` variable, not `a/b.txt`';
    expect(pathsIn(doc)).toEqual([]);
  });

  it('ignores a channel name or a glob', () => {
    expect(pathsIn('the `patch:preview` channel and `packages/*/test/**` glob')).toEqual([]);
  });

  it('ignores a brace group, which names several files at once', () => {
    // Checked as a list by eye, not by this test: resolving every element of a
    // brace group would pass vacuously if the directory were empty.
    expect(pathsIn('core/src/graph/{analysis,reverse}.ts')).toEqual([]);
  });

  it('ignores a bare filename with no directory', () => {
    expect(pathsIn('see ProjectScreen.svelte for the flow')).toEqual([]);
  });

  it('reads the real document without throwing', () => {
    expect(() => pathsIn(readDoc())).not.toThrow();
  });
});

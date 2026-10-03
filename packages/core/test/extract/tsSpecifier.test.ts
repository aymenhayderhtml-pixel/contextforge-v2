/**
 * packages/core/test/extract/tsSpecifier.test.ts
 *
 * A `.js` specifier that names a `.ts` file.
 *
 * This is how every TypeScript project is written: the source is `kart.ts` and
 * the import says `./kart.js`, because the *emitted* JavaScript needs a real
 * extension at runtime and the specifier is written against the output. Before
 * this was resolved, `resolveCandidates` treated an explicit extension as final,
 * so a TypeScript project's entire import graph came back empty — every file
 * looked unreferenced, and the Graph screen's drawer listed the whole project.
 *
 * The same gap existed in `resolveScriptSrc`, where a Vite project's
 * `index.html` loads `/src/main.js` and the file on disk is `src/main.ts`. That
 * drops the graph's root, so everything under it looked orphaned too.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractJsProject } from '../../src/extract/js.js';
import { resolveScriptSrc } from '../../src/extract/html.js';
import { findOrphans } from '../../src/graph/analysis.js';

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-ts-spec-'));
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(dir, relative);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return dir;
}

const temps: string[] = [];
function project(files: Record<string, string>): string {
  const dir = tempProject(files);
  temps.push(dir);
  return dir;
}

describe('a .js specifier resolves to its TypeScript source', () => {
  it('links main.ts to kart.ts when main imports "./kart.js"', () => {
    const root = project({
      'src/main.ts': "import { kart } from './kart.js';\nexport const boot = kart;\n",
      'src/kart.ts': 'export const kart = { speed: 5 };\n',
    });
    const graph = extractJsProject(root);

    expect(graph.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['src/main.ts->src/kart.ts']);
    // Without the edge, kart.ts is a leaf with no dependent and looks orphaned.
    expect(findOrphans(graph).map((o) => o.node.id)).toEqual(['src/main.ts']);
  });

  it('resolves .tsx and .jsx the same way', () => {
    const root = project({
      'src/main.ts': "import { Card } from './Card.jsx';\nexport const all = Card;\n",
      'src/Card.tsx': 'export const Card = 1;\n',
    });
    expect(extractJsProject(root).edges.map((e) => e.to)).toEqual(['src/Card.tsx']);
  });

  it('prefers a real .js file when both exist', () => {
    // Node's rule must still win: a project that has both `kart.js` and
    // `kart.ts` resolves the `.js`, or the graph would describe a different
    // module graph than the one that runs.
    const root = project({
      'src/main.ts': "import { kart } from './kart.js';\nexport const boot = kart;\n",
      'src/kart.js': 'export const kart = 1;\n',
      'src/kart.ts': 'export const kart = 2;\n',
    });
    expect(extractJsProject(root).edges.map((e) => e.to)).toEqual(['src/kart.js']);
  });

  it('leaves a genuinely missing specifier unresolved', () => {
    // The fallback must not invent a node. A reference to a file that does not
    // exist produces no edge — which is the existing contract for an
    // unresolvable import, asserted here so the `.js`-to-`.ts` fallback is not
    // quietly relaxed into "resolve anything that looks close".
    const root = project({
      'src/main.ts': "import { ghost } from './ghost.js';\nexport const boot = ghost;\n",
    });
    expect(extractJsProject(root).edges).toEqual([]);
  });
});

describe('an index.html script src resolves to its TypeScript source', () => {
  it('resolves "/src/main.js" to src/main.ts', () => {
    const root = project({
      'index.html': '<script type="module" src="/src/main.js"></script>\n',
      'src/main.ts': 'export const boot = 1;\n',
    });
    const htmlPath = join(root, 'index.html');
    expect(resolveScriptSrc('/src/main.js', htmlPath, root)).toBe('src/main.ts');
  });

  it('prefers the literal file when it exists', () => {
    const root = project({
      'index.html': '<script type="module" src="/src/main.js"></script>\n',
      'src/main.js': 'export const boot = 1;\n',
    });
    expect(resolveScriptSrc('/src/main.js', join(root, 'index.html'), root)).toBe('src/main.js');
  });

  it('still refuses a remote URL', () => {
    const root = project({ 'index.html': '<script src="https://cdn.example/x.js"></script>\n' });
    expect(resolveScriptSrc('https://cdn.example/x.js', join(root, 'index.html'), root)).toBeNull();
  });

  it('still refuses a src that resolves to nothing at all', () => {
    const root = project({ 'index.html': '<script src="/missing.js"></script>\n' });
    expect(resolveScriptSrc('/missing.js', join(root, 'index.html'), root)).toBeNull();
  });

  it('makes the HTML the graph root rather than an orphan', () => {
    const root = project({
      'index.html': '<script type="module" src="/src/main.js"></script>\n',
      'src/main.ts': 'export const boot = 1;\n',
    });
    const graph = extractJsProject(root);
    // index.html imports main.ts, so main.ts is referenced. index.html itself is
    // referenced by nothing, which is correct and is why the drawer's
    // entry_point reason exists.
    expect(graph.edges.map((e) => `${e.from}->${e.to}`)).toContain('index.html->src/main.ts');
    const orphans = findOrphans(graph).map((o) => o.node.id);
    expect(orphans).toEqual(['index.html']);
    expect(findOrphans(graph)[0]?.reason).toBe('entry_point');
  });
});

afterAll(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});
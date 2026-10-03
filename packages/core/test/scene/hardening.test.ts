/**
 * packages/core/test/scene/hardening.test.ts
 *
 * Phase 5e — the edge cases: an empty project, a large one, and folders that are
 * broken in the ways real folders break.
 *
 * ## The bug this file was written for
 *
 * `generateProject`'s doc comment claimed "existing files are never overwritten".
 * There was no check making that true. Generating twice over a folder the
 * developer had edited silently replaced `prefabs/cube.ts`, `scene.json` and
 * `AI_RULES.md` with the template — the exact data loss the comment said could
 * not happen. It was found by *running* the function in an empty-then-edited
 * folder, not by reading it, which is the only reason it is now pinned.
 *
 * ## Timing policy
 *
 * The large-graph thresholds are loose on purpose. They exist to catch an
 * accidental O(n^2) — a 10× input for a linear algorithm should cost ~10×, and a
 * quadratic one costs 100× — not to benchmark. A slow machine should not fail
 * this suite.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractJsProject } from '../../src/extract/js.js';
import { findCycles, layerNodes } from '../../src/graph/reverse.js';
import {
  edgesWithin,
  findOrphans,
  focusNeighbourhood,
  summariseGraph,
} from '../../src/graph/analysis.js';
import { buildManifest, validateManifest } from '../../src/graph/manifest.js';
import { generateProject } from '../../src/scene/template.js';

const temporaries: string[] = [];
afterAll(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-harden-'));
  temporaries.push(dir);
  return dir;
}

/** A brief that passes every rule. */
const brief = {
  name: 'probe-game',
  idea: 'You drive a hover car around a collapsing space station.',
};

/** `count` files in a chain, plus back-edges so the graph is not a tree. */
function chainProject(count: number): string {
  const dir = tempDir();
  const src = join(dir, 'src');
  mkdirSync(src, { recursive: true });
  for (let i = 0; i < count; i++) {
    const next = i + 1 < count ? `\nimport './f${i + 1}.js';` : '';
    const backEdge = i % 10 === 0 && i > 0 ? `\nimport './f0.js';` : '';
    writeFileSync(
      join(src, `f${i}.js`),
      `export const v${i} = ${i};${next}${backEdge}\n`,
    );
  }
  return dir;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('a project with no files at all', () => {
  const empty = tempDir();
  const graph = extractJsProject(empty);

  it('extracts an empty graph rather than throwing', () => {
    // An empty folder is a legitimate state — it is what a developer has the
    // instant after choosing "New project". Throwing here would make the screen
    // show an error for the moment before anything exists.
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it('summarises to zeroes, not to undefined', () => {
    const summary = summariseGraph(graph);
    expect(summary).toEqual({
      nodes: 0,
      edges: 0,
      orphans: 0,
      byType: {},
      byEdgeKind: {},
    });
  });

  it('finds no orphans and no neighbourhood', () => {
    expect(findOrphans(graph)).toEqual([]);
    expect(focusNeighbourhood(graph, 'anything', 1)).toEqual([]);
    expect(edgesWithin(graph, new Set())).toEqual([]);
  });

  it('produces a manifest that validates', () => {
    const result = validateManifest(buildManifest(empty, graph, '2026-01-01T00:00:00.000Z'));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('generates a project into it', () => {
    // The empty-folder case is the normal one for "New project", so it has to
    // work. It writes six files.
    const generated = generateProject(empty, brief);
    expect(generated.files).toHaveLength(6);
    expect(generated.files).toContain('scene.json');
  });
});

describe('generateProject refuses to destroy work', () => {
  it('refuses to write a second time into the same folder', () => {
    // The regression. Generating twice used to succeed and overwrite everything.
    const dir = tempDir();
    generateProject(dir, brief);

    expect(() => generateProject(dir, brief)).toThrow(/already contains/i);
  });

  it('leaves the developer\'s edits untouched when it refuses', () => {
    const dir = tempDir();
    generateProject(dir, brief);

    // The developer's work, in the three files a second run used to replace.
    const mine = 'export const mine = "do not lose me";\n';
    writeFileSync(join(dir, 'prefabs', 'cube.ts'), mine);
    writeFileSync(join(dir, 'scene.json'), '{"mine":true}');
    writeFileSync(join(dir, 'AI_RULES.md'), 'my own rules');

    let refused = false;
    try {
      generateProject(dir, brief);
    } catch {
      refused = true;
    }
    expect(refused, 'a second generateProject must refuse').toBe(true);

    // Byte-for-byte. Not "close", not "still parses" — identical.
    expect(readFileSync(join(dir, 'prefabs', 'cube.ts'), 'utf-8')).toBe(mine);
    expect(readFileSync(join(dir, 'scene.json'), 'utf-8')).toBe('{"mine":true}');
    expect(readFileSync(join(dir, 'AI_RULES.md'), 'utf-8')).toBe('my own rules');
  });

  it('names the conflicting files so the developer can see what is in the way', () => {
    const dir = tempDir();
    generateProject(dir, brief);
    writeFileSync(join(dir, 'scene.json'), '{"mine":true}');

    let message = '';
    try {
      generateProject(dir, brief);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // Every existing file is named, and the refusal says nothing was written.
    expect(message).toContain('scene.json');
    expect(message).toContain('prefabs/cube.ts');
    expect(message).toMatch(/Nothing has been written/);
  });

  it('ignores files it does not own', () => {
    // Only the six the generator writes are checked. A folder holding other
    // work is still a valid target.
    const dir = tempDir();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'existing.js'), 'export const a = 1;');
    writeFileSync(join(dir, 'package.json'), '{"name":"mine"}');

    const generated = generateProject(dir, brief);
    expect(generated.files).toHaveLength(6);
    // And it left the other files alone.
    expect(readFileSync(join(dir, 'src', 'existing.js'), 'utf-8')).toBe('export const a = 1;');
  });

  it('refuses before writing anything, not partway through', () => {
    // Ordering is part of the guarantee: a partial write is worse than none,
    // because the first file is already gone.
    const dir = tempDir();
    mkdirSync(join(dir, 'prefabs'), { recursive: true });
    writeFileSync(join(dir, 'prefabs', 'index.ts'), 'mine');

    expect(() => generateProject(dir, brief)).toThrow();

    // scene.json is the FIRST file written, so if the check ran after any
    // write this file would exist.
    expect(() => readFileSync(join(dir, 'scene.json'), 'utf-8')).toThrow();
  });
});

describe('a project with a thousand files', () => {
  const root = chainProject(1000);
  const started = Date.now();
  const graph = extractJsProject(root);
  const extractMs = Date.now() - started;

  it('extracts all of them', () => {
    expect(graph.nodes.length).toBe(1000);
    expect(graph.edges.length).toBeGreaterThan(900);
  });

  it('extracts in a time a developer will wait through', () => {
    // Loose on purpose. Extraction is tree-sitter-bound, not graph-bound, and
    // this is the slow path by design.
    expect(extractMs, `extraction took ${extractMs}ms`).toBeLessThan(30_000);
  });

  it('summarises, and finds orphans, quickly', () => {
    const t0 = Date.now();
    const summary = summariseGraph(graph);
    const orphanCount = findOrphans(graph).length;
    const ms = Date.now() - t0;

    expect(summary.nodes).toBe(1000);
    expect(orphanCount).toBeGreaterThan(0);
    // These two run on every screen render, so they have a real budget. A
    // quadratic implementation would be ~100x for 1000 nodes; this asserts the
    // shape stays linear enough to be invisible.
    expect(ms, `summarise + findOrphans took ${ms}ms`).toBeLessThan(2000);
  });

  it('focuses on a middle node at depth 2 without walking the graph', () => {
    // The chain runs `src/f0.js → … → src/f999.js`, with every tenth file also
    // importing `src/f0.js`. Node ids are project-relative, hence the `src/`.
    const t0 = Date.now();
    const focused = focusNeighbourhood(graph, 'src/f500.js', 2);
    const ms = Date.now() - t0;

    expect(focused.map((f) => f.node.id)).toContain('src/f500.js');

    // 105, not 1000: `src/f501.js` is a direct neighbour, `src/f0.js` is a
    // neighbour of it, and `src/f0.js` has ~100 dependents, all of which are at
    // distance 2. A walk that returned everything would be 1000; one that
    // returned only the chain would be ~5. This asserts the neighbourhood is a
    // neighbourhood — bounded by the graph's *shape*, not its size.
    expect(focused.length, `focus returned ${focused.length} nodes`).toBeGreaterThan(10);
    expect(focused.length, `focus returned ${focused.length} nodes`).toBeLessThan(200);
    expect(ms, `focus took ${ms}ms`).toBeLessThan(1000);
  });

  it('finds cycles without blowing up', () => {
    // `findCycles` is the one function measured as super-linear: it sorts a node
    // list per detected cycle, so a 991-node cycle costs O(n log n) to
    // canonicalise. At this size it is still fast, and the threshold is set
    // where a regression to quadratic would be obvious rather than where a slow
    // machine would fail.
    const t0 = Date.now();
    const cycles = findCycles(graph);
    const ms = Date.now() - t0;

    expect(cycles.length).toBeGreaterThan(0);
    expect(ms, `findCycles took ${ms}ms`).toBeLessThan(30_000);
  });

  it('layers the graph without error', () => {
    expect(() => layerNodes(graph)).not.toThrow();
  });

  it('produces a manifest that validates at this size', () => {
    const result = validateManifest(buildManifest(root, graph, '2026-01-01T00:00:00.000Z'));
    if (!result.valid) throw new Error(result.errors.join('\n'));
    expect(result.valid).toBe(true);
  });
});

describe('folders that are broken in the ways folders break', () => {
  it('names a folder that does not exist', () => {
    // Loud, and it names the path so the developer can see the typo.
    expect(() => extractJsProject('/nonexistent/cf/path')).toThrow(/not found/i);
  });

  it('refuses a path that is a file, rather than reporting an empty project', () => {
    // The inconsistency this pins: a *missing* folder throws, but a path that
    // exists as a file returned an empty graph — indistinguishable from a
    // project with no files. An empty graph is a plausible-looking wrong answer,
    // which SPEC R9 is explicit about.
    const dir = tempDir();
    const file = join(dir, 'not-a-folder.js');
    writeFileSync(file, 'export const a = 1;');

    expect(() => extractJsProject(file)).toThrow(/folder/i);
  });

  it('reads a file with invalid UTF-8, skipping only that file', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'good.js'), 'export const a = 1;');
    // Binary bytes. `readFileSync(…, 'utf-8')` substitutes U+FFFD, and the result
    // does not parse — so this file is skipped rather than taking the whole
    // extraction down with it.
    writeFileSync(join(dir, 'bad.js'), Buffer.from([0xff, 0xfe, 0x00, 0x41]));

    const skipped: { path: string; reason: string }[] = [];
    const graph = extractJsProject(dir, (f) => skipped.push(f));

    // The good file survives. This is the point: one unreadable file must not
    // cost the developer the other 999.
    expect(graph.nodes.map((n) => n.id)).toEqual(['good.js']);
    expect(skipped.map((s) => s.path)).toEqual(['bad.js']);
    expect(skipped[0]?.reason).toBeTruthy();
  });

  it('a single broken file does not lose the rest of the graph', () => {
    // The regression that mattered most. `parseJsModule` threw out of
    // `extractJsProject`, so one unparseable file among a thousand took the
    // entire graph with it and the developer got an error instead of a project.
    const dir = tempDir();
    writeFileSync(join(dir, 'good1.js'), 'export const a = 1;');
    writeFileSync(join(dir, 'good2.js'), "import './good1.js';\nexport const b = 2;");
    writeFileSync(join(dir, 'broken.js'), 'export const = ;;; function (((');

    const graph = extractJsProject(dir);
    const ids = graph.nodes.map((n) => n.id).sort();

    expect(ids).toContain('good1.js');
    expect(ids).toContain('good2.js');
    expect(ids).not.toContain('broken.js');
    // And the edge between the two good files survived, so the graph is still
    // a graph rather than a pile of isolated nodes.
    expect(graph.edges.map((e) => `${e.from}->${e.to}`)).toContain('good2.js->good1.js');
  });

  it('skips a directory that happens to be named like a module', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'x.js'), { recursive: true });
    writeFileSync(join(dir, 'x.js', 'inner.js'), 'export const a = 1;');
    writeFileSync(join(dir, 'real.js'), 'export const b = 2;');

    const ids = extractJsProject(dir).nodes.map((n) => n.id);
    expect(ids).toContain('real.js');
    // The directory itself is not a module; the file inside it is walked normally.
    expect(ids).not.toContain('x.js');
  });

  it('terminates on a symlink loop', () => {
    // An infinite recursion here would hang the app rather than fail it, which
    // is the worst shape a bug can take.
    const dir = tempDir();
    const sub = join(dir, 'sub');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'a.js'), 'export const a = 1;');
    // `loop -> .` closes the cycle.
    symlinkSync(dir, join(sub, 'loop'), 'dir');

    const started = Date.now();
    const graph = extractJsProject(dir);
    const ms = Date.now() - started;

    expect(ms, `symlink loop took ${ms}ms — did it terminate?`).toBeLessThan(10_000);
    expect(graph.nodes.length).toBeGreaterThan(0);
  });
});
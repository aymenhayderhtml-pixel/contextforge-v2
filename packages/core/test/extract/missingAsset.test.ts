/**
 * packages/core/test/extract/missingAsset.test.ts
 *
 * An asset reference that resolves to nothing.
 *
 * ## The bug
 *
 * The asset path in `extract/js.ts` created a node for every reference. The
 * import path had always checked the file existed first; the asset path did not.
 * So a reference to a missing `.png` produced a graph node, and the graph then
 * asserted the file existed — 8 phantom nodes in `kart-dash-3d-v2`, none of which
 * a developer could find on disk.
 *
 * ## The decision
 *
 * **No node and no edge; the problem string is the only record.** The edge is
 * what makes a file look connected to a project, so keeping it would preserve
 * exactly the claim being removed — and an edge to a node that does not exist is
 * a dangling edge every consumer then has to special-case.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractJsProject, type MissingAsset } from '../../src/extract/js.js';
import { danglingEdges } from '../../src/graph/reverse.js';

const temporaries: string[] = [];
afterAll(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A project with one source file, and the files it references.
 *
 * `assets` maps project-relative path to contents, or to `null` for "named in
 * the source but never written to disk".
 */
function project(assetFiles: Record<string, string | null>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-asset-'));
  temporaries.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });

  const names = Object.keys(assetFiles);
  const refs = names.map((name) => `  await load('${name}');`).join('\n');
  writeFileSync(
    join(dir, 'src', 'main.js'),
    `export async function load(name) { return name; }\n\nexport async function boot() {\n${refs}\n}\n`,
  );

  for (const [name, contents] of Object.entries(assetFiles)) {
    if (contents === null) continue;
    const absolute = join(dir, name);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return dir;
}

describe('an asset that does not exist', () => {
  const missing: MissingAsset[] = [];
  const root = project({ 'assets/gone.png': null });
  const graph = extractJsProject(root, undefined, (m) => missing.push(m));

  it('creates no node for it', () => {
    expect(graph.nodes.map((n) => n.id)).not.toContain('assets/gone.png');
    expect(graph.nodes.some((n) => n.type === 'asset')).toBe(false);
  });

  it('creates no edge to it, so nothing dangles', () => {
    expect(graph.edges.some((e) => e.to === 'assets/gone.png')).toBe(false);
    // The stronger form: no edge anywhere in the graph names a node that is not
    // there. A missing-asset edge would show up here and nowhere else.
    expect(danglingEdges(graph)).toEqual([]);
  });

  it('leaves it off the referencing file\'s depends_on', () => {
    // A dependency on a file that does not exist is a claim the graph must not
    // make, and `depends_on` is what every other analysis reads.
    expect(graph.nodes.find((n) => n.id === 'src/main.js')?.depends_on).toEqual([]);
  });

  it('reports exactly one problem, naming both files', () => {
    expect(missing).toHaveLength(1);
    expect(missing[0]?.from).toBe('src/main.js');
    expect(missing[0]?.asset).toBe('assets/gone.png');
    // The sentence, exactly as specified. A developer should be able to act on
    // it without opening anything.
    expect(missing[0]?.reason).toBe(
      'src/main.js references assets/gone.png, which does not exist',
    );
  });
});

describe('an asset that does exist', () => {
  const missing: MissingAsset[] = [];
  const root = project({ 'assets/real.png': 'not really a png' });
  const graph = extractJsProject(root, undefined, (m) => missing.push(m));

  it('still makes a node', () => {
    const node = graph.nodes.find((n) => n.id === 'assets/real.png');
    expect(node).toBeDefined();
    expect(node?.type).toBe('asset');
  });

  it('still makes the edge and the dependency', () => {
    expect(graph.edges.some((e) => e.to === 'assets/real.png')).toBe(true);
    expect(graph.nodes.find((n) => n.id === 'src/main.js')?.depends_on).toContain(
      'assets/real.png',
    );
  });

  it('reports no problem', () => {
    expect(missing).toEqual([]);
  });

  it('is a regression guard on the check itself', () => {
    // If the existence check were ever applied to the wrong side — after the
    // node was created, say — this is the case that would catch it, because the
    // node must still exist for a file that is present.
    expect(graph.nodes.length).toBe(2); // src/main.js + the asset
  });
});

describe('a project with nothing missing', () => {
  const missing: MissingAsset[] = [];
  const unparseable: { path: string }[] = [];
  const root = project({ 'assets/a.png': 'a', 'assets/b.png': 'b' });
  const graph = extractJsProject(
    root,
    (u) => unparseable.push(u),
    (m) => missing.push(m),
  );

  it('reports nothing missing and nothing unparseable', () => {
    expect(missing).toEqual([]);
    expect(unparseable).toEqual([]);
  });

  it('is unchanged by the new check', () => {
    // The whole graph, asserted rather than spot-checked: this is the
    // "a project with no missing assets is unchanged" case, and a count alone
    // would not catch a node that appeared with the right number.
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([
      'assets/a.png',
      'assets/b.png',
      'src/main.js',
    ]);
    expect(graph.edges).toEqual([
      { from: 'src/main.js', to: 'assets/a.png', kind: 'asset_ref' },
      { from: 'src/main.js', to: 'assets/b.png', kind: 'asset_ref' },
    ]);
  });
});

describe('a mix of present and absent', () => {
  it('keeps what exists and reports only what does not', () => {
    const missing: MissingAsset[] = [];
    const root = project({ 'assets/real.png': 'x', 'assets/gone.png': null });
    const graph = extractJsProject(root, undefined, (m) => missing.push(m));

    expect(graph.nodes.map((n) => n.id)).toContain('assets/real.png');
    expect(graph.nodes.map((n) => n.id)).not.toContain('assets/gone.png');
    expect(missing.map((m) => m.asset)).toEqual(['assets/gone.png']);
    expect(danglingEdges(graph)).toEqual([]);
  });

  it('reports one problem per reference, not one per file', () => {
    // Two files naming the same missing asset is two faults: each is a place
    // that will fail at runtime. Collapsing them would hide the second one.
    const dir = mkdtempSync(join(tmpdir(), 'cf-asset2-'));
    temporaries.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'a.js'),
      "export async function boot() { await load('assets/gone.png'); }\n",
    );
    writeFileSync(
      join(dir, 'src', 'b.js'),
      "export async function boot() { await load('assets/gone.png'); }\n",
    );

    const missing: MissingAsset[] = [];
    extractJsProject(dir, undefined, (m) => missing.push(m));

    expect(missing.map((m) => m.from).sort()).toEqual(['src/a.js', 'src/b.js']);
  });
});
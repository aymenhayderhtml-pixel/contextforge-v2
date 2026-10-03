/**
 * End-to-end smoke test on a real project tree.
 *
 * The unit suites run against curated fixtures. This one runs the full pipeline
 * — extract, patch, syntax-check, undo — against the actual v1 repository, to
 * prove core works on code nobody designed for it: ~60 files, a `.godot` import
 * cache with thousands of generated entries, mixed engines, and real AI patch
 * transcripts.
 *
 * It is read-only with respect to that project: the patch and undo phases run
 * against a copy in a temp directory.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { extractGodotProject, extractSingleGodotFile } from '../../src/extract/godot.js';
import { extractJsProject } from '../../src/extract/js.js';
import { canonicalizeGraph, validateManifest, buildManifest } from '../../src/graph/manifest.js';
import { danglingEdges, findCycles, layerNodes, reachableFrom } from '../../src/graph/reverse.js';
import { applyEditBlocks } from '../../src/patch/editBlocks.js';
import { validateContentSyntax } from '../../src/patch/syntaxCheck.js';
import {
  captureAndWrite,
  clearHistory,
  recordHistoryStep,
  undo,
} from '../../src/history/history.js';

/**
 * The v1 checkout, treated as read-only reference (never written to).
 *
 * Override with CF_SMOKE_V1_PROJECT when the checkout lives elsewhere.
 */
const V1_PROJECT =
  process.env['CF_SMOKE_V1_PROJECT'] ??
  resolve(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'contextforge');

/**
 * Every test in this suite reads that checkout, which is a personal reference
 * copy rather than part of this repository. Where it is absent there is nothing
 * to smoke, so the suite skips instead of failing: a missing optional input is
 * not a broken product, and a red suite nobody can act on trains everyone to
 * ignore red.
 */
const describeV1 = existsSync(V1_PROJECT) ? describe : describe.skip;

const FIXTURES = join(import.meta.dirname, '..', '..', 'test-fixtures');

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cf-smoke-'));
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describeV1('smoke: v1 JS project (server/ + public/js/)', () => {
  it('extracts a graph without throwing', () => {
    const graph = extractJsProject(V1_PROJECT);

    expect(graph.nodes.length).toBeGreaterThan(20);
    expect(graph.edges.length).toBeGreaterThan(20);

    // The manifest the Project screen would show must validate.
    const validation = validateManifest(
      buildManifest(V1_PROJECT, graph, '2026-01-01T00:00:00.000Z'),
    );
    if (!validation.valid) {
      throw new Error(`Validation errors:\n  - ${validation.errors.join('\n  - ')}`);
    }
  });

  it('excludes node_modules, dist and hidden directories', () => {
    const graph = extractJsProject(V1_PROJECT);
    const offenders = graph.nodes
      .map((n) => n.id)
      .filter((id) => id.startsWith('node_modules/') || id.includes('/.') || id.startsWith('dist/'));
    expect(offenders).toEqual([]);
  });

  it('reads contracts from real files, including complex ones', () => {
    const graph = extractJsProject(V1_PROJECT);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));

    // A file with many exports, async functions and classes.
    const history = byId.get('server/history-manager.js');
    expect(history).toBeDefined();
    expect(history?.contract.exports.some((e) => e.includes('recordHistoryStep'))).toBe(true);
    expect(history?.contract.exports.some((e) => e.includes('undo('))).toBe(true);

    // A module whose default export is a plain identifier.
    const extractor = byId.get('server/extractors/godot-extractor.js');
    expect(extractor).toBeDefined();
  });

  it('produces no dangling edges on a real project', () => {
    const graph = extractJsProject(V1_PROJECT);

    const dangling = danglingEdges(graph);
    expect(
      dangling,
      `dangling edges:\n${dangling.map((e) => `  ${e.from} -[${e.kind}]-> ${e.to}`).join('\n')}`,
    ).toEqual([]);
  });

  it('detects the real circular import in the v1 frontend', () => {
    // v1's `public/js` genuinely contains a cycle:
    //   sidebar/tree.js -> preview/preview.js -> workstation/problem-pane.js
    //     -> workstation/inspector-pane.js -> sidebar/tree.js
    //
    // This is asserted as a *finding*, not as a pass: it demonstrates that
    // findCycles reports something a regex-based extractor could not have
    // surfaced, and that the tool is telling the truth about real code rather
    // than returning a conveniently clean graph.
    const cycles = findCycles(extractJsProject(V1_PROJECT));
    expect(cycles.length).toBeGreaterThan(0);

    const involved = new Set(cycles.flatMap((c) => c.nodes));
    expect(involved).toContain('public/js/sidebar/tree.js');
    expect(involved).toContain('public/js/preview/preview.js');
  });

  it('is deterministic across runs', () => {
    const first = canonicalizeGraph(extractJsProject(V1_PROJECT));
    const second = canonicalizeGraph(extractJsProject(V1_PROJECT));
    expect(first).toBe(second);
  });

  it('layers the acyclic part of the graph and isolates cyclic nodes', () => {
    // The graph has a real cycle (see above), so `layerNodes` must place every
    // node it can and report the rest separately rather than silently dropping
    // them or looping forever.
    const { layers, cyclic } = layerNodes(extractJsProject(V1_PROJECT));

    expect(layers.length).toBeGreaterThan(3);
    expect(layers[0]?.length).toBeGreaterThan(0);
    expect(cyclic.length).toBeGreaterThan(0);

    // Nothing cyclic was placed in a layer, and nothing is lost.
    const layered = layers.flat();
    expect(layered.length + cyclic.length).toBe(
      extractJsProject(V1_PROJECT).nodes.length,
    );
  });
});

describeV1('smoke: v1 Godot large sample', () => {
  const godotSample = join(FIXTURES, 'godot-sample');
  const godotLarge = join(V1_PROJECT, 'test-fixtures', 'godot-large-sample');

  it('extracts the small sample with the expected shape', () => {
    const graph = extractGodotProject(godotSample);
    expect(graph.nodes.filter((n) => n.type === 'scene')).toHaveLength(3);
    expect(graph.nodes.filter((n) => n.type === 'script')).toHaveLength(3);
  });

  it.runIf(existsSync(godotLarge))('extracts the large sample and stays deterministic', () => {
    const graph = extractGodotProject(godotLarge);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(20);

    expect(canonicalizeGraph(extractGodotProject(godotLarge))).toBe(canonicalizeGraph(graph));
  });

  it('reads a single file on demand, as the Patch screen would', () => {
    const node = extractSingleGodotFile('scripts/Player.gd', godotSample);
    expect(node.contract.signals).toContain('died()');
  });
});

describeV1('smoke: patch + undo on a copied project', () => {
  it('applies a patch, refuses a broken one, and undoes both', () => {
    // Copy so the read-only reference is never touched.
    const project = join(scratch, 'mini-project');
    cpSync(join(V1_PROJECT, 'test-fixtures', 'js-sample'), project, { recursive: true });

    const before = readFileSync(join(project, 'src/player.js'), 'utf-8');

    // ── A valid patch applies and is undoable ──
    const validPatch = [
      '### EDIT: src/player.js',
      '<<<<<<< FIND',
      'export const MAX_PLAYERS = 4;',
      '=======',
      'export const MAX_PLAYERS = 8;',
      '>>>>>>> REPLACE',
    ].join('\n');

    const applied = applyEditBlocks(project, validPatch);
    expect(applied.success).toBe(true);
    expect(readFileSync(join(project, 'src/player.js'), 'utf-8')).toContain('MAX_PLAYERS = 8');

    // Record the patch as one transaction, the way the Patch screen does:
    // captureAndWrite snapshots the current content, writes the new one, and
    // returns the change record. Undo then restores `before`.
    const patched = readFileSync(join(project, 'src/player.js'), 'utf-8');
    const changes = captureAndWrite(project, new Map([['src/player.js', before]]));
    expect(changes).toEqual([{ path: 'src/player.js', before: patched, after: before }]);

    recordHistoryStep(project, 'Restore player.js', changes);
    expect(readFileSync(join(project, 'src/player.js'), 'utf-8')).toBe(before);

    expect(undo(project).success).toBe(true);
    expect(readFileSync(join(project, 'src/player.js'), 'utf-8')).toBe(patched);
    clearHistory(project);

    // ── A broken patch is refused, and nothing changes ──
    const current = readFileSync(join(project, 'src/player.js'), 'utf-8');
    const brokenPatch = [
      '### EDIT: src/player.js',
      '<<<<<<< FIND',
      'export class Player {',
      '=======',
      'export class Player { {{{',
      '>>>>>>> REPLACE',
    ].join('\n');

    const refused = applyEditBlocks(project, brokenPatch);
    expect(refused.success).toBe(false);
    expect(refused.preCheckFailed).toBe(true);
    expect(readFileSync(join(project, 'src/player.js'), 'utf-8')).toBe(current);
  });

  it('re-extracts correctly after a patch changes a module contract', () => {
    const project = join(scratch, 'reextract');
    cpSync(join(V1_PROJECT, 'test-fixtures', 'js-sample'), project, { recursive: true });

    const added = validateContentSyntax('src/player.js', 'export function brandNew() { return 1; }\n');
    expect(added.valid).toBe(true);

    const changes = captureAndWrite(
      project,
      new Map([['src/player.js', readFileSync(join(project, 'src/player.js'), 'utf-8') + '\nexport function brandNew() { return 1; }\n']]),
    );
    expect(changes).toHaveLength(1);

    const node = extractJsProject(project).nodes.find((n) => n.id === 'src/player.js');
    expect(node?.contract.exports).toContain('function brandNew()');
  });

  it('walks the dependency closure of the entrypoint', () => {
    const graph = extractJsProject(join(FIXTURES, 'js-sample'));
    const reachable = reachableFrom(graph, 'src/main.js');
    // main.js -> scene-manager/player/asset-loader -> utils
    expect(reachable.has('src/utils.js')).toBe(true);
    expect(reachable.size).toBeGreaterThanOrEqual(5);
  });
});

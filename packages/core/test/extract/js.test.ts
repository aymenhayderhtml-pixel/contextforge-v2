/**
 * Ported from v1 `server/extractors/js-extractor-test.js`.
 *
 * Behaviour preserved: module discovery, dependency edges, contract contents,
 * asset references and determinism. The assertions now describe contracts read
 * from syntax trees rather than from line regexes, so the expected signatures
 * are the real ones (e.g. `default MathUtils` rather than a bare `default`).
 */

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { extractJsProject } from '../../src/extract/js.js';
import { canonicalizeGraph, validateManifest, buildManifest } from '../../src/graph/manifest.js';
import { dependentsOf, findCycles, reachableFrom } from '../../src/graph/reverse.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..', 'test-fixtures', 'js-sample');

const graph = extractJsProject(projectRoot);
const nodeById = (id: string) => graph.nodes.find((n) => n.id === id);

describe('extractJsProject — shape', () => {
  it('returns nodes and edges arrays', () => {
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(Array.isArray(graph.edges)).toBe(true);
  });

  it('produces a manifest that validates against the schema', () => {
    const result = validateManifest(
      buildManifest(projectRoot, graph, '2026-01-01T00:00:00.000Z'),
    );
    if (!result.valid) {
      throw new Error(`Validation errors:\n  - ${result.errors.join('\n  - ')}`);
    }
    expect(result.valid).toBe(true);
  });

  it('finds all five JS modules', () => {
    const modules = graph.nodes.filter((n) => n.type === 'module');
    expect(modules.map((m) => m.id)).toEqual([
      'src/asset-loader.js',
      'src/main.js',
      'src/player.js',
      'src/scene-manager.js',
      'src/utils.js',
    ]);
  });

  it('marks every module node with engine=js', () => {
    for (const node of graph.nodes) {
      if (node.type !== 'module') continue;
      expect(node.engine).toBe('js');
    }
  });

  it('gives every JS node an empty signals array', () => {
    for (const node of graph.nodes) {
      expect(node.contract.signals).toEqual([]);
    }
  });
});

describe('extractJsProject — dependencies', () => {
  it('main.js depends on scene-manager, player and asset-loader', () => {
    const main = nodeById('src/main.js');
    expect(main).toBeDefined();
    expect(main?.depends_on).toContain('src/scene-manager.js');
    expect(main?.depends_on).toContain('src/player.js');
    expect(main?.depends_on).toContain('src/asset-loader.js');
  });

  it('scene-manager.js depends on utils.js', () => {
    expect(nodeById('src/scene-manager.js')?.depends_on).toContain('src/utils.js');
  });

  it('utils.js is a leaf module with no module dependencies', () => {
    const utils = nodeById('src/utils.js');
    const moduleDeps = utils?.depends_on.filter((d) => d.endsWith('.js')) ?? [];
    expect(moduleDeps).toEqual([]);
  });

  it('emits import edges', () => {
    const importEdges = graph.edges.filter((e) => e.kind === 'import');
    expect(importEdges.length).toBeGreaterThanOrEqual(4);
  });

  it('records the asset reference from main.js to character.glb', () => {
    const assetEdges = graph.edges.filter((e) => e.kind === 'asset_ref');
    expect(assetEdges.some((e) => e.to === 'models/character.glb')).toBe(true);
  });

  it('creates an asset node carrying the declared slot contract', () => {
    const asset = nodeById('models/character.glb');
    expect(asset).toBeDefined();
    expect(asset?.type).toBe('asset');
    expect(asset?.slot).toMatchObject({
      slot: 'character',
      format: 'glb',
      expected_animations: ['idle', 'run', 'walk'],
      rigged: true,
    });
  });

  it('does not emit an edge to a node that does not exist', () => {
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const edge of graph.edges) {
      // character.glb is referenced but has no file in the fixture; the node is
      // created for it, so every edge target must be a real node.
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
  });
});

describe('extractJsProject — contracts', () => {
  it('main.js exports startGame and GAME_VERSION', () => {
    const exportsList = nodeById('src/main.js')?.contract.exports ?? [];
    expect(exportsList).toContain('function startGame()');
    expect(exportsList).toContain('const GAME_VERSION');
  });

  it('player.js exports Player, createPlayer and MAX_PLAYERS', () => {
    const exportsList = nodeById('src/player.js')?.contract.exports ?? [];
    expect(exportsList).toContain('class Player');
    expect(exportsList).toContain('function createPlayer(name)');
    expect(exportsList).toContain('const MAX_PLAYERS');
  });

  it('utils.js exports its default', () => {
    const exportsList = nodeById('src/utils.js')?.contract.exports ?? [];
    expect(exportsList.some((e) => e.startsWith('default'))).toBe(true);
  });

  it('asset-loader.js exports its async functions', () => {
    const exportsList = nodeById('src/asset-loader.js')?.contract.exports ?? [];
    expect(exportsList).toContain('function loadModel(path)');
    expect(exportsList).toContain('function loadTexture(path)');
  });

  it('does not report a commented-out export as real', () => {
    // main.js's doc comment mentions SceneManager; only real exports appear.
    const exportsList = nodeById('src/main.js')?.contract.exports ?? [];
    expect(exportsList).not.toContain('SceneManager');
  });
});

describe('extractJsProject — derived graph properties', () => {
  it('fills in depended_on_by from the edge set', () => {
    expect(nodeById('src/utils.js')?.depended_on_by).toEqual([
      'src/player.js',
      'src/scene-manager.js',
    ]);
  });

  it('computes the transitive dependency closure of main.js', () => {
    const reachable = reachableFrom(graph, 'src/main.js');
    expect(reachable.has('src/utils.js')).toBe(true);
  });

  it('computes which files would break if utils.js changed', () => {
    const dependents = dependentsOf(graph, 'src/utils.js');
    expect(dependents).toContain('src/player.js');
    expect(dependents).not.toContain('src/utils.js');
  });

  it('reports no cycles in a healthy project', () => {
    expect(findCycles(graph)).toEqual([]);
  });
});

describe('extractJsProject — determinism', () => {
  it('produces byte-identical output across runs (SPEC R8)', () => {
    const first = canonicalizeGraph(extractJsProject(projectRoot));
    const second = canonicalizeGraph(extractJsProject(projectRoot));
    expect(first).toBe(second);
  });

  it('emits nodes sorted by id', () => {
    const ids = graph.nodes.map((n) => n.id);
    expect([...ids].sort((a, b) => a.localeCompare(b))).toEqual(ids);
  });
});

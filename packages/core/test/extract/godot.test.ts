/**
 * Ported from v1 `server/extractors/godot-extractor-test.js`.
 *
 * Behaviour preserved: node counts, signals, exported vars, public vs private
 * functions, scene→script inheritance, ext_resource / signal_connection /
 * autoload `requires` edges, and determinism.
 */

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { extractGodotProject, extractSingleGodotFile, parseAutoloads } from '../../src/extract/godot.js';
import { buildManifest, canonicalizeGraph, validateManifest } from '../../src/graph/manifest.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..', 'test-fixtures', 'godot-sample');

const graph = extractGodotProject(projectRoot);
const nodeById = (id: string) => graph.nodes.find((n) => n.id === id);

describe('extractGodotProject — shape', () => {
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

  it('finds exactly three scenes and three scripts', () => {
    expect(graph.nodes.filter((n) => n.type === 'scene')).toHaveLength(3);
    expect(graph.nodes.filter((n) => n.type === 'script')).toHaveLength(3);
  });

  it('marks every node with engine=godot', () => {
    for (const node of graph.nodes) {
      expect(node.engine).toBe('godot');
    }
  });

  it('skips the .godot import cache', () => {
    expect(graph.nodes.some((n) => n.id.includes('.godot'))).toBe(false);
  });
});

describe('extractGodotProject — script contracts', () => {
  it('Player.gd declares its signals', () => {
    const player = nodeById('scripts/Player.gd');
    expect(player?.contract.signals).toContain('died()');
    expect(player?.contract.signals).toContain('health_changed(new_value: int)');
  });

  it('Player.gd exposes its @export vars', () => {
    const exportsList = nodeById('scripts/Player.gd')?.contract.exports ?? [];
    expect(exportsList).toContain('speed: float');
    expect(exportsList).toContain('jump_force: float');
  });

  it('Player.gd exposes public funcs but not underscore-prefixed ones', () => {
    const exportsList = nodeById('scripts/Player.gd')?.contract.exports ?? [];
    expect(exportsList).toContain('take_damage(amount: int) -> void');
    expect(exportsList).toContain('get_health() -> int');
    expect(exportsList.some((e) => e.includes('_process'))).toBe(false);
    expect(exportsList.some((e) => e.includes('_physics_process'))).toBe(false);
  });

  it('Player.gd requires the GameManager autoload', () => {
    expect(nodeById('scripts/Player.gd')?.contract.requires).toContain('GameManager');
  });

  it('emits a requires edge to the autoload script', () => {
    const edge = graph.edges.find(
      (e) =>
        e.from === 'scripts/Player.gd' &&
        e.to === 'scripts/GameManager.gd' &&
        e.kind === 'requires',
    );
    expect(edge).toBeDefined();
  });

  it('lists the autoload script in depends_on', () => {
    expect(nodeById('scripts/Player.gd')?.depends_on).toContain('scripts/GameManager.gd');
  });

  it('does not report an autoload as required when it is only mentioned in a comment', () => {
    // Enemy.gd never references GameManager.
    expect(nodeById('scripts/Enemy.gd')?.contract.requires).toEqual([]);
  });
});

describe('extractGodotProject — scenes', () => {
  it('Player.tscn depends on its script', () => {
    expect(nodeById('scenes/Player.tscn')?.depends_on).toContain('scripts/Player.gd');
  });

  it('Level1.tscn depends on both instanced scenes', () => {
    const level = nodeById('scenes/Level1.tscn');
    expect(level?.depends_on).toContain('scenes/Player.tscn');
    expect(level?.depends_on).toContain('scenes/Enemy.tscn');
  });

  it('emits an ext_resource edge from a scene to its script', () => {
    const edge = graph.edges.find(
      (e) => e.from === 'scenes/Player.tscn' && e.to === 'scripts/Player.gd',
    );
    expect(edge?.kind).toBe('ext_resource');
  });

  it('emits signal_connection edges in Level1', () => {
    const signalEdges = graph.edges.filter((e) => e.kind === 'signal_connection');
    expect(signalEdges.length).toBeGreaterThan(0);
    expect(signalEdges.some((e) => e.to === 'scenes/Player.tscn')).toBe(true);
  });

  it('a scene inherits its root script contract', () => {
    const scene = nodeById('scenes/Player.tscn');
    expect(scene?.contract.signals.length).toBeGreaterThan(0);
    expect(scene?.contract.exports.length).toBeGreaterThan(0);
    expect(scene?.contract.signals).toContain('died()');
  });

  it('fills depended_on_by from the edge set', () => {
    expect(nodeById('scripts/Player.gd')?.depended_on_by).toContain('scenes/Player.tscn');
  });

  it('emits no edge to a node that does not exist', () => {
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const edge of graph.edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
  });
});

describe('parseAutoloads', () => {
  it('reads the [autoload] section of project.godot', () => {
    const autoloads = parseAutoloads(projectRoot);
    expect(autoloads.get('GameManager')).toBe('scripts/GameManager.gd');
  });

  it('returns an empty map when project.godot is absent', () => {
    expect(parseAutoloads(join(here, '..', '..', 'test-fixtures', 'js-sample')).size).toBe(0);
  });
});

describe('extractSingleGodotFile', () => {
  it('reads one script without scanning the project', () => {
    const node = extractSingleGodotFile('scripts/Player.gd', projectRoot);
    expect(node.id).toBe('scripts/Player.gd');
    expect(node.type).toBe('script');
    expect(node.contract.signals).toContain('died()');
    expect(node.contract.requires).toContain('GameManager');
  });

  it('reads one scene and inherits its root script contract', () => {
    const node = extractSingleGodotFile('scenes/Player.tscn', projectRoot);
    expect(node.type).toBe('scene');
    expect(node.contract.signals).toContain('died()');
    expect(node.depends_on).toContain('scripts/Player.gd');
  });

  it('refuses a file that is neither .gd nor .tscn', () => {
    expect(() => extractSingleGodotFile('project.godot', projectRoot)).toThrow(/Unsupported/);
  });
});

describe('extractGodotProject — determinism', () => {
  it('produces byte-identical output across runs (SPEC R8)', () => {
    expect(canonicalizeGraph(extractGodotProject(projectRoot))).toBe(
      canonicalizeGraph(extractGodotProject(projectRoot)),
    );
  });

  it('emits nodes sorted by id', () => {
    const ids = graph.nodes.map((n) => n.id);
    expect([...ids].sort((a, b) => a.localeCompare(b))).toEqual(ids);
  });
});

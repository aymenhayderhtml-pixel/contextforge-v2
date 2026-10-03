/**
 * extract/godot.ts — Dependency graph for a Godot 4.x project.
 *
 * Reads three kinds of file:
 *   `.gd`     scripts, via the tree-sitter GDScript grammar (SPEC R5)
 *   `.tscn`   scenes, via the hand-written parser in `parse/tscn.ts`
 *   `project.godot`  autoload declarations, which are global dependencies
 *
 * The interesting dependency is the autoload: `GameManager` is not imported by
 * any script, it is injected by the engine at startup, so nothing but a text
 * search would find it — and a script that calls it without declaring it will
 * break the moment the autoload is renamed. `contract.requires` records it so
 * the AI sees the coupling before it edits.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DependencyGraph,
  GraphEdge,
  GraphNode,
  NodeContract,
} from '../graph/types.js';
import { normalizeDeps, sortGraph, withDependedOnBy } from '../graph/reverse.js';
import {
  formatGdExport,
  formatGdFunction,
  formatGdSignal,
  parseGdScript,
  type GdScriptContract,
} from '../parse/gdscript.js';
import { parseTscn, rootScriptId, type TscnDocument } from '../parse/tscn.js';
import { isAssetFile, parseInCodeSlotHints, parseSlotContract } from './assets.js';
import { readTextFileOrNull, scanFiles } from './files.js';

/** Autoload name -> project-relative script path. */
export type Autoloads = ReadonlyMap<string, string>;

/**
 * Extract the dependency graph for a Godot project.
 *
 * Scripts are parsed before scenes so a scene can inherit the contract of the
 * script on its root node — that inheritance is what makes a scene node useful
 * to an AI ("this scene exposes `take_damage` and the `died` signal").
 */
export function extractGodotProject(projectRoot: string): DependencyGraph {
  if (!existsSync(projectRoot)) {
    throw new Error(`Project folder not found: "${projectRoot}"`);
  }

  const sceneFiles = scanFiles(projectRoot, { extensions: new Set(['.tscn']) });
  const scriptFiles = scanFiles(projectRoot, { extensions: new Set(['.gd']) });

  const autoloads = parseAutoloads(projectRoot);
  const autoloadNames = [...autoloads.keys()].sort();

  const knownIds = new Set<string>([
    ...sceneFiles.map((f) => f.relativePath),
    ...scriptFiles.map((f) => f.relativePath),
  ]);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // ── Scripts ──
  const scriptContracts = new Map<string, GdScriptContract>();

  for (const file of scriptFiles) {
    const source = readTextFileOrNull(file.absolutePath);
    if (source === null) continue;

    const contract = parseGdScript(source, file.relativePath);
    scriptContracts.set(file.relativePath, contract);

    const { node, scriptEdges } = buildScriptNode(
      file.relativePath,
      contract,
      autoloadNames,
      autoloads,
    );
    nodes.push(node);
    edges.push(...scriptEdges);
  }

  // ── Scenes ──
  const assetNodes = new Map<string, GraphNode>();

  for (const file of sceneFiles) {
    const source = readTextFileOrNull(file.absolutePath);
    if (source === null) continue;

    const scene = parseTscn(source, file.relativePath);
    const { node, sceneEdges, sceneAssetNodes } = buildSceneNode(
      file.relativePath,
      scene,
      scriptContracts,
      knownIds,
      source,
      projectRoot,
    );

    nodes.push(node);
    edges.push(...sceneEdges);
    for (const [id, assetNode] of sceneAssetNodes) {
      if (!assetNodes.has(id)) assetNodes.set(id, assetNode);
    }
  }

  nodes.push(...assetNodes.values());

  return withDependedOnBy(sortGraph({ nodes, edges }));
}

/** Build the node and `requires` edges for one script. */
function buildScriptNode(
  id: string,
  contract: GdScriptContract,
  autoloadNames: string[],
  autoloads: Autoloads,
): { node: GraphNode; scriptEdges: GraphEdge[] } {
  // An autoload is a global: the only trace of the dependency is its name
  // appearing as an identifier in the source.
  const requires = autoloadNames.filter((name) =>
    contract.referencedIdentifiers.includes(name),
  );

  const dependsOn: string[] = [];
  const scriptEdges: GraphEdge[] = [];

  for (const name of requires) {
    const target = autoloads.get(name);
    if (target === undefined) continue;
    dependsOn.push(target);
    scriptEdges.push({ from: id, to: target, kind: 'requires' });
  }

  const nodeContract: NodeContract = {
    exports: gdContractExports(contract),
    signals: contract.signals.map(formatGdSignal),
    requires: [...requires].sort((a, b) => a.localeCompare(b)),
  };

  return {
    node: {
      id,
      engine: 'godot',
      type: 'script',
      contract: nodeContract,
      depends_on: normalizeDeps(dependsOn),
      depended_on_by: [],
    },
    scriptEdges,
  };
}

/** Build the node, edges and asset nodes for one scene. */
function buildSceneNode(
  id: string,
  scene: TscnDocument,
  scriptContracts: ReadonlyMap<string, GdScriptContract>,
  knownIds: ReadonlySet<string>,
  source: string,
  projectRoot: string,
): {
  node: GraphNode;
  sceneEdges: GraphEdge[];
  sceneAssetNodes: Map<string, GraphNode>;
} {
  const dependsOn: string[] = [];
  const sceneEdges: GraphEdge[] = [];
  const assetNodes = new Map<string, GraphNode>();
  const hints = parseInCodeSlotHints(source);

  // ── ext_resource dependencies ──
  for (const resource of scene.extResources) {
    const asset = isAssetFile(resource.path);
    // Only record a dependency on something we can name. An ext_resource
    // pointing at a file that is not in the project would put a dangling node
    // in the graph and tell the AI a dependency exists when it does not.
    if (!asset && !knownIds.has(resource.path)) continue;

    dependsOn.push(resource.path);
    sceneEdges.push({
      from: id,
      to: resource.path,
      kind: asset ? 'asset_ref' : 'ext_resource',
    });

    if (asset) {
      const slotResult = parseSlotContract(resource.path, projectRoot, hints);
      assetNodes.set(resource.path, {
        id: resource.path,
        engine: 'godot',
        type: 'asset',
        contract: {
          exports: slotResult.exports,
          signals: [],
          requires: [],
          slot: slotResult.slot,
        },
        slot: slotResult.slot,
        depends_on: [],
        depended_on_by: [],
      });
    }
  }

  // ── Signal connections ──
  for (const connection of scene.connections) {
    const sourceScene = findSignalSourceScene(scene, connection.from);
    if (!sourceScene || !knownIds.has(sourceScene)) continue;

    // The ext_resource edge may already express this dependency; a second edge
    // between the same pair with a different kind is not additional information.
    const alreadyPresent = sceneEdges.some(
      (e) => e.from === id && e.to === sourceScene && e.kind === 'signal_connection',
    );
    if (alreadyPresent) continue;

    sceneEdges.push({ from: id, to: sourceScene, kind: 'signal_connection' });
  }

  // ── Contract inherited from the root script ──
  let nodeContract: NodeContract = { exports: [], signals: [], requires: [] };
  const scriptId = resolveRootScript(scene);
  const scriptContract = scriptId ? scriptContracts.get(scriptId) : undefined;
  if (scriptContract) {
    nodeContract = {
      exports: gdContractExports(scriptContract),
      signals: scriptContract.signals.map(formatGdSignal),
      requires: [],
    };
  }

  return {
    node: {
      id,
      engine: 'godot',
      type: 'scene',
      contract: nodeContract,
      depends_on: normalizeDeps(dependsOn),
      depended_on_by: [],
    },
    sceneEdges,
    sceneAssetNodes: assetNodes,
  };
}

/**
 * The script assigned to a scene's root node.
 *
 * Falls back to the first node with a `script` property, so a scene whose root
 * header is not the first `[node]` still resolves.
 */
function resolveRootScript(scene: TscnDocument): string | null {
  const id = rootScriptId(scene);
  if (id === null) return null;
  return scene.extResources.find((r) => r.id === id)?.path ?? null;
}

/**
 * The sub-scene a signal connection's `from` node refers to.
 *
 * `[connection from="Player"]` names a node *within* this scene, not a file. The
 * file is found by matching the node name against the instanced PackedScene
 * resources. It is a heuristic, so it only matches when exactly one candidate
 * fits — an ambiguous match would put an edge in the graph that may be wrong.
 */
function findSignalSourceScene(
  scene: TscnDocument,
  nodeName: string,
): string | null {
  if (nodeName === '.') return null;

  const candidates = scene.extResources.filter(
    (resource) =>
      resource.type === 'PackedScene' &&
      basenameNoExt(resource.path).toLowerCase() === nodeName.toLowerCase(),
  );

  if (candidates.length !== 1) return null;
  return candidates[0]?.path ?? null;
}

function basenameNoExt(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  return dot === -1 ? file : file.slice(0, dot);
}

/**
 * Render a GDScript contract as the export strings a node carries.
 *
 * A scene inherits its root script's contract verbatim, so the same rendering
 * is used for both and the strings stay comparable between a script and the
 * scene that uses it.
 */
function gdContractExports(contract: GdScriptContract): string[] {
  const exportsList: string[] = [
    ...contract.exports.map(formatGdExport),
    ...contract.constants.map((c) => `const ${c.name}: ${c.type}`),
    ...contract.enums.map((e) => `enum ${e.name}`),
    ...contract.publicFunctions.map(formatGdFunction),
  ];
  return normalizeDeps(exportsList);
}

/**
 * Read `[autoload]` entries from `project.godot`.
 *
 * Format: `GameManager="*res://scripts/GameManager.gd"`, where the leading `*`
 * marks the autoload as a singleton. Both forms are recorded; the flag is Godot's
 * own distinction between a plain autoload and a global singleton.
 */
export function parseAutoloads(projectRoot: string): Autoloads {
  const autoloads = new Map<string, string>();
  const projectFile = join(projectRoot, 'project.godot');

  const content = readTextFileOrNull(projectFile);
  if (content === null) return autoloads;

  let inAutoloadSection = false;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed.startsWith('[')) {
      inAutoloadSection = trimmed === '[autoload]';
      continue;
    }
    if (!inAutoloadSection || trimmed === '') continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?\*?res:\/\/([^"]+)"?\s*$/.exec(
      trimmed,
    );
    if (!match) continue;

    const name = match[1];
    const path = match[2];
    if (name && path) autoloads.set(name, path);
  }

  return autoloads;
}

/**
 * Extract a single Godot file without scanning the project.
 *
 * Used by the Patch screen to re-read one file after an edit.
 */
export function extractSingleGodotFile(
  relativePath: string,
  projectRoot: string,
): GraphNode {
  const absolutePath = join(projectRoot, relativePath);

  if (relativePath.endsWith('.gd')) {
    const source = readTextFileOrNull(absolutePath);
    if (source === null) {
      throw new Error(`Cannot read script "${relativePath}" in project "${projectRoot}"`);
    }
    const autoloads = parseAutoloads(projectRoot);
    const { node } = buildScriptNode(
      relativePath,
      parseGdScript(source, relativePath),
      [...autoloads.keys()].sort(),
      autoloads,
    );
    return node;
  }

  if (relativePath.endsWith('.tscn')) {
    const source = readTextFileOrNull(absolutePath);
    if (source === null) {
      throw new Error(`Cannot read scene "${relativePath}" in project "${projectRoot}"`);
    }
    const scene = parseTscn(source, relativePath);
    const scriptPath = resolveRootScript(scene);
    let nodeContract: NodeContract = { exports: [], signals: [], requires: [] };

    if (scriptPath) {
      const scriptSource = readTextFileOrNull(join(projectRoot, scriptPath));
      if (scriptSource !== null) {
        const scriptContract = parseGdScript(scriptSource, scriptPath);
        nodeContract = {
          exports: gdContractExports(scriptContract),
          signals: scriptContract.signals.map(formatGdSignal),
          requires: [],
        };
      }
    }

    return {
      id: relativePath,
      engine: 'godot',
      type: 'scene',
      contract: nodeContract,
      depends_on: normalizeDeps(scene.extResources.map((r) => r.path)),
      depended_on_by: [],
    };
  }

  throw new Error(
    `Unsupported Godot file extension for single-file extraction: "${relativePath}"`,
  );
}

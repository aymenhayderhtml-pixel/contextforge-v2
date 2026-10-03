/**
 * extract/js.ts — Dependency graph for a JS/Three.js project.
 *
 * Replaces v1's `madge` + regex-export pipeline. madge resolved imports by
 * parsing each module with its own detective plugin and shelling out; here the
 * imports, exports and asset references all come from the same tree-sitter tree
 * the parser layer already owns (SPEC R5). One parse, three answers, and no
 * dependency whose behaviour we do not control.
 *
 * Module resolution follows Node's rules closely enough for game projects:
 * relative specifiers resolve against the importing file, and an extensionless
 * or directory specifier is probed for the usual extensions.
 */

import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type {
  DependencyGraph,
  GraphEdge,
  GraphNode,
  NodeContract,
} from '../graph/types.js';
import { normalizeDeps, sortGraph, withDependedOnBy } from '../graph/reverse.js';
import { jsContractExports, parseJsModule } from '../parse/js.js';
import { parseInCodeSlotHints, isAssetFile, parseSlotContract } from './assets.js';
import { readTextFileOrNull, scanFiles } from './files.js';
import { extractHtmlEntrypoints } from './html.js';

/** Extensions treated as JS/TS modules. */
const MODULE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
]);

/** Extensions probed when a specifier has none. */
const RESOLUTION_EXTENSIONS: readonly string[] = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json',
];

/** Node modules whose members are not project dependencies. */
const EXTERNAL_PREFIXES = ['three', 'react', 'vue', '@types/', 'node:'];

/**
 * Extract the dependency graph for a JS/Three.js project.
 *
 * `depends_on_by` is left empty here and filled in by `withDependedOnBy`: a
 * parser sees what a file imports, never what imports it.
 */
export function extractJsProject(projectRoot: string): DependencyGraph {
  if (!existsSync(projectRoot)) {
    throw new Error(`Project folder not found: "${projectRoot}"`);
  }

  const files = scanFiles(projectRoot, { extensions: MODULE_EXTENSIONS });

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const assetNodes = new Map<string, GraphNode>();
  /** Module id -> absolute path, for resolving relative specifiers. */
  const modulePaths = new Map<string, string>();
  for (const file of files) modulePaths.set(file.relativePath, file.absolutePath);

  for (const file of files) {
    const source = readTextFileOrNull(file.absolutePath);
    if (source === null) continue;

    const contract = parseJsModule(source, file.relativePath);
    const dependsOn: string[] = [];

    // ── Import edges ──
    for (const imported of contract.imports) {
      const target = resolveSpecifier(imported.specifier, file, projectRoot, modulePaths);
      if (target === null) continue;
      dependsOn.push(target);
      edges.push({ from: file.relativePath, to: target, kind: 'import' });
    }

    // ── Asset reference edges ──
    const hints = parseInCodeSlotHints(source);
    for (const assetRef of contract.assetRefs) {
      const assetId = normalizeAssetRef(assetRef);
      if (!assetId) continue;
      if (!edges.some((e) => e.from === file.relativePath && e.to === assetId)) {
        edges.push({ from: file.relativePath, to: assetId, kind: 'asset_ref' });
      }
      dependsOn.push(assetId);

      if (!assetNodes.has(assetId)) {
        const slotResult = parseSlotContract(assetId, projectRoot, hints);
        assetNodes.set(assetId, {
          id: assetId,
          engine: 'js',
          type: 'asset',
          contract: {
            exports: slotResult.exports,
            signals: [],
            requires: [],
            slot: slotResult.slot,
          },
          slot: slotResult.slot,
          // filled in by withDependedOnBy
          depended_on_by: [],
          depends_on: [],
        });
      }
    }

    const nodeContract: NodeContract = {
      exports: jsContractExports(contract),
      signals: [],
      requires: [],
    };

    nodes.push({
      id: file.relativePath,
      engine: 'js',
      type: 'module',
      contract: nodeContract,
      depends_on: normalizeDeps(dependsOn),
      depended_on_by: [],
    });
  }

  // ── HTML entrypoints, wired to the scripts they load ──
  for (const entry of extractHtmlEntrypoints(projectRoot, modulePaths)) {
    const dependsOn: string[] = [];
    for (const script of entry.scripts) {
      dependsOn.push(script);
      edges.push({ from: entry.id, to: script, kind: 'import' });
    }
    nodes.push({
      id: entry.id,
      engine: 'js',
      type: 'scene',
      contract: { exports: ['entrypoint'], signals: [], requires: [] },
      depends_on: normalizeDeps(dependsOn),
      depended_on_by: [],
    });
  }

  nodes.push(...assetNodes.values());

  return withDependedOnBy(sortGraph({ nodes, edges }));
}

/**
 * Resolve an import specifier to a project-relative node id.
 *
 * Returns null for external packages and for specifiers that point at a file
 * which is not in the project — recording an edge to a node that does not exist
 * would make the graph lie about what a project depends on.
 */
export function resolveSpecifier(
  specifier: string,
  importingFile: { absolutePath: string; relativePath: string },
  projectRoot: string,
  modulePaths: ReadonlyMap<string, string>,
): string | null {
  if (specifier.startsWith('node:')) return null;
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    const isExternal = EXTERNAL_PREFIXES.some(
      (prefix) => specifier === prefix || specifier.startsWith(prefix),
    );
    if (isExternal) return null;
    // A bare specifier is a package, not a project file.
    return null;
  }

  const base = specifier.startsWith('/')
    ? join(projectRoot, specifier)
    : resolve(dirname(importingFile.absolutePath), specifier);

  for (const candidate of resolveCandidates(base, projectRoot)) {
    if (modulePaths.has(candidate)) return candidate;
    // The specifier resolves to a real file that is not a tracked module
    // (e.g. a JSON config imported directly). Record it if it is an asset.
    const absolute = join(projectRoot, candidate);
    if (isAssetFile(candidate) && existsSync(absolute)) return candidate;
  }
  return null;
}

/**
 * The project-relative paths a specifier may resolve to, in Node's order.
 *
 * An explicit extension is used as-is; otherwise each known extension is probed,
 * then the directory's index file. Candidates are relative to the project root
 * because that is the key space node ids live in.
 */
function resolveCandidates(base: string, projectRoot: string): string[] {
  const candidates: string[] = [];
  const relativeBase = relative(projectRoot, base).replaceAll('\\', '/');

  if (/\.[A-Za-z0-9]+$/.test(relativeBase)) {
    candidates.push(relativeBase);
  } else {
    for (const extension of RESOLUTION_EXTENSIONS) {
      candidates.push(`${relativeBase}${extension}`);
    }
    for (const extension of RESOLUTION_EXTENSIONS) {
      candidates.push(`${relativeBase}/index${extension}`);
    }
  }
  return candidates;
}

/**
 * Normalise a raw asset string into a project-relative node id.
 *
 * A path written as `../assets/x.png` is relative to the importing file and is
 * not a valid node id, so relative segments are stripped — the resulting id
 * matches how the file appears in the project tree.
 */
export function normalizeAssetRef(rawPath: string): string | null {
  const cleaned = rawPath
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/');
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Extract a single module without scanning the project.
 *
 * Used by the Patch screen to re-read one file after an edit, and by the
 * scaffolder to validate one new file.
 */
export function extractSingleJsModule(
  relativePath: string,
  projectRoot: string,
): GraphNode {
  const absolutePath = join(projectRoot, relativePath);
  const source = readTextFileOrNull(absolutePath);
  if (source === null) {
    throw new Error(`Cannot read module "${relativePath}" in project "${projectRoot}"`);
  }

  const contract = parseJsModule(source, relativePath);
  const dependsOn: string[] = [];

  for (const imported of contract.imports) {
    const target = resolveSpecifier(
      imported.specifier,
      { absolutePath, relativePath },
      projectRoot,
      new Map(),
    );
    if (target !== null) dependsOn.push(target);
  }
  for (const assetRef of contract.assetRefs) {
    const assetId = normalizeAssetRef(assetRef);
    if (assetId) dependsOn.push(assetId);
  }

  return {
    id: relativePath,
    engine: 'js',
    type: 'module',
    contract: {
      exports: jsContractExports(contract),
      signals: [],
      requires: [],
    },
    depends_on: normalizeDeps(dependsOn),
    depended_on_by: [],
  };
}

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

import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type {
  DependencyGraph,
  GraphEdge,
  GraphNode,
  NodeContract,
} from '../graph/types.js';
import { normalizeDeps, sortGraph, withDependedOnBy } from '../graph/reverse.js';
import { jsContractExports, parseJsModule, type JsModuleContract } from '../parse/js.js';
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
 * True when `path` is a directory.
 *
 * `statSync` rather than `existsSync`, and it returns false rather than throwing
 * on a permission error: a folder the process cannot stat is not a folder it can
 * read, and `scanFiles` will find nothing in it either. The one thing this must
 * never do is report a file as a directory.
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A file that exists in the project but could not be parsed.
 *
 * Reported rather than swallowed: a skipped file is a gap in the graph, and a
 * gap the developer cannot see is the same as a file that does not exist. The
 * reason is tree-sitter's own, naming the position it gave up at.
 */
export interface UnparseableFile {
  /** Project-relative path. */
  path: string;
  /** Why it could not be parsed. */
  reason: string;
}

/**
 * An asset a source file references that is not on disk.
 *
 * Recorded rather than silently dropped. A missing asset is a real fault — the
 * game will try to load it and fail at runtime — and a file reference that
 * resolves to nothing is invisible otherwise: before this, a reference to a
 * non-existent `.png` produced a *node*, so the graph claimed the file existed
 * and nothing anywhere said otherwise.
 */
export interface MissingAsset {
  /** Project-relative path of the file doing the referencing. */
  from: string;
  /** Project-relative path the reference names. */
  asset: string;
  /** The sentence shown to a developer. Never bare. */
  reason: string;
}

/**
 * Extract the dependency graph for a JS/Three.js project.
 *
 * `depends_on_by` is left empty here and filled in by `withDependedOnBy`: a
 * parser sees what a file imports, never what imports it.
 *
 * `onUnparseable` and `onMissingAsset`, if given, receive the files that could
 * not be parsed and the asset references that resolve to nothing. Both are
 * **omitted from the graph** rather than included with something guessed: an
 * unparseable file given an empty contract would read as "this file imports
 * nothing", and a missing asset given a node would read as "this file exists".
 * Both are plausible-looking wrong answers, which is the failure SPEC R9 exists
 * to prevent. The callbacks are parameters rather than return fields because
 * `DependencyGraph` is the manifest's public schema and a new field would change
 * every validator.
 */
export function extractJsProject(
  projectRoot: string,
  onUnparseable?: (file: UnparseableFile) => void,
  onMissingAsset?: (missing: MissingAsset) => void,
): DependencyGraph {
  if (!existsSync(projectRoot)) {
    throw new Error(`Project folder not found: "${projectRoot}"`);
  }
  /**
   * Refuse a path that is a file.
   *
   * `scanFiles` on a file path returns nothing, so before this check a mistyped
   * path that happened to land on a file produced an empty graph — byte for byte
   * identical to a real project with no files in it. That is the specific
   * failure SPEC R9 names: a plausible-looking wrong answer. The existence check
   * above already refuses a missing path, so refusing a *wrong kind* of existing
   * path makes the two consistent.
   */
  if (!isDirectory(projectRoot)) {
    throw new Error(`Not a folder: "${projectRoot}". Point this at a project folder, not a file.`);
  }

  const files = scanFiles(projectRoot, { extensions: MODULE_EXTENSIONS });

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
/**
   * Membership for the asset-edge dedupe below: source path -> assets it has
   * already emitted an edge to.
   *
   * `edges.some(...)` before every push scanned the entire accumulated edge list
   * once per asset reference, so a file referencing 4,000 assets cost
   * ~8,000,000 comparisons — 24 seconds in the audit. A Set makes the check O(1)
   * and produces the identical edge list in the identical order, because it
   * replaces only the *test*, not the push (D53).
   *
   * Deliberately not shared with the import path: `normalizeDeps` already dedupes
   * imports within one file, and mixing the two key spaces would let an import
   * suppress an asset edge or the reverse.
   */
  const assetEdgeKeys = new Map<string, Set<string>>();
  const assetNodes = new Map<string, GraphNode>();
  /** Module id -> absolute path, for resolving relative specifiers. */
  const modulePaths = new Map<string, string>();
  for (const file of files) modulePaths.set(file.relativePath, file.absolutePath);

  for (const file of files) {
    const source = readTextFileOrNull(file.absolutePath);
    if (source === null) continue;

    /**
     * One unparseable file must not end the extraction.
     *
     * `parseJsModule` throws on a file tree-sitter cannot parse — a half-written
     * file, an AI mid-edit, a file saved in an encoding we did not expect. Before
     * this, that throw propagated out of `extractJsProject` and the *whole* graph
     * was lost: one broken file out of 1,000 and the developer got nothing at all,
     * with an error naming a file they may not have been looking at. Phase 5e
     * found this by writing one broken file into a two-file project.
     *
     * The file is skipped and recorded. Skipping rather than substituting a
     * guessed contract matters: an empty `contract` would place the file in the
     * graph with no exports and no imports, which reads as "this file imports
     * nothing" — a plausible-looking wrong answer. Omitting it is honest, and the
     * reason is reported to `onUnparseable`.
     */
    let contract: JsModuleContract;
    try {
      contract = parseJsModule(source, file.relativePath);
    } catch (error) {
      onUnparseable?.({
        path: file.relativePath,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

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

      /**
       * The file must exist before it earns a node.
       *
       * This is the check the import path has always had (`resolveSpecifier`
       * returns null for a path that is not on disk) and the asset path did not.
       * Without it, a reference to a missing `.png` produced a node, so the graph
       * asserted the file existed: 8 phantom nodes in `kart-dash-3d-v2`, none of
       * which a developer could find on disk.
       *
       * **No node and no edge.** The edge is what makes a file look connected to
       * a project; keeping it would preserve exactly the claim being removed, and
       * an edge pointing at a node that does not exist is a dangling edge that
       * every consumer then has to special-case. The problem string is the only
       * record, which is the same shape as an unresolvable import.
       */
      if (!existsSync(join(projectRoot, assetId))) {
        onMissingAsset?.({
          from: file.relativePath,
          asset: assetId,
          reason: `${file.relativePath} references ${assetId}, which does not exist`,
        });
        continue;
      }

      // Outer key is `from`, inner is `to`. A nested map rather than a joined
      // string key, because no separator can be proved collision-free here and
      // a collision would silently drop a real edge.
      let seenAssetsFromThisFile = assetEdgeKeys.get(file.relativePath);
      if (seenAssetsFromThisFile === undefined) {
        seenAssetsFromThisFile = new Set<string>();
        assetEdgeKeys.set(file.relativePath, seenAssetsFromThisFile);
      }
      if (!seenAssetsFromThisFile.has(assetId)) {
        seenAssetsFromThisFile.add(assetId);
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
 *
 * **A `.js` specifier also probes the TypeScript sources beside it.** This is
 * not Node's rule — Node resolves `./kart.js` to that exact file or fails. It is
 * the TypeScript rule, and it is how every TS project is written: the source is
 * `kart.ts` and the specifier says `./kart.js`, because the emitted JavaScript
 * needs the extension at runtime. Without this, a TypeScript project's entire
 * import graph comes back empty and every file looks unreferenced.
 *
 * The `.js` candidate is tried first and the TS variants only as fallbacks, so a
 * project that has both `kart.js` and `kart.ts` still resolves the real `.js`
 * file exactly as Node would.
 */
function resolveCandidates(base: string, projectRoot: string): string[] {
  const candidates: string[] = [];
  const relativeBase = relative(projectRoot, base).replaceAll('\\', '/');

  if (/\.[A-Za-z0-9]+$/.test(relativeBase)) {
    candidates.push(relativeBase);
    if (/\.(?:js|mjs|cjs|jsx)$/.test(relativeBase)) {
      const stem = relativeBase.replace(/\.(?:js|mjs|cjs|jsx)$/, '');
      for (const extension of ['.ts', '.tsx', '.mts', '.cts']) {
        candidates.push(`${stem}${extension}`);
      }
    }
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

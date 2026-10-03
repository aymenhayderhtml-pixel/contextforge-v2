/**
 * extract/files.ts — Deterministic filesystem traversal.
 *
 * Every extractor needs the same thing: "give me every file under this root that
 * has one of these extensions, in a stable order". Ordering matters more than it
 * looks — `readdirSync` returns entries in whatever order the filesystem hands
 * back, which differs between machines and between runs on an APFS volume after
 * a directory is rewritten. An extractor whose node order varies would produce a
 * different graph — and therefore a different prompt — for the same project,
 * breaking SPEC R8.
 */

import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';

/** A file discovered on disk. */
export interface ScannedFile {
  /** Absolute path. */
  absolutePath: string;
  /** Path relative to the scan root, always with forward slashes. */
  relativePath: string;
  /** Lowercase extension including the dot, e.g. ".tscn". */
  extension: string;
}

/**
 * Directories never worth scanning: build output, dependency trees and engine
 * caches. Skipping `.godot` matters for Godot — its import cache can contain
 * thousands of generated files that would swamp the graph.
 */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.godot',
  '.import',
  'dist',
  'build',
  'vendor',
  'three',
  '.next',
  '.cache',
  'coverage',
  '.vscode',
  '.idea',
]);

/**
 * Filenames that are third-party bundles, not project source.
 *
 * A vendored `three.min.js` is ~740KB of minified code. Parsing it to discover
 * its exports costs about 8.5 seconds and produces a contract nobody can act on
 * — it is not the developer's code and no AI may change it. Minified files are
 * excluded by name pattern rather than by directory, because projects vendor
 * libraries under whatever directory they like.
 */
const VENDOR_FILE_PATTERNS: readonly RegExp[] = [
  /\.min\.js$/,
  /\.min\.mjs$/,
  /\.bundle\.js$/,
  /-lock\.(?:js|json)$/,
  /\.umd\.js$/,
];

/** True when a filename identifies a vendored or generated bundle. */
export function isVendorFile(fileName: string): boolean {
  return VENDOR_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

/** Options for `scanFiles`. */
export interface ScanOptions {
  /** Extensions to collect, lowercase, including the dot. */
  extensions: ReadonlySet<string>;
  /**
   * How deep to descend. `Infinity` (the default) scans the whole tree; a
   * finite depth bounds work on a project with a huge `assets/` folder.
   */
  maxDepth?: number;
  /** Additional directory names to skip, merged with the default set. */
  ignoreDirectories?: ReadonlySet<string>;
}

/**
 * Recursively collect files under `root` whose extension is in `options.extensions`.
 *
 * Returns absolute paths sorted by relative path, so the result is identical on
 * every machine and every run.
 */
export function scanFiles(root: string, options: ScanOptions): ScannedFile[] {
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const ignored = new Set([
    ...IGNORED_DIRECTORIES,
    ...(options.ignoreDirectories ?? []),
  ]);

  const results: ScannedFile[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // An unreadable directory (permissions, or a broken symlink) is reported
      // by omission rather than aborting the whole extraction.
      return;
    }

    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of sorted) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      if (isVendorFile(entry.name)) continue;

      const extension = extname(entry.name).toLowerCase();
      if (!options.extensions.has(extension)) continue;

      results.push({
        absolutePath: full,
        relativePath: toPosixPath(relative(root, full)),
        extension,
      });
    }
  };

  walk(root, 0);

  // Sorting by relative path (not by walk order) makes the result independent of
  // how the tree was traversed.
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

/** Normalise a filesystem path to forward slashes. */
export function toPosixPath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/**
 * Read a file as UTF-8, returning null when it cannot be read.
 *
 * Extraction runs over a developer's live project, where a file may be open in
 * an editor or locked by a build. A file that cannot be read is skipped rather
 * than failing the whole extraction.
 */
export function readTextFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/** True when `path` exists and is a directory. */
export function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when `path` exists at all. */
export function pathExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

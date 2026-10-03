/**
 * extract/html.ts — Find HTML entrypoints and the scripts they load.
 *
 * A Three.js project's real entrypoint is `index.html`, and the dependency
 * `main.js -> index.html` direction is what a developer sees in the graph. v1
 * scraped this with `/<script\b[^>]*\bsrc=["']([^"']+)["']/gi`, which happily
 * matches a `src=` inside a comment or an inline string.
 *
 * This is a small hand-rolled scanner rather than a regex sweep: it walks the
 * markup once, tracks whether it is inside a comment or a `<script>` body, and
 * only records attributes of real start tags. HTML is markup rather than code
 * with semantics we depend on, but treating it as an opaque character stream
 * here is both simpler and more honest than pretending to parse it.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readTextFileOrNull, toPosixPath } from './files.js';

/** An HTML file that acts as an entrypoint, and the scripts it loads. */
export interface HtmlEntrypoint {
  /** Project-relative path, e.g. "index.html". */
  id: string;
  /** Project-relative paths of the scripts it loads. */
  scripts: string[];
}

/** Directories never scanned for entrypoints. */
const IGNORED = new Set(['node_modules', 'dist', 'build', '.git']);

/** Attribute values are read up to this many characters. */
const MAX_URL_LENGTH = 512;

/**
 * Find HTML entrypoints and the project scripts they load.
 *
 * Only scripts that resolve to a known module are reported: an entrypoint
 * pointing at a CDN bundle has no project node to depend on, and inventing one
 * would put a dangling node in the graph.
 */
export function extractHtmlEntrypoints(
  projectRoot: string,
  modulePaths: ReadonlyMap<string, string>,
): HtmlEntrypoint[] {
  const results: HtmlEntrypoint[] = [];

  for (const absolutePath of findHtmlFiles(projectRoot)) {
    const source = readTextFileOrNull(absolutePath);
    if (source === null) continue;

    const id = toPosixPath(absolutePath.slice(projectRoot.length + 1));
    const scripts: string[] = [];

    for (const src of readScriptSources(source)) {
      const resolved = resolveScriptSrc(src, absolutePath, projectRoot);
      if (resolved === null) continue;
      if (!modulePaths.has(resolved)) continue;
      if (!scripts.includes(resolved)) scripts.push(resolved);
    }

    results.push({ id, scripts: scripts.sort((a, b) => a.localeCompare(b)) });
  }

  return results.sort((a, b) => a.id.localeCompare(b.id));
}

/** Recursively find `.html`/`.htm` files, skipping build and dependency dirs. */
function findHtmlFiles(root: string, depth = 0): string[] {
  if (depth > 3) return [];
  const results: string[] = [];

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue;
      results.push(...findHtmlFiles(join(root, entry.name), depth + 1));
    } else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
      results.push(join(root, entry.name));
    }
  }

  return results;
}

/**
 * Extract `src` values from `<script>` start tags.
 *
 * Walks the document, skipping HTML comments and the bodies of `<script>`
 * elements (where a `<` is text, not a tag), so an example `src=` inside a
 * comment or a string template is not picked up.
 */
export function readScriptSources(html: string): string[] {
  const sources: string[] = [];
  let i = 0;

  while (i < html.length) {
    const open = html.indexOf('<', i);
    if (open === -1) break;

    // Comment: skip to its terminator.
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }

    // Script body: skip to the closing tag so its contents are not scanned.
    if (html.startsWith('<script', open) && !isTagBoundary(html, open + 7)) {
      const close = html.toLowerCase().indexOf('</script', open + 7);
      const tagEnd = html.indexOf('>', open);
      if (close !== -1 && (tagEnd === -1 || close < tagEnd)) {
        i = close + 8;
        continue;
      }
    }

    const tagEnd = html.indexOf('>', open);
    if (tagEnd === -1) break;
    const tag = html.slice(open + 1, tagEnd);

    if (/^script\b/i.test(tag)) {
      const src = readAttribute(tag, 'src');
      if (src !== null) sources.push(src);
    }
    i = tagEnd + 1;
  }

  return sources;
}

/** True when the character at `index` ends the tag name. */
function isTagBoundary(text: string, index: number): boolean {
  const char = text[index];
  return char === undefined || /\s/.test(char) || char === '>' || char === '/';
}

/**
 * Read one attribute value from a start tag's text.
 *
 * Handles `src="x"`, `src='x'` and bare `src=x`, with optional whitespace around
 * the `=`.
 */
function readAttribute(tag: string, name: string): string | null {
  let searchFrom = 0;

  while (searchFrom < tag.length) {
    const at = tag.toLowerCase().indexOf(name, searchFrom);
    if (at === -1) return null;

    const before = tag[at - 1];
    if (before !== undefined && /[A-Za-z0-9_-]/.test(before)) {
      searchFrom = at + name.length;
      continue;
    }

    let i = at + name.length;
    while (i < tag.length && /\s/.test(tag[i] ?? '')) i++;
    if (tag[i] !== '=') {
      searchFrom = at + name.length;
      continue;
    }
    i++;
    while (i < tag.length && /\s/.test(tag[i] ?? '')) i++;

    const quote = tag[i];
    if (quote === '"' || quote === "'") {
      const end = tag.indexOf(quote, i + 1);
      if (end === -1) return null;
      return tag.slice(i + 1, end);
    }

    let end = i;
    while (end < tag.length && !/\s/.test(tag[end] ?? '')) end++;
    const value = tag.slice(i, end);
    return value.length > 0 && value.length <= MAX_URL_LENGTH ? value : null;
  }

  return null;
}

/**
 * Resolve a script `src` to a project-relative module id.
 *
 * Remote and protocol-relative URLs are rejected: they are not project files.
 * A root-relative `/src/main.js` is resolved against the project root, and a
 * document-relative one against the HTML file's own directory.
 */
export function resolveScriptSrc(
  src: string,
  htmlAbsolutePath: string,
  projectRoot: string,
): string | null {
  const trimmed = src.trim();
  if (trimmed === '') return null;
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('//')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;

  const absolute = trimmed.startsWith('/')
    ? join(projectRoot, trimmed)
    : resolve(dirname(htmlAbsolutePath), trimmed);

  if (!existsSync(absolute)) return null;
  return toPosixPath(absolute.slice(projectRoot.length + 1));
}

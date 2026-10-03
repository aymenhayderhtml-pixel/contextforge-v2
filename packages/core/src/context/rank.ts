/**
 * context/rank.ts — rank files by how likely they are to hold the answer.
 *
 * v1 ranked with a single regex over the console output, which meant the *order*
 * of a stack trace decided relevance and a file mentioned in a comment scored
 * like a file that actually threw. The scores are ported, but the extraction
 * of what to score is now a real tokenizer: a file path in a stack frame is a
 * different thing from a path in prose, and only the former is evidence.
 *
 * The scoring ladder itself is unchanged from v1, because it was sound — the
 * problem was never the weights, it was that regex could not tell the cases
 * apart.
 */

import type { Manifest } from '../graph/types.js';

/** Why a file scored what it scored. Every rank carries its reason. */
export interface RankedFile {
  /** Project-relative path. */
  file: string;
  score: number;
  /** The line in the stack, when the trace gave one. */
  line: number | null;
  /** Human-readable, and the developer's only clue if the ranking is wrong. */
  reason: string;
  /** True for the files attached automatically. */
  isTop: boolean;
}

/** How many ranked files are attached without being asked for. */
export const AUTO_ATTACH_COUNT = 3;

/** Files the compiler attached automatically. */
export type AutoAttached = RankedFile[];

/** What the ranker was given. */
export interface RankInput {
  /** Console output, error text, or a pasted stack trace. */
  logs: string;
  /** The developer's own description of the problem. */
  issue: string;
  /** The extracted graph, when one is available. */
  manifest?: Manifest | undefined;
  /** Which project-relative paths actually exist. */
  exists?: (file: string) => boolean;
}

/** One file reference recovered from a log. */
interface FileReference {
  file: string;
  line: number | null;
  /** Position in the log; 0 is the first, which is the frame that threw. */
  order: number;
}

/** Characters that can appear inside a path. Deliberately excludes `(`, `"`, `'` and `:`. */
const PATH_CHAR = /^[A-Za-z0-9_./\\-]$/;

/** Extensions that can name a source file in a project of either engine. */
const SOURCE_EXTENSIONS = new Set([
  'gd', 'js', 'ts', 'tsx', 'jsx', 'mjs', 'html', 'tscn', 'json', 'tres',
]);

/**
 * The identifier a rendered signature binds.
 *
 * The graph stores exports as display signatures — `function buildMesh(name)`,
 * `class TrackManager`, `const SPEED` — because that is what a human reads in
 * the Context screen. For matching, the leading keyword is dropped and the next
 * identifier taken, which yields the name an AI would actually type.
 */
function bindingNameOf(signature: string): string | null {
  const match = /^\s*(?:async\s+)?(?:function\s*\*?\s*|class\s+|const\s+|let\s+|var\s+)?([A-Za-z_$][A-Za-z0-9_$]*)/.exec(
    signature,
  );
  return match?.[1] ?? null;
}

/**
 * Recover file references from console output.
 *
 * A hand-written scan rather than a regex, for the same reason `tscn.ts` has its
 * own parser: a regex that tries to find `foo.js:12` inside arbitrary text has
 * to make a choice about quoting, and the wrong choice silently scores a file
 * the user mentioned in a sentence. This scanner tracks whether it is inside a
 * quoted string so a path in prose is reported separately from a path in a
 * stack frame.
 */
export function extractFileReferences(logs: string): FileReference[] {
  const references: FileReference[] = [];
  const seen = new Set<string>();
  let order = 0;

  for (let i = 0; i < logs.length; i++) {
    // A path must *begin* with a path character. Without this the `(` in
    // `at fn (src/x.js:1:1)` starts a path and the scan yields "(src/x.js" —
    // a path that matches no file on disk, so the file silently ranks nothing.
    // This is the most important guard in the scanner.
    if (!PATH_CHAR.test(logs[i] as string)) continue;

    // And it must not be preceded by another path character, or we are in the
    // middle of a path that was already found.
    if (i > 0 && PATH_CHAR.test(logs[i - 1] as string)) continue;

    // `res://` (Godot) and `http://host/` (a dev server) are both stripped so
    // the graph only ever sees project-relative ids.
    let start = i;
    let rest = logs.slice(i);

    const resMatch = /^res:\/\//.exec(rest);
    if (resMatch) {
      start = i + resMatch[0].length;
      rest = logs.slice(start);
    } else {
      const httpMatch = /^https?:\/\/[^/\s]+\//.exec(rest);
      if (httpMatch) {
        start = i + httpMatch[0].length;
        rest = logs.slice(start);
      }
    }

    // Read the path. A Windows drive letter (`C:\`) is part of the path, not a
    // separator. The colon is not a path character, so without this the scan
    // stops after `C` and returns a one-letter path. `start` stays put — it is
    // what gets sliced — so the colon and separator are skipped by advancing
    // `end` past both.
    const hasDrive = /^[A-Za-z]:[\\/]/.test(logs.slice(start)) !== null;
    let end = hasDrive ? start + 2 : start;

    // `(` is *not* a path character: a stack frame wraps its path as
    // `at fn (src/x.js:1:1)`, and treating `(` as part of the path yields
    // "(src/x.js", which matches no file on disk and silently ranks nothing.
    while (end < logs.length && PATH_CHAR.test(logs[end] as string)) end++;

    if (end === start) continue;

    const rawPath = logs.slice(start, end);
    const dot = rawPath.lastIndexOf('.');
    if (dot === -1) continue;
    const extension = rawPath.slice(dot + 1).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(extension)) continue;

    // A trailing `:123` is the line number. The colon is not a path character,
    // so it is still unconsumed here.
    let line: number | null = null;
    let pathEnd = end;
    const lineMatch = /^:(\d+)/.exec(logs.slice(end));
    if (lineMatch?.[1]) {
      line = Number.parseInt(lineMatch[1], 10);
      pathEnd = end + lineMatch[0].length;
    }

    const normalized = rawPath.replaceAll('\\', '/');
    const key = `${normalized}:${line ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    references.push({ file: normalized, line, order: order++ });
    i = pathEnd - 1;
  }

  return references;
}

/** Words too common to be evidence of relevance. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'when', 'what',
  'not', 'but', 'you', 'are', 'was', 'were', 'has', 'had', 'its', 'his', 'her',
  'they', 'them', 'then', 'than', 'there', 'here', 'will', 'would', 'could',
  'should', 'about', 'into', 'over', 'after', 'before', 'while', 'because',
  'error', 'errors', 'issue', 'problem', 'bug', 'issue',
]);

/** Split a description into candidate tokens, dropping noise words. */
export function tokenize(issue: string): string[] {
  return issue
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

/**
 * Rank files against an error and a description.
 *
 * Scores are v1's, unchanged:
 *  - 100 the file and line the error names first
 *  - 95  a later frame in the same stack
 *  - 80  a symbol in the description matches a file's contract
 *  - 75  a direct dependency of a top file
 *  - 70  a dependent of a top file
 *  - 40  a keyword appears in the filename
 *
 * Ties break on the path, so the same input always produces the same order
 * (SPEC R8).
 */
export function rankRelevantFiles(input: RankInput): RankedFile[] {
  const candidates = new Map<string, RankedFile & { reasons: string[] }>();
  const exists = input.exists ?? ((): boolean => true);

  const add = (file: string, score: number, reason: string, line: number | null = null): void => {
    const normalized = file.replaceAll('\\', '/');
    const current = candidates.get(normalized);

    if (current === undefined) {
      candidates.set(normalized, { file: normalized, score, line, reason, isTop: false, reasons: [reason] });
      return;
    }

    if (score > current.score) current.score = score;
    if (line !== null && current.line === null) current.line = line;
    if (!current.reasons.includes(reason)) current.reasons.push(reason);
  };

  // ── 1. The stack trace ────────────────────────────────────────────────────
  // The *first* reference is where the error surfaced; the rest are frames it
  // passed through. Both matter, but not equally.
  for (const reference of extractFileReferences(input.logs)) {
    if (!exists(reference.file)) continue;
    if (reference.order === 0) {
      add(
        reference.file,
        100,
        reference.line === null ? 'Primary error location' : `Error origin at line ${reference.line}`,
        reference.line,
      );
    } else {
      add(
        reference.file,
        95,
        reference.line === null ? 'Active stack frame' : `Stack frame at line ${reference.line}`,
        reference.line,
      );
    }
  }

  // ── 2. Keywords in the description ────────────────────────────────────────
  const tokens = tokenize(input.issue);
  // The description's own spelling, preserved: `buildMesh` tokenised is
  // lowercased to `buildmesh`, which would never match the contract's
  // `buildMesh` and would silently drop the strongest signal a description can
  // give. So camelCase identifiers are compared case-insensitively against the
  // *original* text instead.
  const describedSymbols = new Set(
    [...input.issue.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)]
      .map((m) => (m[1] ?? '').toLowerCase())
      .filter((name) => name.length >= 3 && !STOP_WORDS.has(name)),
  );

  if (input.manifest) {
    for (const node of input.manifest.nodes) {
      const lowerId = node.id.toLowerCase();

      for (const token of tokens) {
        if (lowerId.includes(token)) {
          add(node.id, 40, `Filename matches "${token}"`);
        }
      }

      // A symbol the description names, present in the file's contract, is much
      // stronger evidence than a filename substring.
      //
      // `contract.exports` holds rendered signatures (`function buildMesh(name)`),
      // not bare names, so the *binding* is extracted before comparing.
      for (const exported of node.contract.exports) {
        const binding = bindingNameOf(exported);
        if (binding !== null && describedSymbols.has(binding.toLowerCase())) {
          add(node.id, 80, `Exports "${binding}", named in your description`);
        }
      }
      for (const signal of node.contract.signals) {
        if (describedSymbols.has(signal.toLowerCase())) {
          add(node.id, 80, `Declares signal "${signal}", named in your description`);
        }
      }
    }
  }

  // ── 3. The graph, from the top files outward ─────────────────────────────
  const topFiles = [...candidates.values()].filter((c) => c.score >= 90).map((c) => c.file);

  if (input.manifest) {
    for (const topFile of topFiles) {
      const node = input.manifest.nodes.find((n) => n.id === topFile);
      if (node === undefined) continue;
      for (const dependency of node.depends_on) {
        add(dependency, 75, `Direct dependency of ${topFile}`);
      }
      for (const dependent of node.depended_on_by) {
        add(dependent, 70, `Dependent of ${topFile} — it may need updating too`);
      }
    }
  }

  return [...candidates.values()]
    .map(({ reasons, ...rest }) => ({
      ...rest,
      reason: reasons.join('; '),
      isTop: rest.score >= 95,
    }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}

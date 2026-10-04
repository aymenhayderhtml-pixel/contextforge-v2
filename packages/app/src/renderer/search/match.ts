/**
 * renderer/search/match.ts — how a search result is *presented*.
 *
 * ## Why the matching rules live in the main process and only display lives here
 *
 * The first version of this file held the matching algorithm too, and the main
 * process imported it. That does not build, and the reason is structural rather
 * than a missing export:
 *
 * `packages/app/tsconfig.json` **excludes** `src/renderer` — the renderer is not in
 * the `tsc` project graph at all, because `tsc` cannot compile `.svelte` and the
 * renderer's *TypeScript* is checked by `svelte-check` against a separate config
 * (`tsconfig.svelte.json`). So `electron/ipcHandlers.ts`, which `tsc` does compile,
 * cannot import a file under `renderer/`: the compiler refuses it with
 * `TS6307 — not listed within the file list`, because the file is not part of that
 * project. There is also no precedent for a main→renderer import anywhere in
 * `src/electron`.
 *
 * So the split is not a preference, it is what the project graph forces:
 *
 *  - **The matching algorithm and every byte read** are in `electron/ipcHandlers.ts`
 *    (the main process), because that is the only compiled, `node:`-capable side.
 *  - **This file is the renderer's half**: turning a `SearchResponse` into the
 *    strings, counts and highlight ranges the SearchBox draws. It has no `node:`
 *    import and no `import type` from core is even needed for the shape — it takes
 *    the already-typed `SearchResponse` from `ipc.ts`.
 *
 * Everything here is a pure function over data that already crossed IPC, so it is
 * trivially testable and can never disagree with the main process about what a
 * result *is* — only about how it is worded on screen.
 */

import type { SearchMatchHit, SearchResponse } from '../../ipc.js';

/** Characters of a matched line rendered before it is elided. */
export const PREVIEW_CHARS = 300;

/**
 * A one-line summary of what the search found, for the line under the box.
 *
 * Says the truth in every case the box can be in, because the failure this avoids
 * is a summary that reads as complete:
 *
 *  - nothing typed yet → the hint, no counts
 *  - a refusal → the refusal's own sentence, passed through
 *  - a query that matched nothing → "no matches", naming what was searched
 *  - a truncated result → the count *and* that it was cut short
 *
 * A summary that omitted the last two would let a developer conclude "no match"
 * when the truth was "too many to list", which is the opposite of what is true.
 */
export function summarizeSearch(
  result: SearchResponse | null,
  refusal: string | null,
  query: string,
): string {
  if (refusal !== null) return refusal;
  if (result === null) return 'Type to search the project by file name or content.';
  if (query.trim() === '') return 'Type to search the project by file name or content.';

  const fileCount = result.files.length;
  const matchCount = result.matches.length;

  if (fileCount === 0 && matchCount === 0) {
    return `No matches for “${query.trim()}” in ${result.scannedFiles} ` +
      `${result.scannedFiles === 1 ? 'file' : 'files'}.`;
  }

  const parts: string[] = [];
  if (fileCount > 0) {
    parts.push(`${fileCount} ${fileCount === 1 ? 'file name' : 'file names'}`);
  }
  if (matchCount > 0) {
    parts.push(`${matchCount} ${matchCount === 1 ? 'line' : 'lines'}`);
  }

  let summary = `${parts.join(' and ')} of ${result.scannedFiles} ` +
    `${result.scannedFiles === 1 ? 'file' : 'files'}.`;
  if (result.truncated) {
    // The cap said out loud. A list that looks complete when it is not is worse
    // than an uncapped one that hangs.
    summary += ` ${result.truncatedReason}`;
  }
  return summary;
}

/**
 * Trim and cap a matched line for display.
 *
 * Mirrors what the main process already did to `MatchHit.text` — the main process
 * caps it at 300 characters and trims leading whitespace so a long minified line
 * cannot flood the result list. The renderer trims again for the *highlight* rows
 * it builds from `MatchHit.text`, and applying the same rule on both sides means a
 * highlighted range always lands where the developer sees the characters.
 */
export function previewOf(hit: SearchMatchHit): string {
  const trimmed = hit.text.replace(/^\s+/, '');
  return trimmed.length > PREVIEW_CHARS ? `${trimmed.slice(0, PREVIEW_CHARS)}…` : trimmed;
}

/**
 * The substring of a matched line that the query covers, for bolding.
 *
 * `hit.column` is a 1-based offset **into the line as the main process sent it** —
 * that is, into `hit.text`, which already has its leading whitespace trimmed and its
 * tail elided. So the offset needs no further adjustment here, and applying one is
 * what put the highlight in the wrong place in the first draft: the main process was
 * correcting for indentation, and this corrected for it a second time.
 *
 * Returns `null` when the query is not on this line as stored — which happens for a
 * match that fell inside an elided tail. The renderer then shows the line with no
 * highlight at all. A highlight on the wrong characters is worse than none.
 */
export function highlightRangeIn(
  needle: string,
  preview: string,
): { start: number; end: number } | null {
  const start = preview.toLowerCase().indexOf(needle);
  if (start === -1) return null;
  const end = start + needle.length;
  // Defensive: a range that runs past the preview would render as a `<mark>` with
  // nothing in it, which reads as a rendering bug rather than as a truncated line.
  if (end > preview.length) return null;
  return { start, end };
}

/**
 * Group matches by file, in first-seen order, so the renderer can list files with
 * their lines nested rather than as one flat list.
 *
 * The grouping preserves the order the main process returned, which is the walk
 * order — deterministic across runs, so the same query always renders the same
 * list. This is the same determinism rule core's `scanFiles` documents (SPEC R8);
 * a search whose order changed between two runs of one query would be a second
 * reason to distrust it.
 */
export function groupMatchesByPath(
  matches: readonly SearchMatchHit[],
): Array<{ path: string; lines: SearchMatchHit[] }> {
  const order: string[] = [];
  const byPath = new Map<string, SearchMatchHit[]>();

  for (const match of matches) {
    const bucket = byPath.get(match.path);
    if (bucket === undefined) {
      order.push(match.path);
      byPath.set(match.path, [match]);
    } else {
      bucket.push(match);
    }
  }

  return order.map((path) => ({ path, lines: byPath.get(path) ?? [] }));
}

/**
 * The files to list, in a stable order: those with content matches first (in the
 * order the main process returned them), then name-only hits.
 *
 * A file whose name matched *and* whose contents matched appears once, not twice —
 * the two lists are separate answers, but rendering the path twice because both
 * were true is noise rather than information. This is why the file-name list and
 * the grouped lines are joined *here*, once, rather than by concatenating two
 * arrays in the template.
 *
 * The order is the walk order the main process produced, which is deterministic
 * across runs — the same determinism rule core's `scanFiles` documents (SPEC R8).
 * A search whose list reordered between two runs of one query would be a second
 * reason to distrust it.
 */
export function listedFilePaths(result: SearchResponse): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const match of result.matches) {
    if (!seen.has(match.path)) {
      seen.add(match.path);
      paths.push(match.path);
    }
  }
  for (const file of result.files) {
    if (!seen.has(file.path)) {
      seen.add(file.path);
      paths.push(file.path);
    }
  }
  return paths;
}
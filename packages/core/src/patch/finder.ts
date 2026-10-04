/**
 * patch/finder.ts — Locate a patch's FIND snippet inside a real file.
 *
 * This is the component that decides whether an AI's surgical patch is applied
 * to the right code. An LLM rewrites a snippet from memory: it drops a space
 * after a comma, changes indentation, reformats a call, and sometimes pastes
 * code with `> 42 | ` line-number prefixes from a chat transcript. A strict
 * exact-match finder rejects all of that and the developer gets nothing.
 *
 * A permissive finder is worse: it applies the patch to the wrong lines, or to
 * the first of five similar blocks, and the developer does not notice until the
 * game misbehaves.
 *
 * So the finder is a ladder of passes, from strictest to loosest, and each pass
 * reports how many places it matched. **A pass that matches more than once is a
 * refusal, never a guess** — the answer is "ambiguous, make the snippet
 * longer", never "I picked the first one". That is the whole contract.
 */

/**
 * Outcome of looking for a FIND snippet.
 *
 * `target` is the **whole matched region**, not the first N lines of it. The
 * distinction is not cosmetic: a snippet with blank lines dropped matches a
 * region *longer* than the snippet, and replacing only the snippet's own length
 * leaves the region's tail on disk as well — duplicating statements in the
 * developer's source while every gate reports success (D52).
 *
 * On a CRLF file, `target` keeps the file's own `\r\n`, because it is sliced out
 * of the original string rather than reconstructed from a normalised one.
 */
export type MatchResult =
  | {
      success: true;
      /** The exact text found in the file, to be replaced. */
      target: string;
      /** Always 1 on success; ambiguity never resolves to a guess. */
      occurrences: number;
    }
  | {
      success: false;
      occurrences: number;
      /** Why the match was refused, phrased for the AI that wrote the patch. */
      reason: string;
    };

/** An inclusive line range inside a file's line array. */
export interface Span {
  start: number;
  end: number;
}

/**
 * Passes are tried in order; the first one that matches decides the result.
 *
 * A pass returns a **span**, not a start index. A pass whose comparator can
 * straddle lines the FIND never mentioned — blank lines, a block whose length
 * the AI guessed wrong — cannot express its answer as a single number, and a
 * caller that re-derives the end as `start + findLines.length` will write the
 * wrong bytes. The type is the fix; see D52.
 */
type Pass = {
  name: string;
  run(fileLines: string[], findLines: string[]): Span[];
};

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * Find `findText` in `fileContent`.
 *
 * Both inputs may use CRLF; they are normalised to LF first so a file authored
 * on Windows is patchable from a patch written on Linux.
 */
export function findTargetMatch(fileContent: string, findText: string): MatchResult {
  if (findText.trim() === '') {
    // Not "no match found". An empty FIND has no region, and the line passes
    // below would happily return a span at line 0 — which `applyToContent`
    // writes as a prepend. Refused by name, never applied (D52).
    return {
      success: false,
      occurrences: 0,
      reason: 'FIND is empty, so there is nothing to locate. Ask the AI for the exact original lines.',
    };
  }

  const normalizedFile = normalizeNewlines(fileContent);
  const normalizedFind = normalizeNewlines(findText);

  // Pass 0: exact substring. The common case, and the only one guaranteed to be
  // byte-for-byte what the AI asked for.
  const exactCount = countOccurrences(normalizedFile, normalizedFind);
  if (exactCount === 1) {
    return { success: true, target: exactTarget(fileContent, normalizedFind), occurrences: 1 };
  }
  if (exactCount > 1) {
    return { success: false, occurrences: exactCount, reason: `matched ${exactCount} times` };
  }

  const fileLines = normalizedFile.split('\n');
  const strippedFind = stripLineNumberPrefixes(normalizedFind);

  // Pass 1: the AI pasted from a transcript that prefixes each line with
  // "> 42 | ". Strip the prefix and retry the exact match.
  if (strippedFind !== normalizedFind) {
    const strippedCount = countOccurrences(normalizedFile, strippedFind);
    if (strippedCount === 1) {
      return { success: true, target: exactTarget(fileContent, strippedFind), occurrences: 1 };
    }
    if (strippedCount > 1) {
      return {
        success: false,
        occurrences: strippedCount,
        reason: `matched ${strippedCount} times`,
      };
    }
  }

  const findLines = strippedFind.split('\n');

  for (const pass of LINE_PASSES) {
    const spans = pass.run(fileLines, findLines);
    if (spans.length === 0) continue;

    if (spans.length > 1) {
      return {
        success: false,
        occurrences: spans.length,
        reason: `matched ${spans.length} times`,
      };
    }

    // One span. It is the whole matched region, so `end` may be past
    // `start + findLines.length - 1` — and replacing only the snippet's own
    // length is what duplicated the tail of a blank-line-drifted block (D52).
    const only = spans[0];
    if (!only) continue;

    const normalizedTarget = fileLines.slice(only.start, only.end + 1).join('\n');
    return { success: true, target: restoreEol(fileContent, normalizedTarget), occurrences: 1 };
  }

  // Variable-anchor pass: locates a block by its declarations rather than its
  // text, for when the AI reworded the body but kept the variable names.
  const anchored = anchorOnVariables(fileLines, findLines);
  if (anchored !== null) {
    const normalized = fileLines.slice(anchored.start, anchored.end + 1).join('\n');
    return { success: true, target: restoreEol(fileContent, normalized), occurrences: 1 };
  }

  return {
    success: false,
    occurrences: 0,
    reason: 'could not find exact FIND text',
  };
}

/**
 * Re-derive the text of an exact match from the **original** file.
 *
 * `findTargetMatch` matches against an LF-normalised copy, but its `target` is
 * handed to a replace on the original string. Handing back the normalised copy
 * makes that replace a no-op on a CRLF file: the block reports applied and not
 * one byte changes. That bug existed here for real, and it is D51's gotcha 11
 * one level up — `ok` and `existsOnDisk` are different questions, and so are
 * "the text I matched" and "the text that is in the file".
 *
 * Reconstruction is a line-array walk, not index arithmetic on two different
 * strings: `restoreEol` has already made the target CRLF when the file is, so
 * the only thing left to recover is the column its first line starts at. The
 * walk tries every occurrence of that first line and keeps the first one whose
 * reconstruction normalises back to the needle — which is the leftmost, because
 * occurrences are visited in order.
 */
function exactTarget(fileContent: string, normalizedNeedle: string): string {
  if (!fileContent.includes('\r\n')) return normalizedNeedle;

  const needleLines = normalizedNeedle.split('\n');
  const fileLines = fileContent.split('\r\n');
  const first = needleLines[0];
  if (first === undefined || first === '') return normalizedNeedle;

  for (const line of fileLines) {
    let column = line.indexOf(first);
    while (column >= 0) {
      const reconstructed = [line.slice(column), ...needleLines.slice(1)].join('\r\n');
      if (normalizeNewlines(reconstructed) === normalizedNeedle) return reconstructed;
      column = line.indexOf(first, column + 1);
    }
  }

  // Unreachable when the caller's count is 1. Returning the normalised text
  // makes the block fail loudly in `applyToContent` rather than write nothing.
  return normalizedNeedle;
}

/**
 * Give a normalised, located region the line endings the file actually uses.
 *
 * Inverse of `normalizeNewlines`, and the reason `exactTarget` can reconstruct
 * from a line array: after this runs, a target on a CRLF file is CRLF.
 */
function restoreEol(fileContent: string, normalizedTarget: string): string {
  return fileContent.includes('\r\n')
    ? normalizedTarget.replace(/\n/g, '\r\n')
    : normalizedTarget;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

/**
 * Remove `> 42 | ` / `  42 | ` line-number prefixes from a pasted snippet.
 * Returns the input unchanged when no line carries a prefix.
 */
function stripLineNumberPrefixes(findText: string): string {
  const prefixPattern = /^(?:\s*>\s*)?\s*\d+\s*\|\s?/;
  if (!prefixPattern.test(findText)) return findText;
  return findText.replace(new RegExp(prefixPattern.source, 'gm'), '');
}

/**
 * Collapse whitespace around punctuation and between tokens.
 *
 * `foo( a, b )` and `foo(a,b)` become identical, which is the drift an LLM
 * introduces when it reformats a call it is "quoting from memory".
 */
function collapseWhitespace(line: string): string {
  return line
    .replace(/\s*([(){}[\];,:=<>+\-*/])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every span where `findLines` matches, under some line comparison.
 *
 * Returns every match, not the first: the caller needs the count to decide
 * whether the match is unique.
 */
function matchLineWindows(
  fileLines: string[],
  findLines: string[],
  equal: (a: string, b: string) => boolean,
): Span[] {
  const spans: Span[] = [];
  for (let j = 0; j <= fileLines.length - findLines.length; j++) {
    let allEqual = true;
    for (let k = 0; k < findLines.length; k++) {
      if (!equal(fileLines[j + k] ?? '', findLines[k] ?? '')) {
        allEqual = false;
        break;
      }
    }
    if (allEqual) spans.push({ start: j, end: j + findLines.length - 1 });
  }
  return spans;
}

/**
 * Match a block that spans a different number of lines because blank lines were
 * dropped or added.
 *
 * The find snippet's non-blank lines must appear in the file in order, with
 * anything allowed between them. The returned span covers from the first to the
 * last matched line, so a replacement replaces the whole region **including the
 * file's blank lines** — which is the only correct outcome, because a block
 * cannot restate the developer's blank-line spacing (D52).
 */
function matchAcrossBlankLines(fileLines: string[], findLines: string[]): Span[] {
  const target = findLines.map(collapseWhitespace).filter((line) => line.length > 0);
  if (target.length < 2) return [];

  const spans: Span[] = [];
  for (let j = 0; j < fileLines.length; j++) {
    if (collapseWhitespace(fileLines[j] ?? '') !== target[0]) continue;

    let matched = 0;
    let valid = true;
    let lastMatchedLine = j;

    for (let k = j; k < fileLines.length && matched < target.length; k++) {
      const collapsed = collapseWhitespace(fileLines[k] ?? '');
      if (collapsed === '') continue; // blank lines in the file are tolerated
      if (collapsed === target[matched]) {
        matched += 1;
        lastMatchedLine = k;
      } else {
        valid = false;
        break;
      }
    }

    if (valid && matched === target.length) {
      spans.push({ start: j, end: lastMatchedLine });
    }
  }
  return dedupeSpans(spans);
}

/**
 * The loosest line pass: anchor a block by its first and last line and require
 * its interior to agree with the snippet.
 *
 * The first and last lines must match exactly and the length must be within a
 * few lines either way. **Every** non-blank line of the snippet must then appear
 * in the candidate, in order — see `anchorInteriorAgrees`.
 *
 * The interior used to be scored at **55%**: at most two of five lines could
 * differ and the block still counted as a match. That is how a snippet sharing
 * nothing but a first and last line with the file was reported as
 * `occurrences: 1` and applied, which is a guess — the one thing D3 forbids.
 *
 * It only ever runs on blocks of three lines or more, because for a one- or
 * two-line snippet an anchor is no more evidence than a plain match.
 */
function matchByBoundaryAnchor(fileLines: string[], findLines: string[]): Span[] {
  if (findLines.length < 3) return [];

  const firstLine = findLines[0]?.trim() ?? '';
  const lastLine = findLines[findLines.length - 1]?.trim() ?? '';
  if (firstLine.length < 4 || lastLine.length < 2) return [];

  const nonBlankFind = findLines.map((line) => line.trim()).filter((line) => line !== '');
  if (nonBlankFind.length === 0) return [];

  const spans: Span[] = [];

  for (let j = 0; j < fileLines.length; j++) {
    if ((fileLines[j] ?? '').trim() !== firstLine) continue;

    const minEnd = Math.max(j + 2, j + findLines.length - 4);
    const maxEnd = Math.min(fileLines.length - 1, j + findLines.length + 4);

    for (let k = minEnd; k <= maxEnd; k++) {
      if ((fileLines[k] ?? '').trim() !== lastLine) continue;

      if (anchorInteriorAgrees(fileLines.slice(j, k + 1), nonBlankFind)) {
        // One span per real match: the old code pushed `j` and broke, so two
        // candidates sharing a first line were counted as one. The caller
        // refuses on >1, so the count it reported was a count of candidate
        // starts, not of matches (D52).
        spans.push({ start: j, end: k });
        break;
      }
    }
  }

  return dedupeSpans(spans);
}

/**
 * Whether every non-blank snippet line appears in the candidate, in order.
 *
 * In order, because an unordered subset test would accept a file that contains
 * all of the snippet's lines in a different arrangement — a different
 * function, or the same statements in the wrong order.
 */
function anchorInteriorAgrees(candidateLines: string[], nonBlankFind: string[]): boolean {
  const candidate = candidateLines.map((line) => line.trim()).filter((line) => line !== '');
  let cursor = 0;

  for (const line of nonBlankFind) {
    const found = candidate.indexOf(line, cursor);
    if (found === -1) return false;
    cursor = found + 1;
  }

  return true;
}

/** Collapse spans that describe the same region, so a count is a count. */
function dedupeSpans(spans: Span[]): Span[] {
  const seen = new Set<string>();
  const unique: Span[] = [];
  for (const span of spans) {
    const key = `${span.start}:${span.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(span);
  }
  return unique;
}

/**
 * Locate a block by the variable declarations it contains.
 *
 * For a snippet that declares two or more `const`/`let`/`var` names, the
 * candidate must start at the first declaration and end at the line closing the
 * last one. Useful when the AI reworded the body between the declarations.
 *
 * The declarations alone are **not** enough, and treating them as enough was
 * how a snippet sharing nothing but three variable names with the file was
 * reported as `occurrences: 1` and applied: the old code returned the span
 * without ever comparing a single body line, so `return a + b + c;` could be
 * replaced by a file containing `return a;`. The candidate's non-blank lines
 * must now contain every non-blank line of the snippet, in order, exactly as
 * `anchorInteriorAgrees` requires of the boundary pass. Re-wording — the thing
 * this pass exists for — changes whitespace, and whitespace is collapsed first;
 * it does not change `return` into nothing.
 */
function anchorOnVariables(fileLines: string[], findLines: string[]): Span | null {
  const declared = [...findLines.join('\n').matchAll(/\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/g)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);

  if (declared.length < 2) return null;

  const firstVar = declared[0];
  const lastVar = declared[declared.length - 1];
  if (!firstVar || !lastVar) return null;

  const firstPattern = new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(firstVar)}\\s*=`);
  const startIndices = fileLines
    .map((line, index) => (firstPattern.test(line) ? index : -1))
    .filter((index) => index !== -1);

  if (startIndices.length !== 1) return null;
  const startLine = startIndices[0];
  if (startLine === undefined) return null;

  const lastPattern = new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(lastVar)}\\s*=`);
  const searchEnd = Math.min(fileLines.length, startLine + findLines.length + 15);

  // Collapsed once, so the comparison below is the same "same code, different
  // spacing" question the earlier passes ask — and no looser.
  const expected = findLines.map(collapseWhitespace).filter((line) => line.length > 0);
  if (expected.length === 0) return null;

  for (let j = startLine; j < searchEnd; j++) {
    if (!lastPattern.test(fileLines[j] ?? '')) continue;

    // The block ends at the first line that closes its statement or block.
    for (let k = j; k < Math.min(fileLines.length, j + 8); k++) {
      if (!/[;}]\s*$/.test((fileLines[k] ?? '').trim())) continue;

      const candidate = fileLines
        .slice(startLine, k + 1)
        .map(collapseWhitespace)
        .filter((line) => line.length > 0);

      if (expected.every((line) => candidate.includes(line))) {
        return { start: startLine, end: k };
      }
      break;
    }
    break;
  }

  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Ordered line passes, strictest first. Each returns every candidate span. */
const LINE_PASSES: readonly Pass[] = [
  {
    name: 'trimEnd',
    run: (f, s) => matchLineWindows(f, s, (a, b) => a.trimEnd() === b.trimEnd()),
  },
  {
    name: 'trim',
    run: (f, s) => matchLineWindows(f, s, (a, b) => a.trim() === b.trim()),
  },
  {
    name: 'collapsed',
    run: (f, s) =>
      matchLineWindows(f, s, (a, b) => collapseWhitespace(a) === collapseWhitespace(b)),
  },
  { name: 'blankLineDrift', run: matchAcrossBlankLines },
  { name: 'boundaryAnchor', run: matchByBoundaryAnchor },
];

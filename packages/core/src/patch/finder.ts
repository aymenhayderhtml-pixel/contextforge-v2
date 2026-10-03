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

/** Outcome of looking for a FIND snippet. */
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

/** Passes are tried in order; the first one that matches decides the result. */
type Pass = {
  name: string;
  run(fileLines: string[], findLines: string[]): number[];
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
  const normalizedFile = normalizeNewlines(fileContent);
  const normalizedFind = normalizeNewlines(findText);

  // Pass 0: exact substring. The common case, and the only one guaranteed to be
  // byte-for-byte what the AI asked for.
  const exactCount = countOccurrences(normalizedFile, normalizedFind);
  if (exactCount === 1) {
    return { success: true, target: normalizedFind, occurrences: 1 };
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
      return { success: true, target: strippedFind, occurrences: 1 };
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
    const starts = pass.run(fileLines, findLines);
    if (starts.length === 0) continue;

    if (starts.length > 1) {
      return {
        success: false,
        occurrences: starts.length,
        reason: `matched ${starts.length} times`,
      };
    }

    const start = starts[0];
    if (start === undefined) continue;
    const matched = fileLines.slice(start, start + findLines.length).join('\n');
    return { success: true, target: matched, occurrences: 1 };
  }

  // Variable-anchor pass: locates a block by its declarations rather than its
  // text, for when the AI reworded the body but kept the variable names.
  const anchored = anchorOnVariables(fileLines, findLines);
  if (anchored !== null) return { success: true, target: anchored, occurrences: 1 };

  return {
    success: false,
    occurrences: 0,
    reason: 'could not find exact FIND text',
  };
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
 * Collect the start indices where `findLines` matches, under some comparison.
 *
 * Returns every match, not the first: the caller needs the count to decide
 * whether the match is unique.
 */
function matchLineWindows(
  fileLines: string[],
  findLines: string[],
  equal: (a: string, b: string) => boolean,
): number[] {
  const starts: number[] = [];
  for (let j = 0; j <= fileLines.length - findLines.length; j++) {
    let allEqual = true;
    for (let k = 0; k < findLines.length; k++) {
      if (!equal(fileLines[j + k] ?? '', findLines[k] ?? '')) {
        allEqual = false;
        break;
      }
    }
    if (allEqual) starts.push(j);
  }
  return starts;
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
 * Match a block that spans a different number of lines because blank lines were
 * dropped or added.
 *
 * The find snippet's non-blank lines must appear in the file in order, with
 * anything allowed between them. The returned range covers from the first to the
 * last matched line, so a replacement replaces the whole region including the
 * file's blank lines.
 */
function matchAcrossBlankLines(fileLines: string[], findLines: string[]): number[] {
  const target = findLines.map(collapseWhitespace).filter((line) => line.length > 0);
  if (target.length < 2) return [];

  const starts: number[] = [];
  for (let j = 0; j < fileLines.length; j++) {
    if (collapseWhitespace(fileLines[j] ?? '') !== target[0]) continue;

    let matched = 0;
    let valid = true;

    for (let k = j; k < fileLines.length && matched < target.length; k++) {
      const collapsed = collapseWhitespace(fileLines[k] ?? '');
      if (collapsed === '') continue; // blank lines in the file are tolerated
      if (collapsed === target[matched]) {
        matched += 1;
      } else {
        valid = false;
        break;
      }
    }

    if (valid && matched === target.length) starts.push(j);
  }
  return starts;
}

/**
 * Anchor a multi-line block by its first and last line, scoring the interior.
 *
 * This is the loosest pass. The first and last lines must match exactly, the
 * block length may differ by a few lines, and at least 55% of the snippet's
 * non-blank lines must appear somewhere in the candidate. It only ever runs on
 * blocks of three lines or more, because for a one- or two-line snippet an
 * anchor is no more evidence than a plain match.
 */
function matchByBoundaryAnchor(fileLines: string[], findLines: string[]): number[] {
  if (findLines.length < 3) return [];

  const firstLine = findLines[0]?.trim() ?? '';
  const lastLine = findLines[findLines.length - 1]?.trim() ?? '';
  if (firstLine.length < 4 || lastLine.length < 2) return [];

  const nonBlankFind = findLines.map((line) => line.trim()).filter((line) => line !== '');
  if (nonBlankFind.length === 0) return [];

  const candidates: number[] = [];

  for (let j = 0; j < fileLines.length; j++) {
    if ((fileLines[j] ?? '').trim() !== firstLine) continue;

    const minEnd = Math.max(j + 2, j + findLines.length - 4);
    const maxEnd = Math.min(fileLines.length - 1, j + findLines.length + 4);

    for (let k = minEnd; k <= maxEnd; k++) {
      if ((fileLines[k] ?? '').trim() !== lastLine) continue;

      const slice = fileLines.slice(j, k + 1);
      const matched = nonBlankFind.filter((line) =>
        slice.some((candidate) => candidate.trim() === line),
      ).length;

      if (matched / nonBlankFind.length >= 0.55) {
        candidates.push(j);
        break;
      }
    }
  }

  return candidates;
}

/**
 * Locate a block by the variable declarations it contains.
 *
 * For a snippet that declares two or more `const`/`let`/`var` names, the
 * candidate must start at the first declaration and end at the line closing the
 * last one. Useful when the AI rewrote the body between the declarations.
 */
function anchorOnVariables(fileLines: string[], findLines: string[]): string | null {
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

  for (let j = startLine; j < searchEnd; j++) {
    if (!lastPattern.test(fileLines[j] ?? '')) continue;

    // The block ends at the first line that closes its statement or block.
    for (let k = j; k < Math.min(fileLines.length, j + 8); k++) {
      if (/[;}]\s*$/.test((fileLines[k] ?? '').trim())) {
        return fileLines.slice(startLine, k + 1).join('\n');
      }
    }
    break;
  }

  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Ordered line passes, strictest first. Each returns candidate start indices. */
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

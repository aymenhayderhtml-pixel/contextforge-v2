/**
 * context/compiler.ts — build the handoff prompt (SPEC §5 Step 2).
 *
 * The problem this solves is not "give the AI the whole project". It is the
 * narrower one: an AI asked to fix an error will confidently invent an API it
 * was never shown, and the developer's only defence is to make sure it saw the
 * real thing. So the prompt carries three kinds of thing and nothing else:
 *
 *  1. **The crime scene, verbatim.** The failing function, sliced from disk with
 *     a syntax tree. Verbatim, because the AI's `FIND` block has to match
 *     character-for-character and a reformatted snippet fails the patch.
 *  2. **The public signatures of everything touching it.** Not the bodies. The
 *     AI needs to know `loadTrack()` exists and what it takes; it does not need
 *     200 lines of a file it is not being asked to change.
 *  3. **An explicit way out.** If that is not enough, the AI is told to reply
 *     `CONTEXT INSUFFICIENT:` and name what it needs, rather than guess. This is
 *     the loop the whole app turns on: ask, attach, re-ask.
 *
 * v1's ideas are ported wholesale; the implementation is rewritten. The prompt
 * format is v1's, because a model that has seen a format works with it, and the
 * contract wording ("DO NOT INVENT", verbatim `FIND`) is the part that actually
 * changes model behaviour.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dependentsOf, normalizeDeps } from '../graph/reverse.js';
import { formatGdExport, formatGdFunction, parseGdScript } from '../parse/gdscript.js';
import { formatJsExport, parseJsModule } from '../parse/js.js';
import { grammarForPath } from '../parse/grammars.js';
import type { Manifest } from '../graph/types.js';
import { rankRelevantFiles, AUTO_ATTACH_COUNT, type RankedFile } from './rank.js';
import {
  findFunctions,
  sliceAroundLine,
  sliceFunctionAtLine,
  sliceFunctionByName,
  sliceWholeFile,
  type Slice,
} from './slice.js';

/** How many lines a file may have before it is sent as an interface only. */
export const MAX_WHOLE_FILE_LINES = 200;

/** How many lines to show either side of an error line with no function. */
const CONTEXT_LINES = 5;

/** How the caller wants the prompt built. */
export interface CompileOptions {
  /** Project root. Every path in the prompt is relative to it. */
  projectRoot: string;
  /** What the developer says is wrong. */
  issue?: string | undefined;
  /** Console output or a pasted stack trace. */
  logs?: string | undefined;
  /** The extracted graph, when available. */
  manifest?: Manifest | undefined;
  /** Force a file to be the primary target, bypassing the ranking. */
  targetFile?: string | undefined;
  /** Force a line in the target file. */
  targetLine?: number | undefined;
  /** Attach whole files instead of slices. Costs far more tokens. */
  fullFiles?: boolean | undefined;
  /** Cap on characters in the compiled prompt. Overflow is reported, not hidden. */
  maxChars?: number | undefined;
  /** Extra project-relative paths to attach. */
  files?: readonly string[] | undefined;
}

/** The compiled prompt and an account of what went into it. */
export interface CompiledContext {
  /** The prompt to paste into an AI. */
  prompt: string;
  /** The files attached, in order, with why. */
  ranked: RankedFile[];
  /** What was actually included, per file. */
  sections: ContextSection[];
  /** True when a symbol or file was asked for and not found. */
  hasGaps: boolean;
  /** Plain-language list of what could not be found. */
  gaps: string[];
  chars: number;
  /** A rough token estimate. Never treated as exact. */
  tokens: number;
  /** What the prompt would have cost with whole files. */
  fullChars: number;
  /** How much the slicing saved, as a percentage. */
  savingsPercent: number;
}

/** One file's contribution to the prompt. */
export interface ContextSection {
  file: string;
  kind: 'slice' | 'signatures' | 'full';
  /** The line span, when the section is a slice. */
  startLine?: number | undefined;
  endLine?: number | undefined;
  /** The symbol a slice covers. */
  symbol?: string | undefined;
  reason: string;
}

/** Default character budget. Roughly 3k tokens — enough to be useful, not a dump. */
export const DEFAULT_MAX_CHARS = 12_000;

/** Paths explicitly requested by AI or caller to be attached in full. */
function extractFullAttachmentRequests(options: CompileOptions): Set<string> {
  const full = new Set<string>();
  if (options.files) {
    for (const f of options.files) {
      const trimmed = f.trim().replaceAll('\\', '/');
      if (trimmed) full.add(trimmed);
    }
  }
  const text = (options.logs ?? '') + '\n' + (options.issue ?? '');
  for (const m of text.matchAll(/\bNEED:\s*([^\s—\n]+)/gi)) {
    if (m[1]) full.add(m[1].trim().replaceAll('\\', '/'));
  }
  for (const m of text.matchAll(/CONTEXT INSUFFICIENT:\s*(?:Need\s+)?([^\s—\n]+)/gi)) {
    if (m[1]) full.add(m[1].trim().replaceAll('\\', '/'));
  }
  for (const m of text.matchAll(/\[developer asked for this file to be attached too:\s*([^\]]+)\]/gi)) {
    if (m[1]) full.add(m[1].trim().replaceAll('\\', '/'));
  }
  return full;
}

/**
 * Compile a handoff prompt.
 *
 * Never throws for a missing file: an unfindable file becomes a reported gap,
 * because the correct response to "I could not see this" is to say so, and an
 * exception here would take down the screen the developer is working in.
 */
export function compileContext(options: CompileOptions): CompiledContext {
  const {
    projectRoot,
    issue = '',
    logs = '',
    manifest,
    fullFiles = false,
    maxChars = DEFAULT_MAX_CHARS,
  } = options;

  const exists = (file: string): boolean => {
    try {
      return existsSync(join(projectRoot, file));
    } catch {
      return false;
    }
  };

  const ranked = rankRelevantFiles({
    logs,
    issue,
    manifest,
    exists,
  });

  const fullRequested = extractFullAttachmentRequests(options);

  // The target is whatever the caller named, else the highest-ranked file.
  const targetFile = options.targetFile ?? ranked[0]?.file ?? null;
  const targetLine = options.targetLine ?? ranked.find((r) => r.file === targetFile)?.line ?? null;

  const sections: ContextSection[] = [];
  const gaps: string[] = [];
  const parts: string[] = [];

  const requestedFileSizes = new Map<string, number>();

  if (targetFile !== null) {
    if (!exists(targetFile)) {
      gaps.push(
        `The target file "${targetFile}" does not exist in the project. It may have been moved or renamed.`,
      );
    } else {
      const isTargetFull = fullFiles || fullRequested.has(targetFile);
      const built = buildTargetSection(projectRoot, targetFile, targetLine, logs + issue, fullFiles, gaps, isTargetFull);
      parts.push(built.text);
      sections.push(built.section);
      if (fullRequested.has(targetFile)) {
        try {
          const source = readFileSync(join(projectRoot, targetFile), 'utf-8');
          requestedFileSizes.set(targetFile, source.length);
        } catch {}
      }
    }
  }

  // Any other file explicitly requested in full by the AI or caller
  for (const file of [...fullRequested].sort()) {
    if (file === targetFile) continue;
    if (!exists(file)) continue;
    const absolute = join(projectRoot, file);
    const source = readFileSync(absolute, 'utf-8');
    requestedFileSizes.set(file, source.length);
    parts.push(`### FILE: ${file} (full source)\n\`\`\`\n${source}\n\`\`\``);
    sections.push({
      file,
      kind: 'full',
      reason: 'Requested by AI (NEED / CONTEXT INSUFFICIENT) — attached in full',
    });
  }

  // Everything else gets signatures, not bodies.
  for (const candidate of ranked.slice(0, AUTO_ATTACH_COUNT + 3)) {
    if (candidate.file === targetFile || fullRequested.has(candidate.file)) continue;
    if (!exists(candidate.file)) continue;

    const signatures = buildSignatureSection(projectRoot, candidate.file);
    if (signatures === null) continue;

    parts.push(signatures.text);
    sections.push(signatures.section);
  }

  // Manifest-level context: what depends on the target.
  const dependents = buildDependentsSection(projectRoot, targetFile, manifest);
  if (dependents !== null) {
    parts.push(dependents.text);
    sections.push(dependents.section);
  }

  const engine = detectEngine(manifest, projectRoot, ranked);
  const gameName = projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? 'this project';
  const requestedList = [...fullRequested].filter((f) => exists(f)).sort();

  const prompt = buildPrompt({
    gameName,
    engine,
    issue,
    logs,
    requestedFiles: requestedList,
    body: parts.length > 0 ? parts.join('\n\n') : '(No files could be attached — see the gaps below.)',
    gaps,
  });

  const fullPrompt = buildPrompt({
    gameName,
    engine,
    issue,
    logs,
    requestedFiles: requestedList,
    body: buildFullBody(projectRoot, ranked),
    gaps,
  });

  // An over-budget prompt is reported rather than silently shipped: the caller
  // gets a number and a gap entry, and can ask for a narrower slice.
  if (prompt.length > maxChars) {
    const requestedAttached = sections.filter((s) => fullRequested.has(s.file));
    let budgetWarning = `Prompt is ${prompt.length} characters, over the ${maxChars} budget.`;
    if (requestedAttached.length > 0) {
      const details = requestedAttached
        .map((s) => `${s.file} (${requestedFileSizes.get(s.file) ?? 0} chars)`)
        .join(', ');
      budgetWarning += ` Files attached because they were requested: ${details}.`;
    }
    budgetWarning += ' Re-run with a target line, or fewer ranked files.';
    gaps.push(budgetWarning);
  }

  return {
    prompt,
    ranked,
    sections,
    hasGaps: gaps.length > 0,
    gaps,
    chars: prompt.length,
    tokens: Math.round(prompt.length / 4),
    fullChars: fullPrompt.length,
    savingsPercent:
      fullPrompt.length > 0
        ? Math.max(0, Math.round(((fullPrompt.length - prompt.length) / fullPrompt.length) * 100))
        : 0,
  };
}

/** One built section and its rendered text. */
interface BuiltSection {
  text: string;
  section: ContextSection;
}

/**
 * The target file: the failing function verbatim, plus its outline.
 *
 * Order of preference, and why:
 *  1. the function containing the error line — exactly what needs fixing;
 *  2. a function named in the description;
 *  3. a window around the line;
 *  4. the whole file, if it is small enough to be worth it.
 */
function buildTargetSection(
  projectRoot: string,
  file: string,
  line: number | null,
  query: string,
  fullFiles: boolean,
  gaps: string[],
  forceFull = false,
): BuiltSection {
  const absolute = join(projectRoot, file);
  const source = readFileSync(absolute, 'utf-8');

  if (fullFiles || forceFull) {
    return {
      text: `### FILE: ${file} (full source)\n\`\`\`\n${source}\n\`\`\``,
      section: { file, kind: 'full', reason: 'Whole file attached at the caller\'s request' },
    };
  }

  const lineCount = source.split('\n').length;
  const outline = buildOutline(file, source);

  let slice: Slice | null = null;
  let reason = '';

  if (line !== null) {
    slice = sliceFunctionAtLine(source, file, line);
    if (slice !== null) reason = `The function containing line ${line}, where the error surfaced`;
  }

  if (slice === null) {
    const symbol = symbolFromText(query);
    if (symbol !== null) {
      slice = sliceFunctionByName(source, file, symbol);
      if (slice !== null) {
        reason = `The function "${symbol}", named in your description`;
      } else {
        gaps.push(
          `No function named "${symbol}" was found in ${file}. The file's functions are: ${listFunctions(source, file)}.`,
        );
      }
    }
  }

  if (slice === null && line !== null) {
    slice = sliceAroundLine(source, file, line, CONTEXT_LINES);
    if (slice !== null) reason = `The lines around ${line}`;
  }

  // No line and no symbol: send the whole file when it is small enough to be
  // cheap, otherwise send only its interface. Either way the choice is stated
  // in the prompt and, for the second case, as a gap — the AI must be able to
  // tell "here is everything" from "here is only what I could narrow to".
  const outlineOnly = lineCount > MAX_WHOLE_FILE_LINES;
  if (outlineOnly) {
    gaps.push(
      `No error line or function name was found for ${file}, and it is ${lineCount} lines long, so only its signatures were sent.`,
    );
    return {
      text: `### FILE: ${file} (interface only)\n// --- Public interface ---\n${outline}`,
      section: {
        file,
        kind: 'signatures',
        reason: `${lineCount} lines is too large to send, and no line or symbol was identified`,
      },
    };
  }

  if (slice === null) {
    slice = sliceWholeFile(source, file);
    reason = 'Whole file: no specific line or symbol was identified';
  }

  const header = `### FILE: ${file}\n// --- Public interface ---\n${outline}`;

  return {
    text:
      `${header}\n\n` +
      `// --- Verbatim from disk: ${describeSlice(slice)} (${reason}) ---\n` +
      `// Lines ${slice.startLine}-${slice.endLine}. Copy exactly; do not re-indent.\n` +
      `\`\`\`\n${slice.text}\n\`\`\``,
    section: {
      file,
      kind: slice.isWholeFile ? 'full' : 'slice',
      startLine: slice.startLine,
      endLine: slice.endLine,
      symbol: slice.symbol === '' ? undefined : slice.symbol,
      reason,
    },
  };
}

function describeSlice(slice: Slice): string {
  if (slice.symbol !== '') return `function ${slice.symbol}()`;
  if (slice.isWholeFile) return 'the whole file';
  return 'the surrounding lines';
}

/**
 * The public interface of one file: exports, signals, exported vars, and
 * function signatures — with no bodies.
 *
 * This is what an AI needs about a file it is not changing. v1's outline was a
 * brace-counting line scan; here the signatures are read from the parse the
 * project extractor already does, so a signature is never a line that merely
 * looked like one.
 */
function buildSignatureSection(
  projectRoot: string,
  file: string,
): BuiltSection | null {
  const source = readFileSync(join(projectRoot, file), 'utf-8');
  const outline = buildOutline(file, source);
  if (outline.trim() === '') return null;

  const reason = 'Signatures only — this file is not the one being changed';
  return {
    text: `### FILE: ${file} (interface only)\n\`\`\`\n${outline}\n\`\`\``,
    section: { file, kind: 'signatures', reason },
  };
}

/** What depends on the target, so the AI does not break a caller. */
function buildDependentsSection(
  projectRoot: string,
  targetFile: string | null,
  manifest: Manifest | undefined,
): BuiltSection | null {
  if (targetFile === null || manifest === undefined) return null;

  const dependents = dependentsOf(manifest, targetFile);
  if (dependents.size === 0) return null;

  const existing = [...dependents].filter((id) => existsSync(join(projectRoot, id))).sort();
  if (existing.length === 0) return null;

  const lines = existing.map((id) => `// ${id}`).join('\n');
  return {
    text:
      `## Files that depend on ${targetFile}\n` +
      `// If you change this file's public interface, these callers may break.\n` +
      lines,
    section: {
      file: targetFile,
      kind: 'signatures',
      reason: `${existing.length} file(s) depend on it`,
    },
  };
}

function cleanLogsForOutput(logs: string): string {
  return logs
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (/^NEED:\s*([^\s—\n]+)/i.test(trimmed)) return false;
      if (/^CONTEXT INSUFFICIENT:\s*(?:Need\s+)?([^\s—\n]+)/i.test(trimmed)) return false;
      if (/^\[developer asked for this file to be attached too:\s*([^\]]+)\]$/i.test(trimmed)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

/** Assemble the prompt. The format is v1's, deliberately. */
function buildPrompt(input: {
  gameName: string;
  engine: string;
  issue: string;
  logs: string;
  requestedFiles?: string[];
  body: string;
  gaps: string[];
}): string {
  const parts: string[] = [];

  parts.push(
    `I am working on the game "${input.gameName}" using ${input.engine}.`,
  );

  if (input.issue.trim() !== '') {
    parts.push(`ISSUE:\n${input.issue.trim()}`);
  }

  if (input.requestedFiles && input.requestedFiles.length > 0) {
    parts.push(`Requested files: ${input.requestedFiles.join(', ')}`);
  }

  const cleanLogs = cleanLogsForOutput(input.logs);
  if (cleanLogs !== '') {
    parts.push(`RUNTIME OUTPUT:\n\`\`\`\n${cleanLogs}\n\`\`\``);
  }

  parts.push(`FILE CONTEXT:\n${input.body}`);

  if (input.gaps.length > 0) {
    parts.push(
      `NOT ATTACHED (you do not have these, so do not assume their contents):\n` +
        input.gaps.map((g) => `- ${g}`).join('\n'),
    );
  }

  parts.push(strictPatchContract());

  return parts.join('\n\n');
}

/**
 * The contract block.
 *
 * The wording is v1's and is the part that changes model behaviour. Four rules,
 * each addressing a specific failure seen in practice:
 *
 *  1. exact match — so the patch applies;
 *  2. surrounding anchors — so the finder locates it unambiguously;
 *  3. complete replacement — so no placeholder ships;
 *  4. DO NOT GUESS — so a missing symbol becomes a question, not an invention.
 */
export function strictPatchContract(): string {
  return `================================================================================
SURGICAL PATCH CONTRACT
================================================================================

1. EDIT SURGICALLY. Do not rewrite a whole file to change one line.

2. FORMAT for an existing file:

### EDIT: relative/path.ext
<<<<<<< FIND
<exact existing code, character for character, including whitespace>
=======
<complete replacement code>
>>>>>>> REPLACE

3. THE FIND BLOCK MUST MATCH THE SUPPLIED SOURCE EXACTLY:
   - Same whitespace, same indentation, same quotes, same semicolons.
   - Do NOT re-indent or "tidy" the code you were given.
   - Include 2-4 unchanged lines above and below so the match is unique.

4. THE REPLACE BLOCK MUST BE COMPLETE. Never write
   "// rest stays the same" or "..." — the full runnable code, every time.

5. NEW FILES use:

### FILE: relative/path.ext
\`\`\`language
<the complete file>
\`\`\`

6. DO NOT INVENT. If a function, variable, signal or file you need was not
   shown above, you do not know whether it exists. Reply with exactly:

   CONTEXT INSUFFICIENT: Need <file path> — <what you need from it>

   and stop. Do not guess an API. Do not assume a name from another engine.
   A wrong guess is applied to a real project and breaks the game; a question
   costs one round trip.`;
}

/** Whole files, used only to compute what the slicing saved. */
function buildFullBody(projectRoot: string, ranked: RankedFile[]): string {
  const parts: string[] = [];
  for (const candidate of ranked.slice(0, AUTO_ATTACH_COUNT + 3)) {
    const absolute = join(projectRoot, candidate.file);
    if (!existsSync(absolute)) continue;
    parts.push(`### FILE: ${candidate.file}\n\`\`\`\n${readFileSync(absolute, 'utf-8')}\n\`\`\``);
  }
  return parts.length > 0 ? parts.join('\n\n') : '(No files could be attached.)';
}

/** The public interface of a file, rendered as text. */
function buildOutline(file: string, source: string): string {
  const grammar = grammarForPath(file);
  if (grammar === null) {
    // A file with no grammar (a .tscn, a .json) is still worth showing; the
    // parser in parse/tscn.ts reads it, and its headers are the contract.
    return source.split('\n').slice(0, 40).join('\n');
  }

  try {
    if (grammar === 'gdscript') {
      const contract = parseGdScript(source, file);
      const lines: string[] = [];
      for (const signal of contract.signals) lines.push(`signal ${signal.name}`);
      for (const constant of contract.constants) lines.push(`const ${constant.name}`);
      for (const exported of contract.exports) lines.push(`@export ${formatGdExport(exported)}`);
      for (const fn of contract.publicFunctions) lines.push(`func ${formatGdFunction(fn)}`);
      return lines.join('\n');
    }

    const contract = parseJsModule(source, file);
    const lines: string[] = [];
    for (const exported of contract.exports) lines.push(`export ${formatJsExport(exported)}`);
    for (const imported of contract.imports) {
      lines.push(`imports: ${imported.specifier} (${imported.names.join(', ')})`);
    }
    return lines.join('\n');
  } catch {
    // A file that does not parse is reported rather than silently omitted —
    // but the prompt is still built, because refusing to compile context at all
    // leaves the developer with nothing.
    return `(could not parse ${file}; no interface available)`;
  }
}

/** Keywords and literals that cannot be custom function names. */
const IGNORED_SYMBOLS = new Set([
  'undefined',
  'null',
  'nan',
  'true',
  'false',
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'throw',
  'new',
  'typeof',
  'void',
  'delete',
  'await',
  'yield',
  'import',
  'export',
  'function',
  'func',
  'class',
  'super',
  'this',
  'constructor',
  'let',
  'const',
  'var',
  'async',
  'try',
  'finally',
  'do',
  'else',
  'case',
  'default',
  'break',
  'continue',
  'in',
  'of',
  'instanceof',
  'assert',
  'match',
  'pass',
  'signal',
  'extends',
  'self',
]);

/** A function name mentioned in free text, if there is one. */
function symbolFromText(text: string): string | null {
  // A camelCase or snake_case identifier that is called somewhere in the text.
  // Deliberately narrow: a bare word is not evidence, and a wrong symbol sends
  // the AI to the wrong function.
  // Iterate through all matches rather than taking only the first, so JS error
  // strings like "undefined (reading '...')" or keywords do not trap the search.
  const calledMatches = text.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g);
  for (const match of calledMatches) {
    const candidate = match[1];
    if (candidate && !IGNORED_SYMBOLS.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  const mentionedMatches = text.matchAll(/\b(?:function|method|func)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g);
  for (const match of mentionedMatches) {
    const candidate = match[1];
    if (candidate && !IGNORED_SYMBOLS.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return null;
}

/** The function names in a file, for a gap message. */
function listFunctions(source: string, file: string): string {
  try {
    const names = findFunctions(source, file).map((f) => f.name);
    return names.length > 0 ? names.join(', ') : '(none found)';
  } catch {
    return '(unavailable)';
  }
}

/**
 * The engine, for the prompt's opening line.
 *
 * Prefers the project's own `project.godot`, because the manifest only says
 * what was *extracted* — a project with a .gd file but no manifest still is a
 * Godot project, and telling an AI it is a Three.js project is exactly the
 * kind of confident wrong answer this app exists to prevent.
 */
function detectEngine(manifest: Manifest | undefined, projectRoot: string, ranked: RankedFile[]): string {
  if (existsSync(join(projectRoot, 'project.godot'))) return 'Godot 4.x (GDScript)';

  // A `.gd` file in the ranked set means this is a Godot project even when no
  // manifest was supplied and `project.godot` was not found. Naming the wrong
  // engine to an AI is exactly the confident-wrong-answer failure this app
  // exists to prevent, so the evidence is taken from whatever is available.
  if (ranked.some((r) => r.file.endsWith('.gd'))) return 'Godot 4.x (GDScript)';

  if (manifest !== undefined && new Set(manifest.nodes.map((n) => n.engine)).has('godot')) {
    return 'Godot 4.x (GDScript)';
  }

  return 'HTML5, Vite, and Three.js';
}

// `normalizeDeps` is re-exported for callers that build a manifest and want the
// same normalisation the graph uses when they compare dependency lists.
export { normalizeDeps };

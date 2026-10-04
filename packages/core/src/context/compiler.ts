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

import { readFileSync, statSync } from 'node:fs';
import {
  resolveInsideRoot,
  resolveInsideRootOrThrow,
  type ResolveInsideRootResult,
} from '../fs/resolveInsideRoot.js';
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

/**
 * Largest single file that may be attached in full, in characters.
 *
 * Separate from `maxChars` because the two answer different questions.
 * `maxChars` bounds the whole prompt; this bounds one read, and it exists so a
 * single `NEED:` line cannot make the compiler load an unbounded file into
 * memory before any budget check has run. A 64 MB file produced a 64 MB prompt
 * and a 16.8M token estimate — the read itself is the denial of service, so the
 * cap has to be on the read (SEC-5).
 *
 * Comfortably above any real source file: 400,000 characters is roughly 12,000
 * lines, about 400 KB of TypeScript.
 */
export const MAX_FULL_FILE_CHARS = 400_000;

/**
 * The refusal for a file too large to attach, in one sentence plus a way out.
 *
 * A gap rather than a throw or a silent skip, for the same reason a refused path
 * is a gap: the developer pasted a `NEED:` line and asked for the file. Saying
 * nothing leaves them unable to tell "you were refused" from "the AI was
 * ignored" (SPEC R9).
 */
function oversizeFileGap(file: string, chars: number): string {
  return (
    `Not attached: "${file}" is ${chars.toLocaleString('en-US')} characters, over the ` +
    `${MAX_FULL_FILE_CHARS.toLocaleString('en-US')}-character limit for attaching one file in full. ` +
    `Ask for a narrower region of it — a function name or a line number — and it will be attached as a slice.`
  );
}

/**
 * Read a file for full attachment, or return why it will not be read at all.
 *
 * The size is checked with `statSync` BEFORE the read, never after. Reading first
 * and measuring `source.length` afterwards is the bug this replaces: by then the
 * 64 MB is already in memory and already inside the prompt, so the check can
 * only report a fact it has already paid the full cost to learn (SEC-5).
 *
 * A `statSync` failure is treated as "do not read" rather than propagated: an
 * unreadable file is a gap, and `compileContext` never throws for a file it
 * cannot show (SPEC R9).
 */
function readForFullAttachment(
  absolutePath: string,
): { source: string } | { tooLarge: number } | { unreadable: true } {
  let size: number;
  try {
    size = statSync(absolutePath).size;
  } catch {
    return { unreadable: true };
  }
  if (size > MAX_FULL_FILE_CHARS) return { tooLarge: size };

  try {
    return { source: readFileSync(absolutePath, 'utf-8') };
  } catch {
    return { unreadable: true };
  }
}

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

  /**
   * Containment-aware existence.
   *
   * Was `existsSync(join(projectRoot, file))`, which answers "is there a file at
   * this name" and silently means "somewhere that name leads, including through
   * a symlink out of the tree". Every caller below now treats `false` as "not a
   * file in this project", which is the only meaning that is safe.
   */
  const exists = (file: string): boolean => {
    const inside = resolveInsideRoot(projectRoot, file);
    return inside.ok && inside.value.existsOnDisk;
  };

  const ranked = rankRelevantFiles({
    logs,
    issue,
    manifest,
    exists,
  });

  const gaps: string[] = [];

  /**
   * Refuse a path that leaves the project, once, and say why.
   *
   * The refusal is a **gap**, not a throw and not a silent skip: the developer
   * pasted an AI's `NEED:` line and asked for a file. Attaching nothing without
   * a word leaves them unable to tell "you were refused" from "the AI was
   * ignored", and a prompt-injected reply naming `~/.ssh/id_rsa` must produce a
   * visible sentence rather than a quietly shorter prompt (SPEC R9).
   *
   * `reported` keeps it to one line per path: the same escape named by both a
   * `NEED:` and the `files` array is one thing that went wrong.
   */
  const reported = new Set<string>();
  const refusalGap = (file: string, verdict: Extract<ResolveInsideRootResult, { ok: false }>): void => {
    if (reported.has(file)) return;
    reported.add(file);
    gaps.push(
      `Not attached: "${file}" is not a file inside the project. ${verdict.reason}`,
    );
  };

  const fullRequestedRaw = extractFullAttachmentRequests(options);

  // One pass, before anything is read: every path named from *any* source —
  // `options.files` (the app's ticked-box channel), `NEED:` and
  // `CONTEXT INSUFFICIENT:` in the pasted logs, and `options.targetFile` — is
  // decided here. Three sources, one rule, one sentence each. Previously the
  // app guarded only the first, which is how SEC-2 reached a file outside the
  // project through a pasted reply.
  const fullRequested = new Set<string>();
  for (const file of fullRequestedRaw) {
    const inside = resolveInsideRoot(projectRoot, file);
    if (inside.ok) fullRequested.add(inside.value.relativePath);
    else refusalGap(file, inside);
  }

  // The target is whatever the caller named, else the highest-ranked file.
  // An explicit `targetFile` is checked on the same terms as everything else:
  // it was the one path SEC-1 found unguarded.
  const namedTarget = options.targetFile;
  let targetFile: string | null = null;
  if (namedTarget !== undefined) {
    const inside = resolveInsideRoot(projectRoot, namedTarget);
    if (inside.ok) targetFile = inside.value.relativePath;
    else {
      refusalGap(namedTarget, inside);
      targetFile = null;
    }
  }
  if (targetFile === null) targetFile = ranked[0]?.file ?? null;
  const targetLine = options.targetLine ?? ranked.find((r) => r.file === targetFile)?.line ?? null;

  const sections: ContextSection[] = [];
  const parts: string[] = [];

  const requestedFileSizes = new Map<string, number>();

  if (targetFile !== null) {
    const inside = resolveInsideRoot(projectRoot, targetFile);
    if (!inside.ok || !exists(targetFile)) {
      gaps.push(
        `The target file "${targetFile}" does not exist in the project. It may have been moved or renamed.`,
      );
    } else {
      const isTargetFull = fullFiles || fullRequested.has(targetFile);
      const built = buildTargetSection(
        projectRoot,
        targetFile,
        targetLine,
        logs + issue,
        fullFiles,
        gaps,
        isTargetFull,
      );
      if (built !== null) {
        parts.push(built.text);
        sections.push(built.section);
      }
      if (fullRequested.has(targetFile)) {
        // Size-gated here too. The target is reached by `NEED:` exactly like any
        // other requested file, so a pasted reply can name it just as easily.
        const read = readForFullAttachment(inside.value.absolutePath);
        if ('tooLarge' in read) gaps.push(oversizeFileGap(targetFile, read.tooLarge));
        else if (!('unreadable' in read)) requestedFileSizes.set(targetFile, read.source.length);
      }
    }
  }

  // Any other file explicitly requested in full by the AI or caller.
  //
  // The read is the whole of SEC-2: this loop attaches a file's bytes to the
  // prompt verbatim, and the path came from pasted text. It is behind two gates
  // now — `fullRequested` only holds paths that survived `resolveInsideRoot`
  // above, and the read itself opens `absolutePath`, never a re-derived `join`.
  for (const file of [...fullRequested].sort()) {
    if (file === targetFile) continue;
    const inside = resolveInsideRoot(projectRoot, file);
    if (!inside.ok || !exists(file)) continue;

    // Size-gated before the read — see `readForFullAttachment`. The path came
    // from pasted text, so this is the route that made a 64 MB prompt possible.
    const read = readForFullAttachment(inside.value.absolutePath);
    if ('unreadable' in read) continue;
    if ('tooLarge' in read) {
      gaps.push(oversizeFileGap(file, read.tooLarge));
      continue;
    }

    requestedFileSizes.set(file, read.source.length);
    parts.push(`### FILE: ${file} (full source)\n\`\`\`\n${read.source}\n\`\`\``);
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

  /**
   * A budget that is not a real number cannot be enforced against.
   *
   * `maxChars: NaN`, `-100`, `0` and `Infinity` all used to fall through the
   * `prompt.length > maxChars` test as false and return whatever the inputs
   * produced, so the declared contract — a cap on the prompt — was simply
   * absent (CTX-2). `Infinity` in particular reads as "no limit" and is
   * honoured as such; every other unusable value falls back to the default,
   * which is a real cap, so a typo produces a bounded prompt instead of an
   * unbounded one.
   */
  const effectiveMaxChars = Number.isFinite(maxChars) && maxChars >= 0
    ? maxChars
    : maxChars === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : DEFAULT_MAX_CHARS;

  /**
   * Drop requested files until the prompt fits, then say which ones went.
   *
   * Enforced by removal rather than by truncation. A truncated file is worse
   * than an absent one: the AI receives half a source file with no marker where
   * it stops, so it reads the end of the file as if it were the end of the
   * logic and confidently reasons about code that is not there (SPEC R9). A
   * missing file is a fact the prompt states plainly.
   *
   * Whole-file attachments go first and largest-first, because they are the
   * discretionary ones — a slice or an outline is what the compiler chose, and
   * keeping it is usually still useful. Only if dropping every one of them is
   * not enough does the prompt stay over budget, and then the gap says so
   * rather than the cap being silently violated (D33: `fullChars` is not
   * guaranteed to exceed `chars`, and neither is `chars` guaranteed to be under
   * `maxChars` — but a violation is always reported, never hidden).
   */
  const droppable = parts
    .map((text, index) => ({ text, index }))
    .filter(({ index }) => fullRequested.has(sections[index]?.file ?? ''))
    .sort((a, b) => b.text.length - a.text.length);

  const dropped: string[] = [];
  const removed = new Set<number>();
  let budget = effectiveMaxChars;

  const render = (): string =>
    buildPrompt({
      gameName,
      engine,
      issue,
      logs,
      requestedFiles: requestedList,
      body:
        parts
          .filter((_, index) => !removed.has(index))
          .join('\n\n') || '(No files could be attached — see the gaps below.)',
      gaps,
    });

  let prompt = render();
  for (const { text, index } of droppable) {
    if (prompt.length <= budget) break;
    removed.add(index);
    dropped.push(sections[index]?.file ?? 'a requested file');
    budget -= text.length;
    prompt = render();
  }

  if (dropped.length > 0) {
    gaps.push(
      `Dropped ${dropped.length} requested file(s) to fit the ${effectiveMaxChars}-character budget: ` +
        `${dropped.join(', ')}. Ask for a narrower region of any of them — a function name or a line ` +
        `number — and it will be attached as a slice.`,
    );
  }

  const fullPrompt = buildPrompt({
    gameName,
    engine,
    issue,
    logs,
    requestedFiles: requestedList,
    body: buildFullBody(projectRoot, ranked),
    gaps,
  });

  // The budget is now enforced by the drop loop above, so reaching here means the
  // prompt still exceeds it with every droppable section already gone. Reported,
  // never hidden — but the sentence says so plainly rather than implying the cap
  // was met.
  if (prompt.length > effectiveMaxChars) {
    // The floor: the prompt's mandatory parts — the opening line, the "FILE
    // CONTEXT" wrapper and the SURGICAL PATCH CONTRACT — are around 1,900
    // characters and cannot be dropped. A budget below that is not a request for
    // a smaller prompt, it is a request for a different prompt, and the only two
    // available answers are to ship a contract-less prompt (every patch would
    // then fail to apply) or to say the request is impossible.
    //
    // So the floor is NAMED rather than quietly violated. `chars` may exceed
    // `maxChars` in exactly this one case, and the gap says why (D33).
    const floor = buildPrompt({
      gameName,
      engine,
      issue,
      logs,
      requestedFiles: requestedList,
      body: '(No files could be attached — see the gaps below.)',
      gaps,
    }).length;
    const requestedAttached = sections.filter((s) => fullRequested.has(s.file));
    let budgetWarning = `Prompt is ${prompt.length} characters, over the ${effectiveMaxChars} budget.`;
    // Unconditional, and not conditioned on `dropped`: the floor applies whenever
    // the prompt is over budget with nothing left to drop, whether the files went
    // via the drop loop or were already refused by the per-file size gate. In the
    // second case `dropped` is empty and a conditional sentence would stay silent
    // about a limit that genuinely cannot be met.
    budgetWarning +=
      ` The prompt's own required parts — the opening, the patch contract and the NOT ` +
      `ATTACHED block — are ${floor} characters on their own, so no budget below ${floor} ` +
      `can be met; this is that floor, not a missed cap.`;
    if (dropped.length > 0) {
      budgetWarning += ` Every requested file was dropped and it is still over.`;
    }
    if (requestedAttached.length > 0) {
      const details = requestedAttached
        .map((s) => `${s.file} (${requestedFileSizes.get(s.file) ?? 0} chars)`)
        .join(', ');
      budgetWarning += ` Files attached because they were requested: ${details}.`;
    }
    budgetWarning += ' Re-run with a target line, or fewer ranked files.';
    gaps.push(budgetWarning);
    // The gap was added after the prompt was rendered, so it is not yet IN the
    // prompt. D30: a gap the developer can see must also be in the text the AI
    // reads. Rebuild once so the AI is told the same thing the screen shows.
    prompt = render();
  }

  return {
    prompt,
    ranked,
    sections: sections.filter((_, index) => !removed.has(index)),
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
 *
 * Returns null when the file is over {@link MAX_FULL_FILE_CHARS} and was asked
 * for in full — the caller records the refusal as a gap. Null rather than a
 * throw, because `compileContext` never throws for a file it cannot show.
 */
function buildTargetSection(
  projectRoot: string,
  file: string,
  line: number | null,
  query: string,
  fullFiles: boolean,
  gaps: string[],
  forceFull = false,
): BuiltSection | null {
  const absolute = resolveInsideRootOrThrow(projectRoot, file).absolutePath;

  /**
   * Full attachment is size-gated before the read, and the gate is shared with
   * the `NEED:` loop. Falling back to the outline rather than refusing outright
   * would be wrong here: the caller asked for this specific file and silently
   * substituting its interface is the plausible-looking wrong answer this app
   * exists to prevent (SPEC R9).
   */
  if (fullFiles || forceFull) {
    const read = readForFullAttachment(absolute);
    if ('unreadable' in read) return null;
    if ('tooLarge' in read) {
      gaps.push(oversizeFileGap(file, read.tooLarge));
      return null;
    }
    return {
      text: `### FILE: ${file} (full source)\n\`\`\`\n${read.source}\n\`\`\``,
      section: { file, kind: 'full', reason: 'Whole file attached at the caller\'s request' },
    };
  }

  const source = readFileSync(absolute, 'utf-8');

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
  const source = readFileSync(resolveInsideRootOrThrow(projectRoot, file).absolutePath, 'utf-8');
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

  const existing = [...dependents]
    .filter((id) => resolveInsideRoot(projectRoot, id).ok)
    .sort();
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
    const inside = resolveInsideRoot(projectRoot, candidate.file);
    if (!inside.ok) continue;
    /**
     * Size-gated, for the same reason as the real read above.
     *
     * This body exists only to compute `fullChars` — a figure shown in the
     * Context screen as "what this would have cost". A file too large to attach
     * is skipped rather than read, so the *savings* number simply does not
     * count it. That is the right answer: the alternative is reading a 64 MB
     * file purely to render a comparison figure nobody will act on, which is
     * the same denial of service SEC-5 is about.
     */
    const read = readForFullAttachment(inside.value.absolutePath);
    if (!('source' in read)) continue;
    parts.push(
      `### FILE: ${candidate.file}\n\`\`\`\n${read.source}\n\`\`\``,
    );
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
  if (resolveInsideRoot(projectRoot, 'project.godot').ok) return 'Godot 4.x (GDScript)';

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

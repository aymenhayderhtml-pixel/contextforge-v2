/**
 * renderer/contextInsufficient.ts — detect an AI asking for more context.
 *
 * ## The loop this closes
 *
 * Core's prompt ends with the contract block, whose sixth rule tells the model
 * that if it cannot see enough it must reply `CONTEXT INSUFFICIENT: …` and stop
 * rather than guess an API. This module is the other half of that sentence: it
 * reads the reply, works out what was asked for, and the Context screen feeds
 * those paths back into `compileContext` and asks again.
 *
 * A wrong guess here is expensive in a specific way. An AI that names a file it
 * could not see, and gets a confident patch back, ships a broken build — and a
 * `CONTEXT INSUFFICIENT` the app failed to notice is the cheapest failure in the
 * whole product to prevent, because the AI already did the work of telling us.
 *
 * ## Why a bounded pattern is the right tool here
 *
 * SPEC R5 says never use a regular expression to decide what code *means*. This
 * is not that. The subject is **prose an AI wrote**, and the question is purely
 * lexical: did a line begin with this exact phrase, a colon, and at least one
 * character after it? Nothing about how any code works, what a symbol means, or
 * whether a path is the *right* path is decided here — the pattern only recovers
 * text that was already written in a form the prompt specified. That is the case
 * R5 explicitly permits, and it is why the pattern below is tight and explained
 * rather than clever.
 *
 * ## Why `missing` exists
 *
 * A path that does not exist is *reported*, never dropped. An AI asking for
 * `src/nope.js` is either wrong about the layout or the developer renamed
 * something; either way, silently ignoring it produces a recompiled prompt
 * missing exactly the thing that was asked for — which is the failure this whole
 * mechanism exists to prevent. So the caller gets the path back, says so, and a
 * human decides.
 *
 * ## Purity
 *
 * Every function here is pure: no filesystem, no store, no clock, no renderer.
 * Existence is a caller-supplied predicate, so a test drives the detector with
 * no Electron, no project and no browser — and the renderer cannot reach the
 * filesystem even if it wanted to, since a renderer may not (SPEC).
 */

import type { ContextInsufficient } from '../ipc.js';

/**
 * The marker, anchored to the start of a line.
 *
 * `^` with the `m` flag is what keeps this honest. A model quoting the rule
 * back — "in that case you reply CONTEXT INSUFFICIENT: <path>" in the middle of
 * an explanation — has not asked for anything, and treating that as a request
 * would attach files on the strength of prose *about* the protocol rather than a
 * request *in* it. A request is always on its own line.
 *
 * The leading character class absorbs the markers Markdown puts in front of a
 * quoted line (`- `, `> `, `* `) so a bulleted refusal is still a refusal.
 *
 * `\s*` before the colon absorbs `INSUFFICIENT :` and a run of spaces, which
 * models do produce. `(.+)` requires at least one character after the colon, so
 * a bare `CONTEXT INSUFFICIENT:` — the rule quoted with nothing requested — is
 * not a detection. `i` is case-insensitive because the contract block upper-cases
 * the phrase and models lower-case it about as often.
 */
const MARKER_SOURCE = '^[ \\t>*_-]*(?:context insufficient|need)[ \\t]*:(.+)$';

/** Hard separators between list items in prose. */
const ITEM_SEPARATORS = /[,\n;]+/;

/** The contract's own "Need" word, which is not part of the request. */
const LEADING_NEED = /^\s*need(?:ed|s)?\b\s*/i;

/** The dash the contract uses between a path and the reason for wanting it. */
const REASON_DASH = /\s+[—–-]\s+[\s\S]*$/;

/** A trailing clause introduced by "and", used to split two file paths. */
const AND_JOINED = /^(.+) and (.+)$/;

/**
 * Split one match's payload into individual requests.
 *
 * The contract's example is `CONTEXT INSUFFICIENT: Need <file path> — <what you
 * need from it>`, so a single line can carry a path *and* a sentence. The dash is
 * the boundary the format itself uses, so it is honoured: everything after an
 * em/en dash is the reason, not another file. A leading `Need` is dropped because
 * it is the contract's word.
 *
 * Anything that is not obviously a path is **kept** as a request rather than
 * discarded — "the update loop" is a legitimate answer to "what do you need", and
 * dropping it would silently narrow what the developer is told the AI asked for.
 * Which requests name a real file is `findMissingRequests`' job, not this one's.
 */
function splitRequests(payload: string): string[] {
  const afterDash = payload.replace(REASON_DASH, '');
  const withoutLead = afterDash.replace(LEADING_NEED, '');

  const items = withoutLead
    .split(ITEM_SEPARATORS)
    .map(clean)
    .filter((item) => item !== '');

  if (items.length === 0) {
    const only = clean(afterDash);
    return only === '' ? [] : [only];
  }

  // `src/a.js and src/b.js` is one clause naming two files. Only split it when
  // both halves are paths: a bare `and` in prose is a conjunction, and
  // "the update loop and the renderer" is one thing the AI asked for.
  const requests: string[] = [];
  for (const item of items) {
    const joined = AND_JOINED.exec(item);
    if (joined !== null && joined[1] !== undefined && joined[2] !== undefined) {
      const left = clean(joined[1]);
      const right = clean(joined[2]);
      if (looksLikePath(left) && looksLikePath(right)) {
        requests.push(left, right);
        continue;
      }
    }
    requests.push(item);
  }

  return requests;
}

/** Strip wrapping quotes, brackets and emphasis a model may have put around a path. */
function clean(item: string): string {
  return item
    .replace(/^[\s"'`*[\]()]+/, '')
    .replace(/[\s"'`*.,:[\]()]+$/, '')
    .trim();
}

/**
 * The extensions that name a source file in a project of either engine.
 *
 * Mirrors core's `extractFileReferences` set rather than inventing one: the
 * ranker already decided what counts as a path in this codebase, and a second
 * list would drift from it without anything noticing.
 */
const SOURCE_EXTENSIONS = new Set([
  'gd', 'js', 'ts', 'tsx', 'jsx', 'mjs', 'html', 'tscn', 'json', 'tres',
]);

/**
 * Does this request name a file, rather than describe one?
 *
 * Narrow on purpose: a request with any whitespace in it is prose, and a
 * sentence containing a period is not a path. Anything looser would put prose
 * into `missing` beside a real finding, which is worse than missing one — the
 * whole point of `missing` is that a developer can act on every entry in it.
 */
function looksLikePath(request: string): boolean {
  const trimmed = request.trim();
  if (trimmed === '' || /\s/.test(trimmed)) return false;

  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot <= 0) return false;

  const extension = trimmed.slice(lastDot + 1).toLowerCase();
  if (!/^[a-z0-9]+$/.test(extension)) return false;

  return SOURCE_EXTENSIONS.has(extension) || trimmed.includes('/') || trimmed.startsWith('res://');
}

/**
 * Find every `CONTEXT INSUFFICIENT:` request in an AI reply.
 *
 * Pure and renderer-free: pass the reply text, get back what was asked for.
 * `missing` is always empty here — existence is a question about the developer's
 * disk, so it is asked separately and deliberately.
 */
export function detectContextInsufficient(reply: string): ContextInsufficient {
  // A fresh regex per call rather than a module-level `g` regex: `matchAll` on a
  // shared one leaves `lastIndex` state that makes a second call disagree with
  // the first, and recompiling calls this repeatedly.
  const matches = [...reply.matchAll(new RegExp(MARKER_SOURCE, 'gim'))];

  const requested: string[] = [];
  for (const match of matches) {
    const payload = match[1];
    if (payload === undefined) continue;
    for (const request of splitRequests(payload)) {
      // Deduped in first-seen order: an AI repeating itself must not produce
      // three identical attachments, and the order it asked in is the order the
      // developer reads them in.
      if (!requested.includes(request)) requested.push(request);
    }
  }

  return { detected: requested.length > 0, requested, missing: [] };
}

/**
 * Report which requests name a file that does not exist.
 *
 * `exists` is a predicate rather than a path because **the renderer has no
 * filesystem** — `contextIsolation` is on and Node is not in the renderer, so it
 * could not check even if it wanted to. The main process is the only thing that
 * can look at the disk. The Context screen passes a predicate built from the
 * `sections` of the last compiled response: a path is "there" exactly when core
 * put it in the prompt, which is the question being asked. That is why this is a
 * parameter — the existence question stays the caller's, and this stays pure.
 *
 * Only path-shaped requests are checked. A request that is a description is left
 * out of *both* lists — `requested` still carries it for the developer to read,
 * and inventing an existence verdict about prose would be a guess.
 *
 * A predicate that throws counts as "not found" for that one item and nothing
 * else: one unreachable path must not cost the developer the whole detection.
 */
export function findMissingRequests(
  requests: readonly string[],
  exists: (file: string) => boolean,
): string[] {
  const missing: string[] = [];
  for (const request of requests) {
    if (!looksLikePath(request)) continue;
    let present: boolean;
    try {
      present = exists(request);
    } catch {
      present = false;
    }
    if (!present) missing.push(request);
  }
  return missing;
}
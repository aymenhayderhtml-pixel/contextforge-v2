/**
 * fs/resolveInsideRoot.ts — the one place a path is allowed to become a file.
 *
 * ## Why this exists
 *
 * Every writer and every reader in core used to do its own containment check,
 * and every one of those checks was **lexical**: reject `..`, strip a leading
 * `/`, then `join(root, path)` and trust the result. Lexical checks are
 * necessary and they are not sufficient, because the filesystem is not lexical.
 * A directory inside the project can be a **symlink** to somewhere else, and
 * then every lexical check passes while the bytes land outside. The audit found
 * four independent instances of exactly that (PATCH-2, SEC-3, NEW-1, NEW-4).
 *
 * The fix is not a fifth lexical check. It is one function that asks the
 * filesystem where the path *actually* goes, and one call site that trusts its
 * answer.
 *
 * ## The rule
 *
 * Resolve `root` through `realpathSync` once. Resolve the target through
 * `realpathSync` too — but only its **nearest existing ancestor**, because the
 * point of a `### FILE:` block is to create a file that does not exist yet. The
 * remaining segments are appended to that real path, which is sound: a path that
 * does not exist cannot be a symlink, so only its existing prefix can redirect
 * it, and the prefix has been resolved for real.
 *
 * Then the resolved absolute path must be the root itself or sit under it.
 * Anything else is refused, with a sentence naming the path and the place it
 * actually pointed to.
 *
 * ## Why the result is a discriminated union and never an errno
 *
 * Three separate callers were, at the time of writing, in the business of
 * reporting "ENOENT" to a developer. An errno says *what the syscall complained
 * about*; it never says *which path*, and it is silent about the security
 * decision that was actually taken. So the failure arm carries a complete
 * sentence and the success arm carries the two paths a caller needs to go on
 * with — the project-relative one to display, and the absolute one to open.
 */

import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Why a path was refused.
 *
 * These are the *reasons*, not the errors. Each one is a property of the path
 * that was asked for, decided before the filesystem is consulted.
 */
export type ContainmentRefusal =
  /** Empty, or a path made only of `.`/empty segments. */
  | 'empty_path'
  /** A NUL byte. `node:fs` throws on it, which is a crash, not an answer. */
  | 'null_byte'
  /** `..` as a segment: traversal, refused by name before anything is opened. */
  | 'traversal'
  /** The path was absolute. */
  | 'absolute_path'
  /** The project root itself is not a directory on disk. */
  | 'root_missing'
  /** Nothing along the way exists, so containment cannot be decided. */
  | 'no_existing_ancestor'
  /**
   * The path — or a directory on the way to it — is a symlink that leaves the
   * root. This is the case every lexical check misses.
   */
  | 'symlink_escape'
  /** Resolved outside the root without any symlink involved (`..` that lands out). */
  | 'outside_root';

/** One path inside a project, in both spellings. */
export interface ResolvedInsideRoot {
  /**
   * The path as the project spells it, `\` normalised to `/` and no leading
   * `./`. This is what goes in a diff header, a scene file or a `NEED:` list,
   * and it is what a developer is shown.
   */
  readonly relativePath: string;
  /** The absolute path to open. Symlinks have been resolved. */
  readonly absolutePath: string;
  /** `realpathSync(root)`. Useful when a caller has several paths to compare. */
  readonly realRoot: string;
  /**
   * Is there a file at `absolutePath` right now?
   *
   * **Separate from `ok`, and callers need both.** `ok: true` means the path is
   * inside the project — which is true for a `### FILE:` target that does not
   * exist yet, and for every path `generateProject` is about to create. Whether
   * the file is *there* is a different question, and a caller that assumed `ok`
   * answered it produced `ENOENT` escapes out of the context compiler, which is
   * the crash this field exists to prevent.
   */
  readonly existsOnDisk: boolean;
}

/** The verdict: either the path, or a sentence a developer can act on. */
/**
 * `allowMissingRoot` is for `generateProject` and nothing else.
 *
 * A project root that does not exist yet cannot be a symlink, so there is nothing
 * for it to redirect through; every path *under* it is still checked. The patch
 * engine, the context compiler and the history stack never pass it, because an open
 * project always has a directory — and a caller that passes it for a root that
 * *should* exist turns a clear refusal into a write to wherever the root has since
 * been pointed.
 */
export interface ResolveOptions {
  allowMissingRoot?: boolean;
}

export type ResolveInsideRootResult =
  | { readonly ok: true; readonly value: ResolvedInsideRoot }
  | {
      readonly ok: false;
      /** Complete sentence (SPEC R9). Names the path and the reason. */
      readonly reason: string;
      /** The path that was asked for, exactly as it was given. */
      readonly path: string;
      /** Which rule refused it. For tests and for callers that branch. */
      readonly refusal: ContainmentRefusal;
    };

/** `resolve()` root, `realpathSync`'d, memoised per root string. */
const realRootCache = new Map<string, string>();

/**
 * `realpathSync(root)`, memoised.
 *
 * A project root is asked about once per path per operation, and the patch
 * preview resolves dozens against one root in a single copy of the tree. The
 * cache is keyed on the literal string, so a caller that passes two spellings
 * of the same root pays for both — which is correctness, not a bug: the two
 * spellings can resolve to different directories if one of them is a symlink.
 *
 * Only successes are cached. A root that does not exist yet must be able to
 * start existing without the process being restarted.
 */
function realRootOf(root: string, allowMissing = false): string | null {
  const cached = realRootCache.get(root);
  if (cached !== undefined) return cached;

  let resolved: string;
  try {
    resolved = realpathSync(root);
  } catch {
    if (!allowMissing) return null;
    /**
     * The root does not exist yet, and the caller has said that is expected.
     *
     * `generateProject` creates a project into a folder the developer has chosen
     * but which has not been made yet, so its first act is to write into a path
     * whose root is absent. Refusing there makes the generator unusable, and the
     * test that caught it was the honest one: *"Cannot generate a project in
     * /tmp/.../demo — the project folder does not exist."*
     *
     * Falling back to `resolve(root)` is safe **because the caller opted in** and
     * because a root that does not exist cannot be a symlink: there is nothing on
     * disk to redirect through. What still gets checked is every path *under* it,
     * which is where the containment property actually lives. Only the generator
     * passes `true`; the patch engine, the compiler and history never do, because
     * an open project always has a directory.
     *
     * Not cached, because the root may be created moments later and the cached
     * lexical value would then hide a symlink swapped in its place.
     */
    return resolve(root);
  }
  realRootCache.set(root, resolved);
  return resolved;
}

/**
 * Forget a memoised root.
 *
 * Called when a project is closed. Without it a long-lived main process would
 * keep one string per project it ever opened, and — worse — would keep
 * answering for a root the developer has since deleted and recreated at a
 * different inode.
 */
export function forgetRoot(root: string): void {
  realRootCache.delete(root);
}

/**
 * How far along `absolute` the path is accounted for, and why it stops there.
 *
 * `anchor` is a real directory and `actualAnchor` is where the filesystem says
 * that directory really is. `residual` is the part of the original path below
 * `anchor`, re-appended unchanged: a segment that does not exist on disk cannot
 * be a symlink, so it needs no resolution — which is exactly what makes a
 * `### FILE:` block that creates a new file work.
 */
interface Anchor {
  anchor: string;
  actualAnchor: string;
  residual: string;
  /** True when the anchor on disk is not the anchor we asked about. */
  viaSymlink: boolean;
}

/**
 * Split `absolute` at its nearest existing directory and resolve that half for
 * real. `null` when even the filesystem root is unreachable.
 *
 * `lstat`, not `stat`, and the difference is the whole of NEW-1: a **dangling**
 * symlink fails `statSync` with `ENOENT` (it follows the link, and there is
 * nothing there) but is perfectly visible to `lstatSync`. Walking up from a
 * dangling link and stopping at its parent would report "inside the project,
 * perfectly safe" for a path that is a link out of it. So when `statSync` fails
 * the code asks `lstatSync` about the same path: if it is a link, the link
 * *itself* is the answer and the walk stops there.
 */
function resolveAnchor(absolute: string, realRoot: string): Anchor | null {
  /**
   * The walk starts at the target's **parent**, never at the target.
   *
   * The anchor must be a strict ancestor for `relative(absolute, current)` to be
   * a forward path. Anchoring on the target itself is only ever right when the
   * target is a directory, and `### FILE:` targets are files — so starting at the
   * target produced a residual of `..` for every ordinary file.
   */
  let current = dirname(absolute);
  for (;;) {
    try {
      if (statSync(current).isDirectory()) {
        return {
          anchor: current,
          actualAnchor: realpathSync(current),
          /**
           * Measured from the anchor itself, which is safe **because the walk
           * starts at the target's parent**: `current` is then always a strict
           * ancestor of `absolute`, so `relative` never yields a leading `..`.
           *
           * Measured from the anchor **to** the target, not the other way round.
           *
           * The direction is the whole function and three versions got it wrong:
           *
           * - `relative(absolute, current)` — anchor to target reversed — gives
           *   `..` for every file, because a file's parent is its anchor, and
           *   `resolve` then walks back out of the project. Every legitimate path
           *   was refused.
           * - `relative(absolute, dirname(current))` overshoots: for a top-level
           *   file the anchor is the root, `dirname(root)` is the root's *parent*,
           *   and the residual becomes `../..`, resolving to `/`.
           * - This direction — `relative(anchor, target)` — is the forward path and
           *   is `'plain.txt'` or `'deep/f.txt'`, never `..`.
           */
          residual: relative(current, absolute),
          viaSymlink: realpathSync(current) !== current,
        };
      }
    } catch {
      // Not there, or not a directory. Before walking up, ask whether it is a
      // symlink whose target is missing — a dangling link is exactly the thing
      // `existsSync` cannot see and `writeFileSync` writes through.
      try {
        if (lstatSync(current).isSymbolicLink()) {
          const target = realpathSync(current);
          return {
            anchor: current,
            actualAnchor: target,
            residual: relative(absolute, dirname(current)),
            viaSymlink: true,
          };
        }
      } catch {
        // A symlink loop (ELOOP) or a permission error: also not resolvable, and
        // stopping here means the containment check below refuses it.
        if (isSymlink(current)) {
          return {
            anchor: current,
            actualAnchor: join(realRoot, '__unresolvable_symlink__'),
            residual: relative(absolute, dirname(current)),
            viaSymlink: true,
          };
        }
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** `realpathSync` that returns null instead of throwing on a broken link or loop. */
function safeRealpath(absolute: string): string | null {
  try {
    return realpathSync(absolute);
  } catch {
    return null;
  }
}

/** Is there a readable file (not a directory) at this path, without throwing? */
function fileExists(absolute: string): boolean {
  try {
    return statSync(absolute).isFile();
  } catch {
    return false;
  }
}

/** Is this path a symlink, without following it and without throwing? */
function isSymlink(absolute: string): boolean {
  try {
    return lstatSync(absolute).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `candidate` is the root itself, or sits under it. Both are already real. */
function isUnder(realRoot: string, candidate: string): boolean {
  return candidate === realRoot || candidate.startsWith(realRoot + sep);
}

/**
 * Resolve `relPath` against `root` and refuse anything that leaves it.
 *
 * The one function every reader and writer in core routes a project-relative
 * path through. It does not throw: the callers are UI handlers and patch
 * engines whose contract is to report a refusal as a sentence (SPEC R9), and a
 * throw here would just move the try/catch around without improving the message.
 *
 * Order of checks is deliberate and is the security property:
 *
 *  1. **Lexical, before touching the filesystem.** An empty path, a NUL byte and
 *     a `..` segment are refused by name. `..` is refused even when it would
 *     land back inside the root (`a/../b`), because a path that needs a
 *     traversal to name a file in its own project is not a path worth guessing
 *     at, and refusing is what `ipc.ts` promises the renderer.
 *  2. **The root must be real.** `realpathSync(root)` — so a project opened
 *     through a symlinked folder is compared by where it actually *is*.
 *  3. **The nearest existing ancestor of the target is resolved for real.** This
 *     is the step a lexical check cannot do: a symlink anywhere along the way
 *     moves the resolved path, and the comparison below catches it.
 *  4. **Containment.** The real, resolved absolute path must be the root or
 *     under it.
 *
 * An **absolute** `relPath` is refused rather than normalised. `join(root,
 * '/etc/passwd')` happens to produce `root/etc/passwd`, so an absolute path is
 * inert *in the places that use `join`* — but `resolve` and `readFile` do not
 * `join`, and a helper whose safety depends on every caller having chosen the
 * right one of two functions is not a helper. Measured, recorded in D51.
 */
export function resolveInsideRoot(
  root: string,
  relPath: string,
  options: ResolveOptions = {},
): ResolveInsideRootResult {
  const path = typeof relPath === 'string' ? relPath : String(relPath ?? '');
  const asked = path;

  if (path.includes('\0')) return refuse(asked, 'null_byte', pathSentence(asked, 'contains a NUL byte'));

  const normalized = path.replaceAll('\\', '/').trim();
  if (normalized === '') return refuse(asked, 'empty_path', pathSentence(asked, 'is not a path'));

  if (isAbsolute(path) || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')) {
    return refuse(
      asked,
      'absolute_path',
      pathSentence(asked, 'is an absolute path. Paths in a project are written relative to its root'),
    );
  }

  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      return refuse(
        asked,
        'traversal',
        pathSentence(asked, 'climbs out of the project with ".."'),
      );
    }
    segments.push(segment);
  }
  if (segments.length === 0) return refuse(asked, 'empty_path', pathSentence(asked, 'is not a path'));

  const realRoot = realRootOf(root, options.allowMissingRoot === true);
  if (realRoot === null) {
    return refuse(
      asked,
      'root_missing',
      `Cannot use "${asked}": the project folder ${root} does not exist.`,
    );
  }

  const relativePath = segments.join('/');
  const lexical = resolve(realRoot, relativePath);

  // Resolve the deepest part of the path that exists. Anything below it is new
  // by definition and cannot be a symlink — unless it is a *dangling* link, and
  // `resolveAnchor` is written to stop at one of those rather than walk past it.
  const anchor = resolveAnchor(lexical, realRoot);
  if (anchor === null) {
    return refuse(
      asked,
      'no_existing_ancestor',
      pathSentence(asked, 'has no folder on disk that could be resolved'),
    );
  }

  // `actualAnchor` is the filesystem's own answer to "where does this path
  // actually go" for every segment that exists. The rest is re-appended
  // verbatim, because it does not exist yet and so cannot redirect anything.
  const absolutePath = resolve(anchor.actualAnchor, anchor.residual);

  if (!isUnder(realRoot, absolutePath)) {
    return refuse(
      asked,
      anchor.viaSymlink ? 'symlink_escape' : 'outside_root',
      pathSentence(asked, 'resolves outside the project', absolutePath),
    );
  }

  /**
   * The final component is checked on its own, and this is not redundant with the
   * anchor walk.
   *
   * `resolveAnchor` starts at the target's **parent**, so it can only see
   * symlinks among the *directories* above the target. When the target itself is a
   * symlink — `src/link.txt` pointing at `/outside/secret.txt` — the walk never
   * looks at it, `absolutePath` keeps the link, and the caller opens a file
   * outside the project. `existsOnDisk` then reports true, because following the
   * link finds a real file.
   *
   * So: if the target exists, resolve it through `realpath` and re-check. That
   * catches the case the directory walk structurally cannot.
   */
  const realTarget = fileExists(absolutePath) ? safeRealpath(absolutePath) : absolutePath;
  if (realTarget !== null && !isUnder(realRoot, realTarget)) {
    return refuse(
      asked,
      'symlink_escape',
      pathSentence(asked, 'resolves outside the project', realTarget),
    );
  }

  return {
    ok: true,
    value: {
      relativePath,
      absolutePath: realTarget ?? absolutePath,
      realRoot,
      // `statSync` so a directory is not reported as a readable file. A symlink
      // that resolves has already been followed by `resolveAnchor`.
      existsOnDisk: fileExists(absolutePath),
    },
  };
}

/** The one sentence shape every refusal uses. Ends in a full stop (SPEC R9). */
function pathSentence(path: string, what: string, actual?: string): string {
  const base = `"${path}" ${what}.`;
  if (actual === undefined) return base;
  return `"${path}" ${what} (${actual}).`;
}

function refuse(
  path: string,
  refusal: ContainmentRefusal,
  reason: string,
): ResolveInsideRootResult {
  return { ok: false, path, refusal, reason };
}

/**
 * `resolveInsideRoot`, or a thrown sentence.
 *
 * For the callers that genuinely cannot continue — the patch engines, which
 * already throw on an unusable path and whose refusal the IPC wrapper turns
 * into a sentence anyway. Every such caller is a place where "refuse" and
 * "return a verdict" mean the same thing, so this keeps one message rather than
 * two that could drift apart.
 *
 * The error carries `path` and `refusal` on it, so a caller that *can* report
 * the refusal as a result still has the machine-readable half.
 */
export function resolveInsideRootOrThrow(
  root: string,
  relPath: string,
  options?: ResolveOptions,
): ResolvedInsideRoot {
  const result = resolveInsideRoot(root, relPath, options);
  if (result.ok) return result.value;

  const error = new Error(result.reason) as Error & { path: string; refusal: ContainmentRefusal };
  error.path = result.path;
  error.refusal = result.refusal;
  throw error;
}

/**
 * Is `relPath` inside `root`?
 *
 * The boolean form of `resolveInsideRoot`, for a caller that has a better
 * sentence of its own to say (the app's `compileContext` names the tick box the
 * developer should have used). It still *delegates* — there is no second
 * implementation of containment to drift out of step with the first, which was
 * the whole point of the refactor.
 */
export function isInsideRoot(root: string, relPath: string): boolean {
  return resolveInsideRoot(root, relPath).ok;
}
/**
 * electron/ipcHandlers.ts — the main-process side of the IPC contract.
 *
 * This is where the disk actually is. The renderer has no Node (`contextIsolation`
 * is on and `nodeIntegration` is off — see `main.ts`), so every read, every write
 * and every watcher lives here, and the renderer sends named requests.
 *
 * ## The two rules this file is shaped by
 *
 * 1. **Nothing throws across IPC.** Every handler returns a `Result`. A rejected
 *    promise in the renderer arrives as an unhandled rejection carrying a message
 *    written for a stack trace, not for a developer looking at a screen. So the
 *    only way a handler reports failure is `{ ok: false, reason }`, and `reason`
 *    is a sentence that can be shown verbatim (SPEC R9).
 * 2. **One place owns the open project.** A single `AppBackend` holds one root,
 *    one scene, one prefab registry and one set of watchers. Two owners would
 *    mean two histories, and history is keyed by project path in core, so "which
 *    project's undo stack" is a question with exactly one correct answer.
 *
 * ## A project that is not ready
 *
 * Three states are all normal, and none of them is an error screen:
 *
 *  - **No scene file.** `loadScene` returns `null`. The project opens against an
 *    empty scene and the first edit creates the file.
 *  - **An invalid scene.** An AI has just written it. The app opens anyway, keeps
 *    the last state that *was* valid, and reports the validation errors — each
 *    naming its JSON path — in `SceneSnapshot.problems`.
 *  - **A prefab that throws.** Reported in `PrefabRegistryResult.failed`, one row
 *    per broken file, and the rest of the project still opens.
 *
 * In every case the developer gets a working window and a list of what is wrong,
 * which is the only outcome that lets them fix it.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  watch,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  applyEditBlocks,
  applySceneEdit,
  buildManifest,
  buildScaffoldPrompt,
  captureAndWrite,
  compileContext,
  emptyScene,
  edgesWithin,
  extractFileReferences,
  extractGodotProject,
  extractJsProject,
  findOrphans,
  focusNeighbourhood,
  formatUnifiedDiff,
  getHistoryStatus,
  generateBrief,
  normalizeProjectPath,
  parseEditBlocks,
  parseFileBlocks,
  readBrief,
  readFileOrNull,
  recordHistoryStep,
  redoSceneEdit,
  rankRelevantFiles,
  saveScene,
  scaffoldPromptProblems,
  sceneHistoryStatus,
  summariseGraph,
  undoSceneEdit,
  validateAllSyntax,
  validateBriefRequest,
  validateContentSyntax,
  validateScene,
  writeFileBlocks,
  type Manifest,
  type DependencyGraph,
  type FocusDepth,
  type FocusedNode,
  type GameBrief,
  type GraphEdge,
  type GraphNode,
  type GraphSummary,
  type HistoryActionResult,
  type MissingAsset,
  type Orphan,
  type SceneEdit,
  type SceneFile,
  type UnparseableFile,
} from '@contextforge/core';
import {
  CHANNELS,
  EVENTS,
  fail,
  ok,
  type CompiledPrompt,
  type EventPayloadFor,
  type EventName,
  type BriefMode,
  type BriefResult,
  type HistoryActionOutcome,
  type PatchApplyResult,
  type PatchBlockFailure,
  type PatchFilePreview,
  type PatchHistoryEntry,
  type PatchPreview,
  type PrefabRegistryResult,
  type ProjectInfo,
  type RankedFileRow,
  type Result,
  type SceneSnapshot,
} from '../ipc.js';
import { bundlePrefabsForBrowser, createPrefabLoader, type PrefabLoader } from './prefabLoader.js';

/**
 * How a file the developer ticked, or an AI asked for, is put in front of core's
 * ranker.
 *
 * ## Why a note in the log rather than a new option on the compiler
 *
 * `compileContext`'s `CompileOptions` has no `extraFiles`, and `compiler.ts` is
 * not this area's file to change. The one input core already knows how to read
 * paths out of is `logs` — that is precisely what `extractFileReferences` scans —
 * so an attachment request is expressed in the shape core understands.
 *
 * Two properties of doing it this way are worth more than a new option would be:
 *
 *  - **The slicing is still core's.** Nothing here decides what goes into the
 *    prompt; the note only makes the file *rank*, and then `compileContext` reads
 *    it off disk with its own grammar-aware slicer, exactly as if a stack trace
 *    had named it (SPEC: do not reimplement the slicing in the main process).
 *  - **The error origin cannot be displaced.** The note is *appended* to the
 *    developer's log, so `extractFileReferences` numbers the real trace first and
 *    the attachment last. A ticked file can therefore never take score 100 and
 *    become the target — which is the file the developer least wants lost, and
 *    the one an uncareful "extra file becomes the target" implementation drops.
 *
 * The line is written as a note about a *request* rather than as a claim of
 * attachment, and that wording is load-bearing twice over. It appears in the
 * `RUNTIME OUTPUT:` block the prompt echoes, so "was attached" would be a false
 * claim in front of the AI for a path that does not exist — and the AI is told
 * not to assume the contents of anything it was not shown. A request is also the
 * truthful thing to say about a file the developer ticked, which exists.


/**
 * Is this path inside the open project?
 *
 * `isAbsolute` and a leading `..` are refused by name, the same two cases core's
 * patch path normaliser refuses. A path that is relative, has no `..` segment and
 * normalises to something still under the root is inside it. `resolve` collapses
 * `.` segments, so `./src/a.js` and `src/a.js` are the same file and both pass.
 */
function isInsideProject(root: string, file: string): boolean {
  const candidate = file.trim();
  if (candidate === '') return false;
  if (isAbsolute(candidate)) return false;

  const absolute = resolve(root, candidate);
  return absolute === root || absolute.startsWith(root + sep);
}

// ── Watching ────────────────────────────────────────────────────────────────

/**
 * How long to wait after the last filesystem event before reporting a change.
 *
 * A save is rarely one write. A tool that rewrites a scene file may truncate,
 * write and rename, which the OS reports as two or three events; reporting each
 * one would send the renderer three reloads and show the developer the same
 * message three times. 150ms swallows a multi-write save and still feels
 * immediate to a human pressing Ctrl+S in another editor.
 */
export const WATCH_DEBOUNCE_MS = 150;

/** Collapse a burst of calls into one, `ms` after the last of them. */
interface Debouncer {
  schedule(): void;
  cancel(): void;
}

/**
 * Build a debouncer over `fn`.
 *
 * The timer is `unref`'d where the runtime supports it so a pending debounce
 * cannot keep the process alive: closing a project inside the debounce window
 * should release the window immediately, not 150ms later.
 */
function makeDebouncer(fn: () => void, ms: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    schedule(): void {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
      timer.unref?.();
    },
    cancel(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

// ── Locating things inside a project ────────────────────────────────────────

/** Where a scene file was found. */
interface SceneLocation {
  /** Project-relative, posix-separated. What `ProjectInfo.scenePath` reports. */
  relativePath: string;
  absolutePath: string;
}

/** How deep to look under `scenes/` for a scene file, in directory levels. */
const SCENE_SEARCH_DEPTH = 4;

/**
 * Find the project's scene file.
 *
 * `scene.json` at the root wins, because that is what `generateProject` writes and
 * what the generated `loadScene.ts` reads. Otherwise the first `*.scene.json`
 * under `scenes/` **in sorted order** — sorted, not newest: which scene opens must
 * not depend on a modification time (SPEC R8).
 *
 * `null` when the project has none, which is a state the app opens in rather than
 * refuses.
 */
export function findSceneFile(root: string): SceneLocation | null {
  const direct = join(root, 'scene.json');
  if (existsSync(direct)) return { relativePath: 'scene.json', absolutePath: direct };

  const found = findSceneFilesUnder(join(root, 'scenes'), 0);
  const first = found[0];
  if (first === undefined) return null;
  return { relativePath: toPosix(relative(root, first)), absolutePath: first };
}

/** Every `*.scene.json` at or under `dir`, sorted, bounded by `depth`. */
function findSceneFilesUnder(dir: string, depth: number): string[] {
  if (depth > SCENE_SEARCH_DEPTH || !isDirectory(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    if (isDirectory(full)) {
      files.push(...findSceneFilesUnder(full, depth + 1));
    } else if (entry.endsWith('.scene.json')) {
      files.push(full);
    }
  }
  return files;
}

/** Native separators to posix, so a snapshot's paths read the same anywhere. */
function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/** True when the path exists and is a directory. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The folder name, used as the project's display name. */
function projectName(root: string): string {
  const name = basename(root);
  return name === '' ? root : name;
}

/**
 * Which engine the project targets.
 *
 * `project.godot` is the only unambiguous signal and is checked first. A Three.js
 * project has no such marker — it has a `package.json` and a `scene.json` — so the
 * scene's own `engine` field is the fallback and `three` is the last resort.
 * Getting this wrong costs a label in the title bar, which is why the guess is
 * stated as a guess rather than asserted.
 */
export function detectEngine(root: string, scene: SceneFile | null): 'three' | 'godot' {
  if (existsSync(join(root, 'project.godot'))) return 'godot';
  return scene?.engine ?? 'three';
}

// ── Reading a scene that may be broken ──────────────────────────────────────

/** A scene read from disk, plus what was wrong with it. */
export interface SceneRead {
  /** The scene to show. The last known-good one when the file is invalid. */
  scene: SceneFile;
  /** Validation errors, each naming a JSON path. Empty when the file is valid. */
  problems: string[];
  /** False when the file could not be read, parsed or validated. */
  valid: boolean;
  /** The file's exact text. Used to recognise our own writes; `null` if absent. */
  raw: string | null;
}

/**
 * Read a scene file without ever throwing.
 *
 * The fallback is the point: when the file on disk is invalid, the *previous*
 * scene is kept, so the viewport still shows the last thing that was real while
 * the developer is told what is now wrong. A brand new project has no previous
 * scene, so it gets `emptyScene` — an open, empty, valid project rather than an
 * error screen with no way back (SPEC R9).
 *
 * Problems are formatted `path: message` because that is both the form the
 * inspector parses to attach an error to a field and the form a developer can act
 * on without a lookup table.
 */
export function readSceneFile(absolutePath: string, fallback: SceneFile | null): SceneRead {
  if (!existsSync(absolutePath)) {
    return {
      scene: fallback ?? emptyScene('Level1', 0),
      problems: [
        `No scene file at ${absolutePath} — starting from an empty scene. ` +
          'The first edit will create the file.',
      ],
      valid: false,
      raw: null,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(absolutePath, 'utf-8');
  } catch (error) {
    return {
      scene: fallback ?? emptyScene('Level1', 0),
      problems: [`Could not read ${absolutePath}: ${describe(error)}`],
      valid: false,
      raw: null,
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return {
      scene: fallback ?? emptyScene('Level1', 0),
      problems: [`${absolutePath} is not valid JSON: ${describe(error)}`],
      valid: false,
      raw,
    };
  }

  const validation = validateScene(data);
  if (validation.valid && validation.data !== undefined) {
    return { scene: validation.data, problems: [], valid: true, raw };
  }

  return {
    scene: fallback ?? emptyScene('Level1', 0),
    problems: validation.errors.map((e) => `${absolutePath}: ${e.path}: ${e.message}`),
    valid: false,
    raw,
  };
}

/** Any thrown value as a sentence fragment. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Staging an AI reply against a scratch copy ───────────────────────────────

/**
 * Directories never copied into the scratch project.
 *
 * They are either enormous, or regenerated, or would make core's own extractors
 * walk a dependency tree instead of the developer's source. `node_modules` alone
 * is the difference between a preview that returns in milliseconds and one that
 * does not.
 */
const SCRATCH_SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  '.contextforge',
  '.cache',
]);

/**
 * One file a patch would write, in memory.
 *
 * `before` is `null` when the file does not exist yet, which is the same
 * convention core's history uses — and the reason undo deletes a file the patch
 * created rather than leaving an empty husk behind.
 */
interface StagedFile {
  path: string;
  before: string | null;
  after: string;
  changed: boolean;
  syntax: { valid: boolean; message: string; line: number | null };
}

/** Everything a paste resolves to, decided before anything real is written. */
interface PatchPlan {
  /** Every file the reply names, changed or not. Drives the per-file diffs. */
  files: StagedFile[];
  /** The files whose content actually differs from what is on disk. */
  changed: StagedFile[];
  failedBlocks: PatchBlockFailure[];
  alreadyApplied: number;
  blocksApplied: number;
  blockCount: number;
  /** The first syntax failure across the changed files, or `null`. */
  syntaxFailure: { path: string; message: string; line: number | null } | null;
  /** The final content of every changed file, keyed by project-relative path. */
  updates: Map<string, string>;
  created: string[];
}

/** Either a plan, or the sentence refusing to make one. */
type PlanOutcome = { ok: true; plan: PatchPlan } | { ok: false; reason: string };

/**
 * Copy a project into a scratch folder.
 *
 * ## Why the patch is decided against a copy at all
 *
 * Core's patch engine writes files as it goes — `writeFileBlocks` and
 * `applyEditBlocks` are both writers. That is the right shape for a tool whose
 * caller has already decided to commit, and the wrong one for a preview channel
 * and for an all-or-nothing apply that also has to survive a late failure.
 *
 * So both handlers here resolve the reply against a throwaway copy: core runs
 * exactly as designed, against a project that costs nothing if it goes wrong.
 * The real project is touched once, afterwards, by `captureAndWrite` — and only
 * for files the plan says will change. That is what makes "a preview writes
 * nothing" true by construction rather than by careful sequencing, and it is
 * also what lets `applyAnyway` skip core's own pre-check without also skipping
 * the real project's safety: the content came out of the copy, and the write is
 * still a plain in-memory map.
 */
function copyIntoScratch(root: string, scratch: string): void {
  const walk = (dir: string, relative: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relativePath = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SCRATCH_SKIPPED_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const destination = join(scratch, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(dir, entry.name), destination);
    }
  };
  walk(root, '');
}

/**
 * Make a thrown engine message safe to show as a sentence.
 *
 * Core's refusals are already sentences in prose ("Invalid file path in patch:
 * …"), but its *format* refusals are blocks of instructions ending in a
 * question or a fragment. R9 asks for a complete sentence, so the only change
 * here is a full stop — never a rewrite. A refusal the developer cannot read in
 * one go is a refusal they cannot act on.
 */
function asSentence(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === '') return 'The patch engine refused this reply without saying why.';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** What the plan should say when it cannot make one. */
function noProjectOpen(): { ok: false; reason: string } {
  return {
    ok: false,
    reason: 'No project is open, so there is nowhere to apply a patch. Open a project first.',
  };
}

/**
 * Resolve a pasted AI reply into what it *would* do. Writes nothing.
 *
 * Order matters and is not arbitrary: `### FILE:` blocks run first, then
 * `### EDIT:` blocks against the result. A reply that creates a file and then
 * edits it is one coherent request, and running them the other way round would
 * refuse the edit as "target file does not exist" — a failure caused by the
 * engine's own sequencing, not by anything the AI got wrong.
 *
 * Core's per-engine pre-check is switched off here (`preCheckSyntax: false`)
 * because it would refuse at the first bad file and stop, leaving the developer
 * with one syntax error instead of the full picture. The check that actually
 * gates the write is `validateAllSyntax` below, over the *final* content of every
 * file — the same ordering rule core itself documents, so a patch that
 * legitimately passes through invalid syntax on its way to valid syntax is not
 * refused mid-flight.
 *
 * `applyAnyway` does not change what is computed here — it is not a parameter —
 * only whether the caller acts on the syntax verdict. The content is identical
 * either way, so the diff a developer approved is the diff that gets written,
 * and there is no second code path for an override to disagree with.
 */
function planPatch(root: string, text: string): PlanOutcome {
  if (typeof text !== 'string' || text.trim() === '') {
    return {
      ok: false,
      reason:
        'Paste the AI\'s reply above first — a patch is made of "### FILE:" and "### EDIT:" blocks, ' +
        'and there is nothing here to read.',
    };
  }

  const fileBlocks = parseFileBlocks(text);
  const editBlocks = parseEditBlocks(text);
  if (fileBlocks.length === 0 && editBlocks.length === 0) {
    return {
      ok: false,
      reason:
        'This reply contains no patch blocks, so there is nothing to apply. ContextForge reads ' +
        'these two markers and nothing else:\n' +
        '### FILE: relative/path/to/file.ext\n' +
        '```\n<the whole file>\n```\n' +
        '### EDIT: relative/path/to/file.ext\n' +
        '<<<<<<< FIND\n<the exact snippet to replace>\n=======\n<the replacement>\n>>>>>>> REPLACE\n' +
        'Ask the AI to reformat its answer using those.',
    };
  }

  const scratch = mkdtempSync(join(tmpdir(), 'cf-patch-'));
  try {
    copyIntoScratch(root, scratch);

    // Core writes, and the only place it writes here is a directory created for
    // this plan. A throw is core's refusal — an unsafe path, or a project that
    // vanished between the check and the copy — and its sentence is the answer.
    let filePaths: string[] = [];
    if (fileBlocks.length > 0) {
      filePaths = writeFileBlocks(scratch, text, { preCheckSyntax: false }).files;
    }

    let editPaths: string[] = [];
    let failedBlocks: PatchBlockFailure[] = [];
    let alreadyApplied = 0;
    let blocksApplied = 0;
    if (editBlocks.length > 0) {
      const outcome = applyEditBlocks(scratch, text, { preCheckSyntax: false });
      editPaths = outcome.files;
      failedBlocks = outcome.failed.map((failure) => ({
        path: failure.path,
        index: failure.index,
        find: failure.find,
        reason: failure.reason,
      }));
      alreadyApplied = outcome.alreadyApplied.length;
      blocksApplied = outcome.applied.length;
    }

    // Every file the reply names, in the order the reply named it, de-duplicated
    // across the two block kinds so a file that is both written and edited is
    // one row rather than two diffs of different content.
    const named: string[] = [];
    for (const path of [...filePaths, ...editPaths, ...failedBlocks.map((f) => f.path)]) {
      if (!named.includes(path)) named.push(path);
    }

    const files: StagedFile[] = named.map((path) => {
      const before = readFileOrNull(root, path);
      // The scratch always has the file after the engines ran; an absent one means
      // the block produced nothing, which is reported by the diff being empty.
      const after = readFileOrNull(scratch, path) ?? before ?? '';
      const check = validateContentSyntax(path, after);
      return {
        path,
        before,
        after,
        changed: before !== after,
        syntax: {
          valid: check.valid,
          message: check.valid ? '' : check.message,
          line: check.valid ? null : check.line,
        },
      };
    });

    const changed = files.filter((file) => file.changed);
    const updates = new Map(changed.map((file) => [file.path, file.after] as const));
    const created = changed
      .filter((file) => file.before === null)
      .map((file) => file.path);

    // `validateAllSyntax` decides once, over the final content of everything that
    // would be written, so the verdict matches what actually lands on disk rather
    // than any intermediate state the patch passed through.
    const verdict = validateAllSyntax(
      changed.map((file) => ({ path: file.path, content: file.after })),
    );
    const syntaxFailure = verdict.valid
      ? null
      : { path: verdict.file, message: verdict.message, line: verdict.line };

    return {
      ok: true,
      plan: {
        files,
        changed,
        failedBlocks,
        alreadyApplied,
        blocksApplied,
        blockCount: fileBlocks.length + editBlocks.length,
        syntaxFailure,
        updates,
        created,
      },
    };
  } catch (error) {
    return { ok: false, reason: asSentence(describe(error)) };
  } finally {
    // The scratch is disposable by construction, so it is removed on every path
    // — including a refusal, where leaving it would leak a full copy of the
    // developer's source into the temp directory on every bad paste.
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Why a plan is not applicable, as one sentence a developer can act on.
 *
 * Ordered by what the developer must fix first: an unresolvable block names the
 * file, the block number and core's own reason; a syntax error names the file and
 * the line; and only then do the two "there is genuinely nothing to do" cases
 * appear, which read differently and must not be confused with a refusal.
 */
function blockedReasonFor(plan: PatchPlan): string {
  if (plan.failedBlocks.length > 0) {
    const first = plan.failedBlocks[0];
    const others = plan.failedBlocks.length - 1;
    const more = others > 0 ? ` (and ${others} more)` : '';
    const where = first === undefined ? '' : ` In "${first.path}" (edit block ${first.index}): `;
    return (
      `${plan.failedBlocks.length} of the ${plan.blockCount} blocks in this reply could not be ` +
      `resolved${more}, so nothing will be written.${where}${first?.reason ?? ''}`.trim()
    );
  }

  if (plan.syntaxFailure !== null) {
    const where = plan.syntaxFailure.line === null ? '' : ` (line ${plan.syntaxFailure.line})`;
    return (
      `Pre-save syntax check failed for "${plan.syntaxFailure.path}"${where}: ` +
      `${plan.syntaxFailure.message} Nothing was written.`
    );
  }

  if (plan.changed.length === 0 && plan.alreadyApplied > 0) {
    return (
      `All ${plan.alreadyApplied} block(s) in this reply are already present in the project. ` +
      'Nothing was written because there is nothing left to change.'
    );
  }

  if (plan.changed.length === 0) {
    return 'This reply names files whose content would not change. Nothing was written.';
  }

  return '';
}

/** Whether `canApplyAnyway` may be offered: only the syntax gate, never a block. */
function canApplyAnywayFor(plan: PatchPlan): boolean {
  return (
    plan.syntaxFailure !== null && plan.failedBlocks.length === 0 && plan.changed.length > 0
  );
}

/**
 * The undo label for one Apply.
 *
 * Names the files rather than the block count: what the developer is undoing is
 * "the four files the AI just rewrote", and a count of parse blocks is an
 * implementation detail they never saw.
 */
function describePatchStep(plan: PatchPlan): string {
  const files = plan.changed.map((file) => file.path);
  const shown = files.slice(0, 3).join(', ');
  const rest = files.length > 3 ? ` +${files.length - 3} more` : '';
  return `Patch: ${shown}${rest}`;
}

// ── The backend ─────────────────────────────────────────────────────────────

/** The subset of Electron's `IpcMain` this module uses. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: never[]) => unknown): void;
  removeHandler(channel: string): void;
}

/** The options `pickFolder` asks the OS dialog for. Only the one it uses. */
export interface OpenFolderOptions {
  properties: ['openDirectory'];
}

/** The two fields of Electron's `OpenDialogReturnValue` that carry meaning. */
export interface OpenFolderResult {
  /** True when the user dismissed the dialog rather than choosing a folder. */
  canceled: boolean;
  /** Chosen folders. Empty when `canceled`, which is a normal outcome. */
  filePaths: string[];
}

/**
 * The one piece of Electron this backend needs, as a shape rather than a type.
 *
 * Declared structurally instead of imported because importing `electron` at the
 * top of this file is what the whole arrangement exists to avoid: `main.ts` can
 * only construct the real dialog *after* `app.whenReady()`, so `AppBackend` is
 * built at module scope — before any window exists and before `dialog` is usable.
 * Injecting the *function* (resolved lazily in `main.ts`, which does import
 * Electron) is therefore the only way both requirements hold at once: no Electron
 * import here, and no unready-dialog call at startup.
 *
 * It is deliberately only `showOpenDialog`. Anything wider would be an invitation
 * to reach for `showSaveDialog` or `showMessageBox` from a handler that cannot
 * be driven headlessly.
 */
export interface FolderPickerLike {
  showOpenDialog(options: OpenFolderOptions): Promise<OpenFolderResult>;
}

/** The request each channel carries, as the handler map declares it. */
interface Requests {
  [CHANNELS.openProject]: { root: string };
  [CHANNELS.pickFolder]: Record<string, never>;
  [CHANNELS.closeProject]: Record<string, never>;
  [CHANNELS.loadScene]: Record<string, never>;
  [CHANNELS.applyEdit]: { edit: SceneEdit };
  [CHANNELS.undo]: Record<string, never>;
  [CHANNELS.redo]: Record<string, never>;
  [CHANNELS.save]: Record<string, never>;
  [CHANNELS.listPrefabs]: Record<string, never>;
  [CHANNELS.compileContext]: {
    issue: string;
    logs: string;
    targetFile?: string;
    targetLine?: number;
    /** Extra project-relative paths to attach — ticked boxes, or an AI's requests. */
    files?: string[];
    /** Attach whole files instead of slices. Costs far more tokens. */
    fullFiles?: boolean;
  };
  [CHANNELS.rankFiles]: { issue: string; logs: string };
  [CHANNELS.projectGraph]: Record<string, never>;
  [CHANNELS.projectFocus]: { id: string; depth: FocusDepth; graph: DependencyGraph };
  [CHANNELS.scaffoldPrompt]: Partial<GameBrief>;
  [CHANNELS.scaffoldProblems]: Partial<GameBrief>;
  [CHANNELS.previewPatch]: { text: string };
  [CHANNELS.applyPatch]: { text: string; applyAnyway?: boolean };
  [CHANNELS.patchHistory]: Record<string, never>;
  [CHANNELS.generateBrief]: { mode: BriefMode; task?: string };
  [CHANNELS.readBrief]: Record<string, never>;
}

/** One channel: the channel name, its request type and its response type. */
type ChannelBinding = {
  [C in keyof Requests]: [C, (request: Requests[C]) => Promise<Result<unknown>>];
}[keyof Requests];

/**
 * The single owner of the open project.
 *
 * Constructed by `main.ts` with a `send` function bound to the window, so this
 * class imports no Electron at all. That is what lets a test drive it with a
 * recording `send` and a real temp folder and assert exactly what it would have
 * told the renderer, with no Electron runtime anywhere in sight.
 */
export class AppBackend {
  private root: string | null = null;
  private sceneLocation: SceneLocation | null = null;
  private scene: SceneFile = emptyScene('Level1', 0);
  /** Scene-level problems, recomputed on every read. */
  private problems: string[] = [];
  private registry: PrefabRegistryResult = { prefabs: [], failed: [] };

  /**
   * The exact bytes of the last write this process made to the scene file.
   *
   * `fs.watch` reports *our own* save as a change. Reloading on it would be
   * harmless but wasteful, and on a large scene it is visible: one gizmo drag
   * would re-parse the file per pointer move. Comparing content is exact, and an
   * external tool that happens to write identical bytes genuinely has nothing to
   * tell the renderer.
   */
  private lastWritten: string | null = null;

  private closeWatchers: Array<() => void> = [];

  /**
   * The prefab registry, and the watcher that keeps it current.
   *
   * `prefabLoader.ts` owns this: bundling a project's TypeScript registry, loading
   * it with the *same* Three.js instance the app has (so `instanceof Mesh` is true
   * across the boundary), and converting its Zod schema into the inspector's form.
   * It watches the prefabs directory itself and calls back, so the only thing
   * `AppBackend` has to do is emit the event.
   */
  private prefabLoader: PrefabLoader | null = null;

  /** @param send deliver a push event to the renderer. */
  constructor(
    private readonly send: <V extends EventName>(event: V, payload: EventPayloadFor<V>) => void,
    /**
     * Optional deps, as an object rather than a second positional argument.
     *
     * `send` stays first and alone because it is the one thing every backend
     * needs; everything else is an *optional* capability, and a positional
     * `(send, picker)` cannot be skipped — passing `undefined` to reach the
     * default is exactly the sort of `null`-ish argument that later becomes a
     * silent no-op. Named fields also mean the next optional capability is
     * additive instead of another parameter nobody remembers the order of.
     */
    private readonly deps: { picker?: FolderPickerLike } = {},
  ) {}

  // ── Handlers ─────────────────────────────────────────────────────────────

  /**
   * Open a project by absolute path.
   *
   * Everything that can go wrong here goes into `SceneSnapshot.problems` rather
   * than into a refusal, except the two things that genuinely prevent opening: a
   * path that is not a folder, and a folder that does not exist. A developer who
   * typed a wrong path deserves to be told so; a developer whose scene file is
   * mid-edit by an AI does not deserve a dead window.
   */
  async openProject(request: { root: string }): Promise<Result<SceneSnapshot>> {
    const trimmed = (request.root ?? '').trim();
    if (trimmed === '') return fail('Enter the path to a project folder first.');

    const root = resolve(trimmed);
    if (!existsSync(root)) return fail(`No such folder: ${root}`);
    if (!isDirectory(root)) {
      return fail(`Not a folder: ${root}. Point ContextForge at a project folder, not a file.`);
    }

    // Opening a second project must not leave the first one's watchers running.
    this.teardown();

    this.root = root;
    this.sceneLocation = findSceneFile(root);
    this.lastWritten = null;

    if (this.sceneLocation === null) {
      this.sceneLocation = { relativePath: 'scene.json', absolutePath: join(root, 'scene.json') };
      this.scene = emptyScene(projectName(root), 0);
      this.problems = [
        `No scene.json and no scenes/*.scene.json under ${root} — the project opens with an ` +
          'empty scene. Saving will create scene.json.',
      ];
    } else {
      const read = readSceneFile(this.sceneLocation.absolutePath, null);
      this.scene = read.scene;
      this.problems = read.problems;
      this.lastWritten = null;
    }

    await this.loadPrefabs();
    this.startWatching();

    return ok(this.requireSnapshot());
  }

  /**
   * Show the OS folder picker and return what the user chose.
   *
   * ## A cancel is not a failure
   *
   * `canceled: true` — and an empty `filePaths`, which is what some platforms
   * report for a dialog dismissed with the window manager — returns `ok(null)`.
   * A user who pressed Escape did nothing wrong, and a refusal would put an error
   * in front of them for the most ordinary action a file dialog invites. The
   * renderer treats `null` as "do nothing at all", which is the only correct
   * outcome for a decision the user declined to make.
   *
   * A *refusal* on this channel therefore means one thing only: the dialog could
   * not be shown. There is no filesystem check here — this handler never opens
   * anything. If the chosen path turns out not to be a usable project, that is
   * `openProject`'s refusal to say, because it is the one that knows what a
   * project is.
   */
  async pickFolder(): Promise<Result<string | null>> {
    const picker = this.deps.picker;
    if (picker === undefined) {
      // The channel is registered whatever the caller passed, so a backend built
      // without a picker must not answer `null` — that reads as "the user
      // cancelled" and the UI would sit there doing nothing, forever, for a
      // wiring mistake. Name the mistake instead.
      return fail(
        'The folder picker is not available: this build of the main process was ' +
          'started without a native folder dialog.',
      );
    }

    // The cancel test is `canceled === true` **or** an empty `filePaths`, because
    // an empty array is also how a dialog dismissed with the window manager
    // reports itself. Both mean the user declined, and both must look the same to
    // the renderer — otherwise the same gesture would sometimes be a cancel and
    // sometimes a refusal.
    //
    // Note there is no `try`/`catch` here: a `showOpenDialog` that throws is
    // turned into a refusal by the registrar's wrapper in `registerHandlers`,
    // which catches a synchronous throw and a rejected promise alike. That is
    // where that lives, so every channel gets it rather than only this one.
    const result = await picker.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return ok(null);

    // One folder: the dialog is not multi-select, so the first entry is the whole
    // answer. `filePaths[0]` is `string | undefined` under `noUncheckedIndexedAccess`
    // even after the length check, so it is narrowed by the line above rather
    // than asserted — and `openProject` re-checks it against the disk anyway,
    // because the main process does not trust a path without looking at it.
    return ok(result.filePaths[0] as string);
  }

  closeProject(): Result<null> {
    this.teardown();
    return ok(null);
  }

  /** Re-read the scene from disk, discarding in-memory state. */
  loadScene(): Result<SceneSnapshot> {
    if (this.root === null) return fail('No project is open.');
    if (this.sceneLocation === null) return fail('No project is open, so there is no scene to load.');

    const read = readSceneFile(this.sceneLocation.absolutePath, this.scene);
    this.scene = read.scene;
    this.problems = read.problems;
    this.lastWritten = null;
    return ok(this.requireSnapshot());
  }

  /**
   * Apply one edit: validate, write, record one undo step, return the new state.
   *
   * `applySceneEdit` is core's whole point for this channel: it saves *and*
   * records the transaction, so "move the crate" is one undo step and the renderer
   * never writes anything itself.
   *
   * A refused edit — an `addInstance` under a parent that does not exist, an
   * unknown op, a write that would produce an invalid scene — comes back as
   * `ok: false` carrying core's own sentence. Nothing was written and no undo step
   * was recorded, so the developer can fix the cause and try again without an undo
   * step that appears to do nothing when pressed (SPEC D15).
   */
  applyEdit(edit: SceneEdit): Result<SceneSnapshot> {
    if (this.root === null) return fail('No project is open.');
    if (this.sceneLocation === null) return fail('No project is open, so there is no scene to edit.');

    const result = applySceneEdit(this.root, this.sceneLocation.relativePath, this.scene, edit);
    if (!result.ok) {
      return fail(result.error ?? 'The edit was refused for an unknown reason.');
    }

    // Read back rather than trusting the returned value: the file is the truth,
    // and re-reading also picks up any normalisation `saveScene` applied and
    // records `lastWritten` so the watcher can ignore its own echo.
    const read = readSceneFile(this.sceneLocation.absolutePath, result.scene);
    this.scene = read.scene;
    this.lastWritten = read.raw;
    this.problems = read.problems;

    return ok(this.requireSnapshot());
  }

  undo(): Result<HistoryActionOutcome> {
    if (this.root === null) return fail('No project is open.');
    const action = undoSceneEdit(this.root);
    if (!action.success) return fail(action.error ?? 'Nothing to undo.');
    return this.afterHistoryAction(action);
  }

  redo(): Result<HistoryActionOutcome> {
    if (this.root === null) return fail('No project is open.');
    const action = redoSceneEdit(this.root);
    if (!action.success) return fail(action.error ?? 'Nothing to redo.');
    return this.afterHistoryAction(action);
  }

  /**
   * The explicit Save.
   *
   * Edits are already on disk when they are applied — an invalid scene must never
   * land there (SPEC R6) — so this is a re-validation and a confirmation rather
   * than the only write. It also creates the file in a project that had none.
   */
  save(): Result<SceneSnapshot> {
    if (this.root === null) return fail('No project is open.');

    const target = this.sceneLocation ?? {
      relativePath: 'scene.json',
      absolutePath: join(this.root, 'scene.json'),
    };

    try {
      saveScene(target.absolutePath, this.scene);
    } catch (error) {
      // `saveScene` validates before writing, so this is a real refusal and the
      // file on disk is unchanged. Reported, not thrown.
      return fail(`Not saved — ${describe(error)}`);
    }

    this.sceneLocation = target;
    const read = readSceneFile(target.absolutePath, this.scene);
    this.scene = read.scene;
    this.lastWritten = read.raw;
    this.problems = read.problems;

    return ok(this.requireSnapshot());
  }

  listPrefabs(): Result<PrefabRegistryResult> {
    if (this.root === null) return fail('No project is open.');
    return ok(this.registry);
  }

  // ── Context (Step 4) ──────────────────────────────────────────────────
  //
  // Everything below is core's work: `rankRelevantFiles` decides what is
  // relevant and says why, `compileContext` reads the files with its own
  // grammar-aware slicer and writes the prompt, and `extractFileReferences` is
  // what reads a path out of the log. Neither handler makes a relevance or a
  // slicing decision of its own — a second implementation here would be a second
  // set of answers to a question core has already been given.

  /**
   * The graph, for ranking and for the dependents section.
   *
   * A graph that will not build makes the prompt worse — a description-naming
   * symbol is worth 80 points and a stack frame 100 — but it does not mean there
   * is no prompt. So extraction failure is reported once, as a notice, and the
   * work proceeds without a manifest rather than being refused: refusing here
   * would leave a developer with no way to get context out of a project whose
   * extractor has an edge case, which is the opposite of "refuse rather than
   * guess" (SPEC R9 is about not hiding a gap, and this gap *is* reported).
   */
  private tryBuildManifest(): Manifest | undefined {
    const root = this.root;
    if (root === null) return undefined;
    try {
      return this.buildManifestFor(root);
    } catch (error) {
      this.send(EVENTS.notice, {
        level: 'warning',
        message: `Could not extract the dependency graph: ${describe(error)}. Files will be ranked ` +
          'from the error text and the description alone.',
      });
      return undefined;
    }
  }

  /**
   * Rank files for an issue, without building a prompt.
   *
   * Separate from `compileContext` because the Context screen shows the ranking
   * *first* and recompiles when a checkbox changes — recompiling to discover
   * the ranking would cost a full prompt build, and a disk read of every ranked
   * file, per tick.
   *
   * Uses core's `rankRelevantFiles` with the `exists` predicate it takes, so a
   * path in a log that names a file this project does not have never reaches the
   * list. That is core's decision about what evidence means, and duplicating the
   * scanner here would produce exactly the drift `extractFileReferences` was
   * written to avoid.
   */
  rankFiles(request: Requests[typeof CHANNELS.rankFiles]): Result<{ files: RankedFileRow[] }> {
    const root = this.root;
    if (root === null) return fail('No project is open, so there are no files to rank.');

    try {
      const ranked = rankRelevantFiles({
        issue: request.issue ?? '',
        logs: request.logs ?? '',
        manifest: this.tryBuildManifest(),
        exists: (file) => this.fileExists(root, file),
      });

      // `RankedFile` and `RankedFileRow` have identical fields today; the mapping
      // is written out rather than spread so that a field added to core's type
      // without being added to the contract is a compile error here instead of a
      // silently absent row field in the UI.
      const files: RankedFileRow[] = ranked.map((entry) => ({
        file: entry.file,
        score: entry.score,
        line: entry.line,
        reason: entry.reason,
        isTop: entry.isTop,
      }));

      return ok({ files });
    } catch (error) {
      return fail(`Could not rank the files for ${root}: ${describe(error)}`);
    }
  }

  /**
   * Compile a handoff prompt for the Context screen.
   *
   * The graph is extracted here rather than in the renderer because extraction is
   * the slow part — seconds on a real project (D11) — and it must not block the
   * UI. It is built only when a prompt is actually asked for, not when a project
   * opens.
   *
   * Returns the whole `CompiledPrompt`: the token estimate and the savings figure
   * are shown beside the prompt, and a screen cannot render a number it was
   * never sent. `sections` is what makes the checkbox list auditable — every row
   * carries the reason core gave for attaching it.
   *
   * `files` are **added to** the ranked selection, never substituted for it. See
   * `attachmentNote` for how, and for why the error origin cannot be displaced
   * by a ticked box.
   */
  compileContext(
    request: Requests[typeof CHANNELS.compileContext],
  ): Result<CompiledPrompt> {
    const root = this.root;
    if (root === null) return fail('No project is open, so there is nothing to compile context from.');

    const logs = request.logs ?? '';
    const files = request.files ?? [];

    // Refuse a path that leaves the project rather than reading it.
    //
    // The renderer cannot name an arbitrary path on its own — `files` only ever
    // carries a string a developer ticked or an AI asked for, and both are
    // supposed to be project-relative — but `..` in a name an AI invented is
    // exactly the case where a "refuse rather than guess" is cheaper than a
    // sanitiser. A sanitiser would attach a *different* file from the one asked
    // for, which is worse: the AI would be told it had been shown something it
    // was not. This mirrors core's own refusal in the patch path normaliser.
    for (const file of files) {
      if (!isInsideProject(root, file)) {
        return fail(
          `Cannot attach "${file}": it is not a path inside the open project. ` +
            'Tick a file from the ranked list, or use the path exactly as the project spells it.',
        );
      }
    }

    const fullFiles = request.fullFiles ?? false;

    try {
      const compiled = compileContext({
        projectRoot: root,
        issue: request.issue ?? '',
        logs,
        files,
        manifest: this.tryBuildManifest(),
        fullFiles,
        ...(request.targetFile !== undefined ? { targetFile: request.targetFile } : {}),
        ...(request.targetLine !== undefined ? { targetLine: request.targetLine } : {}),
      });

      // A path that was asked for and is not in the project.
      //
      // Two sources, both of which end up the same way from the developer's point
      // of view: a file pasted into the error text, and a file ticked in the
      // checkbox list or named by an AI. Core's ranker skips a reference that does
      // not exist — correctly, since ranking a file it cannot read is meaningless —
      // but the *consequence* is that the prompt simply does not mention it, and
      // the gap list core builds says nothing about it. So the developer asked for
      // something, did not get it, and has no way to tell that apart from "the
      // ranker decided it was not relevant". Both are reported here, where the disk
      // is: the gap says the file was named and is not there, which is the
      // difference between "renamed" and "ignored".
      const requested = new Set([
        ...extractFileReferences(logs).map((reference) => reference.file),
        ...files,
      ]);

      const gaps = [...compiled.gaps];
      for (const file of requested) {
        if (this.fileExists(root, file)) continue;
        gaps.push(
          `You asked for "${file}" to be attached, but it does not exist in this project. ` +
            'It may have been moved or renamed; nothing was attached for it.',
        );
      }

      // The prompt has to learn about a gap, not just the response.
      //
      // Core builds `prompt` before this loop runs, so a gap discovered here —
      // a requested file that is not on disk — was in the gap list the developer
      // sees but *absent from the text the AI reads*. That is the worst possible
      // split: the developer's screen says "I could not attach src/nope.js" while
      // the AI receives a prompt with no mention of it at all and no reason to
      // doubt the request was fulfilled. An AI that asked for context and was
      // quietly given none is exactly the failure this app exists to prevent.
      //
      // So the not-found files are stated **inside the prompt**, and the same
      // sentences are returned in `gaps` for the screen. One fact, both places.
      const notFound = [...requested].filter((file) => !this.fileExists(root, file));
      const prompt =
        notFound.length === 0
          ? compiled.prompt
          : `${compiled.prompt}\n\n## NOT ATTACHED — requested but absent\n\n` +
            notFound
              .map(
                (file) =>
                  `- \`${file}\` — no such file in this project. It was requested and nothing was attached.`,
              )
              .join('\n') +
            '\n\nDo not assume you were shown it. Ask for it again by name if you need it.';

      return ok({
        prompt,
        gaps,
        tokens: compiled.tokens,
        chars: prompt.length,
        fullChars: compiled.fullChars,
        savingsPercent: compiled.savingsPercent,
        sections: compiled.sections.map((section) => ({
          file: section.file,
          kind: section.kind,
          reason: section.reason,
        })),
      });
    } catch (error) {
      return fail(`Could not compile the context for ${root}: ${describe(error)}`);
    }
  }

  // ── Patch (Step 4) ────────────────────────────────────────────────────────

  /**
   * Parse a pasted AI reply and report what it would do. Writes nothing.
   *
   * The result is `PatchPreview`, which carries a diff per file, the syntax
   * verdict per file, and — the reason this screen exists — core's own sentence
   * for every `### EDIT:` block that would fail. Those sentences are copied
   * across as-is: "matched 3 times" and "could not find exact FIND text" are
   * the difference between asking the AI for more surrounding code and
   * guessing, and paraphrasing them into "couldn't apply" throws that away.
   *
   * Refusing outright is reserved for a reply with no blocks and for an unsafe
   * path. Both are cases where there is no diff to show, and a refusal with
   * core's sentence is more useful than an empty preview.
   */
  previewPatch(request: Requests[typeof CHANNELS.previewPatch]): Result<PatchPreview> {
    const root = this.root;
    if (root === null) return fail(noProjectOpen().reason);

    const outcome = planPatch(root, request.text ?? '');
    if (!outcome.ok) return fail(outcome.reason);

    const plan = outcome.plan;
    const files: PatchFilePreview[] = plan.files.map((file) => ({
      path: file.path,
      diff: file.changed ? formatUnifiedDiff(file.path, file.before ?? '', file.after) : '',
      created: file.before === null,
      syntaxFailed: !file.syntax.valid,
      syntax: file.syntax,
    }));

    const blockedReason = blockedReasonFor(plan);
    return ok({
      files,
      failedBlocks: plan.failedBlocks,
      alreadyApplied: plan.alreadyApplied,
      applicable: blockedReason === '',
      canApplyAnyway: canApplyAnywayFor(plan),
      blockedReason,
      blockCount: plan.blockCount,
    });
  }

  /**
   * Apply a pasted AI reply, all-or-nothing.
   *
   * ## The order is the whole design
   *
   * 1. `planPatch` decides everything against a scratch copy — no block that
   *    cannot resolve, no syntax failure, no path outside the project.
   * 2. The **same** function decides it again for the real root, immediately
   *    before the write. A preview and an apply that resolved separately could
   *    disagree, and the developer's approval would then be of one thing while
   *    another thing landed on disk. Deciding twice against the live tree is
   *    cheap and makes the approval honest.
   * 3. Only then does `captureAndWrite` touch the real project, and it takes the
   *    whole map at once — so the bytes go down in one pass over one decision,
   *    with a `before` captured for each file before any of them is written.
   * 4. `recordHistoryStep` records **one** step for that entire map. One Apply is
   *    one Undo, whether the patch touched one file or six.
   *
   * `applyAnyway` is a second, explicit click and never a default. It suppresses
   * the syntax gate and nothing else: a block that cannot be located, or a path
   * that escapes the project, still refuses, because "the syntax checker does not
   * understand this grammar" is a reason to override and "we do not know which
   * five lines you meant" is not.
   */
  applyPatch(request: Requests[typeof CHANNELS.applyPatch]): Result<PatchApplyResult> {
    const root = this.root;
    if (root === null) return fail(noProjectOpen().reason);

    const applyAnyway = request.applyAnyway === true;
    const outcome = planPatch(root, request.text ?? '');
    if (!outcome.ok) return fail(outcome.reason);

    const plan = outcome.plan;
    const blocked = blockedReasonFor(plan);
    if (blocked !== '') {
      const overridable = canApplyAnywayFor(plan) && applyAnyway;
      if (!overridable) return fail(blocked);
    }

    if (plan.changed.length === 0) {
      // Nothing to do, and no refusal to report: every block was already
      // applied, or the files would not change. Recording a history step here
      // would give the developer an Undo that visibly does nothing.
      return fail(blockedReasonFor(plan));
    }

    const changes = captureAndWrite(root, plan.updates);

    const step = recordHistoryStep(
      normalizeProjectPath(root),
      describePatchStep(plan),
      changes,
      { blockCount: plan.blockCount, source: 'patch' },
    );

    const status = getHistoryStatus(normalizeProjectPath(root));
    return ok({
      files: changes.map((change) => change.path),
      created: plan.created,
      applied: plan.blocksApplied,
      patchId: step?.patchId ?? '',
      canUndo: status.canUndo,
      undoCount: status.undoCount,
    });
  }

  /**
   * The patch history for the open project, newest first.
   *
   * Read from core's history rather than kept here, so the Patch screen and the
   * Scene screen's undo buttons are looking at one stack. Two histories in one
   * process would mean two answers to "what is next to be undone", and only one
   * of them would be right.
   *
   * Core returns its most recent handful; the contract asks for the whole
   * 20-step stack, which core keeps in memory and exposes only as a short tail.
   * What is reported is what core reports — nothing here is invented to fill in
   * a longer list.
   */
  patchHistory(): Result<{
    entries: PatchHistoryEntry[];
    canUndo: boolean;
    canRedo: boolean;
  }> {
    const root = this.root;
    if (root === null) return fail(noProjectOpen().reason);

    const status = getHistoryStatus(normalizeProjectPath(root));
    const entries: PatchHistoryEntry[] = status.recentTransactions
      .map((step) => ({
        patchId: step.patchId,
        description: step.description,
        files: step.files,
        timestamp: step.timestamp,
      }))
      .reverse();

    return ok({ entries, canUndo: status.canUndo, canRedo: status.canRedo });
  }

  /**
   * Build `.contextforge/brief.md` for the open project.
   *
   * The request is validated by core with Zod rather than by a switch here: a
   * bad mode must be a refusal naming the field, not a fall-through to the
   * one-shot path that would hand the developer a brief they did not ask for.
   */
  generateBrief(request: Requests[typeof CHANNELS.generateBrief]): Result<BriefResult> {
    if (this.root === null) return fail('No project is open.');

    const validated = validateBriefRequest(request);
    if (!validated.ok) return fail(validated.reason);

    try {
      return ok(
        generateBrief({
          projectRoot: this.root,
          mode: validated.value.mode,
          task: validated.value.task,
          // Injected, not read twice: core refuses to put a wall-clock time in
          // its own output (SPEC R8), so the caller is the only clock there is.
          generatedAt: new Date().toISOString(),
          ...(this.sceneLocation !== null ? { scenePath: this.sceneLocation.relativePath } : {}),
        }),
      );
    } catch (error) {
      return fail(`Could not build the brief: ${describe(error)}`);
    }
  }

  /**
   * Read `.contextforge/brief.md`, or `ok(null)` when there is none.
   *
   * `null` and not a refusal: a project that has never had a brief is the normal
   * state of a project no AI has been handed yet, and the Context screen shows an
   * empty state rather than a red error for it.
   */
  readBrief(): Result<BriefResult | null> {
    if (this.root === null) return fail('No project is open.');
    try {
      return ok(readBrief(this.root));
    } catch (error) {
      return fail(`Could not read the brief: ${describe(error)}`);
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Does `file` exist under the open project?
   *
   * The predicate core's ranker takes, so a path in a log that names a file this
   * project does not have never enters the ranking. `existsSync` already returns
   * false on a permission error, and the `try` is for the rarer `join` throwing —
   * either way the answer is "no such file", which is the same thing.
   */
  private fileExists(root: string, file: string): boolean {
    try {
      return existsSync(join(root, file));
    } catch {
      return false;
    }
  }

  /**
   * Re-read the scene after undo or redo, which changed the file behind us, and
   * report which files the step touched.
   *
   * The action is threaded through rather than dropped: `paths` is the only
   * thing that lets the screen say "reverted src/modes.js, src/settings.js"
   * instead of a sentence that could describe any undo at all.
   */
  private afterHistoryAction(action: HistoryActionResult): Result<HistoryActionOutcome> {
    if (this.sceneLocation !== null) {
      const read = readSceneFile(this.sceneLocation.absolutePath, this.scene);
      this.scene = read.scene;
      this.problems = read.problems;
      this.lastWritten = null;
    }
    return ok({
      snapshot: this.requireSnapshot(),
      paths: action.paths,
      patchId: action.patchId ?? '',
      canUndo: action.canUndo,
      canRedo: action.canRedo,
      undoCount: action.undoCount,
      redoCount: action.redoCount,
    });
  }

  /**
   * Build the graph for the Context screen. Slow, so it is never on a hot path.
   *
   * `collect` is an options object rather than a second positional callback
   * because there are now two of them, and a bare positional is a swap waiting
   * to happen — passing the asset collector where the parse one goes compiles
   * fine and silently reports nothing.
   */
  private buildManifestFor(
    root: string,
    collect?: {
      onUnparseable?: (file: UnparseableFile) => void;
      onMissingAsset?: (missing: MissingAsset) => void;
    },
  ): Manifest {
    if (existsSync(join(root, 'project.godot'))) {
      return buildManifest(root, extractGodotProject(root), new Date().toISOString());
    }
    return buildManifest(
      root,
      extractJsProject(root, collect?.onUnparseable, collect?.onMissingAsset),
      new Date().toISOString(),
    );
  }

  /**
   * The file-level dependency graph for the open project, with core's own
   * analysis of it.
   *
   * The summary and the orphan list are computed here rather than in the
   * renderer, and that is forced rather than chosen: `@contextforge/core` is
   * `external` in the renderer build, so a value import of it would leave a bare
   * specifier the browser cannot resolve and the app would fail to mount. The
   * screen receives the counts rather than deriving them, which also means there
   * is exactly one derivation — the D44 defect was two layers counting one fact.
   */
  projectGraph(
    _request: Requests[typeof CHANNELS.projectGraph],
  ): Result<{
    nodes: GraphNode[];
    edges: GraphEdge[];
    summary: GraphSummary;
    orphans: Orphan[];
    /** Files that exist but could not be parsed, and why. */
    unparseable: UnparseableFile[];
    /** Asset references that resolve to nothing, and why. */
    missingAssets: MissingAsset[];
  }> {
    const root = this.root;
    if (root === null) return fail('No project is open, so there is no graph to show.');

    const unparseable: UnparseableFile[] = [];
    const missingAssets: MissingAsset[] = [];
    try {
      const manifest = this.buildManifestFor(root, {
        onUnparseable: (file) => unparseable.push(file),
        onMissingAsset: (missing) => missingAssets.push(missing),
      });
      const graph: DependencyGraph = { nodes: manifest.nodes, edges: manifest.edges };
      return ok({
        nodes: graph.nodes,
        edges: graph.edges,
        summary: summariseGraph(graph),
        orphans: findOrphans(graph),
        unparseable,
        missingAssets,
      });
    } catch (error) {
      // The extractors throw on a missing folder and on a path that is a file.
      // A graph screen that renders an empty canvas for a project that failed to
      // read looks identical to a project with no files, so the reason is
      // returned rather than swallowed.
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * The neighbourhood around one node, at depth 1 or 2.
   *
   * Takes the graph as its request rather than re-extracting the project: this
   * runs on every node click, and a full extraction per click would make the
   * graph unusable at any real project size. The cost of sending the graph back
   * is honest and worth naming — at 1,000 files it is a few hundred KB per
   * click — and the fix, if it ever shows up, is for this class to cache the
   * manifest per project root, not to make the renderer do the analysis.
   */
  projectFocus(request: Requests[typeof CHANNELS.projectFocus]): Result<{
    nodes: FocusedNode[];
    edges: { from: string; to: string; kind: string }[];
  }> {
    const graph = request.graph;
    if (graph === undefined) return fail('No graph was sent to focus within.');

    const nodes = focusNeighbourhood(graph, request.id, request.depth);
    return ok({
      nodes,
      // Only edges with both endpoints drawn. An edge leaving the neighbourhood
      // would point at a node that is not on screen, which reads as a bug in the
      // graph rather than as a deliberate boundary.
      edges: edgesWithin(graph, new Set(nodes.map((n) => n.node.id))),
    });
  }

  /**
   * The scaffold prompt for a new project.
   *
   * Refuses an incomplete brief rather than returning a half-built prompt. The
   * refusal is `IncompleteBriefError`'s own sentence, the same one
   * `generateProject` throws with — so a developer who reads it here and a
   * developer who reads it from the generator are told the same thing.
   */
  scaffoldPrompt(request: Requests[typeof CHANNELS.scaffoldPrompt]): Result<{ prompt: string }> {
    const problems = scaffoldPromptProblems(request);
    if (problems.length > 0) {
      return fail(
        `Cannot build the scaffold prompt — the game brief is incomplete:\n` +
          problems.map((p) => `  - ${p}`).join('\n') +
          '\n\nA prompt generated from a half-filled brief teaches an AI nothing about\n' +
          'what the game is. Fill these in first.',
      );
    }
    return ok({ prompt: buildScaffoldPrompt(request) });
  }

  /**
   * Why a brief cannot be used yet.
   *
   * Never refuses for a bad brief — "incomplete" is the expected answer here,
   * and a refusal would be a second way of saying the same thing. It does
   * refuse a request it cannot understand, which is a different failure.
   */
  scaffoldProblems(
    request: Requests[typeof CHANNELS.scaffoldProblems],
  ): Result<{ problems: string[] }> {
    if (request === null || typeof request !== 'object') {
      return fail('Expected a brief with a name and an idea.');
    }
    return ok({ problems: scaffoldPromptProblems(request) });
  }

  /**
   * Start (or restart) the prefab loader for the open project.
   *
   * The loader loads the registry once and then watches for changes itself, so
   * this is called on open only. `onChanged` is the whole of the prefab watcher
   * contract: the loader decides *when* the registry is current, and this class
   * only has to say so to the renderer.
   */
  private async loadPrefabs(): Promise<void> {
    const root = this.root;
    if (root === null) return;

    this.prefabLoader = createPrefabLoader(root, {
      onChanged: async (registry) => {
        if (this.root === null) return;
        const bundle = await bundlePrefabsForBrowser(root).catch(() => null);
        this.registry = {
          ...registry,
          ...(bundle?.code ? { bundleCode: bundle.code } : {}),
        };
        if (bundle) bundle.handle.dispose();
        this.send(EVENTS.prefabsChanged, { registry: this.registry });
      },
    });

    const registry = await this.prefabLoader.reload();
    const bundle = await bundlePrefabsForBrowser(root).catch(() => null);
    this.registry = {
      ...registry,
      ...(bundle?.code ? { bundleCode: bundle.code } : {}),
    };
    if (bundle) bundle.handle.dispose();
  }

  /** Prefab-loading failures, as scene problems. */
  private prefabProblems(): string[] {
    return this.registry.failed.map((f) => `Prefab ${f.name} (${f.file}): ${f.reason}`);
  }

  /**
   * Prefab-level scene problems: an instance naming a prefab that does not exist,
   * or params the prefab's own schema rejects.
   *
   * Reported rather than enforced, because the file is still a valid scene: it
   * renders with placeholders, and refusing to open it would leave the developer
   * with no way to see what is wrong.
   *
   * The registry the loader returns is a *summary* — enough to draw a form, not
   * the live `PrefabDefinition`s, because those hold a Three.js object graph this
   * process has no reason to keep. So this is matched against the summaries'
   * names and schemas rather than by re-running core's `validateScenePrefabs`,
   * which would need the definitions.
   */
  private paramProblems(): string[] {
    // Reads `this.registry` directly rather than `this.snapshot`.
    //
    // It used to take the snapshot, which is a cycle: the snapshot's `problems`
    // array calls this method, so every call recursed until the stack blew. The
    // snapshot added exactly one thing this needs — the prefab summaries — and
    // that is already a field. Reading the field keeps the dependency one-way
    // (registry → problems → snapshot), which is also the order they are built.
    const known = new Map(this.registry.prefabs.map((p) => [p.name, p] as const));
    const problems: string[] = [];
    const label = this.sceneLocation?.relativePath ?? 'scene.json';

    this.scene.instances.forEach((instance, i) => {
      const prefab = known.get(instance.prefab);
      if (prefab === undefined) {
        problems.push(
          `${label}: instances[${i}].prefab: no registered prefab named "${instance.prefab}" — ` +
            `registered prefabs: ${[...known.keys()].join(', ') || '(none)'}`,
        );
        return;
      }

      for (const key of Object.keys(instance.params)) {
        if (!(key in prefab.paramsJsonSchema.properties)) {
          // The prefab's schema is `.strict()`, so an unknown param is a
          // validation error, not a hint to ignore.
          problems.push(
            `${label}: instances[${i}].params.${key}: prefab "${instance.prefab}" does not accept a ` +
              `param called "${key}" (accepted: ${
                Object.keys(prefab.paramsJsonSchema.properties).join(', ') || 'none'
              })`,
          );
        }
      }

      for (const key of prefab.paramsJsonSchema.required) {
        if (!(key in instance.params)) {
          const field = prefab.paramsJsonSchema.properties[key];
          if (field !== undefined && field.kind !== 'unsupported' && field.default === undefined) {
            problems.push(
              `${label}: instances[${i}].params.${key}: prefab "${instance.prefab}" requires ` +
                `"${key}", and this instance does not set it`,
            );
          }
        }
      }
    });

    return problems;
  }

  /** The current state, as the renderer sees it. */
  private get snapshot(): SceneSnapshot | null {
    const root = this.root;
    if (root === null) return null;

    const history = sceneHistoryStatus(root);
    const project: ProjectInfo = {
      root,
      name: projectName(root),
      scenePath: this.sceneLocation?.relativePath ?? 'scene.json',
      engine: detectEngine(root, this.scene),
    };

    return {
      project,
      scene: this.scene,
      prefabs: this.registry,
      history: {
        canUndo: history.canUndo,
        canRedo: history.canRedo,
        undoCount: history.undoCount,
        redoCount: history.redoCount,
      },
      problems: [...this.problems, ...this.prefabProblems(), ...this.paramProblems()],
    };
  }

  /**
   * The current state, for a handler that has already checked a project is open.
   *
   * Separate from the getter above because this one is a *bug detector*: it is
   * only called from paths that have established `this.root`, and a `null` there
   * means a handler reached the end without checking — which should be a loud
   * failure at the source, not a snapshot of nothing sent to the renderer.
   */
  private requireSnapshot(): SceneSnapshot {
    const snapshot = this.snapshot;
    if (snapshot === null) {
      throw new Error('snapshot() was called with no project open — a bug in a handler.');
    }
    return snapshot;
  }

  // ── Watching ─────────────────────────────────────────────────────────────

  private startWatching(): void {
    const root = this.root;
    if (root === null) return;

    // The scene's *directory*, not the file: an editor that saves by
    // write-to-temp-then-rename replaces the inode, and a watch on the old inode
    // would go quiet forever. That failure is the whole reason for watching here.
    //
    // Prefabs are **not** watched here. `prefabLoader.ts` watches them itself,
    // because it has to rebuild the registry from a burst of events and a second
    // watcher doing the same job would rebuild it twice.
    if (this.sceneLocation !== null) {
      this.watchDirectory(
        dirname(this.sceneLocation.absolutePath),
        (name) => name === basename(this.sceneLocation?.absolutePath ?? ''),
        () => this.onSceneChanged(),
      );
    }
  }

  /**
   * Watch one directory, debounced, with a handle that closes it.
   *
   * A watch that cannot be established is a warning, not a failure: watching is a
   * convenience, and a platform that cannot watch a directory still gets a working
   * editor.
   */
  private watchDirectory(
    directory: string,
    interested: (filename: string | null) => boolean,
    onChange: () => void,
  ): void {
    const debouncer = makeDebouncer(onChange, WATCH_DEBOUNCE_MS);
    const target = basename(directory);

    let watcher: ReturnType<typeof watch>;
    try {
      watcher = watch(directory, (_event, filename) => {
        const name = filename === null ? null : String(filename);
        if (interested(name)) debouncer.schedule();
      });
    } catch (error) {
      this.send(EVENTS.notice, {
        level: 'warning',
        message: `Cannot watch ${target} for changes: ${describe(error)}. Edits from another tool will not appear until you reload.`,
      });
      return;
    }

    watcher.on('error', () => {
      try {
        watcher.close();
      } catch {
        // Already closed.
      }
    });

    this.closeWatchers.push(() => {
      debouncer.cancel();
      try {
        watcher.close();
      } catch {
        // Already closed.
      }
    });
  }

  /**
   * The scene file changed on disk — by an AI, by the developer's other editor, or
   * by an `applyEdit` this process just made itself.
   */
  private onSceneChanged(): void {
    const location = this.sceneLocation;
    if (location === null) return;

    let raw: string | null = null;
    try {
      raw = existsSync(location.absolutePath) ? readFileSync(location.absolutePath, 'utf-8') : null;
    } catch (error) {
      this.send(EVENTS.sceneChangedOnDisk, {
        valid: false,
        problems: [`Could not re-read ${location.relativePath}: ${describe(error)}`],
      });
      return;
    }

    if (raw !== null && raw === this.lastWritten) {
      // Our own write, echoed back. The renderer already holds the result of the
      // `applyEdit` that caused it, so there is nothing to tell it.
      this.lastWritten = null;
      return;
    }

    const read = readSceneFile(location.absolutePath, this.scene);
    this.send(EVENTS.sceneChangedOnDisk, { valid: read.valid, problems: read.problems });
  }

  /**
   * Release every watcher and the loaded registry.
   *
   * Called on project close, when another project is opened over this one, and
   * before the process exits — three paths, one body, because a leaked `fs.watch`
   * keeps a file handle on a project the developer has closed.
   */
  teardown(): void {
    for (const close of this.closeWatchers) close();
    this.closeWatchers = [];
    this.prefabLoader?.dispose();
    this.prefabLoader = null;
    this.registry = { prefabs: [], failed: [] };
    this.lastWritten = null;
    this.problems = [];
    this.root = null;
    this.sceneLocation = null;
    this.scene = emptyScene('Level1', 0);
  }
}

// ── Registration ────────────────────────────────────────────────────────────

/**
 * Every handler, in one list.
 *
 * Written as a list of builder functions rather than one array literal because a
 * union of tuples does not contextually type its second element — and a handler
 * whose `request` is implicitly `any` is a handler nobody has checked against
 * `ipc.ts`. Each entry declares its own parameter type, so every call into the
 * backend below is checked.
 */
const HANDLERS: ReadonlyArray<(backend: AppBackend) => ChannelBinding> = [
  (backend) => [
    CHANNELS.openProject,
    (request: { root: string }) => backend.openProject(request),
  ],
  // `async`, so a synchronous throw inside it becomes a rejected promise. The
  // registrar handles both shapes, but one shape is easier to reason about.
  (backend) => [CHANNELS.pickFolder, () => backend.pickFolder()],
  (backend) => [CHANNELS.closeProject, () => Promise.resolve(backend.closeProject())],
  (backend) => [CHANNELS.loadScene, () => Promise.resolve(backend.loadScene())],
  (backend) => [
    CHANNELS.applyEdit,
    (request: { edit: SceneEdit }) => Promise.resolve(backend.applyEdit(request.edit)),
  ],
  (backend) => [CHANNELS.undo, () => Promise.resolve(backend.undo())],
  (backend) => [CHANNELS.redo, () => Promise.resolve(backend.redo())],
  (backend) => [CHANNELS.save, () => Promise.resolve(backend.save())],
  (backend) => [CHANNELS.listPrefabs, () => Promise.resolve(backend.listPrefabs())],
  (backend) => [
    CHANNELS.compileContext,
    (request: Requests[typeof CHANNELS.compileContext]) =>
      Promise.resolve(backend.compileContext(request)),
  ],
  (backend) => [
    CHANNELS.rankFiles,
    (request: Requests[typeof CHANNELS.rankFiles]) => Promise.resolve(backend.rankFiles(request)),
  ],
  (backend) => [
    CHANNELS.projectGraph,
    (request: Requests[typeof CHANNELS.projectGraph]) =>
      Promise.resolve(backend.projectGraph(request)),
  ],
  (backend) => [
    CHANNELS.projectFocus,
    (request: Requests[typeof CHANNELS.projectFocus]) =>
      Promise.resolve(backend.projectFocus(request)),
  ],
  (backend) => [
    CHANNELS.scaffoldPrompt,
    (request: Requests[typeof CHANNELS.scaffoldPrompt]) =>
      Promise.resolve(backend.scaffoldPrompt(request)),
  ],
  (backend) => [
    CHANNELS.scaffoldProblems,
    (request: Requests[typeof CHANNELS.scaffoldProblems]) =>
      Promise.resolve(backend.scaffoldProblems(request)),
  ],
  (backend) => [
    CHANNELS.previewPatch,
    (request: Requests[typeof CHANNELS.previewPatch]) =>
      Promise.resolve(backend.previewPatch(request)),
  ],
  (backend) => [
    CHANNELS.applyPatch,
    (request: Requests[typeof CHANNELS.applyPatch]) => Promise.resolve(backend.applyPatch(request)),
  ],
  (backend) => [CHANNELS.patchHistory, () => Promise.resolve(backend.patchHistory())],
  (backend) => [
    CHANNELS.generateBrief,
    (request: Requests[typeof CHANNELS.generateBrief]) =>
      Promise.resolve(backend.generateBrief(request)),
  ],
  (backend) => [CHANNELS.readBrief, () => Promise.resolve(backend.readBrief())],
];

/**
 * Register a handler for every channel in `CHANNELS`.
 *
 * Two things happen here and nowhere else, and both exist because of how a
 * rejected `ipcRenderer.invoke` behaves in the renderer:
 *
 *  - the handler is wrapped so a bug in it (a null dereference, an `fs` error
 *    nobody predicted) becomes `ok: false` with a readable reason instead of a
 *    rejected promise the renderer can only log;
 *  - every channel in `CHANNELS` must be bound, and nothing else may be. A
 *    channel with no handler is a UI that hangs forever on a request nobody is
 *    listening for, and a handler for a channel no renderer may call is a door
 *    that should not exist. Both are checked here, at startup, with a list.
 *
 * Returns a teardown function removing every handler, so a second `ready` — which
 * Electron fires on macOS activate — does not stack duplicates.
 */
export function registerHandlers(ipcMain: IpcMainLike, backend: AppBackend): () => void {
  const bindings: ChannelBinding[] = HANDLERS.map((build) => build(backend));

  const declared = new Set<string>(Object.values(CHANNELS));
  const bound = new Set<string>();
  for (const [channel] of bindings) {
    if (!declared.has(channel)) {
      throw new Error(`Refusing to register a handler for unknown channel "${channel}".`);
    }
    if (bound.has(channel)) {
      throw new Error(`Channel "${channel}" has two handlers. One channel, one handler.`);
    }
    bound.add(channel);
  }

  const missing = [...declared].filter((c) => !bound.has(c));
  if (missing.length > 0) {
    throw new Error(
      `No handler registered for: ${missing.join(', ')}. ` +
        'Every channel in CHANNELS must be handled, or the UI waits forever on it.',
    );
  }

  for (const [channel, run] of bindings) {
    ipcMain.handle(channel, (_event: unknown, ...args: never[]) => {
      // Both a synchronous throw and a rejected promise become a refusal.
      //
      // `.catch()` alone is not enough, and the difference is invisible until a
      // handler throws *before* its first `await` — which is exactly what a bug
      // in the early validation path does. A handler declared `async` converts
      // its own synchronous throw into a rejection, but `run(...)` is invoked
      // here, outside that handler, so the throw escapes and reaches the
      // renderer as an unhandled rejection carrying a message written for a
      // stack trace (SPEC R9). The full stop is part of that: `describe(error)`
      // returns whatever message the failure had — "Cannot read properties of
      // undefined", with no punctuation — and R9 asks for a sentence the UI can
      // show verbatim, not a fragment glued onto one.
      const refusal = (error: unknown): Result<null> =>
        fail(`The main process could not handle ${channel}: ${describe(error)}.`);

      try {
        return Promise.resolve(run((args[0] ?? {}) as never)).catch(refusal);
      } catch (error) {
        return Promise.resolve(refusal(error));
      }
    });
  }

  return (): void => {
    for (const [channel] of bindings) ipcMain.removeHandler(channel);
  };
}

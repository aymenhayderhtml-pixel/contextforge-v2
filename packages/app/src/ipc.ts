/**
 * ipc.ts — the contract between the Electron main process and the Svelte UI.
 *
 * This file is the *only* thing the six Step 3 areas share. It is written
 * before they are, deliberately: a boundary defined after the code that crosses
 * it is a boundary that has already been crossed six different ways.
 *
 * ## Why the renderer cannot touch the filesystem
 *
 * The renderer loads a project from disk: it reads `scene.json`, resolves
 * prefab bundles, and watches for an AI rewriting the scene mid-edit. None of
 * that can happen in the renderer, because `contextIsolation` is on and Node is
 * not in the renderer at all. So every operation that touches the disk is a
 * request over IPC, handled in the main process, which owns the filesystem and
 * core's parsers.
 *
 * ## Three rules the shape below depends on
 *
 *  1. **Every request is typed, and every response is typed as a result union.**
 *     Not `{ ok: boolean }` — a discriminated `Result` carrying either `value`
 *     or a `reason`. A boolean makes every caller invent its own error handling,
 *     and R9 says a failure must name what went wrong and where.
 *  2. **An edit is one request and one undo step.** `applyEdit` carries the whole
 *     operation, so the renderer never has to sequence move-then-rotate and
 *     cannot leave the scene half-changed. This is the same rule the patch
 *     engine follows (D5).
 *  3. **Push events are named and versioned.** The renderer subscribes to
 *     `scene:changed` and `prefabs:changed`; anything else is a reply to a
 *     request it sent. A firehose of anonymous `webContents.send` calls is how
 *     a UI and its backend drift apart without a compiler noticing.
 *
 * ## What is deliberately absent
 *
 * There is no `execute arbitrary code` channel, and no way to hand the main
 * process a path the user did not open. The renderer cannot ask core to read a
 * file outside the open project. Anything that would be one of those belongs in
 * core behind a validated function (SPEC R3/R9), not in an escape hatch here.
 */

import type { SceneFile, SceneEdit } from '@contextforge/core';

/**
 * The result of an operation that can fail.
 *
 * `reason` is a complete, human-readable sentence — not a code and not a bare
 * boolean — because it is shown directly in the UI. Whoever formats it for a
 * developer should not have to reconstruct the context.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Build a success. Named so `ok: true` is never written by hand. */
export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** Build a failure. `reason` must be a sentence the UI can show verbatim. */
export function fail<T = never>(reason: string): Result<T> {
  return { ok: false, reason };
}

// ── Prefabs ──────────────────────────────────────────────────────────────────

/** One prefab the main process could load, as the UI sees it. */
export interface PrefabSummary {
  /** The name a scene instance refers to. */
  name: string;
  /** One line, from the registry. Shown in the add-instance list. */
  description: string;
  /**
   * A JSON-Schema-shaped description of the prefab's params, derived from its
   * Zod `paramsSchema`.
   *
   * The renderer builds the inspector form from this rather than from Zod
   * itself, because Zod is a Node-side dependency and the renderer must not
   * carry it. One conversion in the main process beats a second, drifting
   * implementation of "what does this prefab accept" in the renderer.
   */
  paramsJsonSchema: JsonSchema;
}

/**
 * A minimal JSON Schema, as far as the inspector needs it.
 *
 * Deliberately not full JSON Schema: the inspector renders three field kinds
 * (number, string, boolean) with a select for enums. Claiming to support the
 * whole specification and then not doing it would be worse than naming the
 * subset.
 */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, FieldSchema>;
  required: string[];
  /** True when the source schema rejects unknown keys. */
  additionalProperties: boolean;
}

/** One field in a params form. */
export type FieldSchema =
  | {
      kind: 'number';
      title: string;
      min?: number;
      max?: number;
      /**
       * `min` is exclusive. Set for Zod's `.positive()` (and any other
       * non-inclusive check), because Zod's `.positive()` is `min: 0` and an
       * *inclusive* `min: 0` admits the value the schema refuses — so the app
       * would accept `width: 0` while the game skips the instance, and the
       * developer would see a clean panel and a missing track with nothing
       * connecting them (D26).
       *
       * Optional rather than a second bound because the exclusive value is
       * still in `min`; a consumer that ignores this marker keeps its current
       * behaviour, which is the safe direction.
       */
      exclusiveMin?: true;
      default?: number;
    }
  | { kind: 'string'; title: string; pattern?: string; default?: string; options?: string[] }
  | { kind: 'boolean'; title: string; default?: boolean }
  | { kind: 'unsupported'; title: string; /** Why it cannot be edited, shown in the UI. */ reason: string };

/** Why a prefab could not be loaded. Never fatal: the viewer still opens. */
export interface PrefabFailure {
  /** The prefab's declared name, or the file it was declared in. */
  name: string;
  /** Source file, so the developer can go and look at it. */
  file: string;
  /** The thrown error, including its stack's first frames. */
  reason: string;
}

/**
 * The result of loading a project's prefabs.
 *
 * `failed` is a first-class field, not an error. A prefab that throws must
 * produce a placeholder in the viewport and a row in the outliner — not a
 * viewer that refuses to open, because one bad prefab in a directory of twelve
 * is the normal state of a project an AI is actively editing.
 */
export interface PrefabRegistryResult {
  prefabs: PrefabSummary[];
  failed: PrefabFailure[];
  bundleCode?: string;
}

// ── Project and scene ────────────────────────────────────────────────────────

/** A project the developer has opened. */
export interface ProjectInfo {
  /** Absolute path on disk. */
  root: string;
  /** Folder name, shown in the title bar. */
  name: string;
  /** Project-relative path of the scene file, e.g. `scene.json`. */
  scenePath: string;
  /** False when the project has no `project.godot` and no manifest. */
  engine: 'three' | 'godot';
}

/** Everything the UI needs to draw the Scene screen. */
export interface SceneSnapshot {
  project: ProjectInfo;
  scene: SceneFile;
  prefabs: PrefabRegistryResult;
  /** Whether the scene has unsaved changes, and how many undo steps are available. */
  history: { canUndo: boolean; canRedo: boolean; undoCount: number; redoCount: number };
  /**
   * Problems found while loading, which do NOT prevent opening.
   *
   * A scene file an AI has just written is often invalid. The right behaviour is
   * to open it anyway with the last valid state and say what is wrong, not to
   * show an error screen with no way back (SPEC R9).
   */
  problems: string[];
}

// ── Requests ─────────────────────────────────────────────────────────────────

/** Channel names. Every message in the app is one of these. */
export const CHANNELS = {
  // Renderer → main, request/response over `ipcRenderer.invoke`.
  openProject: 'project:open',
  /**
   * Show the OS folder picker and return what the user chose.
   *
   * The renderer may ask for a dialog and receive the folder the user picked in
   * it. It may not name a path: this channel takes no argument, so the main
   * process is the only thing that ever learns a directory, and it learns it
   * from a human clicking in a native dialog. See `IpcRequests[CHANNELS.pickFolder]`.
   */
  pickFolder: 'project:pick-folder',
  closeProject: 'project:close',
  loadScene: 'scene:load',
  applyEdit: 'scene:applyEdit',
  undo: 'scene:undo',
  redo: 'scene:redo',
  save: 'scene:save',
  listPrefabs: 'prefabs:list',

  // ── Patch (Step 4) ──────────────────────────────────────────────────────
  /**
   * Parse an AI reply into a preview. Writes nothing.
   *
   * Separate from `applyPatch` on purpose. The developer must be able to see
   * what a patch *would* do — every file, the diff, the syntax verdict, and
   * exactly which block would fail and why — before anything touches disk. A
   * preview channel that shares its code path with the writer is a writer that
   * can be one bug away from previewing and applying in the same click.
   */
  previewPatch: 'patch:preview',
  /** Write a patch. All-or-nothing: one failure means no file is written. */
  applyPatch: 'patch:apply',
  /** The patch history for the open project, newest first. */
  patchHistory: 'patch:history',

  // ── Context (Step 4) ────────────────────────────────────────────────────
  compileContext: 'context:compile',
  /**
   * Rank files for an issue, without compiling a prompt.
   *
   * The Context screen shows the ranked list with a checkbox per file and
   * recompiles when the developer ticks one, so ranking has to be a separate,
   * cheap request rather than something inferred from a compiled prompt.
   */
  rankFiles: 'context:rank',

  // ── Brief (Step 4) ──────────────────────────────────────────────────────
  /** Build `brief.md` and write it under `.contextforge/`. */
  generateBrief: 'brief:generate',
  /** Read `brief.md` if it already exists. */
  readBrief: 'brief:read',
} as const;

/** One channel name. */
export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];

/** Push events, main → renderer via `webContents.send`. */
export const EVENTS = {
  /** An AI or an external tool changed `scene.json`. The renderer must reload. */
  sceneChangedOnDisk: 'scene:changedOnDisk',
  /** A prefab file was added, edited or deleted. The registry was rebuilt. */
  prefabsChanged: 'prefabs:changed',
  /** A long operation finished or failed. Carries a human-readable message. */
  notice: 'app:notice',
} as const;

/** One push event name — the *value* of the entry, e.g. `scene:changedOnDisk`. */
export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/**
 * One push event name as a TypeScript key, e.g. `sceneChangedOnDisk`.
 *
 * Distinct from `EventName`, and the two are easy to confuse: `EVENTS` is keyed
 * by identifier but its values are the channel strings. A generic constrained by
 * the wrong one resolves `EventPayload` to `never`, which surfaces as a baffling
 * "not assignable to parameter of type 'never'" at the call site rather than as
 * an error where the mistake is. So the key form has its own name.
 */
export type EventKey = keyof typeof EVENTS;

/** The payload of `scene:changedOnDisk`. */
export interface SceneChangedOnDisk {
  /** True when the on-disk file is now valid, so a reload will succeed. */
  valid: boolean;
  /** Empty when valid; otherwise the validation errors, each naming a JSON path. */
  problems: string[];
}

/** The payload of `prefabs:changed`. */
export interface PrefabsChanged {
  registry: PrefabRegistryResult;
}

/** The payload of `app:notice`. */
export interface Notice {
  level: 'info' | 'warning' | 'error';
  message: string;
}

// ── Patch (Step 4) ───────────────────────────────────────────────────────────

/**
 * One file a patch would write, as the developer reviews it.
 *
 * `diff` is a unified diff computed by core's `diff.ts`, and it is computed
 * **against the file on disk right now**, not against a cached copy — so what the
 * developer approves is what will be written, and a patch aimed at a file that
 * changed underneath them produces a different diff rather than silently
 * overwriting the newer content.
 */
export interface PatchFilePreview {
  /** Project-relative path. */
  path: string;
  /** Unified diff. Empty for a file the patch does not change. */
  diff: string;
  /** True when the file does not exist yet and the patch would create it. */
  created: boolean;
  /** True when the patch is all-or-nothing blocked by this file's syntax error. */
  syntaxFailed: boolean;
  /** The pre-save syntax verdict for this file's final content. */
  syntax: { valid: boolean; message: string; line: number | null };
}

/** One `### EDIT:` block the patch engine could not resolve. */
export interface PatchBlockFailure {
  path: string;
  /** Which block within the file, so a developer can count to it. */
  index: number;
  /** The FIND text that found nothing, truncated for display. */
  find: string;
  /** Core's own sentence, verbatim. Never rewritten. */
  reason: string;
}

/**
 * Everything the Patch screen renders before anyone clicks Apply.
 *
 * `failedBlocks` is the whole point of a preview: a developer who cannot see
 * *which* block is broken and *why* cannot judge whether to apply the rest, and
 * an ambiguous-snippet refusal (core's `finder.ts`) is the single most likely
 * outcome of pasting an LLM's patch. Showing the reason is what turns "it didn't
 * work" into "ask the AI for more surrounding context".
 */
export interface PatchPreview {
  files: PatchFilePreview[];
  /** Blocks that would fail. Empty means every block resolved. */
  failedBlocks: PatchBlockFailure[];
  /** Blocks that were already applied — re-pasting the same reply is safe. */
  alreadyApplied: number;
  /**
   * True when at least one file would be written and nothing refused it.
   *
   * Apply stays disabled when false, and the screen says why. A button that is
   * enabled and then refuses is worse than one that is disabled with a reason.
   */
  applicable: boolean;
  /** True when the syntax pre-check refused, and `applyAnyway` may override. */
  canApplyAnyway: boolean;
  /** A complete sentence explaining why `applicable` is false, if it is. */
  blockedReason: string;
  /** Blocks parsed. `### FILE:` blocks count as one write each. */
  blockCount: number;
}

/** What a patch actually did. */
export interface PatchApplyResult {
  /** Project-relative paths written. */
  files: string[];
  /** Files that did not exist before. */
  created: string[];
  /** How many `### EDIT:` blocks resolved. */
  applied: number;
  /** One history step was recorded; its id, so the screen can show it. */
  patchId: string;
  /** Undo depth after this write, so the screen enables Undo correctly. */
  canUndo: boolean;
  undoCount: number;
}

/** One entry of the patch undo history. */
export interface PatchHistoryEntry {
  patchId: string;
  description: string;
  files: string[];
  timestamp: number;
}

/**
 * What one undo or redo actually did.
 *
 * `snapshot` is the scene re-read from disk, because an undo rewrites the scene
 * file behind the renderer's back. `paths` is the set of project-relative files
 * the step wrote or deleted, which the screen shows so the developer can tell
 * which files moved rather than being told that "changes were reverted".
 */
export interface HistoryActionOutcome {
  snapshot: SceneSnapshot;
  /** Files written or deleted by this step, in the order the step recorded them. */
  paths: string[];
  /** The step's id, e.g. "PATCH #003". Empty when the action reported no step. */
  patchId: string;
  canUndo: boolean;
  canRedo: boolean;
  undoCount: number;
  redoCount: number;
}

// ── Context (Step 4) ─────────────────────────────────────────────────────────

/** One file the ranker considers relevant, as the checkbox list renders it. */
export interface RankedFileRow {
  /** Project-relative path. */
  file: string;
  score: number;
  /** The line the stack trace pointed at, when it gave one. */
  line: number | null;
  /** Why the ranker chose it. This is the developer's only clue when it is wrong. */
  reason: string;
  /** True for the files attached automatically. */
  isTop: boolean;
}

/**
 * A compiled prompt, plus everything the screen must show beside it.
 *
 * `tokens` is explicitly a rough estimate and is never presented as exact —
 * `compileContext` computes it as characters/4, which is the right order of
 * magnitude and the wrong number. A developer who catches it being off will stop
 * trusting the savings figure beside it too.
 */
export interface CompiledPrompt {
  prompt: string;
  /** What was asked for and could not be found. Never hidden. */
  gaps: string[];
  /** Rough token estimate. */
  tokens: number;
  /** Characters in the prompt. */
  chars: number;
  /** What whole-file attachment would have cost. */
  fullChars: number;
  /** How much slicing saved, as a percentage. */
  savingsPercent: number;
  /** The files that went in, in order. */
  sections: Array<{ file: string; kind: string; reason: string }>;
}

/**
 * The marker an AI uses to say "I cannot see enough to answer".
 *
 * Matched case-insensitively on the leading phrase, with a colon and at least one
 * character after it. This is a **lexical** concern on AI prose, not a question
 * of what code means, so a bounded pattern is the right tool here (SPEC R5
 * permits exactly this case).
 */
export interface ContextInsufficient {
  /** True when the reply asked for more context. */
  detected: boolean;
  /** The verbatim text after the marker, one entry per requested item. */
  requested: string[];
  /**
   * Requested paths that do not exist in the project.
   *
   * Reported rather than dropped: an AI asking for `src/nope.js` is either wrong
   * about the layout or the developer renamed something, and silently ignoring
   * it produces a recompiled prompt missing exactly what was asked for — the
   * failure this mechanism exists to prevent.
   */
  missing: string[];
}

// ── Brief (Step 4) ───────────────────────────────────────────────────────────

/** Which brief the developer asked for. */
export type BriefMode = 'oneShot' | 'interactive';

/** A generated brief, and where it landed. */
export interface BriefResult {
  /** Project-relative path. Always `.contextforge/brief.md`. */
  path: string;
  /** The markdown, so the screen can show it without a second round trip. */
  markdown: string;
  mode: BriefMode;
  /** What went in: node count, edge count, prefab and instance counts. */
  stats: { nodes: number; edges: number; prefabs: number; instances: number };
}

/** The map of request channel → its argument and result types. */
export interface IpcRequests {
  /** Open a project by absolute path. Rejects a path that is not a directory. */
  [CHANNELS.openProject]: {
    request: { root: string };
    response: Result<SceneSnapshot>;
  };
  /**
   * Show the native folder picker; the response is the chosen folder.
   *
   * ## Why this channel carries no path
   *
   * A channel shaped `{ request: { root: string } }` would let the renderer name
   * any directory on the developer's disk, and the renderer is exactly the part
   * of this app that loads JSON written by a language model and modules written
   * by prefabs. Taking no argument makes the only folder this channel can ever
   * return one a human chose in an OS dialog — and that is what the main process
   * then opens. It is the whole reason this replaced a hidden
   * `<input type="file" webkitdirectory>` in the renderer, whose `File.path`
   * trick does not exist any more under `sandbox: true` (see `electron/main.ts`).
   *
   * ## `null` is an answer, not a failure
   *
   * The dialog's `canceled` flag becomes `ok(null)`. Dismissing a file dialog is
   * something a user does dozens of times a day without thinking, so reporting it
   * as `ok: false` would put a red error on screen for the ordinary act of
   * changing their mind. A failure here means the dialog itself could not be
   * shown — that is a real problem, and it is a refusal with a sentence.
   */
  [CHANNELS.pickFolder]: { request: Record<string, never>; response: Result<string | null> };
  /** Close the open project and stop watching it. */
  [CHANNELS.closeProject]: { request: Record<string, never>; response: Result<null> };
  /** Re-read `scene.json` from disk, discarding unsaved changes. */
  [CHANNELS.loadScene]: { request: Record<string, never>; response: Result<SceneSnapshot> };
  /**
   * Apply one scene edit, save it, and record one undo step.
   *
   * The whole edit travels in one message so the main process can validate and
   * write it as a single transaction. The renderer must not send a move and a
   * rotate as two edits unless it wants two undo steps.
   */
  [CHANNELS.applyEdit]: { request: { edit: SceneEdit }; response: Result<SceneSnapshot> };
  /**
   * Undo the last step.
   *
   * The response carries `paths` as well as the snapshot because the answer to
   * "what did that button just do?" has to name the files. A re-read snapshot
   * alone leaves the screen saying "previous changes were reverted", which is
   * indistinguishable from a no-op that reverted something else — and a
   * developer who cannot tell which files moved will not trust the next undo.
   */
  [CHANNELS.undo]: { request: Record<string, never>; response: Result<HistoryActionOutcome> };
  [CHANNELS.redo]: { request: Record<string, never>; response: Result<HistoryActionOutcome> };
  /**
   * Write the current scene to disk.
   *
   * Edits are already written when applied (SPEC R9: an invalid scene never
   * lands on disk), so this is an explicit flush and a confirmation rather than
   * the only write. It exists so the developer has a Save that means something.
   */
  [CHANNELS.save]: { request: Record<string, never>; response: Result<SceneSnapshot> };
  /** The prefab registry, rebuilt from `prefabs/index.ts`. */
  [CHANNELS.listPrefabs]: { request: Record<string, never>; response: Result<PrefabRegistryResult> };
  /**
   * Compile a handoff prompt for the Context screen.
   *
   * `files` are extra paths the developer ticked, or that an AI asked for with
   * `NEED:`. They are **added to** the ranked selection rather than replacing
   * it, because "also show me this file" is additive in intent — replacing the
   * ranking would silently drop the file the stack trace pointed at, which is
   * the one the developer least wants lost.
   *
   * The previous shape returned `{ prompt, gaps, savingsPercent }` only. Step 4
   * shows a token estimate and a savings figure beside each other, and a screen
   * cannot render a number it was never sent.
   */
  [CHANNELS.compileContext]: {
    request: {
      issue: string;
      logs: string;
      targetFile?: string;
      targetLine?: number;
      /** Extra project-relative paths to attach. */
      files?: string[];
      /** Attach whole files instead of slices. Costs far more tokens. */
      fullFiles?: boolean;
    };
    response: Result<CompiledPrompt>;
  };

  // ── Patch ───────────────────────────────────────────────────────────────

  /**
   * Parse an AI reply and report what it would do. Writes nothing.
   *
   * The AI reply is pasted text, so it is attacker-shaped input in the same way
   * `scene.json` is: the main process parses it with core's patch engine and
   * reports the outcome. The renderer never interprets a block itself.
   *
   * ## Why a path in the reply cannot escape the project
   *
   * `normalizePatchPath` refuses an absolute path and one that climbs out with
   * `..`. This is enforced by core, and it is the reason the renderer may be
   * allowed to paste arbitrary text into a channel that writes files: a reply
   * containing `### FILE: ../../../.bashrc` is **refused**, not sanitised. A
   * sanitiser that rewrote the path would apply a patch to a file the AI did not
   * name, which is worse than refusing.
   */
  [CHANNELS.previewPatch]: { request: { text: string }; response: Result<PatchPreview> };

  /**
   * Apply a pasted AI reply. All-or-nothing.
   *
   * `applyAnyway` is a deliberate second click, never a default: it exists for
   * the case where the syntax pre-check is right about a construct core has no
   * grammar for. A default of `false` is the whole safety property (SPEC R9).
   *
   * Records **exactly one** history step, so one Apply is one Undo. A patch
   * touching four files that needs four Undos is a patch a developer cannot
   * reason about.
   */
  [CHANNELS.applyPatch]: {
    request: { text: string; applyAnyway?: boolean };
    response: Result<PatchApplyResult>;
  };

  /** The patch history, newest first. At most 20 entries (core's cap). */
  [CHANNELS.patchHistory]: {
    request: Record<string, never>;
    response: Result<{ entries: PatchHistoryEntry[]; canUndo: boolean; canRedo: boolean }>;
  };

  // ── Context ─────────────────────────────────────────────────────────────

  /**
   * Rank files for an issue without compiling a prompt.
   *
   * Separate from `compileContext` because the screen shows the ranking *first*
   * and recompiles when a checkbox changes. Recompiling to discover the ranking
   * would cost a full prompt build per tick.
   */
  [CHANNELS.rankFiles]: {
    request: { issue: string; logs: string };
    response: Result<{ files: RankedFileRow[] }>;
  };

  // ── Brief ───────────────────────────────────────────────────────────────

  /**
   * Build `brief.md` and write it under `.contextforge/`.
   *
   * `task` is appended only in `oneShot` mode. In `interactive` mode the brief
   * instead instructs the AI to reply `NEED: path` for anything missing, which
   * the Context screen detects and feeds back into `compileContext`. That is the
   * whole difference between the two modes and it is a real one: one-shot asks
   * the question now, interactive negotiates what is missing first.
   */
  [CHANNELS.generateBrief]: {
    request: { mode: BriefMode; task?: string };
    response: Result<BriefResult>;
  };

  /** Read `.contextforge/brief.md`; `ok(null)` when it does not exist yet. */
  [CHANNELS.readBrief]: {
    request: Record<string, never>;
    response: Result<{ path: string; markdown: string; mode: BriefMode } | null>;
  };
};

/**
 * A convenience type for one channel's argument.
 *
 * `IpcRequests[C]['request']` reads better at a call site than an indexed
 * access on a mapped type, and it keeps the channel name and its payload from
 * being spelled separately and drifting.
 */
export type IpcRequest<C extends keyof IpcRequests> = IpcRequests[C]['request'];

/** The result type for one channel. */
export type IpcResponse<C extends keyof IpcRequests> = IpcRequests[C]['response'];

/** Every request the UI can make. */
export type IpcChannel = keyof IpcRequests;

// ── Typed helpers ────────────────────────────────────────────────────────────

/**
 * The typed `invoke` the renderer uses.
 *
 * Declared as a parameter rather than imported directly so a test can supply a
 * fake and assert what the UI sends without an Electron runtime. The main
 * process must accept exactly these channels; `assertChannelMap` below is what
 * keeps the two ends in step.
 */
export interface IpcInvoker {
  invoke<C extends IpcChannel>(
    channel: C,
    request: IpcRequest<C>,
  ): Promise<IpcResponse<C>>;
}

/**
 * The typed `on` the renderer uses for push events.
 *
 * Constrained by the channel **value**, not the identifier, because a subscriber
 * writes `deps.listener(EVENTS.notice, …)` and `EVENTS.notice` is the string
 * `'app:notice'`. Constraining by `keyof typeof EVENTS` there rejects every call
 * with a message about an unrelated union — which is exactly the confusion D18
 * records, so this signature is the one the store actually uses.
 */
export type IpcListener = <V extends EventName>(
  event: V,
  handler: (payload: EventPayloadFor<V>) => void,
) => () => void;

/**
 * The listener shape keyed by identifier instead.
 *
 * Kept because it reads better where the event is named as a literal key rather
 * than taken from `EVENTS`, and because `AllEventPayloads` below is the
 * exhaustiveness guard that depends on it.
 */
export type IpcListenerByKey = <E extends keyof typeof EVENTS>(
  event: E,
  handler: (payload: EventPayload<E>) => void,
) => () => void;

/** The payload type for one push event. */
export type EventPayload<E extends keyof typeof EVENTS> =
  E extends typeof EVENTS.sceneChangedOnDisk ? SceneChangedOnDisk
  : E extends typeof EVENTS.prefabsChanged ? PrefabsChanged
  : E extends typeof EVENTS.notice ? Notice
  : never;

/**
 * Every event payload, for a type-level exhaustiveness check.
 *
 * `EventPayload` resolves to `never` for an unlisted event, so adding an event
 * without a payload here is a compile error rather than a `never` arriving at a
 * handler that cannot switch on it.
 */
export type AllEventPayloads = {
  [E in keyof typeof EVENTS]: EventPayload<E>;
};

/**
 * Event payload, keyed by the channel **value** rather than by its identifier.
 *
 * `EVENTS` is written as an object, so `EVENTS.notice` is the string
 * `'app:notice'`. A sender therefore has the value in hand, not the key — and a
 * generic constrained by `EventKey` would reject every call site with a message
 * about the wrong union, pointing nowhere near the mistake. `EventPayload<E>`
 * (keyed by identifier) and this (keyed by value) both exist because both are
 * needed: the listener API receives names from its own table, while a sender
 * passes whatever `EVENTS.x` evaluated to.
 *
 * Adding an entry to `EVENTS` without adding one here is a compile error at every
 * call site that sends it, which is the point.
 */
export interface EventPayloadByName {
  'app:notice': Notice;
  'prefabs:changed': PrefabsChanged;
  'scene:changedOnDisk': SceneChangedOnDisk;
}

/** The payload one event's channel value must carry. */
export type EventPayloadFor<V extends EventName> = EventPayloadByName[V];

// ── Editor affordances ───────────────────────────────────────────────────────

/**
 * Keyboard shortcuts the viewport must implement.
 *
 * Declared here because they are part of the contract between the developer and
 * the app, not a detail of one component. The end-to-end test asserts these
 * bindings exist, so a refactor that drops `F` is caught.
 */
export const VIEWPORT_KEYS = {
  move: 'w',
  rotate: 'e',
  scale: 'r',
  toggleSpace: 'q',
  focus: 'f',
} as const;

/** Which gizmo TransformControls is showing. */
export type GizmoMode = 'translate' | 'rotate' | 'scale';

/**
 * Translate a viewport key to its mode.
 *
 * Shared so the shortcut table and the key handler cannot disagree: the handler
 * looks the binding up here rather than switching on its own literals.
 */
export function gizmoModeForKey(key: string): GizmoMode | 'toggle-space' | 'focus' | null {
  const lower = key.toLowerCase();
  if (lower === VIEWPORT_KEYS.move) return 'translate';
  if (lower === VIEWPORT_KEYS.rotate) return 'rotate';
  if (lower === VIEWPORT_KEYS.scale) return 'scale';
  if (lower === VIEWPORT_KEYS.toggleSpace) return 'toggle-space';
  if (lower === VIEWPORT_KEYS.focus) return 'focus';
  return null;
}

/** What a user is doing in the viewport, so the inspector can stay in step. */
export type Selection = { kind: 'instance'; id: string } | { kind: 'none' };

/** The editor state the Svelte store holds. One shape, one owner. */
export interface EditorState {
  snapshot: SceneSnapshot | null;
  selection: Selection;
  gizmo: GizmoMode;
  /** Local vs world space for the gizmo. */
  space: 'world' | 'local';
  /** Grid increment used when snapping is on, in scene units. */
  snap: number | null;
}

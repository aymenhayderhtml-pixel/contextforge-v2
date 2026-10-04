/**
 * renderer/store.ts — the editor store. The single owner of scene state.
 *
 * ## The one rule
 *
 * **Every mutation of the scene is an IPC `applyEdit`, and the returned
 * `SceneSnapshot` replaces the state whole.** There is no optimistic update and no
 * second copy. The renderer's job is to say what should change; the main process
 * validates it, writes it, records one undo step and sends back what is now true.
 *
 * That is not a style preference, it is the only arrangement that can be correct
 * in the situation this app exists for: the developer and an AI are editing the
 * same `scene.json`. An optimistic local edit is a value the renderer believes and
 * the file does not, and the two drift apart silently — the gizmo shows an object
 * at a position the scene does not have, the developer's next edit is computed from
 * the wrong parent, and nothing complains. One copy, replaced from the authority,
 * cannot drift.
 *
 * It also makes undo trivially honest: `canUndo` is not a local guess about
 * whether a stack is deep enough, it is the count the main process reports.
 *
 * ## What the store owns, and what it does not
 *
 * It owns `EditorState` — snapshot, selection, gizmo mode, space, snap — plus the
 * transient `Notices` list and the path being typed on the Project screen. It does
 * not own the scene: that lives in the main process, and the snapshot here is a
 * rendered copy of the file, not a cache of it.
 *
 * ## Testable without Electron
 *
 * Both the invoker and the listener are injected. A test passes a fake
 * `IpcInvoker` and a fake `IpcListener` and gets the real store, exercising the
 * real logic — edit-then-snapshot, undo, a disk change arriving — with no Electron
 * and no browser. That is the same injection point `ipc.ts` was written for.
 */

import type { SceneEdit } from '@contextforge/core';
import {
  CHANNELS,
  fail,
  EVENTS,
  type EditorState,
  type EventName,
  type IpcChannel,
  type IpcInvoker,
  type IpcListener,
  type IpcRequest,
  type IpcResponse,
  type Result,
  type EventPayloadFor,
  type GizmoMode,
  type HistoryActionOutcome,
  type Notice,
  type Notice as NoticePayload,
  type PrefabRegistryResult,
  type SceneSnapshot,
  type Selection,
} from '../ipc.js';
import { get, set, state, type Source } from './runes.js';

/** How long a notice stays on screen. Long enough to read a two-line refusal. */
const NOTICE_TTL_MS = 6000;

/** The most notices kept at once, so a chatty event cannot grow the list forever. */
const MAX_NOTICES = 5;

/** What one completed undo or redo touched. */
export interface HistoryActionPaths {
  /** Project-relative files written or deleted, in the step's own order. */
  paths: string[];
  /** The step's id, e.g. "PATCH #003". Empty when the action named no step. */
  patchId: string;
}

/** What the store exposes. Read through the accessors, not the raw sources. */
/**
 * The success arm of a `Result<T>`, whatever `T` is.
 *
 * `Result<T>` is `{ ok: true; value: T } | { ok: false; reason: string }`, so the
 * success arm carries `value`. `Extract<Result<T>, { ok: true }>['value']` would
 * say the same thing, but it is written here as a named type because it is used in
 * three signatures and the inline form is long enough to hide the argument it
 * applies to.
 */
export type SuccessOf<R> = Extract<R, { ok: true }> extends { value: infer V } ? V : never;

export interface EditorStore {
  /** The whole state object, as a plain value. */
  readonly current: EditorState;
  readonly snapshot: SceneSnapshot | null;
  readonly selection: Selection;
  readonly gizmo: GizmoMode;
  readonly space: 'world' | 'local';
  readonly snap: number | null;
  /** True while a request is in flight, so buttons can say so. */
  readonly busy: boolean;
  /**
   * Messages for the developer: refusals, warnings, disk changes. Newest last.
   *
   * `LiveNotice[]`, not `Notice[]`, because the screen reads `notice.id` to key
   * and dismiss each one. `Notice` is the IPC payload and has no `id` — the store
   * mints one in `pushNotice`. Typing this as `readonly Notice[]` said `id` did
   * not exist on every `{#each visibleNotices as notice (notice.id)}` in
   * `App.svelte`, six times, and it was correct: the values have ids and the type
   * did not say so.
   */
  readonly notices: readonly LiveNotice[];

  // ── Project ────────────────────────────────────────────────────────────
  openProject(root: string): Promise<boolean>;
  /**
   * Show the OS folder picker; the path the user chose, or `null` for a cancel.
   *
   * This is the single renderer-side entry point to the filesystem for choosing
   * a project, which is why it is here and not in a component: the store is the
   * owner of renderer↔main requests, so a component that needed a folder would
   * end up reaching for `invoker` itself, and the boundary would grow a second
   * door.
   *
   * `null` and `undefined` both mean the user declined — a cancel is a normal
   * outcome, so neither pushes a notice nor changes any state. Callers must
   * therefore treat "no path" as "do nothing", never as a failure.
   */
  pickFolder(): Promise<string | null>;
  closeProject(): Promise<void>;
  reloadScene(): Promise<boolean>;
  save(): Promise<boolean>;
  listPrefabs(): Promise<PrefabRegistryResult | null>;

  /**
   * Send one typed IPC request and return its result.
   *
   * ## Why a screen calls this rather than having a method per channel
   *
   * The Patch, Context and Brief screens each need several channels, and each
   * channel's screen-specific state (which file is ticked, which brief mode is
   * selected) belongs to the component, not to the store. Giving every new
   * channel a hand-written store method would put presentation state in the one
   * file that is supposed to hold only `EditorState` — and it would mean three
   * screens contending for one file.
   *
   * This is the same seam `createEditorStore`'s injected `IpcInvoker` already
   * provides, exposed with its types intact. It is **not** an escape hatch: the
   * channel name and both payload types are checked against `IpcRequests`, so a
   * wrong argument or a misused result is a compile error. What it deliberately
   * does *not* provide is a path the store did not intend — there is no
   * "execute arbitrary code" channel and no way to name a file outside the open
   * project, exactly as `ipc.ts` documents.
   */
  requestChannel<C extends IpcChannel>(
    channel: C,
    payload: IpcRequest<C>,
  ): Promise<IpcResponse<C>>;
  /** An IPC refusal's sentence, or `null` on success. The screen decides how to show it. */
  refusalOf<C extends IpcChannel>(result: IpcResponse<C>): string | null;
  /**
   * The success arm of a `Result`, or `null` for a refusal. See the implementation
   * for why this exists rather than a discriminant check at each call site.
   */
  valueOf<R>(result: R): SuccessOf<R> | null;

  // ── Scene ──────────────────────────────────────────────────────────────
  /**
   * Apply one edit and adopt the resulting snapshot.
   *
   * Returns false and leaves the state untouched when the edit was refused. The
   * refusal's sentence is pushed to `notices` and shown verbatim, which is the
   * whole of how a refused edit is surfaced — see the module docstring.
   */
  applyEdit(edit: SceneEdit): Promise<boolean>;
  /**
   * Undo the last step, adopting the scene it rewrote.
   *
   * Resolves to the files the step actually touched, or `null` when there was
   * nothing to undo. The paths are the point: a screen that only learns "an undo
   * happened" cannot tell the developer which files moved, and "previous changes
   * were reverted" is indistinguishable from a no-op that reverted something
   * else.
   */
  undo(): Promise<HistoryActionPaths | null>;
  redo(): Promise<HistoryActionPaths | null>;

  // ── Selection and viewport affordances ─────────────────────────────────
  select(selection: Selection): void;
  /** Select by id, or deselect everything when the id is `null`. */
  selectInstance(id: string | null): void;
  setGizmo(mode: GizmoMode): void;
  setSpace(space: 'world' | 'local'): void;
  /** `null` turns snapping off. */
  setSnap(increment: number | null): void;
  toggleSpace(): void;

  // ── Notices ────────────────────────────────────────────────────────────
  notice(notice: Notice): void;
  dismissNotice(id: number): void;
  clearNotices(): void;

  // ── Lifecycle ──────────────────────────────────────────────────────────
  /** Subscribe to main-process push events. Returns an unsubscribe function. */
  connect(): () => void;
  /** Release everything. For tests and for `onDestroy`. */
  destroy(): void;
}

/** The bridge shape the preload exposes. Declared here, structurally, not imported. */
interface Bridge {
  invoke(channel: string, request: unknown): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): () => void;
}

/**
 * The name the preload uses to expose the bridge on `window`.
 *
 * Declared in `preload.cts` as `BRIDGE_NAME` — that file is the one source of
 * truth, and this constant documents that the store agrees with it. The two must
 * match or every IPC call silently fails; `contract.test.ts` asserts both sides
 * contain this string so neither can be changed without the test failing.
 */
const BRIDGE_NAME = 'contextforge';

/** The `window.contextforge` the preload installed. */
interface RendererWindow extends Window {
  readonly [BRIDGE_NAME]?: Bridge;
}

/** One live notice. */
interface LiveNotice extends Notice {
  /** Stable for the notice's life, so it can be dismissed and keyed. */
  id: number;
  /** When it arrived. `Date.now()` here is presentation, not extracted data. */
  at: number;
}

/** The injected ends. Both are structural, so a test can supply fakes. */
export interface StoreDeps {
  /** How the store sends requests. In the app, the preload bridge. */
  invoker: IpcInvoker;
  /** How the store receives push events. */
  listener: IpcListener;
  /** Timers, injected so a test need not wait six seconds. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * The invoker the real renderer uses.
 *
 * Built from the preload bridge rather than from `ipcRenderer` directly, because
 * `nodeIntegration: false` means the renderer has no `ipcRenderer` at all — the
 * preload is the only thing that does. The bridge is untyped by design (see
 * `preload.cts`), so this is the one place a cast stands between the renderer and
 * the main process.
 *
 * It is a narrow, deliberate hole: the *call sites* are fully checked against
 * `ipc.ts`, because they go through `IpcInvoker` with a real channel name and a
 * real request type. What is unchecked is only that the string arriving from the
 * other side of the bridge is the channel it claims to be — which is exactly the
 * job of `registerHandlers` in the main process, and it checks it at startup.
 *
 * Throws when the bridge is missing rather than returning a rejected result: if
 * the preload did not run, the app cannot work at all, and that is a startup
 * failure to be reported plainly rather than a per-click error message.
 */
function bridgeInvoker(): IpcInvoker {
  const bridge = (globalThis as unknown as RendererWindow)[BRIDGE_NAME];
  if (bridge === undefined) {
    throw new Error(
      `window.${BRIDGE_NAME} is missing — the preload script did not run. ` +
        'Check `preload` in the BrowserWindow webPreferences.',
    );
  }
  // The bridge is untyped across the process boundary (`preload.cts` knows
  // nothing about the app, deliberately). The cast lives exactly here, at the
  // one crossing; every call above it is checked by `IpcInvoker`.
  return {
    invoke: <C extends IpcChannel>(channel: C, request: IpcRequest<C>) =>
      bridge.invoke(channel, request) as Promise<IpcResponse<C>>,
  };
}

/** The listener the real renderer uses, from the same bridge. */
function bridgeListener(): IpcListener {
  const bridge = (globalThis as unknown as RendererWindow)[BRIDGE_NAME];
  if (bridge === undefined) {
    throw new Error(
      `window.${BRIDGE_NAME} is missing — the preload script did not run. ` +
        'Check `preload` in the BrowserWindow webPreferences.',
    );
  }
  return <V extends EventName>(event: V, handler: (p: EventPayloadFor<V>) => void) =>
    bridge.on(event, (payload) => {
      handler(payload as EventPayloadFor<V>);
    });
}

/**
 * Build a store.
 *
 * A factory rather than a module-level singleton so a test gets a fresh one with
 * no shared history and no teardown order to think about. `store.ts` exports
 * `createEditorStore`, and the app's entry point creates the one real store and
 * hands it to the root component.
 */
export function createEditorStore(deps: StoreDeps): EditorStore {
  const now = deps.now ?? ((): number => Date.now());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ??
    ((handle: unknown): void => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });

  // ── State ───────────────────────────────────────────────────────────────
  //
  // One source for the whole of `EditorState`, so replacing the state is one
  // write and there is no question of which of four sources is authoritative.
  const editorState: Source<EditorState> = state<EditorState>({
    snapshot: null,
    selection: { kind: 'none' },
    gizmo: 'translate',
    space: 'world',
    snap: null,
  });

  const busySource = state(false);
  const noticesSource = state<LiveNotice[]>([]);
  const noticesTimers = new Map<number, unknown>();

  let noticeCounter = 0;
  let unsubscribes: Array<() => void> = [];
  let destroyed = false;

  // ── Reading ─────────────────────────────────────────────────────────────

  /**
   * One place the whole `EditorState` is read.
   *
   * Returning a fresh object on every read is deliberate: a component that read
   * `store.current` and held the result would hold a snapshot that never updates,
   * which is the second copy this module exists to prevent.
   */
  function current(): EditorState {
    return get(editorState);
  }

  /** Replace the state, keeping the parts of it that are not the snapshot. */
  function adopt(snapshot: SceneSnapshot | null): void {
    const previous = get(editorState);
    set(editorState, { ...previous, snapshot });
    reconcileSelection(snapshot, previous.selection);
  }

  /**
   * Drop a selection whose instance no longer exists.
   *
   * An `applyEdit` that removed the selected object returns a snapshot without
   * it. Keeping the selection would leave the inspector showing a transform for an
   * object that is not in the scene, and the next edit would be a refusal naming
   * an id the developer can no longer see — a loop with no way out. Deselecting is
   * the only state that cannot be wrong.
   */
  function reconcileSelection(snapshot: SceneSnapshot | null, selection: Selection): void {
    if (selection.kind !== 'instance' || snapshot === null) return;
    const stillThere = snapshot.scene.instances.some((i) => i.id === selection.id);
    if (stillThere) return;
    set(editorState, { ...get(editorState), selection: { kind: 'none' } });
  }

  // ── Notices ─────────────────────────────────────────────────────────────

  function pushNotice(notice: Notice): void {
    noticeCounter += 1;
    const id = noticeCounter;
    const live: LiveNotice = { id, at: now(), level: notice.level, message: notice.message };
    const next = [...get(noticesSource), live].slice(-MAX_NOTICES);
    set(noticesSource, next);

    const handle = setTimer(() => {
      noticesTimers.delete(id);
      removeNotice(id);
    }, NOTICE_TTL_MS);
    noticesTimers.set(id, handle);
  }

  function removeNotice(id: number): void {
    const handle = noticesTimers.get(id);
    if (handle !== undefined) {
      clearTimer(handle);
      noticesTimers.delete(id);
    }
    set(noticesSource, get(noticesSource).filter((n) => n.id !== id));
  }

  // ── Requests ────────────────────────────────────────────────────────────

  /**
   * Run one request, with the busy flag and the guarantee that it cannot throw.
   *
   * Three layers, each for a different reason:
   *
   *  - `busy` is set around the await so the UI can disable its buttons, and
   *    cleared in a `finally` so a rejection cannot leave it stuck on;
   *  - a `Result` failure becomes a notice and `false`, which is the ordinary way
   *    a request fails — a refused edit is a message, not an error (SPEC D15);
   *  - a *thrown* rejection should not happen, because the main process returns
   *    `Result` for everything. It is still caught, and reported as a warning,
   *    because the alternative is an unhandled rejection that kills the renderer
   *    with a message written for a stack trace.
   */
  async function request<T>(
    label: string,
    send: () => Promise<{ ok: boolean; value?: T; reason?: string }>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    set(busySource, true);
    try {
      const result = await send();
      if (result === null || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        // A handler that answered with something that is not a `Result` is a
        // contract break, and it is far better to say so than to read `.value`
        // from it and render `undefined`.
        pushNotice({
          level: 'error',
          message: `${label} returned something that is not a result. The app and the main process disagree.`,
        });
        return { ok: false };
      }
      if (!result.ok) {
        pushNotice({
          level: 'error',
          message: result.reason ?? `${label} failed for an unknown reason.`,
        });
        return { ok: false };
      }
      return { ok: true, value: result.value as T };
    } catch (error) {
      pushNotice({
        level: 'error',
        message: `${label} could not reach the main process: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return { ok: false };
    } finally {
      set(busySource, false);
    }
  }

  // ── Store ───────────────────────────────────────────────────────────────

  const store: EditorStore = {
    get current() {
      return current();
    },
    get snapshot() {
      return current().snapshot;
    },
    get selection() {
      return current().selection;
    },
    get gizmo() {
      return current().gizmo;
    },
    get space() {
      return current().space;
    },
    get snap() {
      return current().snap;
    },
    get busy() {
      return get(busySource);
    },
    get notices() {
      return get(noticesSource);
    },

    async openProject(root) {
      const trimmed = root.trim();
      if (trimmed === '') {
        pushNotice({ level: 'warning', message: 'Enter the path to a project folder first.' });
        return false;
      }
      const result = await request<SceneSnapshot>('Opening the project', () =>
        deps.invoker.invoke(CHANNELS.openProject, { root: trimmed }),
      );
      if (!result.ok) return false;

      // A new project starts with nothing selected: a selection from the previous
      // project would name an id that means nothing here.
      set(editorState, {
        snapshot: result.value,
        selection: { kind: 'none' },
        gizmo: 'translate',
        space: 'world',
        snap: null,
      });

      // Problems from opening are reported in snapshot.problems and displayed in the
      // Problems panel, not as popup toast notices.
      return true;
    },

    /**
     * Ask the main process to show the folder picker.
     *
     * The `ok(false)` branch — the dialog could not be shown — *does* push a
     * notice, because that is a real fault the developer can act on and there is
     * nothing else on screen saying so.
     *
     * The `ok(true)` branch with a `null` value is the cancel, and it is silent:
     * no notice, no busy flag left on, no state touched. A user who dismissed a
     * dialog did nothing wrong, and an error toast for it would train them to
     * ignore errors that matter (SPEC R9 is about loud *failures*, not about
     * reporting decisions the user made).
     *
     * The extra `typeof === 'string'` guard is not paranoia about the union:
     * `request` reads `.value` off a shape the main process filled in, and a
     * contract break there must surface as "no folder" rather than as a raw
     * object rendered into a text input as `[object Object]`.
     */
    async pickFolder() {
      const result = await request<string | null>('Choosing a folder', () =>
        deps.invoker.invoke(CHANNELS.pickFolder, {}),
      );
      if (!result.ok) return null;
      return typeof result.value === 'string' && result.value !== '' ? result.value : null;
    },

    /**
     * The typed seam for the Patch, Context and Brief screens.
     *
     * Named `requestChannel` rather than `request` because the private helper
     * above already owns that name with a different signature; two overloads of
     * one name across a value and a closure is a mistake waiting to happen.
     *
     * It deliberately does **not** funnel through the private `request` helper,
     * which pushes a notice on every refusal. These screens render their own
     * refusals inline — a failed preview beside the diff is more useful than a
     * toast that vanishes — so a refusal is returned untouched and it is the
     * screen's job to show `refusalOf(result)` where it belongs.
     *
     * `busy` is still tracked, because a screen's Apply button must not be
     * clickable while its request is in flight, and `busy` is the one flag every
     * component already reads.
     */
    async requestChannel<C extends IpcChannel>(
      channel: C,
      payload: IpcRequest<C>,
    ): Promise<IpcResponse<C>> {
      set(busySource, true);
      try {
        return await deps.invoker.invoke(channel, payload);
      } catch (error) {
        // The main process answers every channel with a `Result`, so a rejection
        // is a contract break rather than an ordinary failure. Returning a
        // refusal keeps it on the screen as a sentence instead of killing the
        // renderer with a message written for a stack trace (SPEC R9).
        return fail(
          `The main process did not answer ${channel}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        set(busySource, false);
      }
    },

    refusalOf<C extends IpcChannel>(result: IpcResponse<C>): string | null {
      return result.ok ? null : result.reason;
    },

    /**
     * Narrow a `Result` by returning its value, or `null` for a refusal.
     *
     * Exists because `refusalOf` cannot do this job. A method call cannot narrow a
     * union — TypeScript only narrows on a discriminant check written at the use
     * site — so every screen was written as
     *
     * ```ts
     * const reason = store.refusalOf(result);
     * if (reason !== null) { refusal = reason; return; }
     * entries = result.value.entries;   // error: 'value' does not exist on Result<...>
     * ```
     *
     * and `value` is a property of the success arm only. Six such errors across
     * PatchScreen and ContextScreen, all the same error, all reported by
     * `svelte-check` and invisible to `tsc` because it does not read `.svelte`.
     *
     * The alternative was `if (!result.ok) { ... return; }` at each of the six
     * sites, which works and needs no new method. It is not what was chosen,
     * because each of those sites wants the *reason* as well as the branch, and
     * `refusalOf` is how they get it. This returns both in one call, so a site
     * reads the refusal and the value from a single expression and the union is
     * narrowed once, in one place.
     *
     * Null rather than a thrown error, because every caller already handles the
     * refusal by putting it on screen and returning. A throw here would be a new
     * failure mode at six sites rather than a narrowing.
     */
    valueOf<R>(result: R): SuccessOf<R> | null {
      return (result as Result<unknown>).ok
        ? ((result as { value: unknown }).value as SuccessOf<R>)
        : null;
    },

    async closeProject() {
      const result = await request<null>('Closing the project', () =>
        deps.invoker.invoke(CHANNELS.closeProject, {}),
      );
      if (!result.ok) return;
      set(editorState, {
        snapshot: null,
        selection: { kind: 'none' },
        gizmo: 'translate',
        space: 'world',
        snap: null,
      });
    },

    async reloadScene() {
      const result = await request<SceneSnapshot>('Reloading the scene', () =>
        deps.invoker.invoke(CHANNELS.loadScene, {}),
      );
      if (!result.ok) return false;
      adopt(result.value);
      return true;
    },

    async save() {
      const result = await request<SceneSnapshot>('Saving the scene', () =>
        deps.invoker.invoke(CHANNELS.save, {}),
      );
      if (!result.ok) return false;
      adopt(result.value);
      pushNotice({ level: 'info', message: `Saved ${result.value.project.scenePath}.` });
      return true;
    },

    async listPrefabs() {
      const result = await request<PrefabRegistryResult>('Listing prefabs', () =>
        deps.invoker.invoke(CHANNELS.listPrefabs, {}),
      );
      return result.ok ? result.value : null;
    },

    // The old `compileContext` store method is gone. It returned
    // `{ prompt, gaps, savingsPercent } | null`, which cannot express the token
    // estimate and the file list the Context screen now shows, and `null` cannot
    // distinguish "refused" from "succeeded with nothing to say". The screen
    // calls `requestChannel(CHANNELS.compileContext, …)` and gets a `Result` it
    // can render either half of.

    async applyEdit(edit) {
      // Refused edits leave the state exactly as it was. Nothing to undo, nothing
      // to restore — because nothing was changed. That is why there is no
      // optimistic update to roll back.
      const result = await request<SceneSnapshot>(`Applying "${describeEdit(edit)}"`, () =>
        deps.invoker.invoke(CHANNELS.applyEdit, { edit }),
      );
      if (!result.ok) return false;
      adopt(result.value);
      return true;
    },

    async undo() {
      const result = await request<HistoryActionOutcome>('Undo', () =>
        deps.invoker.invoke(CHANNELS.undo, {}),
      );
      if (!result.ok) return null;
      adopt(result.value.snapshot);
      return {
        paths: result.value.paths,
        patchId: result.value.patchId,
      };
    },

    async redo() {
      const result = await request<HistoryActionOutcome>('Redo', () =>
        deps.invoker.invoke(CHANNELS.redo, {}),
      );
      if (!result.ok) return null;
      adopt(result.value.snapshot);
      return {
        paths: result.value.paths,
        patchId: result.value.patchId,
      };
    },

    select(selection) {
      set(editorState, { ...current(), selection });
    },

    selectInstance(id) {
      set(editorState, {
        ...current(),
        selection: id === null ? { kind: 'none' } : { kind: 'instance', id },
      });
    },

    setGizmo(mode) {
      set(editorState, { ...current(), gizmo: mode });
    },

    setSpace(space) {
      set(editorState, { ...current(), space });
    },

    setSnap(increment) {
      set(editorState, { ...current(), snap: increment });
    },

    toggleSpace() {
      const { space } = current();
      set(editorState, { ...current(), space: space === 'world' ? 'local' : 'world' });
    },

    notice: pushNotice,

    dismissNotice(id) {
      removeNotice(id);
    },

    clearNotices() {
      for (const handle of noticesTimers.values()) clearTimer(handle);
      noticesTimers.clear();
      set(noticesSource, []);
    },

    /**
     * Subscribe to the main process's push events.
     *
     * `EventPayloadFor` is used for every handler, so a payload type cannot drift
     * from the event it belongs to: adding an event without a payload makes this
     * a compile error rather than a `never` arriving at a handler that cannot
     * switch on it.
     *
     * Returned so a caller can unsubscribe — a store that cannot be detached
     * leaks a listener per `connect`, and a remounted root would leave the old
     * store writing into a component that is gone.
     */
    connect() {
      const offScene = deps.listener(EVENTS.sceneChangedOnDisk, (payload: SceneChangedPayload) => {
        void onSceneChangedOnDisk(payload);
      });
      const offPrefabs = deps.listener(EVENTS.prefabsChanged, (payload: PrefabsChangedPayload) => {
        onPrefabsChanged(payload);
      });
      const offNotice = deps.listener(EVENTS.notice, (payload: NoticePayload) => {
        pushNotice(payload);
      });
      unsubscribes = [offScene, offPrefabs, offNotice];
      return () => {
        for (const off of unsubscribes) off();
        unsubscribes = [];
      };
    },

    destroy() {
      for (const off of unsubscribes) off();
      unsubscribes = [];
      for (const handle of noticesTimers.values()) clearTimer(handle);
      noticesTimers.clear();
      set(noticesSource, []);
      destroyed = true;
    },
  };

  return store;

  // ── Event handling ──────────────────────────────────────────────────────

  /**
   * The scene file changed on disk.
   *
   * A change that is still invalid is *reported and not applied*. Reloading a
   * half-written file would replace the last good scene with a broken one, and the
   * developer would lose the thing they were looking at to a file an AI is
   * currently in the middle of writing. So the state keeps the last valid scene
   * and the problems become notices naming the JSON paths to fix.
   *
   * A change that is valid is reloaded — but only when it is not our own edit. The
   * main process suppresses the echo of its own writes, so anything arriving here
   * is genuinely someone else's.
   */
  async function onSceneChangedOnDisk(payload: SceneChangedPayload): Promise<void> {
    if (destroyed) return;

    if (!payload.valid) {
      pushNotice({
        level: 'error',
        message:
          'The scene file on disk is not valid. The editor is still showing the last version that ' +
          `was valid.\n${payload.problems.join('\n')}`,
      });
      return;
    }

    await store.reloadScene();
    pushNotice({
      level: 'info',
      message: 'The scene file changed on disk and was reloaded.',
    });
  }

  /** The prefab registry was rebuilt: adopt it into the current snapshot. */
  function onPrefabsChanged(payload: PrefabsChangedPayload): void {
    const snapshot = current().snapshot;
    if (snapshot === null) return;
    set(editorState, {
      ...current(),
      snapshot: { ...snapshot, prefabs: payload.registry },
    });
    // Failed prefabs live in snapshot.prefabs.failed and are shown in ProblemsPanel,
    // not as popup toast notices.
  }
}

/** The two event payloads this store handles, taken from `ipc.ts`'s own types. */
// Payload aliases are keyed by the channel *value*, matching `IpcListener`.
type SceneChangedPayload = EventPayloadFor<typeof EVENTS.sceneChangedOnDisk>;
type PrefabsChangedPayload = EventPayloadFor<typeof EVENTS.prefabsChanged>;

/** A short human label for an edit, used in the busy/failure message. */
function describeEdit(edit: SceneEdit): string {
  switch (edit.op) {
    case 'setTransform':
      return `move ${edit.instanceId}`;
    case 'swapModel':
      return `swap the model of ${edit.instanceId}`;
    case 'addInstance':
      return `add ${edit.input.prefab} "${edit.input.id}"`;
    case 'removeInstance':
      return `remove ${edit.instanceId}`;
    case 'setParams':
      return `set params of ${edit.instanceId}`;
    default:
      return 'the edit';
  }
}

/** Build the store the real app uses, from the preload bridge. */
export function createWindowStore(): EditorStore {
  return createEditorStore({ invoker: bridgeInvoker(), listener: bridgeListener() });
}

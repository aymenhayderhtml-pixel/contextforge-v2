/**
 * test/shell/pickFolder.test.ts — the folder picker, end to end minus the OS.
 *
 * This replaces a fake picker that did nothing. `<input type="file"
 * webkitdirectory>` was visually hidden in the renderer and its `change` handler
 * read `File.path` — a non-standard Chromium extension that Electron deprecated
 * in v32 and **removed under `sandbox: true`**, which `main.ts` sets. The button
 * therefore silently did nothing at all. What it does now is ask the main process
 * to show the real OS dialog and open whatever the user picks.
 *
 * ## What is covered here, and what cannot be
 *
 * There is no display in this environment and no way to launch Electron, so the
 * native dialog is never clicked. The mock is the only way to test any of it.
 * What that means concretely, and honestly:
 *
 *  - **Proven:** the channel name and its types, that the handler asks for
 *    `['openDirectory']` and nothing else, that a chosen folder comes back as
 *    `ok(path)`, that a cancel comes back as `ok(null)` and produces no error UI
 *    anywhere in the renderer, that a throwing dialog becomes a refusal rather
 *    than an exception crossing the boundary, and that the renderer no longer
 *    renders a file input at all.
 *  - **Not proven:** that macOS and Windows show a folder chooser for these
 *    options, whether `canceled` is always set alongside an empty `filePaths`,
 *    and whether `dialog.showOpenDialog` is usable at the moment the first
 *    request arrives on any given platform. Those need a real desktop.
 *
 * The one property that makes the rest testable is that `ipcHandlers.ts` imports
 * no Electron at all, so `AppBackend` is constructed here with a fake dialog and
 * a recording `send`. `no Electron import` below asserts that as a property of
 * the source rather than taking it on trust: if someone adds `import { dialog }
 * from 'electron'` to make a handler work, this test file fails to even load.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ProjectScreen from '../../src/renderer/screens/ProjectScreen.svelte';
import {
  AppBackend,
  registerHandlers,
  type FolderPickerLike,
  type IpcMainLike,
  type OpenFolderOptions,
  type OpenFolderResult,
} from '../../src/electron/ipcHandlers.js';
import { createEditorStore, type EditorStore, type StoreDeps } from '../../src/renderer/store.js';
import { CHANNELS, type Result } from '../../src/ipc.js';
import { FakeClock, FakeInvoker, FakeListener, demoScene, refuse, snapshotOf, succeed } from './fakes.js';

/** The main-process source, read as text for the no-Electron assertion below. */
const IPC_HANDLERS_TS = readFileSync(
  fileURLToPath(new URL('../../src/electron/ipcHandlers.ts', import.meta.url)),
  'utf-8',
);

/** One recorded call to the injected dialog. */
interface DialogCall {
  options: OpenFolderOptions;
}

/**
 * A dialog that records how it was called and answers what the test says.
 *
 * `answer` is a function rather than a value so a test can hand back a *throwing*
 * picker — both the synchronous throw and the rejected promise — which is the
 * half of the failure story that a plain mock object cannot express.
 */
function fakePicker(
  answer: (options: OpenFolderOptions) => Promise<OpenFolderResult>,
): FolderPickerLike & { calls: DialogCall[] } {
  const calls: DialogCall[] = [];
  return {
    calls,
    showOpenDialog(options: OpenFolderOptions): Promise<OpenFolderResult> {
      calls.push({ options });
      return answer(options);
    },
  };
}

/** A picker that chose `path`. */
function choosing(path: string): ReturnType<typeof fakePicker> {
  return fakePicker(() => Promise.resolve({ canceled: false, filePaths: [path] }));
}

/** A picker the user dismissed. */
function cancelling(): ReturnType<typeof fakePicker> {
  return fakePicker(() => Promise.resolve({ canceled: true, filePaths: [] }));
}

/** A backend with a recording `send` and, optionally, a fake dialog. */
function backend(picker?: FolderPickerLike): AppBackend {
  return new AppBackend(
    () => {},
    picker === undefined ? {} : { picker },
  );
}

/** The registered handler for a channel, as the renderer would reach it. */
type Handler = (event: unknown, ...args: never[]) => unknown;

/** Register against a fake `ipcMain` and return the channel handlers by name. */
function registeredHandlers(app: AppBackend): Map<string, Handler> {
  const listeners = new Map<string, Handler>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => {
      listeners.set(channel, listener as Handler);
    },
    removeHandler: () => {},
  };
  registerHandlers(ipcMain, app);
  return listeners;
}

/** The `pickFolder` handler, or a thrown error if it was never registered. */
function pickHandler(app: AppBackend): Handler {
  const handler = registeredHandlers(app).get(CHANNELS.pickFolder);
  if (handler === undefined) {
    throw new Error(`no handler registered for ${CHANNELS.pickFolder}`);
  }
  return handler;
}

/** A store wired to the given answers, with a hand-driven clock. */
function storeWith(
  answers: ConstructorParameters<typeof FakeInvoker>[0],
): { store: EditorStore; invoker: FakeInvoker } {
  const invoker = new FakeInvoker(answers);
  const listener = new FakeListener();
  const clock = new FakeClock();
  const deps: StoreDeps = {
    invoker,
    listener: listener.on,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  };
  return { store: createEditorStore(deps), invoker };
}

// ── The handler ─────────────────────────────────────────────────────────────

describe('pickFolder — a chosen folder', () => {
  it('returns the absolute path the user picked', async () => {
    const picker = choosing('/abs/path/to/project');

    const result = await backend(picker).pickFolder();

    expect(result).toEqual(succeed('/abs/path/to/project'));
  });

  it('asks for a directory chooser and nothing else', async () => {
    const picker = choosing('/abs/path/to/project');

    await backend(picker).pickFolder();

    // Exactly this object, with no `defaultPath`, no `multiSelections` and no
    // filters. `multiSelections` would let the OS return several folders for one
    // request, and the handler takes the first one — silently opening a project
    // the user did not mean to open. `defaultPath` would require the renderer to
    // name a directory, which is the capability this channel exists not to have.
    expect(picker.calls).toHaveLength(1);
    expect(picker.calls[0]?.options).toEqual({ properties: ['openDirectory'] });
  });

  it('is reachable through the registrar as its own named channel', async () => {
    const picker = choosing('/abs/path/to/project');
    const handler = pickHandler(backend(picker));

    const result = (await handler(null, {} as never)) as Result<string | null>;

    expect(result).toEqual(succeed('/abs/path/to/project'));
  });
});

describe('pickFolder — a cancel is not a failure', () => {
  it('answers ok(null) when the dialog was cancelled', async () => {
    const result = await backend(cancelling()).pickFolder();

    // Asserted explicitly because the temptation is to report this as
    // `fail(...)`: the user pressed Escape, or clicked the window's close box.
    // They did nothing wrong. A refusal here would put an error in front of
    // someone for the single most ordinary action a file dialog invites, and
    // would train them to dismiss errors that do matter.
    expect(result).toEqual(succeed(null));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it('answers ok(null) when filePaths is empty but the dialog does not say cancelled', async () => {
    // Some platforms report a window-manager dismissal as an empty selection with
    // no `canceled` flag. Treating that as "no folder" is right; treating it as a
    // refusal is not, for exactly the reason above.
    const picker = fakePicker(() => Promise.resolve({ canceled: false, filePaths: [] }));

    const result = await backend(picker).pickFolder();

    expect(result).toEqual(succeed(null));
  });

  it('never opens anything itself — the chosen folder is still opened by openProject', async () => {
    const picker = choosing('/abs/path/to/project');
    const app = backend(picker);

    await app.pickFolder();

    // `pickFolder` holds no project state: it asked a question and reported the
    // answer. The folder is opened by the separate `openProject` request, so a
    // cancel leaves an already-open project exactly as it was.
    expect(app.closeProject()).toEqual(succeed(null));
  });
});

describe('pickFolder — a broken dialog becomes a refusal, never an exception', () => {
  it('converts a synchronous throw from showOpenDialog into ok: false', async () => {
    const picker = fakePicker(() => {
      throw new Error('no display available');
    });
    const handler = pickHandler(backend(picker));

    // `.resolves` is a *promise that fails the test* if the value never arrives,
    // and it has to be awaited — an un-awaited `.resolves` neither asserts
    // anything nor reports the rejection it was supposed to catch, which would
    // make this test pass for the wrong reason. A rejected promise here is what a
    // broken IPC boundary looks like in the renderer: an unhandled rejection
    // carrying a message written for a stack trace (SPEC R9).
    await expect(handler(null, {} as never)).resolves.toMatchObject({ ok: false });
  });

  it('converts a rejected promise from showOpenDialog into ok: false', async () => {
    // Both shapes have to become refusals. `registerHandlers` wraps for both
    // because the handler is invoked *outside* the handler's own `async` body,
    // so a throw before its first `await` escapes synchronously — which is
    // exactly what a dialog that cannot be shown does.
    const picker = fakePicker(() => Promise.reject(new Error('dialog unavailable')));
    const handler = pickHandler(backend(picker));

    await expect(handler(null, {} as never)).resolves.toMatchObject({ ok: false });
  });

  it('names the channel and the underlying cause in one sentence', async () => {
    const picker = fakePicker(() => {
      throw new Error('no display available');
    });
    const handler = pickHandler(backend(picker));

    const result = (await handler(null, {} as never)) as Result<string | null>;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    // R9: the sentence has to say which operation failed and why, because the
    // UI shows it verbatim and a developer reading it has nothing else. The full
    // stop is part of the contract — the underlying `Error` message has none, so
    // the registrar has to add one rather than leave a fragment on screen.
    expect(result.reason).toContain(CHANNELS.pickFolder);
    expect(result.reason).toContain('no display available');
    expect(result.reason.endsWith('.')).toBe(true);
  });

  it('refuses rather than reporting a cancel when no picker was injected', async () => {
    // A backend constructed without a picker still *registers* the channel — the
    // registrar checks channels, not dependencies — so answering `ok(null)`
    // would read as "the user cancelled" and the Browse button would sit there
    // doing nothing forever, with nothing on screen explaining why.
    const result = await backend().pickFolder();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('folder picker');
  });
});

// ── The renderer ────────────────────────────────────────────────────────────

describe('the renderer — asking for a folder', () => {
  it('sends one pickFolder request carrying nothing, and returns the path', async () => {
    const { store, invoker } = storeWith({
      [CHANNELS.pickFolder]: () => succeed('/abs/path/to/project'),
    });

    const chosen = await store.pickFolder();

    expect(chosen).toBe('/abs/path/to/project');
    // An empty request is the security property, not an oversight: the renderer
    // cannot name a folder. A channel that accepted a path would give the
    // renderer — which loads model-written JSON and prefab modules — a way to
    // ask the main process to open anything on the developer's disk.
    expect(invoker.requestsFor(CHANNELS.pickFolder)).toEqual([{}]);
    expect(invoker.calls).toHaveLength(1);
    expect(invoker.calls[0]?.channel).toBe(CHANNELS.pickFolder);
  });

  it('opens nothing when the dialog was cancelled', async () => {
    const { store, invoker } = storeWith({
      [CHANNELS.pickFolder]: () => succeed(null),
    });

    const chosen = await store.pickFolder();

    expect(chosen).toBeNull();
    // A cancel is not an error and not an action. It must not open a project, it
    // must not touch state, and above all it must not say anything: the user
    // pressed Escape.
    expect(store.notices).toEqual([]);
    expect(store.snapshot).toBeNull();
    expect(invoker.requestsFor(CHANNELS.openProject)).toEqual([]);
  });

  it('pushes no notice for a cancel — the loudest thing on screen must be nothing', async () => {
    const { store } = storeWith({
      [CHANNELS.pickFolder]: () => succeed(null),
    });

    await store.pickFolder();

    // Spelled out separately from the test above because this is the requirement
    // most likely to be "improved" later by someone adding a helpful notice.
    expect(store.notices).toHaveLength(0);
  });

  it('does report a real failure, because that one is worth a sentence', async () => {
    const { store } = storeWith({
      [CHANNELS.pickFolder]: () => refuse('The folder picker is not available.'),
    });

    const chosen = await store.pickFolder();

    // A dialog that could not be shown is a fault the developer can act on and
    // the UI cannot otherwise reveal, so R9 applies in full: one notice, the
    // main process's own sentence, no thrown error.
    expect(chosen).toBeNull();
    expect(store.notices).toHaveLength(1);
    expect(store.notices[0]?.level).toBe('error');
    expect(store.notices[0]?.message).toContain('The folder picker is not available.');
  });

  it('reports an unreachable main process rather than throwing at the call site', async () => {
    const { store } = storeWith({
      [CHANNELS.pickFolder]: () => Promise.reject(new Error('no handler')),
    });

    const chosen = await store.pickFolder();

    expect(chosen).toBeNull();
    expect(store.notices.map((n) => n.message).join('\n')).toContain('no handler');
  });
});

// ── The component ───────────────────────────────────────────────────────────

describe('ProjectScreen', () => {
  /** A store whose picker answers with `answer`. */
  function screenStore(answer: () => Promise<unknown>): {
    store: EditorStore;
    invoker: FakeInvoker;
  } {
    const invoker = new FakeInvoker({
      [CHANNELS.pickFolder]: answer,
      [CHANNELS.openProject]: (request: unknown) => {
        const root = (request as { root?: string }).root ?? '';
        return succeed(snapshotOf(demoScene(), { project: { ...snapshotOf(demoScene()).project, root } }));
      },
    });
    const listener = new FakeListener();
    const clock = new FakeClock();
    const deps: StoreDeps = {
      invoker,
      listener: listener.on,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    };
    return { store: createEditorStore(deps), invoker };
  }

  it('renders no file input of any kind — the webkitdirectory trick is gone', () => {
    const { store } = screenStore(() => succeed(null));
    const { body } = render(ProjectScreen, { props: { store, onOpenScene: () => {} } });

    // The old picker was a visually hidden `<input type="file" webkitdirectory>`
    // whose `File.path` was read in the change handler. Under `sandbox: true`
    // that property does not exist, so the button looked alive and did nothing.
    // Its absence is the point of this test: any file input in this component is
    // a step back toward a picker that cannot work.
    expect(body).not.toContain('webkitdirectory');
    expect(body).not.toContain('type="file"');
    expect(body).not.toContain('project-folder-picker');
  });

  it('still offers a Browse… action, which is the only way to get a dialog', () => {
    const { store } = screenStore(() => succeed(null));
    const { body } = render(ProjectScreen, { props: { store, onOpenScene: () => {} } });

    expect(body).toContain('Browse…');
  });

  it('keeps one main action per screen — Open project stays the primary button', () => {
    const { store } = screenStore(() => succeed(null));
    const { body } = render(ProjectScreen, { props: { store, onOpenScene: () => {} } });

    // Browse is secondary; the screen's one primary action is still "Open
    // project". Adding a third emphasized button here would make the screen ask
    // a question it already answers.
    // Matched on the class list rather than the whole attribute, because the SSR
    // renderer appends a scoping class to every element (`class="primary svelte-…"`)
    // and an exact-string match would break on any future rename of that hash.
    expect(body).toMatch(/class="primary\s+svelte-[^"]*"/);
    expect(body).toContain('Open project');
    expect(body).toMatch(/class="secondary browse-btn\s+svelte-[^"]*"/);
  });
});

// ── The injection point itself ──────────────────────────────────────────────

describe('the dialog injection', () => {
  it('keeps ipcHandlers.ts free of any Electron import', () => {
    // This is a lexical check on a source file, which the one permitted kind:
    // it asks whether a module *specifier* appears, not what any expression
    // means. It is also the load-bearing property of this whole design — the
    // file above has to be importable by a test with no Electron runtime at all,
    // which is why this test file can construct `AppBackend` and call it.
    // A single `import … from 'electron'` here would make every test in this file
    // unrunnable, so it would be caught immediately rather than silently.
    const importStatements = IPC_HANDLERS_TS.match(/^\s*import\s[^\n]*$/gm) ?? [];

    for (const statement of importStatements) {
      expect(statement).not.toMatch(/from\s+['"]electron['"]/);
      expect(statement).not.toMatch(/require\(\s*['"]electron['"]/);
    }
  });

  it('names Electron nowhere as a value in ipcHandlers.ts', () => {
    // Belt and braces on the same property, with comments and string literals
    // blanked first — otherwise this file's own prose about `dialog` would match
    // it, and an assertion that cannot survive the file it describes is worse
    // than no assertion. What is left is code, and no code there refers to
    // Electron's `dialog` module: it is only ever a parameter name and a type.
    const codeOnly = IPC_HANDLERS_TS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(codeOnly).not.toMatch(/from\s*['"]electron['"]/);
    expect(codeOnly).not.toMatch(/require\(\s*['"]electron['"]/);
  });

  it('still constructs with only a send function, so existing callers keep working', async () => {
    // `new AppBackend(send)` — the shape `main.ts` used before this change and the
    // shape every existing test uses — must keep type-checking and running. The
    // picker is optional, so nothing has to be threaded through to add it.
    const app = new AppBackend(() => {});
    const listeners = registeredHandlers(app);

    expect(listeners.get(CHANNELS.pickFolder)).toBeTypeOf('function');
    expect((await app.pickFolder()).ok).toBe(false);
  });
});
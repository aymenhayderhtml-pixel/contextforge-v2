<!--
  ProjectScreen.svelte — open a project.
-->
<script module lang="ts">
  export const RECENT_PROJECTS_KEY = 'contextforge:recent_projects';
  export const MAX_RECENT_PROJECTS = 10;

  /**
   * The New Project steps, exported so a test can assert the flow against the
   * same list the screen renders rather than a copy of it.
   */
  export const NEW_PROJECT_STEPS = [
    'Name it',
    'Describe the game',
    'Take the prompt',
  ] as const;
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  // **Type-only.** `@contextforge/core` is `external` in the renderer build,
  // which is sound only while every renderer import of it is erased. A value
  // import leaves a bare specifier the browser cannot resolve and the app fails
  // to mount with no error — see D45.
  //
  // So the prompt text is built in the main process. What this screen owns is
  // the *gate*: `scaffoldPromptProblems` is asked over IPC, and its answer
  // decides whether the copy button is enabled.
  import type { GameBrief } from '@contextforge/core';
  import type { EditorStore } from '../store.js';
  import { CHANNELS } from '../../ipc.js';

  function loadRecentProjects(): string[] {
    try {
      if (typeof localStorage === 'undefined') return [];
      const raw = localStorage.getItem(RECENT_PROJECTS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
    } catch {
      return [];
    }
  }

  function saveRecentProjects(list: readonly string[]): void {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(list));
    } catch {
      // Ignore storage errors in restricted environments
    }
  }

  let {
    store,
    onOpenScene,
    initialRecents,
  }: {
    store: EditorStore;
    onOpenScene: () => void;
    initialRecents?: string[];
  } = $props();

  const snapshot = $derived(store.snapshot);

  // svelte-ignore state_referenced_locally
  let path = $state(store.snapshot?.project.root ?? '');
  let opening = $state(false);
  // svelte-ignore state_referenced_locally
  let recents = $state<string[]>(initialRecents ?? loadRecentProjects());
  // While the native picker is up, the Browse button stays disabled. Without this
  // a second click queues a second modal dialog behind the first one, which is
  // both confusing and a leak of OS windows.
  let browsing = $state(false);

  // Add the opened project to the recents list, once the snapshot has one.
  //
  // `addRecent` writes `recents`, and this effect reads `snapshot` — but the
  // re-render it triggers re-runs this effect, which calls `addRecent` again,
  // which writes `recents` again. Svelte gives up with
  // `effect_update_depth_exceeded` and the screen never settles, so the project
  // never opens and every screen that depends on it stays disabled. The symptom
  // is a frozen app; the cause is this effect feeding itself.
  //
  // The guard is the point of the effect, so it is written as the condition
  // rather than hidden in a helper: if the root is already first in the list,
  // there is nothing to add.
  $effect(() => {
    const root = snapshot?.project.root;
    if (!root) return;
    path = root;
    // `untrack` because `addRecent`'s own writes are not an input to this effect.
    // Writing the same root again is a no-op, but making the effect re-enter on
    // its own output is what turned a one-line convenience into a freeze.
    untrack(() => addRecent(root));
  });

  function addRecent(projectPath: string): void {
    const trimmed = projectPath.trim();
    if (!trimmed) return;
    const next = [trimmed, ...recents.filter((p) => p !== trimmed)].slice(0, MAX_RECENT_PROJECTS);
    recents = next;
    saveRecentProjects(next);
  }

  async function open(pathToOpen?: string): Promise<void> {
    const target = (pathToOpen ?? path).trim();
    if (!target) return;
    path = target;
    opening = true;
    try {
      // The store's own `openProject` pushes a notice for every problem found, and
      // returns false for a path that cannot be opened at all.
      const opened = await store.openProject(target);
      // Landing on the Scene screen is the point of opening a project, so a
      // success goes there — a developer who opened a project wants to see it.
      if (opened) {
        addRecent(target);
        onOpenScene();
      }
    } finally {
      opening = false;
    }
  }

  async function close(): Promise<void> {
    await store.closeProject();
  }

  /**
   * Ask the main process for the OS folder picker, and open whatever comes back.
   *
   * There is no `<input type="file" webkitdirectory>` here any more, and there
   * cannot be one. It used to be a visually hidden file input whose `File.path`
   * property was read to recover the folder — a non-standard Chromium extension
   * that Electron deprecated in v32 and removed under `sandbox: true`, which this
   * app sets. The picker therefore does nothing at all, silently, which is the
   * worst possible failure for a button that looks like it works.
   *
   * A cancel is `null` and must produce *no* error UI: the user pressed Escape.
   * The `finally` is what guarantees the button comes back even if `open` or the
   * IPC request throws.
   */
  async function browse(): Promise<void> {
    if (browsing) return;
    browsing = true;
    try {
      const chosen = await store.pickFolder();
      if (chosen === null) return;
      await open(chosen);
    } finally {
      browsing = false;
    }
  }

  /** Problems from the current snapshot, if any. */
  const problems = $derived(snapshot?.problems ?? []);

  // ── New Project (Step 5d) ───────────────────────────────────────────────────

  /** Whether the New Project flow is showing at all. */
  let newProjectOpen = $state(false);
  /**
   * Which step is showing. Step 3 is reachable only by passing through the
   * first two, so the wizard cannot start at the prompt — but the developer
   * *can* step back, and doing so must not lose what they typed.
   */
  let step = $state<1 | 2 | 3>(1);
  /** The folder name, step 1. */
  let draftName = $state('');
  /** The game, in the developer's own words, step 2. */
  let draftIdea = $state('');
  /** The folder the new project will live in, chosen with the OS dialog. */
  let parentFolder = $state<string | null>(null);
  /** True while the native picker is up for this flow. */
  let choosingFolder = $state(false);

  /**
   * Why the scaffold prompt cannot be copied yet, from core's `checkBrief`.
   *
   * Not a local reimplementation. `generateProject` refuses a brief that fails
   * these rules, so a screen that checked them differently would enable a copy
   * button that produced a prompt the AI could not act on — and the developer
   * would find out only after pasting it.
   */
  const brief = $derived<GameBrief>({ name: draftName, idea: draftIdea });

  /**
   * The blocking reasons, fetched from core in the main process.
   *
   * Async, so this is state rather than a `$derived`. It is refreshed when the
   * flow opens and when either field changes.
   */
  let scaffoldProblems = $state<string[]>([]);

  /**
   * Whether the copy button may be enabled.
   *
   * Both conditions are required. `scaffoldProblems` is the real rule — it is
   * core's `checkBrief` — but it is fetched asynchronously, so on the very first
   * render it is an empty array. Requiring both fields to be non-empty as well
   * means the button can never be briefly enabled while a fetch is in flight,
   * and fails closed if the fetch never arrives.
   */
  const canCopy = $derived(
    draftName.trim() !== '' && draftIdea.trim() !== '' && scaffoldProblems.length === 0,
  );

  /** The built prompt, or null while it has not been fetched. */
  let promptText = $state<string | null>(null);
  let promptError = $state<string | null>(null);
  let promptBusy = $state(false);
  let copied = $state(false);

  async function scaffoldProblemsFor(briefToCheck: GameBrief): Promise<string[]> {
    try {
      const result = await store.requestChannel(CHANNELS.scaffoldProblems, briefToCheck);
      if (result.ok) {
        scaffoldProblems = result.value.problems;
        return result.value.problems;
      }
      // A refusal here means the screen cannot know the rules, so it refuses to
      // offer the copy button. Failing closed is the only safe direction: a
      // wrongly-enabled button produces a prompt that silently fails.
      scaffoldProblems = [result.reason];
      return scaffoldProblems;
    } catch (error) {
      scaffoldProblems = [
        `Could not check the brief: ${error instanceof Error ? error.message : String(error)}`,
      ];
      return scaffoldProblems;
    }
  }

  async function refreshBriefProblems(): Promise<void> {
    if (!newProjectOpen) return;
    await scaffoldProblemsFor(brief);
  }

  async function openNewProject(): Promise<void> {
    newProjectOpen = true;
    step = 1;
    promptText = null;
    promptError = null;
    copied = false;
    await refreshBriefProblems();
  }

  function closeNewProject(): void {
    newProjectOpen = false;
    step = 1;
  }

  function goTo(target: 1 | 2 | 3): void {
    step = target;
    promptText = null;
    promptError = null;
    copied = false;
    void refreshBriefProblems();
  }

  /**
   * Step 2 → 3.
   *
   * Refuses while the brief is incomplete, and says why. The button is also
   * disabled in that case, so this is the belt to that braces' — a disabled
   * button with no explanation is worse than one that says what is missing.
   */
  async function toPrompt(): Promise<void> {
    if (!canCopy) return;
    await loadPrompt();
    step = 3;
  }

  async function loadPrompt(): Promise<void> {
    promptBusy = true;
    promptError = null;
    try {
      const result = await store.requestChannel(CHANNELS.scaffoldPrompt, brief);
      if (result.ok) {
        promptText = result.value.prompt;
      } else {
        promptText = null;
        promptError = result.reason;
      }
    } catch (error) {
      promptText = null;
      promptError = error instanceof Error ? error.message : String(error);
    } finally {
      promptBusy = false;
    }
  }

  /**
   * Ask the OS for the folder the project will live in.
   *
   * Step 1's "Choose folder" uses the same `pickFolder` channel as Open. The
   * dialog *opens* an existing folder rather than creating one — a native
   * create-folder dialog is a different Electron call, and `pickFolder` is
   * deliberately restricted to `showOpenDialog` so the main process stays
   * drivable headlessly (see `pickFolder.test.ts`). So this picks the
   * **parent**, and the project folder name from the same form becomes the last
   * segment. That is why step 1 asks for both at once.
   */
  async function chooseParentFolder(): Promise<void> {
    if (choosingFolder) return;
    choosingFolder = true;
    try {
      const chosen = await store.pickFolder();
      // A cancel is `null` and must produce no error UI: the user pressed
      // Escape. It is the same contract `browse()` follows.
      if (chosen === null) return;
      parentFolder = chosen;
      if (draftName.trim() === '') {
        draftName = chosen.split('/').filter(Boolean).pop() ?? '';
      }
    } finally {
      choosingFolder = false;
    }
  }

  /**
   * Copy the prompt.
   *
   * Silent on failure, and only here: `navigator.clipboard` needs a secure
   * context and a permission the app never asks for, so a refusal is almost
   * always a red line about something the developer cannot act on. The same
   * reasoning and the same shape as `ContextScreen.copyPrompt`.
   */
  async function copyPrompt(): Promise<void> {
    if (!canCopy || promptText === null) return;
    try {
      await navigator.clipboard.writeText(promptText);
      copied = true;
    } catch {
      copied = false;
    }
  }
</script>

<section class="screen">
  <header>
    <h1>Project</h1>
    <p class="lede">
      Open a folder containing a <code>scene.json</code> and a <code>prefabs/</code> directory.
      ContextForge never writes outside the folder you open.
    </p>
    <button type="button" class="secondary" onclick={() => void openNewProject()}>
      New project…
    </button>
  </header>

  <!--
    The New Project flow (Step 5d). Three steps, and step 3 cannot be reached
    without passing through the first two — so the prompt is never shown before
    the brief is filled in. The copy button on step 3 is additionally gated on
    core's own `checkBrief`, fetched over IPC, so the screen and the generator
    cannot disagree about whether a brief is usable.
  -->
  {#if newProjectOpen}
    <div class="panel new-project">
      <ol class="steps">
        {#each NEW_PROJECT_STEPS as label, i (label)}
          <li class:active={step === i + 1} class:done={step > i + 1}>
            <span class="step-num">{i + 1}</span>
            <span class="step-label">{label}</span>
          </li>
        {/each}
      </ol>

      {#if step === 1}
        <label class="field" for="np-name">
          <span class="label">Project name</span>
          <input
            id="np-name"
            type="text"
            spellcheck="false"
            autocomplete="off"
            placeholder="star-crawler"
            bind:value={draftName}
            oninput={() => void refreshBriefProblems()}
          />
        </label>

        <label class="field" for="np-folder">
          <span class="label">Create it in</span>
          <div class="input-row">
            <input id="np-folder" type="text" readonly value={parentFolder ?? ''} />
            <button
              type="button"
              class="secondary"
              onclick={() => void chooseParentFolder()}
              disabled={choosingFolder}
            >
              Choose folder…
            </button>
          </div>
          <span class="hint">
            Picks where the project will live. The folder created inside it is named above.
          </span>
        </label>

        <div class="actions">
          <button type="button" class="primary" onclick={() => goTo(2)} disabled={draftName.trim() === ''}>
            Next: describe the game
          </button>
        </div>
      {:else if step === 2}
        <label class="field" for="np-idea">
          <span class="label">What is the game?</span>
          <textarea
            id="np-idea"
            rows="5"
            placeholder="You drive a hover car around a collapsing space station, collecting fuel pods."
            bind:value={draftIdea}
            oninput={() => void refreshBriefProblems()}
          ></textarea>
          <span class="hint">
            One or two sentences on what the player actually does. This goes into the prompt
            verbatim — the AI will build exactly this, so be specific.
          </span>
        </label>

        {#if scaffoldProblems.length > 0 && draftName.trim() !== ''}
          <ul class="problems brief-problems" role="alert">
            {#each scaffoldProblems as problem (problem)}
              <li>{problem}</li>
            {/each}
          </ul>
        {/if}

        <div class="actions">
          <button type="button" class="secondary" onclick={() => goTo(1)}>Back</button>
          <button type="button" class="primary" onclick={() => void toPrompt()}>
            Build the prompt
          </button>
        </div>
      {:else}
        {#if promptBusy}
          <p class="lede small">Building…</p>
        {:else if promptError !== null}
          <p class="refusal" role="alert">{promptError}</p>
        {:else if promptText !== null}
          <p class="lede small">
            Paste this into an AI. It describes the project shape, the <code>scene.json</code>
            contract and the prefab rules — the same rules <code>npm run lint:prefabs</code>
            enforces.
          </p>
          <pre class="prompt">{promptText}</pre>
        {/if}

        {#if scaffoldProblems.length > 0}
          <ul class="problems brief-problems" role="alert">
            {#each scaffoldProblems as problem (problem)}
              <li>{problem}</li>
            {/each}
          </ul>
        {/if}

        <div class="actions">
          <button type="button" class="secondary" onclick={() => goTo(2)}>Back</button>
          <!--
            The gate. `canCopy` is false while either field is empty, and false
            while core reports any problem — so this button cannot be used to
            copy a prompt built from a brief the generator would refuse.
          -->
          <button
            type="button"
            class="primary"
            onclick={() => void copyPrompt()}
            disabled={!canCopy || promptText === null}
          >
            {copied ? 'Copied' : 'Copy prompt'}
          </button>
        </div>
      {/if}

      <div class="actions">
        <button type="button" class="secondary" onclick={closeNewProject}>Cancel</button>
      </div>
    </div>
  {/if}

  <div class="panel">
    <label class="field" for="project-path">
      <span class="label">Project folder path</span>
      <div class="input-row">
        <input
          id="project-path"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="/home/you/projects/my-game"
          bind:value={path}
          onkeydown={(event) => {
            if (event.key === 'Enter') void open();
          }}
        />
        <button
          type="button"
          class="secondary browse-btn"
          onclick={() => void browse()}
          disabled={opening || browsing}
        >
          Browse…
        </button>
      </div>
    </label>

    <div class="actions">
      <button type="button" class="primary" onclick={() => void open()} disabled={opening}>
        {opening ? 'Opening project…' : 'Open project'}
      </button>

      {#if snapshot !== null}
        <button type="button" class="secondary" onclick={() => void close()}>
          Close project
        </button>
      {/if}
    </div>
  </div>

  {#if recents.length > 0}
    <div class="panel recents-panel">
      <h2>Recent projects</h2>
      <ul class="recent-list">
        {#each recents as item (item)}
          <li>
            <button
              type="button"
              class="recent-item"
              onclick={() => void open(item)}
              disabled={opening}
            >
              <span class="recent-path">{item}</span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if snapshot !== null}
    <div class="panel">
      <h2>Open project</h2>
      <dl class="facts">
        <dt>Name</dt>
        <dd>{snapshot.project.name}</dd>
        <dt>Folder</dt>
        <dd class="path">{snapshot.project.root}</dd>
        <dt>Engine</dt>
        <dd>{snapshot.project.engine}</dd>
        <dt>Scene file</dt>
        <dd class="path">{snapshot.project.scenePath}</dd>
        <dt>Objects</dt>
        <dd>{snapshot.scene.instances.length}</dd>
        <dt>Prefabs</dt>
        <dd>
          {snapshot.prefabs.prefabs.length} available
          {#if snapshot.prefabs.failed.length > 0}
            <span class="bad">({snapshot.prefabs.failed.length} failed to load)</span>
          {/if}
        </dd>
        <dt>Undo steps</dt>
        <dd>{snapshot.history.undoCount}</dd>
      </dl>
    </div>

    {#if problems.length > 0}
      <div class="panel problems">
        <h2>Problems found while opening</h2>
        <p class="lede small">
          The project opened anyway. These are what an AI wrote or left behind, and they are the
          reason some of the scene may not render.
        </p>
        <ul>
          {#each problems as problem, i (i)}
            <li>{problem}</li>
          {/each}
        </ul>
      </div>
    {/if}
  {:else}
    <p class="empty">
      No project is open. Type a folder path above or browse to open a project.
    </p>
  {/if}
</section>

<style>
  .screen {
    padding: 24px 28px;
    max-width: 780px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  h1 {
    margin: 0 0 6px;
    font-size: 20px;
  }
  h2 {
    margin: 0 0 10px;
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }

  .lede {
    margin: 0;
    color: var(--muted);
    line-height: 1.5;
  }
  .lede.small {
    font-size: 12px;
    margin-bottom: 10px;
  }

  .panel {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 16px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .label {
    font-size: 12px;
    color: var(--muted);
  }

  .input-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .input-row input[type='text'] {
    flex: 1;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 8px 10px;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 13px;
  }

  .browse-btn {
    white-space: nowrap;
  }

  .actions {
    display: flex;
    gap: 10px;
    margin-top: 14px;
  }

  .primary {
    background: var(--accent);
    color: #06121a;
    border: 1px solid var(--accent);
    border-radius: 5px;
    padding: 8px 16px;
    font-weight: 600;
    cursor: pointer;
  }
  .primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .secondary {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 8px 14px;
    cursor: pointer;
  }
  .secondary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .recents-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .recent-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .recent-item {
    width: 100%;
    display: flex;
    align-items: center;
    padding: 8px 12px;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 5px;
    color: var(--text);
    text-align: left;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .recent-item:hover:not(:disabled) {
    background: var(--panel-2);
    border-color: var(--accent);
  }
  .recent-item:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .recent-path {
    word-break: break-all;
  }

  .facts {
    display: grid;
    grid-template-columns: 130px 1fr;
    gap: 6px 14px;
    margin: 0;
    font-size: 13px;
  }
  .facts dt {
    color: var(--muted);
  }
  .facts dd {
    margin: 0;
  }
  .path {
    font-family: ui-monospace, Menlo, monospace;
    font-size: 12px;
    word-break: break-all;
  }
  .bad {
    color: var(--danger);
  }

  .problems ul {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--warning);
    white-space: pre-wrap;
  }

  .empty {
    color: var(--muted);
    line-height: 1.6;
  }

  /* ── New Project (Step 5d) ──────────────────────────────────────────────── */

  header button {
    margin-top: 10px;
  }

  .steps {
    list-style: none;
    display: flex;
    gap: 0.5rem;
    margin: 0 0 1rem;
    padding: 0;
  }
  .steps li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 12px;
    color: var(--muted);
    padding: 4px 10px;
    border: 1px solid var(--line);
    border-radius: 999px;
  }
  .steps li.active {
    color: var(--text);
    border-color: var(--accent);
  }
  .steps li.done {
    color: var(--ok);
  }
  .step-num {
    font-weight: 700;
    font-size: 11px;
  }

  .hint {
    display: block;
    margin-top: 4px;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
  }
  textarea {
    width: 100%;
    resize: vertical;
    font: inherit;
    font-size: 13px;
    padding: 8px;
    border-radius: 4px;
    border: 1px solid var(--line);
    background: var(--panel-2);
    color: var(--text);
  }
  .brief-problems {
    margin: 0.5rem 0 0;
  }
  .refusal {
    color: var(--warning);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    margin: 0 0 0.5rem;
  }
  .prompt {
    margin: 0 0 0.75rem;
    padding: 10px;
    max-height: 340px;
    overflow: auto;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 4px;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    color: var(--text);
  }
</style>

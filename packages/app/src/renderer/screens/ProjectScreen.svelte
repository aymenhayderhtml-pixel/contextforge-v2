<!--
  ProjectScreen.svelte — open a project.
-->
<script module lang="ts">
  export const RECENT_PROJECTS_KEY = 'contextforge:recent_projects';
  export const MAX_RECENT_PROJECTS = 10;
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import type { EditorStore } from '../store.js';

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
</script>

<section class="screen">
  <header>
    <h1>Project</h1>
    <p class="lede">
      Open a folder containing a <code>scene.json</code> and a <code>prefabs/</code> directory.
      ContextForge never writes outside the folder you open.
    </p>
  </header>

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
</style>

<!--
  App.svelte — the root shell: sidebar, screen, notices.

  Three regions and nothing else, because this app has one job per screen and a
  layout that implies more structure than exists is a layout that lies. The
  component holds no state of its own: everything it shows comes from the store
  passed in as a prop, which is what makes the root a pure function of the editor
  state rather than a second place scene state can live.
-->
<script lang="ts">
  import type { EditorStore } from './store.js';
  import Sidebar from './Sidebar.svelte';
  import ContextScreen from './screens/ContextScreen.svelte';
  import GraphScreen from './screens/GraphScreen.svelte';
  import PatchScreen from './screens/PatchScreen.svelte';
  import ProjectScreen from './screens/ProjectScreen.svelte';
  import SceneScreen from './screens/SceneScreen.svelte';

  /** The one store. Passed in rather than imported so tests can supply a fake. */
  let { store }: { store: EditorStore } = $props();

  /** The five screens. `step` is a build tag for the sidebar, not a promise. */
  type ScreenId = 'project' | 'context' | 'graph' | 'scene' | 'patch';
  const SCREENS: ReadonlyArray<{ id: ScreenId; label: string; step: string }> = [
    { id: 'project', label: 'Project', step: 'working' },
    { id: 'context', label: 'Context', step: 'working' },
    // Delivered in Step 5. It was briefly tagged with that step number, which
    // screenRegressions.test.ts correctly rejected: a label naming a step is a
    // claim about when it works, and the sidebar already disables the screen
    // when there is nothing to show.
    { id: 'graph', label: 'Graph', step: 'working' },
    { id: 'scene', label: 'Scene', step: 'working' },
    { id: 'patch', label: 'Patch', step: 'working' },
  ];

  let active: ScreenId = $state('project');

  $effect(() => {
    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>)['__setActiveScreen'] = (id: ScreenId) => {
        active = id;
      };
      (window as unknown as Record<string, unknown>)['__store'] = store;
    }
  });

  /** The project's display name, or a dash before one is open. */
  const projectName = $derived(store.snapshot?.project.name ?? null);

  /** Details expansion state for individual notices. */
  let expandedNoticeDetails = $state<Record<number, boolean>>({});
  /** Whether the collapsed notice stack is expanded to show all. */
  let showAllNotices = $state(false);

  function toggleNoticeDetails(id: number): void {
    expandedNoticeDetails = {
      ...expandedNoticeDetails,
      [id]: !expandedNoticeDetails[id],
    };
  }

  function parseToast(message: string): { short: string; details?: string } {
    const lines = message.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1) {
      return { short: lines[0] ?? message, details: lines.slice(1).join('\n') };
    }
    const colonIdx = message.indexOf(':');
    if (message.length > 60 && colonIdx > 0 && colonIdx < message.length - 1) {
      return { short: message.slice(0, colonIdx).trim(), details: message.slice(colonIdx + 1).trim() };
    }
    return { short: message };
  }

  const visibleNotices = $derived(
    showAllNotices || store.notices.length <= 3
      ? store.notices
      : store.notices.slice(-3),
  );

  const hiddenCount = $derived(
    showAllNotices ? 0 : Math.max(0, store.notices.length - 3),
  );
</script>

<div class="app">
  <Sidebar
    screens={SCREENS}
    {active}
    onSelect={(id: ScreenId) => (active = id)}
    projectName={projectName}
    scenePath={store.snapshot?.project.scenePath ?? null}
    dirty={store.busy}
  />

  <main class="screen">
    {#if active === 'project'}
      <ProjectScreen {store} onOpenScene={() => (active = 'scene')} />
    {:else if active === 'context'}
      <ContextScreen {store} />
    {:else if active === 'graph'}
      <GraphScreen {store} />
    {:else if active === 'scene'}
      <SceneScreen {store} />
    {:else}
      <PatchScreen {store} />
    {/if}
  </main>

  <!--
    Toasts: stacked in the bottom-right corner, max 3 visible with '+N more' collapse,
    one line each, always dismissible, with a Details toggle for multi-line/path info.
  -->
  {#if store.notices.length > 0}
    <div class="notices" role="status" aria-live="polite">
      {#if hiddenCount > 0}
        <button
          type="button"
          class="notices-collapse-toggle"
          onclick={() => (showAllNotices = true)}
        >
          +{hiddenCount} more
        </button>
      {:else if showAllNotices && store.notices.length > 3}
        <button
          type="button"
          class="notices-collapse-toggle"
          onclick={() => (showAllNotices = false)}
        >
          Show fewer
        </button>
      {/if}

      {#each visibleNotices as notice (notice.id)}
        {@const toast = parseToast(notice.message)}
        <div class="notice notice-{notice.level}">
          <div class="notice-row">
            <span class="notice-level">{notice.level}</span>
            <span class="notice-text" title={toast.short}>{toast.short}</span>
            {#if toast.details}
              <button
                type="button"
                class="notice-details"
                onclick={() => toggleNoticeDetails(notice.id)}
                aria-expanded={expandedNoticeDetails[notice.id] === true}
              >
                {expandedNoticeDetails[notice.id] ? 'Hide' : 'Details'}
              </button>
            {/if}
            <button
              type="button"
              class="notice-dismiss"
              onclick={() => store.dismissNotice(notice.id)}
            >
              Dismiss
            </button>
          </div>
          {#if toast.details && expandedNoticeDetails[notice.id]}
            <div class="notice-details-container">
              <pre class="notice-details-content">{toast.details}</pre>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .app {
    display: grid;
    grid-template-columns: 220px 1fr;
    height: 100%;
    position: relative;
  }

  .screen {
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }

  .notices {
    position: fixed;
    bottom: 16px;
    right: 16px;
    width: min(460px, calc(100vw - 32px));
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 1000;
    pointer-events: none;
  }

  .notices-collapse-toggle {
    pointer-events: auto;
    align-self: flex-end;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 2px 10px;
    font-size: 11px;
    color: var(--muted);
    cursor: pointer;
  }
  .notices-collapse-toggle:hover {
    color: var(--text);
    border-color: var(--accent);
  }

  .notice {
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 12px;
    border: 1px solid var(--line);
    border-left-width: 4px;
    border-radius: 6px;
    background: var(--panel-2);
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.45);
  }

  .notice-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .notice-error {
    border-left-color: var(--danger);
  }
  .notice-warning {
    border-left-color: var(--warning);
  }
  .notice-info {
    border-left-color: var(--accent);
  }

  .notice-level {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    flex-shrink: 0;
  }

  .notice-text {
    font-size: 12px;
    line-height: 1.4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1 1 auto;
    min-width: 0;
  }

  .notice-details {
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 3px;
    color: var(--muted);
    padding: 1px 6px;
    font-size: 11px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .notice-details:hover {
    color: var(--text);
    border-color: var(--muted);
  }

  .notice-details-container {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 6px 8px;
    max-height: 140px;
    overflow-y: auto;
  }

  .notice-details-content {
    margin: 0;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--muted);
  }

  .notice-dismiss {
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 4px;
    color: var(--muted);
    padding: 2px 8px;
    font-size: 11px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .notice-dismiss:hover {
    color: var(--text);
  }
</style>

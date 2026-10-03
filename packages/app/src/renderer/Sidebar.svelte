<!--
  Sidebar.svelte — navigation across the application screens.
-->
<script lang="ts">
  /** One screen as `App.svelte` declares it. */
  export interface ScreenEntry {
    id: string;
    label: string;
    /** Which step delivers it, or `working` for the one that does. */
    step?: string;
    disabled?: boolean;
    tooltip?: string;
  }

  let {
    screens,
    active,
    onSelect,
    projectName,
    scenePath,
    dirty,
  }: {
    screens: ReadonlyArray<ScreenEntry>;
    active: string;
    onSelect: (id: string) => void;
    projectName: string | null;
    scenePath: string | null;
    /** True while a request is in flight; shown as text, not as a spinner glyph. */
    dirty: boolean;
  } = $props();

  /**
   * Whether a screen can be opened.
   *
   * Context, Graph and Patch all read the open project — the ranker needs files
   * on disk, the graph is extracted from them, and a patch needs somewhere to
   * land — so they are gated on `projectName` rather than on a step number. They
   * used to return `true` unconditionally here, which disabled them with a
   * tooltip promising a future release long after the screens were built: a
   * navigation entry that lies about what exists is worse than a missing one,
   * because it hides working software behind a promise.
   *
   * An explicit `disabled` on the entry still wins, so a caller can disable a
   * screen for a reason of its own.
   */
  function isScreenDisabled(screen: ScreenEntry): boolean {
    if (typeof screen.disabled === 'boolean') {
      return screen.disabled;
    }
    if (screen.id === 'context' || screen.id === 'graph' || screen.id === 'patch') {
      return projectName === null;
    }
    return false;
  }

  function getScreenTooltip(screen: ScreenEntry): string | undefined {
    if (screen.tooltip) return screen.tooltip;
    if (isScreenDisabled(screen)) {
      return 'Open a project first — this screen works on the files in it.';
    }
    return undefined;
  }
</script>

<nav class="sidebar" aria-label="Screens">
  <div class="brand">
    <span class="brand-name">ContextForge</span>
    <span class="brand-tag">v2</span>
  </div>

  <ul class="screens">
    {#each screens as screen (screen.id)}
      {@const disabled = isScreenDisabled(screen)}
      {@const tooltip = getScreenTooltip(screen)}
      <li>
        <button
          type="button"
          class="screen"
          class:active={screen.id === active}
          class:disabled
          disabled={disabled}
          title={tooltip}
          aria-disabled={disabled ? 'true' : undefined}
          aria-current={screen.id === active ? 'page' : undefined}
          onclick={() => {
            if (!disabled) onSelect(screen.id);
          }}
        >
          <span class="screen-label">{screen.label}</span>
        </button>
      </li>
    {/each}
  </ul>

  <div class="summary">
    <div class="summary-row">
      <span class="summary-key">Project</span>
      <span class="summary-value">{projectName ?? 'none open'}</span>
    </div>
    <div class="summary-row">
      <span class="summary-key">Scene file</span>
      <span class="summary-value">{scenePath ?? '—'}</span>
    </div>
    <div class="summary-row">
      <span class="summary-key">Status</span>
      <span class="summary-value">{dirty ? 'working…' : 'idle'}</span>
    </div>
  </div>
</nav>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 16px 12px;
    background: var(--panel);
    border-right: 1px solid var(--line);
    overflow: auto;
  }

  .brand {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 0 4px;
  }
  .brand-name {
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  .brand-tag {
    font-size: 11px;
    color: var(--muted);
  }

  .screens {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .screen {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 8px 10px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    text-align: left;
    color: var(--text);
    cursor: pointer;
  }
  .screen:hover:not(:disabled) {
    background: var(--panel-2);
  }
  .screen.active {
    background: var(--panel-2);
    border-color: var(--accent);
  }
  .screen:disabled,
  .screen.disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .screen-label {
    font-size: 14px;
  }

  .summary {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 4px 0;
    border-top: 1px solid var(--line);
  }
  .summary-row {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .summary-key {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
  }
  .summary-value {
    font-size: 12px;
    word-break: break-all;
  }
</style>

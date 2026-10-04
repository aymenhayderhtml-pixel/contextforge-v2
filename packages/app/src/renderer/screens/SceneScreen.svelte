<!--
  SceneScreen.svelte — the only functional screen.

  It is a composition, not an implementation. The viewport, the outliner and the
  inspector belong to the components and viewport agents, and this screen's job is
  to lay them out and to give them the store.

  Features:
  - Resizable panes between Outliner, Viewport, and Inspector with a wider default outliner
  - Single-row merged header bar with scene and project name, modes, history, and actions
  - Save status indicators (dot and badge) for unsaved changes
  - Clean error display passing AppError instances to Outliner and Inspector
  - Clean collapsible Problems panel container
-->
<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import type { PrefabDefinition, SceneEdit } from '@contextforge/core';
  import { VIEWPORT_KEYS, type GizmoMode } from '../../ipc.js';
  import { createAppError, type AppError } from '../../errors.js';
  import { instanceLabel } from '../components/tree.js';
  import { indexPrefabDefinitions } from '../viewport/sceneGraph.js';
  import { snapValuesFor, toggleSpace } from '../viewport/picking.js';
  import Outliner from '../components/Outliner.svelte';
  import Inspector from '../components/Inspector.svelte';
  import ProblemsPanel from '../components/ProblemsPanel.svelte';
  import Viewport from '../viewport/Viewport.svelte';
  import { getRegisteredPrefab, subscribeRegistry } from '../viewport/registry.js';
  import type { EditorStore } from '../store.js';

  interface Props {
    store: EditorStore;
    problemsPanel?: Snippet;
  }

  let { store, problemsPanel }: Props = $props();

  const snapshot = $derived(store.snapshot);

  /**
   * Resizable panes state.
   *
   * The inspector defaults to 380px, not 320px. Its transform rows are a fixed
   * label (8.5rem, sized so `rotation (radians)` is not clipped) plus three axis
   * inputs that each need ~4.5rem to show a signed decimal — about 355px plus
   * pane padding. At 320px the z input overflowed the pane and `.pane.inspector`
   * has `overflow-x: hidden`, so the third axis was cut off entirely: a rotation
   * with an x, y and z where z is unreachable. The pane is still resizable, so a
   * developer who wants it wider can drag it.
   */
  let outlinerWidth = $state(300);
  let inspectorWidth = $state(380);
  let resizingPane = $state<'outliner' | 'inspector' | null>(null);

  function startResize(pane: 'outliner' | 'inspector', event: MouseEvent): void {
    event.preventDefault();
    resizingPane = pane;
    const startX = event.clientX;
    const startOutliner = outlinerWidth;
    const startInspector = inspectorWidth;

    function onMouseMove(e: MouseEvent): void {
      if (pane === 'outliner') {
        const delta = e.clientX - startX;
        outlinerWidth = Math.max(180, Math.min(600, startOutliner + delta));
      } else {
        const delta = startX - e.clientX;
        inspectorWidth = Math.max(200, Math.min(700, startInspector + delta));
      }
    }

    function onMouseUp(): void {
      resizingPane = null;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  /**
   * Save status tracking.
   * Tracks undoCount since last save or reload. When undoCount differs, changes exist.
   */
  let lastSavedUndoCount = $state<number | null>(null);

  $effect(() => {
    const snap = snapshot;
    if (snap !== null) {
      untrack(() => {
        if (lastSavedUndoCount === null) {
          lastSavedUndoCount = snap.history.undoCount;
        }
      });
    }
  });

  const hasUnsavedChanges = $derived(
    snapshot !== null &&
      lastSavedUndoCount !== null &&
      snapshot.history.undoCount !== lastSavedUndoCount,
  );

  async function handleSave(): Promise<void> {
    const success = await store.save();
    if (success && snapshot !== null) {
      lastSavedUndoCount = snapshot.history.undoCount;
    }
  }

  async function handleReload(): Promise<void> {
    const success = await store.reloadScene();
    if (success && snapshot !== null) {
      lastSavedUndoCount = snapshot.history.undoCount;
    }
  }

  /** Problems collapsible section state */
  let problemsCollapsed = $state(true);

  import { collectSkippedInstanceProblems } from '../validation.js';

  /**
   * Normalize problems, prefab failures, and parameter validation into AppError records.
   *
   * The parameter-validation step is **not** written here: it is
   * `collectSkippedInstanceProblems` from `validation.ts`, the same function the
   * Problems panel calls. This screen used to run its own identical pass, which
   * D26 recorded as a real gap — two derivations of one fact can drift, and
   * nothing forces them to agree. One function, two call sites.
   */
  const appErrors = $derived.by<AppError[]>(() => {
    if (snapshot === null) return [];
    const list: AppError[] = [];

    // 1. Problems from snapshot (parsed for instance scoping)
    for (let idx = 0; idx < snapshot.problems.length; idx++) {
      const p = snapshot.problems[idx]!;
      if (typeof p === 'object' && p !== null && 'scope' in p) {
        list.push(p as AppError);
        continue;
      }
      const raw = String(p);
      const instMatch = /instances\[(\d+)\]|instance\s+['"]?([^'"]+)['"]?/.exec(raw);
      let instanceId: string | undefined;
      if (instMatch) {
        if (instMatch[1] !== undefined) {
          const index = Number(instMatch[1]);
          instanceId = snapshot.scene.instances[index]?.id;
        } else if (instMatch[2] !== undefined) {
          instanceId = instMatch[2];
        }
      }
      list.push(
        createAppError({
          id: `err-prob-${idx}`,
          scope: instanceId !== undefined ? 'instance' : 'project',
          instanceId,
          short: raw,
        }),
      );
    }

    // 2. Prefab failures mapped to their instances.
    const failedMap = new Map(snapshot.prefabs.failed.map((f) => [f.name, f]));

    for (const inst of snapshot.scene.instances) {
      const failed = failedMap.get(inst.prefab);
      if (failed) {
        list.push(
          createAppError({
            id: `err-prefab-${inst.id}:${failed.name}`,
            scope: 'instance',
            instanceId: inst.id,
            short: `${failed.name} failed to load: ${failed.reason}`,
            details: failed.file ? `File: ${failed.file}` : undefined,
          }),
        );
      }
    }

    // 3. Param validation: the ONE shared pass, so the inspector and the
    // Problems panel describe the same skips with the same ids.
    const claimed = new Set(list.map((p) => p.id));
    list.push(...collectSkippedInstanceProblems(snapshot, snapshot.prefabs.prefabs, claimed));

    return list;
  });

  /**
   * The one problem count for this screen.
   *
   * The Problems bar used to read `snapshot.problems.length` — a raw string
   * array off the IPC snapshot — while the panel underneath counted normalized,
   * deduplicated rows. Those were two counts of one fact and they disagreed:
   * `PROBLEMS (2)` above `PROBLEMS (6)` (D44). Worse, the screen handed the
   * *same* array to the panel as both `snapshot` and `problems`, so
   * `collectProjectProblems` derived every string twice and its id-dedupe could
   * not catch it (each copy mints a random id). One list, one length.
   */
  const problemCount = $derived(appErrors.length);

  /**
   * Prefab load failures by prefab name, so the outliner can mark a row as coming
   * from a prefab that threw. Matched by name because an instance records only the
   * prefab name.
   */
  let registryVersion = $state(0);
  $effect(() => {
    return subscribeRegistry(() => {
      registryVersion++;
    });
  });

  /**
   * The registry the viewport builds its scene graph from, plus any duplicates it
   * found. Both halves matter: the index is what renders, the failures are what
   * the problems list shows.
   */
  const indexed = $derived.by(() => {
    void registryVersion;
    if (snapshot === null) {
      return { index: new Map<string, PrefabDefinition>(), failures: [] };
    }
    return indexPrefabDefinitions(
      snapshot.prefabs.prefabs.map(
        (p) => getRegisteredPrefab(p.name) ?? (p as unknown as PrefabDefinition),
      ),
    );
  });

  const prefabIndex = $derived(indexed.index);

  /** What the current snap setting means, shown so the choice is not a guess. */
  const snapValues = $derived(snapValuesFor(store.snap));

  /**
   * The selected instance, or null. The inspector's whole input.
   *
   * Written as a captured discriminant rather than an inline ternary on
   * `store.selection`, because `Selection` is a union — `{kind:'instance'; id} |
   * {kind:'none'}` — and TypeScript narrows a union from a *check written on the
   * value*, not from a condition spread across a ternary. Inside
   * `snapshot === null || store.selection.kind !== 'instance' ? … : …` the
   * `selection.id` in the false branch had no narrowing, and `id` does not exist
   * on the `none` arm.
   *
   * `selectionId` is the narrowed id or `null`, so the `find` is a plain lookup
   * with no union left in it.
   */
  const selectionId = $derived(store.selection.kind === 'instance' ? store.selection.id : null);
  const selected = $derived(
    snapshot === null || selectionId === null
      ? null
      : (snapshot.scene.instances.find((i) => i.id === selectionId) ?? null),
  );

  const gizmoModes: ReadonlyArray<{ mode: GizmoMode; label: string; key: string }> = [
    { mode: 'translate', label: 'Move', key: VIEWPORT_KEYS.move.toUpperCase() },
    { mode: 'rotate', label: 'Rotate', key: VIEWPORT_KEYS.rotate.toUpperCase() },
    { mode: 'scale', label: 'Scale', key: VIEWPORT_KEYS.scale.toUpperCase() },
  ];

  const snapChoices: ReadonlyArray<{ value: number | null; label: string }> = [
    { value: null, label: 'Snap off' },
    { value: 0.25, label: 'Snap 0.25' },
    { value: 0.5, label: 'Snap 0.5' },
    { value: 1, label: 'Snap 1' },
  ];

  /**
   * Apply an edit from the viewport or the inspector.
   */
  async function apply(edit: SceneEdit): Promise<void> {
    await store.applyEdit(edit);
  }
</script>

<section class="screen">
  {#if snapshot === null}
    <div class="empty">
      <h1>Scene</h1>
      <p>
        No project is open. Go to <strong>Project</strong>, type a folder path, and press
        <strong>Open project</strong>.
      </p>
    </div>
  {:else}
    <header class="bar" role="toolbar" aria-label="Scene controls">
      <!-- Merged single-row top bar: Scene name, project, action buttons -->
      <div class="bar-group scene-info">
        <span class="bar-project" title={`Project: ${snapshot.project.name}`}>
          {snapshot.project.name}
        </span>
        <span class="bar-divider">/</span>
        <span class="bar-value scene-name" title={`Scene: ${snapshot.scene.name}`}>
          {snapshot.scene.name}{hasUnsavedChanges ? ' •' : ''}
        </span>
        <span class="bar-muted">({snapshot.scene.instances.length} objects)</span>
        {#if hasUnsavedChanges}
          <span class="unsaved-badge" title="Scene has unsaved changes">unsaved</span>
        {/if}
      </div>

      <div class="bar-group" role="group" aria-label="Transform mode">
        <span class="bar-label">Mode</span>
        {#each gizmoModes as choice (choice.mode)}
          <button
            type="button"
            class="chip"
            class:on={store.gizmo === choice.mode}
            aria-pressed={store.gizmo === choice.mode}
            onclick={() => store.setGizmo(choice.mode)}
          >
            {choice.label} ({choice.key})
          </button>
        {/each}
      </div>

      <div class="bar-group">
        <span class="bar-label">Space</span>
        <button
          type="button"
          class="chip"
          aria-pressed={store.space === 'local'}
          onclick={() => store.setSpace(toggleSpace(store.space))}
        >
          {store.space === 'world' ? 'World' : 'Local'} ({VIEWPORT_KEYS.toggleSpace.toUpperCase()})
        </button>
      </div>

      <label class="bar-group">
        <span class="bar-label">Snap</span>
        <select
          value={store.snap === null ? 'off' : String(store.snap)}
          onchange={(event) => {
            const raw = event.currentTarget.value;
            store.setSnap(raw === 'off' ? null : Number(raw));
          }}
        >
          {#each snapChoices as choice (choice.label)}
            <option value={choice.value === null ? 'off' : String(choice.value)}>
              {choice.label}
            </option>
          {/each}
        </select>
      </label>

      <div class="bar-group actions-group">
        <button
          type="button"
          class="chip"
          disabled={!snapshot.history.canUndo}
          onclick={() => void store.undo()}
          title="Undo (Ctrl+Z)"
        >
          Undo{snapshot.history.canUndo && snapshot.history.undoCount > 0 ? ` (${snapshot.history.undoCount})` : ''}
        </button>
        <button
          type="button"
          class="chip"
          disabled={!snapshot.history.canRedo}
          onclick={() => void store.redo()}
          title="Redo (Ctrl+Shift+Z)"
        >
          Redo{snapshot.history.canRedo && snapshot.history.redoCount > 0 ? ` (${snapshot.history.redoCount})` : ''}
        </button>
        <button
          type="button"
          class="chip save-button"
          class:unsaved={hasUnsavedChanges}
          onclick={handleSave}
          aria-label="Save scene"
          title={hasUnsavedChanges ? 'Save changes to disk (Ctrl+S)' : 'Scene is saved'}
        >
          Save{hasUnsavedChanges ? ' •' : ''}
        </button>
        <button
          type="button"
          class="chip"
          onclick={handleReload}
          title="Reload scene from disk"
        >
          Reload
        </button>
      </div>
    </header>

    <div
      class="panes"
      class:resizing={resizingPane !== null}
      style="--outliner-width: {outlinerWidth}px; --inspector-width: {inspectorWidth}px;"
    >
      <div class="pane outliner">
        <h2>Outliner</h2>
        <Outliner
          instances={snapshot.scene.instances}
          prefabs={snapshot.prefabs.prefabs}
          failed={snapshot.prefabs.failed}
          selection={store.selection}
          errors={appErrors}
          onSelect={(sel) => store.select(sel)}
          onAdd={(intent) => {
            if (snapshot === null) return;
            const existing = new Set(snapshot.scene.instances.map((i) => i.id));
            let counter = 1;
            let candidate = `${intent.prefab}_${counter}`;
            while (existing.has(candidate)) {
              counter++;
              candidate = `${intent.prefab}_${counter}`;
            }
            void apply({
              op: 'addInstance',
              input: {
                id: candidate,
                prefab: intent.prefab,
                parent: intent.parent ?? undefined,
              },
            });
          }}
          onDelete={(intent) => {
            void apply({
              op: 'removeInstance',
              instanceId: intent.instanceId,
            });
          }}
        />
      </div>

      <!-- Left Resizer between Outliner and Viewport -->
      <!--
        The `<div>` is deliberate: a drag handle is not a control.
        `role="separator"` with `aria-orientation` and a live `aria-valuenow`
        describes it correctly, where a `<button>` would claim it is activatable.

        `a11y_no_noninteractive_element_interactions` is suppressed because the
        element genuinely handles pointer input. `a11y_no_noninteractive_tabindex`
        is **not** suppressed and `svelte-check` still reports it under
        `--threshold warning`; Svelte 5.57.1 does not honour a multi-code
        `svelte-ignore` for it. Left reporting rather than worked around, because the
        `tabindex="0"` is what makes the separator keyboard-reachable — which is the
        entire point of `aria-valuenow`. Recorded in AI.md under Known gaps.
      -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="resizer left"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={outlinerWidth}
        aria-valuemin={180}
        aria-valuemax={600}
        aria-label="Resize outliner pane"
        tabindex="0"
        onmousedown={(e) => startResize('outliner', e)}
        onkeydown={(e) => {
          if (e.key === 'ArrowLeft') outlinerWidth = Math.max(180, outlinerWidth - 10);
          if (e.key === 'ArrowRight') outlinerWidth = Math.min(600, outlinerWidth + 10);
        }}
      ></div>

      <div class="pane viewport">
        <Viewport
          {store}
          scene={snapshot.scene}
          {prefabIndex}
          onEdit={(edit) => void apply(edit)}
        />
      </div>

      <!-- Right Resizer between Viewport and Inspector. Same reasoning as the left one. -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="resizer right"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={inspectorWidth}
        aria-valuemin={200}
        aria-valuemax={700}
        aria-label="Resize inspector pane"
        tabindex="0"
        onmousedown={(e) => startResize('inspector', e)}
        onkeydown={(e) => {
          if (e.key === 'ArrowRight') inspectorWidth = Math.max(200, inspectorWidth - 10);
          if (e.key === 'ArrowLeft') inspectorWidth = Math.min(700, inspectorWidth + 10);
        }}
      ></div>

      <div class="pane inspector">
        <h2>Inspector</h2>
        <Inspector
          selection={store.selection}
          instance={selected}
          prefabs={snapshot.prefabs.prefabs}
          errors={appErrors}
          onEdit={(edit) => void apply(edit)}
          onSelect={(sel) => store.select(sel)}
        />
        {#if selected !== null}
          <p class="selected-id">
            Selected: <code title={instanceLabel(selected)}>{instanceLabel(selected)}</code>
            {#if selected.locked === true}
              <span class="locked">locked — an AI must not change this</span>
            {/if}
          </p>
        {/if}
      </div>
    </div>

    <!-- Problems container / panel from ERRORS subagent -->
    <div class="problems-container" class:collapsed={problemsCollapsed}>
      <header class="problems-bar">
        <button
          type="button"
          class="problems-toggle"
          aria-expanded={!problemsCollapsed}
          onclick={() => (problemsCollapsed = !problemsCollapsed)}
        >
          <span class="problems-chevron">{problemsCollapsed ? '▶' : '▼'}</span>
          <span class="problems-title">Problems</span>
          {#if problemCount > 0}
            <span class="badge problems-badge error-badge" title={`${problemCount} problem(s)`}>
              {problemCount}
            </span>
          {:else}
            <span class="badge problems-badge zero">0</span>
          {/if}
        </button>
      </header>

      {#if !problemsCollapsed}
        <div class="problems-content">
          {#if problemsPanel}
            {@render problemsPanel()}
          {:else}
            <ProblemsPanel
              snapshot={snapshot}
              problems={appErrors}
              prefabs={snapshot.prefabs.prefabs}
              failed={snapshot.prefabs.failed}
              count={problemCount}
              onSelectInstance={(id) => store.selectInstance(id)}
            />
          {/if}
        </div>
      {/if}
    </div>

    <footer class="foot">
      <span>
        Snap: translate {snapValues.translation ?? 'off'}, rotate
        {snapValues.rotation === null
          ? 'off'
          : `${Math.round((snapValues.rotation * 180) / Math.PI)}°`}, scale
        {snapValues.scale ?? 'off'} · Focus ({VIEWPORT_KEYS.focus.toUpperCase()}) frames the
        selection.
      </span>
    </footer>
  {/if}
</section>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  /* Merged clean single-row header */
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
    overflow-x: hidden;
    overflow-y: hidden;
    min-height: 42px;
  }

  .bar-group {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .scene-info {
    min-width: 0;
    margin-right: 4px;
  }
  .bar-project {
    font-size: 12px;
    color: var(--muted);
    font-weight: 500;
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bar-divider {
    color: var(--muted);
    opacity: 0.5;
    font-size: 12px;
  }
  .bar-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
  }
  .bar-value {
    font-weight: 600;
  }
  .scene-name {
    font-size: 13px;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bar-muted {
    color: var(--muted);
    font-size: 12px;
  }
  .unsaved-badge {
    font-size: 10px;
    color: #e0a030;
    background: rgba(224, 160, 48, 0.15);
    border: 1px solid #e0a030;
    border-radius: 3px;
    padding: 1px 4px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .chip {
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 4px 10px;
    font-size: 12px;
    white-space: nowrap;
  }
  .chip.on {
    border-color: var(--accent);
    color: var(--accent);
  }
  .chip:hover:not(:disabled) {
    border-color: var(--muted);
  }
  .chip.save-button.unsaved {
    border-color: #e0a030;
    color: #e0a030;
  }

  select {
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 4px 8px;
    font-size: 12px;
  }

  /* Resizable Panes layout */
  .panes {
    display: grid;
    grid-template-columns: var(--outliner-width, 300px) 5px 1fr 5px var(--inspector-width, 320px);
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .panes.resizing {
    user-select: none;
    cursor: col-resize;
  }

  .pane {
    min-width: 0;
    min-height: 0;
    padding: 12px;
  }
  .pane.outliner {
    background: var(--panel);
    overflow-x: hidden;
    overflow-y: auto;
  }
  .pane.inspector {
    background: var(--panel);
    overflow-x: hidden;
    overflow-y: auto;
  }
  .pane.viewport {
    padding: 0;
    overflow: hidden;
  }

  /* Resizers */
  .resizer {
    width: 5px;
    cursor: col-resize;
    background: var(--line);
    transition: background 0.15s;
    z-index: 10;
  }
  .resizer:hover,
  .resizer:focus-visible {
    background: var(--accent, #646cff);
    outline: none;
  }

  h2 {
    margin: 0 0 10px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
  }

  .selected-id {
    margin-top: 14px;
    font-size: 12px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .selected-id code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .locked {
    display: block;
    color: var(--warning);
    margin-top: 4px;
  }

  /* Problems panel container */
  .problems-container {
    border-top: 1px solid var(--line);
    background: var(--panel);
    font-size: 12px;
    flex-shrink: 0;
  }
  .problems-bar {
    display: flex;
    align-items: center;
    padding: 4px 12px;
    border-bottom: 1px solid var(--line);
  }
  .problems-container.collapsed .problems-bar {
    border-bottom: none;
  }
  .problems-toggle {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px;
    border-radius: 3px;
  }
  .problems-toggle:hover {
    background: rgba(255, 255, 255, 0.06);
  }
  .problems-chevron {
    font-size: 9px;
    opacity: 0.7;
  }
  .problems-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
  }
  .badge.problems-badge {
    font-size: 10px;
    padding: 0 5px;
    border-radius: 8px;
    font-weight: 600;
  }
  .badge.error-badge {
    color: #e05252;
    background: rgba(224, 82, 82, 0.15);
    border: 1px solid #e05252;
  }
  .badge.zero {
    color: var(--muted);
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--line);
  }
  .problems-content {
    max-height: 140px;
    overflow-y: auto;
    padding: 6px 12px;
  }

  .foot {
    padding: 6px 16px;
    border-top: 1px solid var(--line);
    background: var(--panel);
    font-size: 11px;
    color: var(--muted);
    flex-shrink: 0;
  }

  .empty {
    padding: 40px;
    color: var(--muted);
    line-height: 1.6;
  }
  .empty h1 {
    color: var(--text);
  }
</style>

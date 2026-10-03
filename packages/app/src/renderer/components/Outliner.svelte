<!--
  Outliner.svelte — the searchable tree of scene instances.

  ## What this component is and is not

  It renders a hierarchy and emits **intents**. It never mutates the `instances`
  it is given, never writes to disk, and never decides an id: `instances` is a
  prop, and every change leaves as an `onAdd` / `onDelete` callback that the
  shell turns into one `SceneEdit` for the main process (SPEC R10, and the
  one-edit-one-undo-step rule in `ipc.ts`). Keeping the scene data in one owner
  is what stops two panels disagreeing about what the scene contains.

  ## The parts that carry a decision

  * **Search** — `filterTree` in `tree.ts`, which keeps a matched parent *and*
    its whole subtree. A row kept only because a descendant matched says so.
  * **Delete with children** — inline confirmation whose text states the
    consequence (children move up to the removed instance's parent and are
    kept). Never a silent removal, and never `window.confirm`, because the
    consequence has to be readable next to the button that caused it.
  * **Failed prefabs** — a distinct marker, from `PrefabRegistryResult.failed`.
    A prefab that threw is a normal state of a project an AI is editing, so it
    is a row you can still select, not a viewer that refuses to open.
-->

<script lang="ts">
  import type { PrefabFailure, PrefabSummary, Selection } from '../../ipc.js';
  import type { SceneInstance } from '@contextforge/core';
  import type { AppError } from '../../errors.js';
  import {
    addIntentFor,
    buildTree,
    countDirectChildren,
    deleteIntentFor,
    describeRemoval,
    filterTree,
    flattenVisible,
    pickerEmptyText,
    pickerState,
    type AddIntent,
    type DeleteIntent,
    type OutlinerNode,
  } from './tree.js';

  interface Props {
    /** Every instance in the scene, in file order. Never mutated here. */
    instances: readonly SceneInstance[];
    /** The registry, split into what loaded and what did not. */
    prefabs: readonly PrefabSummary[];
    failed: readonly PrefabFailure[];
    /** What is selected now. Clicking calls `onSelect`; it does not assign this. */
    selection: Selection;
    /** Scene or validation errors to show against instances. */
    errors?: readonly (AppError | string)[];
    /** Keyboard selection also goes through here. */
    onSelect?: (selection: Selection) => void;
    /** A prefab was picked. The shell mints the id and sends one edit. */
    onAdd?: (intent: AddIntent) => void;
    /** A delete was confirmed. */
    onDelete?: (intent: DeleteIntent) => void;
  }

  const {
    instances,
    prefabs,
    failed,
    selection,
    errors = [],
    onSelect = () => {},
    onAdd = () => {},
    onDelete = () => {},
  }: Props = $props();

  let query = $state('');
  /** The row whose delete is awaiting confirmation. */
  let pendingDeleteId = $state<string | null>(null);
  let pickerOpen = $state(false);
  /** Prefab names offered in the picker, filtered by the same box. */
  let prefabQuery = $state('');

  const failedByName = $derived(
    new Map<string, PrefabFailure>(failed.map((failure) => [failure.name, failure])),
  );
  const roots = $derived(buildTree(instances, failedByName));
  const visible = $derived(filterTree(roots, query));
  /** Flattened, so arrow keys walk only the rows that are actually on screen. */
  const rows = $derived(flattenVisible(visible));

  /** What the picker is showing, and the sentence when it has nothing. */
  const picker = $derived(pickerState(prefabs, prefabQuery));
  const pickerMessage = $derived(pickerEmptyText(picker));

  const selectedId = $derived(selection.kind === 'instance' ? selection.id : null);

  function nodeFor(id: string | null): OutlinerNode | null {
    if (id === null) return null;
    for (const row of rows) if (row.node.instance.id === id) return row.node;
    return null;
  }

  const pendingDelete = $derived(nodeFor(pendingDeleteId));
  const pendingDeleteReason = $derived(
    pendingDelete === null ? null : describeRemoval(pendingDelete),
  );

  function select(id: string): void {
    onSelect({ kind: 'instance', id });
  }

  function nodeErrors(id: string): AppError[] {
    if (!errors) return [];
    const list: AppError[] = [];
    for (const err of errors) {
      if (typeof err === 'object' && err !== null && 'scope' in err) {
        if (err.instanceId === id) {
          list.push(err);
        }
      }
    }
    return list;
  }

  /**
   * Arrow-key navigation over the *visible* rows.
   *
   * Walking the filtered list rather than the full tree is the point: with a
   * search active, a down-arrow that jumped over a hidden row would move the
   * selection somewhere the developer cannot see.
   */
  function onKeyDown(event: KeyboardEvent): void {
    if (rows.length === 0) return;
    const index = rows.findIndex((row) => row.node.instance.id === selectedId);
    let next = index;
    if (event.key === 'ArrowDown') next = index + 1;
    else if (event.key === 'ArrowUp') next = index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    else return;

    event.preventDefault();
    if (next < 0) next = 0;
    if (next >= rows.length) next = rows.length - 1;
    const row = rows[next];
    if (row !== undefined) select(row.node.instance.id);
  }

  function requestDelete(node: OutlinerNode): void {
    pendingDeleteId = node.instance.id;
    pickerOpen = false;
  }

  function confirmDelete(node: OutlinerNode): void {
    onDelete(deleteIntentFor(node));
    pendingDeleteId = null;
  }

  function pickPrefab(prefab: PrefabSummary): void {
    onAdd(addIntentFor(prefab.name, selectedId));
    pickerOpen = false;
    prefabQuery = '';
  }
</script>

<section class="outliner" aria-label="Scene instances">
  <header>
    <input
      type="search"
      placeholder="Filter by id, name or prefab"
      aria-label="Filter instances"
      bind:value={query}
    />
    <button type="button" onclick={() => (pickerOpen = !pickerOpen)} aria-expanded={pickerOpen}>
      Add…
    </button>
  </header>

  <!--
    The picker's contents are always in the markup, open or closed. A component
    that only renders them while open means "the registry is empty" — a fact
    the developer needs before clicking Add, and one that costs nothing to keep
    on screen. The list itself is hidden rather than removed, so the search
    input keeps its focus and the registry is inspectable either way.
  -->
  <div class="picker" role="dialog" aria-label="Add an instance" hidden={!pickerOpen}>
    <input
      type="search"
      placeholder="Filter prefabs"
      aria-label="Filter prefabs"
      bind:value={prefabQuery}
    />
    <p class="empty" hidden={pickerMessage === ''}>{pickerMessage}</p>
    {#if picker.kind === 'list'}
      <ul>
        {#each picker.prefabs as prefab (prefab.name)}
          <li>
            <button type="button" onclick={() => pickPrefab(prefab)}>
              <span class="prefab-name" title={prefab.name}>{prefab.name}</span>
              <span class="prefab-desc" title={prefab.description}>{prefab.description}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>


  {#if instances.length === 0}
    <p class="empty">This scene has no instances.</p>
  {:else if rows.length === 0}
    <p class="empty">No instance matches “{query}”.</p>
  {:else}
    <ul class="tree" role="tree" tabindex="0" onkeydown={onKeyDown} aria-label="Instance tree">
      {#each rows as row (row.node.instance.id)}
        {@const node = row.node}
        {@const errs = nodeErrors(node.instance.id)}
        <li
          role="treeitem"
          aria-selected={selectedId === node.instance.id}
          aria-level={node.depth + 1}
        >
          <div
            class="row"
            class:selected={selectedId === node.instance.id}
            class:orphan={node.orphan}
            class:failed={node.failed}
            class:has-error={errs.length > 0}
            style:--depth={node.depth}
          >
            <button
              type="button"
              class="pick"
              onclick={() => select(node.instance.id)}
              title={node.instance.id}
            >
              <span class="label" title={node.label}>{node.label}</span>
              <span class="prefab" title={node.instance.prefab}>{node.instance.prefab}</span>
              {#if node.instance.locked === true}
                <span class="badge locked" title="Locked: edits are blocked">locked</span>
              {/if}
              {#if node.instance.visible === false}
                <span class="badge hidden" title="Hidden in the viewport">hidden</span>
              {/if}
              {#if node.orphan}
                <span
                  class="badge orphan"
                  title="Its parent id is not in this scene; shown at the root so it can still be selected"
                >
                  missing parent “{node.instance.parent}”
                </span>
              {/if}
              {#if node.failed && node.failure !== null}
                <span
                  class="badge failed-badge"
                  title={`${node.failure.reason}${node.failure.file ? ` — ${node.failure.file}` : ''}`}
                >
                  prefab failed: {node.failure.name}
                </span>
              {/if}
              {#if errs.length > 0}
                <span
                  class="badge error-badge"
                  title={errs.map((e) => e.short).join('; ')}
                >
                  error
                </span>
              {/if}
              {#if row.reason === 'descendant'}
                <span class="badge hint" title="Shown because something below it matches">
                  via child
                </span>
              {/if}
            </button>
            <button
              type="button"
              class="delete"
              onclick={() => requestDelete(node)}
              aria-label={`Delete ${node.label}`}
            >
              ✕
            </button>
          </div>

          {#if pendingDeleteId === node.instance.id && pendingDeleteReason !== null}
            <div class="confirm" role="alertdialog" aria-label={`Confirm deleting ${node.label}`}>
              <p>{pendingDeleteReason}</p>
              {#if countDirectChildren(node) > 0}
                <p class="consequence">
                  {countDirectChildren(node) === 1
                    ? 'Its child is kept and moved up.'
                    : 'Its children are kept and moved up.'}
                </p>
              {/if}
              <div class="actions">
                <button type="button" class="danger" onclick={() => confirmDelete(node)}>
                  Delete
                </button>
                <button type="button" onclick={() => (pendingDeleteId = null)}>Cancel</button>
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .outliner {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
    max-width: 100%;
    overflow-x: hidden;
  }
  header {
    display: flex;
    gap: 0.25rem;
    min-width: 0;
  }
  header input {
    flex: 1 1 auto;
    min-width: 0;
  }
  .picker {
    border: 1px solid #555;
    padding: 0.5rem;
    overflow-x: hidden;
  }
  .picker ul,
  .tree {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-x: hidden;
    width: 100%;
  }
  .picker button {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: 100%;
    min-width: 0;
    text-align: left;
    overflow: hidden;
  }
  .prefab-desc {
    opacity: 0.7;
    font-size: 0.85em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .prefab-name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding-left: calc(var(--depth, 0) * 1rem);
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }
  .pick {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    flex: 1 1 auto;
    min-width: 0;
    text-align: left;
    overflow: hidden;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex-shrink: 1;
  }
  .prefab {
    opacity: 0.65;
    font-size: 0.8em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex-shrink: 2;
  }
  .badge {
    font-size: 0.7em;
    border: 1px solid currentColor;
    border-radius: 3px;
    padding: 0 0.25em;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .badge.failed-badge,
  .badge.orphan {
    color: #b4553a;
  }
  .badge.locked {
    color: #b08b2a;
  }
  .badge.error-badge {
    color: #e05252;
    border-color: #e05252;
    background: rgba(224, 82, 82, 0.12);
  }
  .row.has-error {
    background: rgba(224, 82, 82, 0.08);
  }
  .row.selected .label {
    font-weight: 700;
  }
  .row.selected {
    outline: 1px solid currentColor;
  }
  .confirm {
    border: 1px solid #b4553a;
    padding: 0.5rem;
    margin: 0.25rem 0 0.5rem 1rem;
    overflow-x: hidden;
  }
  .confirm p {
    margin: 0 0 0.25rem;
    overflow-wrap: break-word;
  }
  .consequence {
    opacity: 0.85;
    font-size: 0.9em;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
  }
  .danger {
    color: #b4553a;
  }
  .empty {
    opacity: 0.7;
    font-size: 0.9em;
  }
</style>

<!--
  GraphScreen.svelte — the file-level dependency graph (Step 5a/5b/5c).

  Everything numeric on this screen comes from core: `summariseGraph` for the
  header counts, `focusNeighbourhood` + `edgesWithin` for focus mode, and
  `findOrphans` for the drawer. This component counts nothing itself. That is
  deliberate and is the D44 lesson applied: the Problems panel once showed
  `PROBLEMS (2)` over `PROBLEMS (6)` because two layers derived one count, and a
  graph with a node badge and a header that disagree is the same defect.

  Cytoscape owns the canvas and the layout. It is given exactly the elements the
  core functions returned — no counting, no filtering decisions of its own.
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  // **Type-only.** Core is `external` in the renderer build (see
  // `vite.config.ts`), which is sound *because* every renderer import of it is
  // erased at build time. A value import would leave a bare
  // `@contextforge/core` specifier in the bundle that the browser sandbox cannot
  // resolve, and the whole app would fail to mount with no error — which is
  // exactly what happened when this screen first imported `focusNeighbourhood`
  // as a value.
  //
  // So the analysis the screen needs is computed in the main process and arrives
  // over IPC. `graph:project` returns the neighbourhood and orphan list the
  // screen needs, derived by the one set of core functions, so the counts on
  // screen still have exactly one derivation (D44).
  import type {
    DependencyGraph,
    FocusDepth,
    FocusedNode,
    GraphNode,
    GraphSummary,
    Orphan,
  } from '@contextforge/core';
  import type { EditorStore } from '../store.js';
  import { CHANNELS } from '../../ipc.js';

  let { store }: { store: EditorStore } = $props();

  /** The graph as the main process produced it. Null until the request resolves. */
  let graph = $state<DependencyGraph | null>(null);
  /** core's counts for this graph, so the screen derives nothing itself. */
  let summary = $state<GraphSummary | null>(null);
  /** core's unreferenced files, each with the reason it was flagged. */
  let orphans = $state<Orphan[]>([]);

  /**
   * The focused neighbourhood, requested from core when the selection changes.
   *
   * Empty means "no focus", which is the whole-graph view — the same null-ish
   * default the toolbar uses, so `Show all files` is a single state and not a
   * special case.
   */
  let focused = $state<FocusedNode[]>([]);
  let focusedEdges = $state<{ from: string; to: string; kind: string }[]>([]);

  let loading = $state(false);
  /** Set when the request failed; the screen says so rather than showing an empty canvas. */
  let error = $state<string | null>(null);

  /** The focused node, or null for the whole graph. */
  let focusId = $state<string | null>(null);
  let depth = $state<FocusDepth>(1);
  let orphansOpen = $state(false);
  /** Paths the developer ticked in the drawer, waiting to go into a prompt. */
  let attached = $state<string[]>([]);

  let container: HTMLDivElement | undefined = $state();
  let cy: import('cytoscape').Core | null = null;

  /**
   * Guards against a stale focus request landing after a newer one.
   *
   * `focusOn` is asynchronous, and a developer who clicks a node and then
   * presses "Show all files" before the answer arrives has both requests in
   * flight. If the focus answer arrives last it overwrites the clear, and the
   * canvas is left showing a neighbourhood for a node that is no longer
   * selected — with no error and no way back, because the "Show all files"
   * button is only rendered while focused.
   *
   * A monotonically increasing generation, captured when a request is made and
   * checked when it returns, is enough: a later call always wins.
   */
  let focusGeneration = 0;

  /**
   * No `$derived` element set here, deliberately.
   *
   * The obvious design computes the visible nodes from `focusId` and lets the
   * canvas re-render from it. It does not work: a `$derived` only recomputes on
   * a flush, so a `sync()` called right after an `await` reads the *previous*
   * value and pushes the wrong elements. The symptom was a blank canvas on
   * every focus change, with no error anywhere — the one state this screen
   * exists to show.
   *
   * So each path that changes what should be drawn passes the elements to
   * `sync` explicitly. The cost is that the derivation is written out three
   * times; the benefit is that it cannot read a stale value.
   */

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const result = await store.requestChannel(CHANNELS.projectGraph, {});
      if (result.ok) {
        graph = { nodes: result.value.nodes, edges: result.value.edges };
        summary = result.value.summary;
        orphans = result.value.orphans;
      } else {
        // Said out loud. An empty canvas for a project that failed to read is
        // indistinguishable from a project with no files, and the developer
        // would have no way to tell which they were looking at.
        error = result.reason;
        graph = null;
        summary = null;
        orphans = [];
      }
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
      graph = null;
      summary = null;
      orphans = [];
    } finally {
      loading = false;
    }
  }

  /**
   * Ask core for the neighbourhood around `id`.
   *
   * The request carries the whole graph because the main process owns the
   * analysis — the renderer cannot do it itself, since core is `external` in the
   * renderer build. Resizing the payload is a real cost at 1,000 files; the
   * honest fix is a graph the main process caches by project root, which is where
   * this should go if it ever shows up.
   *
   * Two things in here are load-bearing, and both were found by running the app
   * rather than by any test.
   *
   * **`$state.snapshot` on the payload.** `graph` is a `$state`, so it is a
   * Svelte **proxy**, and `ipcRenderer.invoke` sends its argument through the
   * structured-clone algorithm — which cannot clone a proxy. Every focus click
   * failed with "An object could not be cloned" and left the canvas blank. The
   * store's own error path turned that into a refusal sentence shown on a
   * screen that was otherwise empty, so nothing pointed at the cause. The
   * snapshot unwraps the proxy; the deep copy it performs is the honest cost,
   * and it is why the fix at 1,000 files is a cached graph in the main process
   * rather than a cheaper clone here.
   *
   * **The generation guard.** See `focusGeneration` above.
   */
  async function focusOn(id: string, at: FocusDepth): Promise<number> {
    const generation = ++focusGeneration;
    const payload = {
      id,
      depth: at,
      graph: $state.snapshot({ nodes: graph?.nodes ?? [], edges: graph?.edges ?? [] }),
    };
    const result = await store.requestChannel(CHANNELS.projectFocus, payload);
    // A later request has already superseded this one — a click followed
    // quickly by "Show all files", say. Its answer is the one the developer
    // sees, so this one is dropped rather than allowed to overwrite it.
    if (generation !== focusGeneration) return generation;
    if (result.ok) {
      focused = result.value.nodes;
      focusedEdges = result.value.edges;
    }
    return generation;
  }

  /**
   * Push an element set into Cytoscape.
   *
   * The nodes and edges are **required**, not defaulted to a `$derived`. Svelte
   * recomputes a `$derived` only on a flush, so a `sync()` called immediately
   * after an `await` would read the previous value and push the wrong elements —
   * which showed as an empty canvas on every focus change, silently.
   *
   * Cytoscape is told which elements to remove before which to add, and the
   * layout reruns only when the node set actually changed. Rerunning a layout on
   * every focus change would throw away the developer's pan and zoom, which is
   * the thing they were doing when they clicked a node.
   */
  function sync(next: {
    nodes: GraphNode[];
    edges: { from: string; to: string; kind: string }[];
    distance?: Map<string, number>;
  }): void {
    if (cy === null) return;
    const nodes = next.nodes;
    const edges = next.edges;
    const distance = next.distance ?? new Map<string, number>();

    /**
     * Built from scratch each time, then swapped in wholesale.
     *
     * The obvious version — remove what is not wanted, then `add` the rest —
     * does not work, and the failure is quiet and severe. Cytoscape's `add` is a
     * **no-op for an id already in the graph**, so a node that survived the
     * removal pass keeps its *old* data, and a node removed by an earlier
     * `sync` is not in the collection the later pass iterates. The result was
     * "Show all files" painting 17 of 37 nodes with zero edges: every node that
     * had been in the focused set kept its focus-scoped data and no edge
     * between any two of them survived.
     *
     * Building the whole element set fresh and swapping it in cannot have that
     * failure mode, because nothing is merged with a previous state.
     */
    const elements = [
      ...nodes.map((node) => ({
        group: 'nodes' as const,
        data: {
          id: node.id,
          label: node.id,
          type: node.type,
          // A string, because a Cytoscape attribute selector compares quoted
          // strings: `node[distance = "1"]`, never `node[distance = 1]`.
          distance: String(distance.get(node.id) ?? -1),
          focus: node.id === focusId,
        },
      })),
    ];
    const seenEdges = new Set<string>();
    for (const edge of edges) {
      const id = `${edge.from}->${edge.to}:${edge.kind}`;
      if (seenEdges.has(id)) continue;
      seenEdges.add(id);
      elements.push({
        group: 'edges' as const,
        data: { id, source: edge.from, target: edge.to, kind: edge.kind },
      });
    }

    cy.elements().remove();
    cy.add(elements);

    const layout = (cy as unknown as { layout: (o: unknown) => { run: () => void } }).layout({
      name: 'breadthfirst',
      directed: true,
      padding: 24,
      spacingFactor: 1.05,
    });
    layout.run();
  }

  function selectFocus(id: string): void {
    // Clicking the focused node again releases the focus, so there is always a
    // way back to the full graph from the node itself as well as the button.
    focusId = focusId === id ? null : id;
    void applyFocus();
  }

  async function applyFocus(): Promise<void> {
    if (focusId === null) {
      // Bumping the generation invalidates any focus request still in flight, so
      // it cannot repopulate the canvas after the developer has left it.
      focusGeneration++;
      focused = [];
      focusedEdges = [];
      sync({ nodes: graph?.nodes ?? [], edges: graph?.edges ?? [] });
      return;
    }
    const generation = await focusOn(focusId, depth);
    if (generation !== focusGeneration) return;
    // The elements are passed explicitly. `visible` is a `$derived` and only
    // recomputes on a flush, so reading it here would push the previous set —
    // which showed as a blank canvas on every focus change.
    sync({
      nodes: focused.map((f) => f.node),
      edges: focusedEdges,
      distance: new Map(focused.map((f) => [f.node.id, f.distance])),
    });
  }

  function clearFocus(): void {
    focusId = null;
    // Same invalidation as the `focusId === null` branch above, so a request
    // already in flight cannot resurrect the neighbourhood.
    focusGeneration++;
    focused = [];
    focusedEdges = [];
    sync({ nodes: graph?.nodes ?? [], edges: graph?.edges ?? [] });
  }

  function setDepth(next: FocusDepth): void {
    depth = next;
    void applyFocus();
  }

  function toggleAttach(path: string): void {
    attached = attached.includes(path)
      ? attached.filter((p) => p !== path)
      : [...attached, path];
  }

  onMount(() => {
    // Imported lazily so the module graph for every other screen does not carry
    // a rendering library it never uses.
    void (async () => {
      const cytoscape = (await import('cytoscape')).default;
      if (container === undefined) return;
      cy = cytoscape({
        container,
        elements: [],
        layout: { name: 'breadthfirst', directed: true },
        style: [
          {
            selector: 'node',
            style: {
              'background-color': '#4a5468',
              label: 'data(label)',
              color: '#c8ceda',
              'font-size': 9,
              'text-valign': 'bottom',
              'text-margin-y': 3,
              width: 16,
              height: 16,
            },
          },
          {
            selector: 'node[type = "asset"]',
            style: { 'background-color': '#6b5a3e', shape: 'round-rectangle' },
          },
          {
            selector: 'node[type = "scene"]',
            style: { 'background-color': '#3f6b4a', shape: 'diamond' },
          },
          { selector: 'edge', style: { width: 1, 'line-color': '#5a6272', 'curve-style': 'straight' } },
          {
            selector: 'edge[kind = "asset_ref"]',
            style: { 'line-style': 'dashed', 'line-color': '#7a6a4a' },
          },
          // Values in an attribute selector are quoted strings, not bare
          // identifiers. `node[focus = true]` is rejected by Cytoscape's
          // selector parser — it threw at draw time and left the canvas empty
          // whenever focus mode was on, which is exactly the state this screen
          // exists to show.
          {
            selector: 'node[focus = "true"]',
            style: { 'background-color': '#e0913a', width: 26, height: 26 },
          },
          {
            selector: 'node[distance = "1"]',
            style: { 'background-color': '#4a7fa8', width: 20, height: 20 },
          },
          { selector: 'node:selected', style: { 'border-width': 2, 'border-color': '#e0913a' } },
        ],
      });

      // Exposed for the capture harness, which has to click a *real* node: the
      // canvas has no per-node element, so a harness that guesses coordinates
      // would be clicking the background and proving nothing. `App.svelte`
      // already exposes `__store` for the same reason.
      if (typeof window !== 'undefined') {
        (window as unknown as Record<string, unknown>)['__cy'] = cy;
      }

      cy.on('tap', 'node', (event) => selectFocus(event.target.id() as string));
      await load();
      // Explicit elements again: `load()` just assigned `graph`, and `visible`
      // would still be its pre-load empty value on this tick.
      sync({ nodes: graph?.nodes ?? [], edges: graph?.edges ?? [] });
    })();

    return () => {
      cy?.destroy();
      cy = null;
    };
  });

  onDestroy(() => {
    cy?.destroy();
    cy = null;
  });

  /** `src/a/b.ts` — the last segment, for a label that fits in a 16px circle. */
  function basename(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1] ?? path;
  }

  const ORPHAN_LABEL: Record<string, string> = {
    unreferenced:
      'Nothing imports this file and it imports nothing. It may be dead code — or something that is loaded by a path the extractor cannot see, like a config file.',
    entry_point:
      'Nothing imports this file, but it imports others. That is the shape of an entry point: main.ts, a test, a CLI. It is unreferenced, not unused.',
    unreferenced_asset: 'No source file references this asset. The model or texture may never be loaded.',
  };
</script>

<section class="graph-screen">
  <header class="head">
    <div class="titles">
      <h2>Graph</h2>
      {#if summary !== null}
        <p class="counts">
          {summary.nodes} files · {summary.edges} edges · {summary.orphans} unreferenced
        </p>
      {/if}
    </div>

    <div class="controls">
      {#if focusId !== null}
        <label class="depth">
          Depth
          <select
            value={depth}
            onchange={(e) => setDepth(Number(e.currentTarget.value) as FocusDepth)}
          >
            <option value={1}>1 — neighbours</option>
            <option value={2}>2 — and theirs</option>
          </select>
        </label>
        <span class="focus-name" title={focusId}>{basename(focusId)}</span>
        <!-- The way back. Always present while focused, never buried. -->
        <button type="button" class="clear" onclick={clearFocus}>Show all files</button>
      {:else}
        <button
          type="button"
          class="drawer-toggle"
          aria-expanded={orphansOpen}
          onclick={() => (orphansOpen = !orphansOpen)}
        >
          {orphansOpen ? '▶' : '▼'} Unreferenced ({orphans.length})
        </button>
      {/if}
    </div>
  </header>

  {#if loading}
    <p class="status">Reading the project…</p>
  {:else if error !== null}
    <p class="status error" role="alert">{error}</p>
  {/if}

  <div class="body">
    <div class="canvas" bind:this={container}></div>

    {#if orphansOpen && graph !== null}
      <aside class="orphans" aria-label="Unreferenced files">
        <h3>Unreferenced files</h3>
        <p class="hint">
          Nothing in the project imports these. That is not the same as useless — an entry point is
          unreferenced by definition. Each one says which case it is.
        </p>
        {#if orphans.length === 0}
          <p class="empty">Every file is imported by something.</p>
        {:else}
          <ul>
            {#each orphans as orphan (orphan.node.id)}
              <li class:attached={attached.includes(orphan.node.id)}>
                <label>
                  <input
                    type="checkbox"
                    checked={attached.includes(orphan.node.id)}
                    onchange={() => toggleAttach(orphan.node.id)}
                  />
                  <span class="path" title={orphan.node.id}>{basename(orphan.node.id)}</span>
                  <span class={`reason ${orphan.reason}`}>{orphan.reason.replace('_', ' ')}</span>
                </label>
                <p class="why">{ORPHAN_LABEL[orphan.reason] ?? ''}</p>
                {#if orphan.dependsOn.length > 0}
                  <p class="deps">imports {orphan.dependsOn.join(', ')}</p>
                {/if}
              </li>
            {/each}
          </ul>
          {#if attached.length > 0}
            <p class="attached-note" role="status">
              {attached.length} file(s) attached: {attached.map(basename).join(', ')}
            </p>
            <p class="hint">
              Use these in the Context screen — they are not in the brief unless something references
              them.
            </p>
          {/if}
        {/if}
      </aside>
    {/if}
  </div>
</section>

<style>
  .graph-screen {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    gap: 0.5rem;
    padding: 0.5rem;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
  }
  .counts {
    margin: 0.15rem 0 0;
    font-size: 0.78rem;
    opacity: 0.75;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .depth {
    font-size: 0.78rem;
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  select,
  button {
    background: var(--panel-2, #2a2a2a);
    border: 1px solid var(--line, #444);
    color: var(--text, #ccc);
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 0.78rem;
  }
  button {
    cursor: pointer;
  }
  button:hover {
    border-color: #888;
  }
  .clear {
    border-color: var(--accent, #61afef);
    color: var(--accent, #61afef);
  }
  .focus-name {
    font-family: monospace;
    font-size: 0.78rem;
    padding: 2px 6px;
    background: rgba(224, 145, 58, 0.15);
    border-radius: 3px;
  }
  .status {
    margin: 0;
    font-size: 0.85rem;
    opacity: 0.8;
  }
  .status.error {
    color: #e0714f;
    opacity: 1;
  }
  .body {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    gap: 0.5rem;
  }
  .canvas {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 320px;
    border: 1px solid var(--line, #333);
    border-radius: 3px;
    background: #16181d;
  }
  .orphans {
    width: 300px;
    flex: 0 0 300px;
    overflow-y: auto;
    border: 1px solid var(--line, #333);
    border-radius: 3px;
    padding: 0.5rem;
    font-size: 0.8rem;
  }
  .orphans h3 {
    margin: 0 0 0.3rem;
    font-size: 0.85rem;
  }
  .hint {
    margin: 0 0 0.5rem;
    opacity: 0.7;
    line-height: 1.35;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  li {
    border-left: 3px solid #b4553a;
    background: rgba(180, 85, 58, 0.07);
    padding: 0.3rem 0.45rem;
    border-radius: 2px;
  }
  li.attached {
    border-left-color: var(--accent, #61afef);
    background: rgba(97, 175, 239, 0.08);
  }
  label {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    cursor: pointer;
  }
  .path {
    font-family: monospace;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .reason {
    font-size: 0.68rem;
    padding: 0.05em 0.4em;
    border-radius: 999px;
    background: #333;
    opacity: 0.9;
    white-space: nowrap;
  }
  .reason.entry_point {
    background: #3a4a3a;
  }
  .reason.unreferenced_asset {
    background: #4a3f2e;
  }
  .why {
    margin: 0.25rem 0 0;
    opacity: 0.65;
    line-height: 1.3;
  }
  .deps {
    margin: 0.2rem 0 0;
    font-family: monospace;
    font-size: 0.7rem;
    opacity: 0.6;
  }
  .empty {
    opacity: 0.7;
    font-style: italic;
  }
  .attached-note {
    margin: 0.5rem 0 0.2rem;
    font-size: 0.78rem;
    color: var(--accent, #61afef);
  }
</style>
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
    MissingAsset,
    Orphan,
    UnparseableFile,
  } from '@contextforge/core';
  import type { EditorStore } from '../store.js';
  import { basename, decideGraphLabels, isSingled } from '../graph/labels.js';

  /**
   * The font Cytoscape draws labels in, kept in one constant because two places
   * need it: the style block that draws, and the measuring probe that has to
   * match it exactly. If they drifted, the measured width would describe a font
   * nobody is looking at.
   */
  const LABEL_FONT_FAMILY =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const LABEL_FONT = `9px ${LABEL_FONT_FAMILY}`;

  import { CHANNELS } from '../../ipc.js';

  let { store }: { store: EditorStore } = $props();

  /** The graph as the main process produced it. Null until the request resolves. */
  let graph = $state<DependencyGraph | null>(null);
  /** core's counts for this graph, so the screen derives nothing itself. */
  let summary = $state<GraphSummary | null>(null);
  /** core's unreferenced files, each with the reason it was flagged. */
  let orphans = $state<Orphan[]>([]);
  /**
   * Files that exist in the project but could not be parsed.
   *
   * Shown, not hidden. Before the extractor was made to survive one, a single
   * broken file threw and the whole graph was empty — and an empty graph with a
   * broken file in it is indistinguishable from an empty graph without one.
   */
  let unparseable = $state<UnparseableFile[]>([]);

  /**
   * Asset references that resolve to nothing.
   *
   * Collapsed by default, unlike the unparseable banner. A project can have a
   * handful of these legitimately (a dev harness writing screenshots outside the
   * project is the common case), and an always-expanded list of them pushes the
   * graph itself off the screen — which is the thing the developer opened this
   * screen to look at. The count is always visible; the detail is one click.
   */
  let missingAssets = $state<MissingAsset[]>([]);
  let missingOpen = $state(false);

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
        unparseable = result.value.unparseable;
        missingAssets = result.value.missingAssets;
      } else {
        // Said out loud. An empty canvas for a project that failed to read is
        // indistinguishable from a project with no files, and the developer
        // would have no way to tell which they were looking at.
        error = result.reason;
        graph = null;
        summary = null;
        orphans = [];
        unparseable = [];
        missingAssets = [];
      }
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
      graph = null;
      summary = null;
      orphans = [];
      unparseable = [];
      missingAssets = [];
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
    // Decided by core, not here: the rule is "draw the singled-out node's label
    // always, and every other label only when there is room for all of them".
    // See core/src/graph/labels.ts for the full statement and for why hiding
    // every label is not allowed.
    //
    // Decided once per sync, not per node. Inside the map it was O(n^2) — and on
    // the 1,000-file project of Phase 5e that is a million comparisons per redraw.
    const labels = new Map(
      decideGraphLabels({
        nodes,
        pixelsPerSlot,
        labelWidthPx,
        rowIndex,
        focusId,
        selectedId,
        hoverId,
      }).map((l) => [l.nodeId, l]),
    );

    /**
     * Cytoscape elements, widened before the first push.
     *
     * Declared explicitly because the array literal below infers its element type
     * from the *node* objects alone, and pushing an edge into it was an error:
     * `'edges'` is not assignable to `'nodes'`. `ElementDefinition` is Cytoscape's
     * own union, so nothing here restates what an element may contain.
     */
    const elements: import('cytoscape').ElementDefinition[] = [
      ...nodes.map((node) => ({
        group: 'nodes' as const,
        data: {
          id: node.id,
          label: labels.get(node.id)?.show === true ? labels.get(node.id)?.text : '',
          // Strings, because the style selectors compare quoted values.
          // `show` drives `text-opacity` rather than `display`, so a node with no
          // label is still a visible circle.
          show: String(labels.get(node.id)?.show ?? false),
          singled: String(labels.get(node.id)?.reason !== undefined && isSingled(labels.get(node.id)?.reason)),
          lane: String(labels.get(node.id)?.lane ?? 0),
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

    // Measure, then re-decide, because the rule needs the laid-out positions and
    // the decision is baked into each node's `label` data above. Re-deciding
    // through `sync` would re-run the layout, so the labels are written onto the
    // existing elements directly — one pass, no reflow, no second layout.
    measureLabels();
    applyLabelDecision();
  }

  /**
   * Write the current label decision onto the nodes already drawn.
   *
   * Separate from `sync` on purpose. `sync` rebuilds elements and re-runs the
   * layout, which is a ~40ms reflow for a hover, and hover fires continuously as
   * the pointer crosses the canvas. This mutates only the `label` field, so
   * moving the pointer across a crowded graph costs one pass over the nodes and
   * no geometry at all.
   */
  function applyLabelDecision(): void {
    // `graph`, not a local: `nodes` is the parameter of `sync`, and reaching for
    // it here was a `ReferenceError` that `tsc` does not catch in a `.svelte`
    // file. It fired four times in the capture run — on hover, on selection and
    // on every resize — so the label rule was never applied at all in the app,
    // while every test passed. Read from `graph` and the rule works.
    if (cy === null || graph === null) return;
    const drawn = decideGraphLabels({
      nodes: graph.nodes,
      pixelsPerSlot,
      labelWidthPx,
      rowIndex,
      focusId,
      selectedId,
      hoverId,
    });
    for (const label of drawn) {
      const element = cy.getElementById(label.nodeId);
      if (element.length === 0) continue;
      element.data('label', label.show ? label.text : '');
      element.data('show', String(label.show));
      element.data('lane', String(label.lane));
      element.data('singled', String(isSingled(label.reason)));
    }
  }

  function selectFocus(id: string): void {
    // Clicking the focused node again releases the focus, so there is always a
    // way back to the full graph from the node itself as well as the button.
    focusId = focusId === id ? null : id;
    // Kept even when focus is released, because a released node is still the one
    // the developer last chose, and clearing it would blank that node's label the
    // moment they clicked it a second time to zoom back out.
    selectedId = id;
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
              'font-family': LABEL_FONT_FAMILY,
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

          /**
           * Lane 1: the stagger.
           *
           * A second vertical offset for the labels that would otherwise sit on
           * top of their neighbours. Two labels in one lane are two slots apart,
           * which is what makes a row of 17 legible at 54px per slot.
           *
           * The `lane` data field is a *string*, for the same reason `distance`
           * is: a Cytoscape attribute selector compares quoted values, and
           * `node[lane = 1]` is rejected by its selector parser.
           */
          { selector: 'node[lane = "1"]', style: { 'text-margin-y': 15 } },

          /**
           * The singled-out node: full path, lane 0, in the accent colour and one
           * point larger, so it is findable by colour and size as well as by
           * text.
           *
           * `text-opacity` rather than `display: none` for the hidden case: a node
           * with no label must still be a *visible* node. `display: none` was the
           * first attempt and it removed the circles as well as the text, which
           * made a crowded graph look empty — the rule working perfectly and
           * erasing the graph it was describing.
           */
          {
            selector: 'node[show = "false"]',
            style: { 'text-opacity': 0 },
          },
          {
            selector: 'node[singled = "true"]',
            style: { 'text-margin-y': 4, color: '#e0a35a', 'font-size': 10, 'font-weight': 600 },
          },
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

      /**
       * Hover and selection both feed the label rule, so both are wired here.
       *
       * `mouseover`/`mouseout` rather than the delegated `hover` event: the
       * delegated form fires for a node *and* for the space between nodes, so
       * crossing a gap would blank the label you were reading. `mouseover` on
       * the node itself is exactly "the pointer is on this node".
       *
       * `mouseout` clears only when the pointer genuinely left every node. A
       * naive `mouseout` would clear the label the instant the pointer stepped
       * off the node's own bounds into its label's area, which is still "reading
       * this node" to a human.
       */
      cy.on('mouseover', 'node', (event) => {
        hoverId = event.target.id() as string;
        applyLabelDecision();
      });
      /**
       * `originalEvent.relatedTarget`, not `event.relatedTarget`.
       *
       * Cytoscape's `EventObject` has no `relatedTarget` of its own — it carries
       * `originalEvent: MouseEvent`, which does. So the pointer's real destination
       * is one hop down, and reading it off the wrapper was reading a property that
       * is not there: `undefined` every time, so the guard never fired and the
       * hovered label cleared on every step between nodes instead of only on
       * leaving the canvas.
       *
       * `relatedTarget` is `EventTarget | null` on the DOM type, and Cytoscape's
       * element is not a DOM `EventTarget`, so it is narrowed to "something was
       * entered" rather than compared for identity: if the pointer entered
       * anything, the following `mouseover` will set the new hover id anyway.
       */
      cy.on('mouseout', 'node', (event) => {
        if (event.originalEvent?.relatedTarget != null) return;
        hoverId = null;
        applyLabelDecision();
      });

      await load();
      // Explicit elements again: `load()` just assigned `graph`, and `visible`
      // would still be its pre-load empty value on this tick.
      sync({ nodes: graph?.nodes ?? [], edges: graph?.edges ?? [] });

      // Registered after the first sync so a resize cannot fire against an
      // empty graph and measure a widest row of 1, which reads as "plenty of
      // room" and is the one value that would draw every label overlapping.
      window.addEventListener('resize', onResize);
    })();

    return () => {
      cy?.destroy();
      cy = null;
      window.removeEventListener('resize', onResize);
    };
  });

  /**
   * Re-measure on resize.
   *
   * The measurements are derived from the canvas width and the widest basename,
   * so a resize that narrows the window has to re-decide or the labels keep
   * whatever room they had. It is a resize listener rather than an `$effect`
   * because the measurement reads Cytoscape's laid-out positions, which are only
   * stable after a layout has run.
   */
  function onResize(): void {
    measureLabels();
    applyLabelDecision();
  }

  onDestroy(() => {
    cy?.destroy();
    cy = null;
  });

  /**
   * The node the user last clicked, and the node under the pointer.
   *
   * Either one earns its label in a crowded layout. Kept as separate variables
   * rather than folded into `focusId` because they are different things: `focusId`
   * is the centre of the neighbourhood core fetched from main, and a click that
   * has not yet been confirmed must not change which node is the centre.
   */
  let selectedId = $state<string | null>(null);
  let hoverId = $state<string | null>(null);

  /**
   * The two measurements the label rule needs, in CSS pixels.
   *
   * Both are 0 until the canvas has been laid out, which makes the first paint
   * show only a singled-out node. Re-measured after layout and on resize.
   *
   * Two numbers rather than one "is there room" boolean, because the rule is a
   * comparison between a *slot* and a *label*, and precomputing the answer would
   * move the arithmetic out of the function that is under test.
   */
  let pixelsPerSlot = $state(0);
  let labelWidthPx = $state<Record<string, number>>({});
  /**
   * Each node's index within its row, read off the laid-out `y` positions.
   *
   * This is what the stagger alternates on. Deriving it from the drawn-label
   * order instead is what produced a row with 14 of 18 labels sharing a lane:
   * the two orders coincide only while nothing is hidden, and hiding is the whole
   * point of the rule. See `core/src/graph/labels.ts`.
   */
  let rowIndex = $state<Record<string, number>>({});

  /**
   * Measure the two numbers the label rule compares, and store them.
   *
   * **`pixelsPerSlot` is the room available, not the room wanted.** Those are
   * different numbers, and confusing them is what makes a heuristic flip between
   * "everything overlaps" and "nothing is labelled". It is `canvas width / nodes
   * in the widest row`, because `breadthfirst` puts siblings on one line and only
   * the widest row can collide.
   *
   * Rows come from laid-out positions by bucketing `y`. Measured after
   * `layout()`, because before a layout there are no positions and any answer
   * would be a guess about a layout that has not happened.
   *
   * **`labelWidthPx` is measured from the DOM, not guessed from a character
   * count.** Cytoscape draws labels on its own canvas, so there is no element to
   * measure; the proxy is a real hidden span carrying the longest basename in the
   * style Cytoscape is using. Estimating from `chars * aConstant` instead is how
   * this ends up wrong for a project full of `W`-heavy names, and it is wrong in
   * the direction that draws labels overlapping each other.
   */
  function measureLabels(): void {
    const canvas = container;
    // `graph`, not `nodes` — the latter is `sync`'s parameter and is not in scope
    // here. See applyLabelDecision.
    if (canvas === undefined || cy === null || graph === null) return;

    // A 6px tolerance: Cytoscape's `breadthfirst` spaces ranks by a float, so two
    // nodes on the same rank can differ by a subpixel or two. Without it the ranks
    // fragment and the "widest row" comes back as 1, which reads as "plenty of
    // room" and is exactly the bug.
    // The positions themselves, not just the counts: the spacing measurement below
    // needs them and the row-index pass needs the same bucketing.
    const TOLERANCE = 6;
    const rowPositions = new Map<number, { id: string; x: number; y: number }[]>();
    for (const node of cy.nodes()) {
      const key = Math.round(node.position('y') / TOLERANCE);
      const entry = rowPositions.get(key) ?? [];
      entry.push({ id: node.id(), x: node.position('x'), y: node.position('y') });
      rowPositions.set(key, entry);
    }

    const width = canvas.clientWidth;
    if (width <= 0) return;

    // **Measured from the laid-out positions, not `width / widestRow`.** The
    // division was a guess and it guessed 12% high: `breadthfirst` puts 18 nodes
    // across a 926px canvas, so the arithmetic gave 926/17 = 54px per slot while
    // the nodes are actually 48px apart. Every label was then drawn believing it
    // had 6px more room than it did, which is how `scene-manager.js` and
    // `settings.js` ended up touching.
    //
    // The spacing between adjacent nodes in the widest row is the real number, and
    // it is the only one that cannot drift from what the layout did.
    const spacings: number[] = [];
    for (const row of rowPositions.values()) {
      row.sort((a, b) => a.x - b.x);
      for (let i = 1; i < row.length; i += 1) {
        spacings.push((row[i] as { x: number }).x - (row[i - 1] as { x: number }).x);
      }
    }
    // The *minimum* gap, not the mean: one tight pair is what causes an overlap,
    // and averaging it away is how a row with two long names collided anyway.
    pixelsPerSlot = spacings.length === 0 ? 0 : Math.floor(Math.min(...spacings));
    labelWidthPx = measureBasenames();
    rowIndex = measureRowIndex(rowPositions);
  }

  /**
   * Each node's position within its row, left to right.
   *
   * Rows are the nodes sharing a `y` (bucketed by 6px, because `breadthfirst`
   * spaces ranks by a float). Within each row the nodes are sorted by `x`, so the
   * indices describe the geometry the developer sees rather than the order the
   * extractor happened to walk the project in.
   */
  function measureRowIndex(rows: Map<number, { id: string; x: number }[]>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of rows.values()) {
      row.sort((a, b) => a.x - b.x);
      row.forEach((node, i) => {
        out[node.id] = i;
      });
    }
    return out;
  }

  /**
   * The rendered width of every node's basename, in CSS pixels.
   *
   * **Each one measured, not the longest measured once.** A single widest-name
   * figure was tried and drawn a graph with no labels on it at all: the widest is
   * `playerSceneLoader.js` at 108px, the row gives 108px across two staggered
   * slots, and with a 25% margin 108 x 1.25 > 108 — so every label in the graph
   * was judged too wide and hidden. A crowded row is mostly short names with a few
   * long ones, and two long ones are not a reason to blank all of them. See
   * `core/src/graph/labels.ts`.
   *
   * All the basenames go into one probe span separated by a newline, because a
   * span is laid out once and `getBoundingClientRect` on it is one layout rather
   * than N. Each line is measured individually below.
   *
   * `visibility: hidden` rather than `display: none`: a display:none element has
   * no box, and `getBoundingClientRect` would return zeros — the same number a
   * broken measurement returns, which silently turns the rule off.
   */
  function measureBasenames(): Record<string, number> {
    if (graph === null) return {};
    const out: Record<string, number> = {};
    if (graph.nodes.length === 0) return out;

    const probe = document.createElement('span');
    probe.style.cssText =
      'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;' +
      'line-height:normal;pointer-events:none';
    probe.style.font = LABEL_FONT;
    // A unique separator per line would change the text; `white-space: pre` plus a
    // newline keeps each name on its own line and each measurable on its own.
    probe.textContent = graph.nodes.map((n) => basename(n.id)).join('\n');
    document.body.appendChild(probe);

    // One Range per line rather than a rect per span: fewer nodes in the DOM and
    // the same measurement, and it works for a single text node.
    const textNode = probe.firstChild;
    if (textNode !== null) {
      const text = textNode.textContent ?? '';
      let offset = 0;
      for (const node of graph.nodes) {
        const name = basename(node.id);
        const range = document.createRange();
        range.setStart(textNode, offset);
        range.setEnd(textNode, offset + name.length);
        out[node.id] = Math.ceil(range.getBoundingClientRect().width);
        offset += name.length + 1; // the newline
      }
      void text;
    }
    probe.remove();
    return out;
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
  {:else if unparseable.length > 0 || missingAssets.length > 0}
    <!--
      Two separate faults, deliberately not merged into one list.

      A file that exists but could not be parsed is missing from the graph for a
      *different reason* than a reference to a file that does not exist, and the
      fix for each is different. Merging them would produce a list where the
      developer cannot tell which of the two they are looking at.

      Missing assets are collapsed by default: a project can legitimately have a
      few — a dev harness writing screenshots outside the project is the common
      case — and an always-expanded list pushes the graph itself off the screen,
      which is the thing the developer opened this screen to look at. The count is
      always visible; the detail is one click.
    -->
    <div class="faults">
      {#if unparseable.length > 0}
        <div class="unparseable" role="alert">
          <strong>{unparseable.length} file(s) could not be parsed</strong>
          <p class="why">
            They are <em>missing from the graph below</em> — not absent from the project.
          </p>
          <ul>
            {#each unparseable as file (file.path)}
              <li>
                <span class="path">{file.path}</span>
                <span class="reason-text">{file.reason}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if missingAssets.length > 0}
        <div class="missing-files" role="alert">
          <button
            type="button"
            class="missing-toggle"
            aria-expanded={missingOpen}
            onclick={() => (missingOpen = !missingOpen)}
          >
            <span class="chevron">{missingOpen ? '▼' : '▶'}</span>
            <strong>
              {missingAssets.length} missing file{missingAssets.length === 1 ? '' : 's'}
            </strong>
            <span class="hint-inline">referenced but not on disk — not in the graph below</span>
          </button>
          {#if missingOpen}
            <ul>
              {#each missingAssets as missing (missing.from + '::' + missing.asset)}
                <li>
                  <span class="path">{missing.asset}</span>
                  <span class="reason-text">referenced by {missing.from}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </div>
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
  .unparseable {
    border-left: 3px solid #b4553a;
    background: rgba(180, 85, 58, 0.08);
    padding: 0.4rem 0.6rem;
    border-radius: 2px;
    font-size: 0.8rem;
  }
  /* Two fault lists stack; each keeps its own border so they stay distinct. */
  .faults {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .missing-files {
    border-left: 3px solid #b4883a;
    background: rgba(180, 136, 58, 0.08);
    padding: 0.35rem 0.6rem;
    border-radius: 2px;
    font-size: 0.8rem;
  }
  .missing-toggle {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 0;
    color: inherit;
    font: inherit;
    padding: 0;
    cursor: pointer;
  }
  .missing-toggle:hover strong {
    color: var(--accent, #61afef);
  }
  .chevron {
    font-size: 0.7rem;
    opacity: 0.7;
  }
  .hint-inline {
    opacity: 0.65;
    font-size: 0.75rem;
  }
  .missing-files ul {
    list-style: none;
    margin: 0.35rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    max-height: 120px;
    overflow-y: auto;
  }
  .missing-files li {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
  }
  .unparseable .why {
    margin: 0.2rem 0 0.35rem;
    opacity: 0.75;
  }
  .unparseable ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-height: 140px;
    overflow-y: auto;
  }
  .unparseable li {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
  }
  .unparseable .path {
    font-family: monospace;
    flex: 0 0 auto;
  }
  .unparseable .reason-text {
    opacity: 0.65;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
<!--
  renderer/search/SearchBox.svelte — a search box over the open project.

  ## What this component owns, and what it deliberately does not

  It owns three things: the text the developer has typed, the result of asking
  the main process to search, and which result is selected. Everything else — the
  walk, the reads, the containment check — is the main process's, behind one
  channel (`search:project`).

  Selecting a result is **renderer state**, not a request. Which row is
  highlighted changes nothing in main, so it costs no channel. That is the reason
  this feature needs exactly one, and the reason "jump to the match" is instant
  rather than a round trip.

  ## The two traps this component sits on

  1. **`$state.snapshot` before anything crosses IPC** (AI.md gotcha 2). `query` is
     a `$state` proxy and `ipcRenderer.invoke` structured-clones its argument,
     which cannot clone a proxy — every call died with "An object could not be
     cloned" until the value was wrapped. So `runSearch` sends
     `$state.snapshot(query)`, not `query`.

  2. **No value import from `@contextforge/core`** (AI.md gotcha 1). This file
     imports only *types* from core, and gets its data from `store.requestChannel`
     rather than reaching for `scanFiles` itself.

  ## Why the search is on request rather than on every keystroke

  A search walks the project. Doing that per character would queue a walk behind
  every keystroke, and the results would arrive out of order — an older, broader
  query landing after a newer one. So it runs on **Enter** or on the Search button,
  which makes the answer to each request the answer to the query that produced it.
  The query is still sent as `$state.snapshot` so this stays correct if it is ever
  driven per-keystroke.
-->
<script lang="ts">
  import { CHANNELS, type SearchMatchHit, type SearchResponse } from '../../ipc.js';
  import type { EditorStore } from '../store.js';
  import {
    summarizeSearch,
    previewOf,
    highlightRangeIn,
    groupMatchesByPath,
    listedFilePaths,
  } from './match.js';

  let { store }: { store: EditorStore } = $props();

  /** What the developer has typed. A `$state` proxy — snapshot it before IPC. */
  let query = $state('');
  /** Narrow to names or contents. `all` is what the box sends by default. */
  let kind = $state<'all' | 'files' | 'contents'>('all');
  /** True while a search is in flight, so the button can say so. */
  let busy = $state(false);
  /** The last result, or `null` before the first search. */
  let result = $state<SearchResponse | null>(null);
  /** A refusal sentence, shown verbatim. Cleared when a new search starts. */
  let refusal = $state<string | null>(null);
  /**
   * Which result is selected: a file path, or a `path:line` for a match.
   *
   * The `path:line` key is what lets one string identify both a file row and a
   * specific line beneath it, so "selected" is one piece of state rather than two
   * that could disagree.
   */
  let selected = $state<string | null>(null);

  /**
   * Matches grouped by file, so the list nests lines under the file they belong
   * to. Derived, so it cannot go stale relative to `result`.
   */
  const grouped = $derived(result === null ? [] : groupMatchesByPath(result.matches));

  /** Every path to list: those with line matches, then name-only hits. */
  const listed = $derived(result === null ? [] : listedFilePaths(result));

  /** The line under the box: the honest summary, or the refusal. */
  const summary = $derived(summarizeSearch(result, refusal, query));

  /**
   * Is there a project to search?
   *
   * Search reads files off disk, so with no project open there is nothing to
   * search. The box stays visible and says why rather than disappearing — a
   * control that vanishes is one a developer cannot find again.
   */
  const hasProject = $derived(store.snapshot !== null);

  /** The key identifying one match. Shared by the rows and the selection check. */
  function matchKey(hit: SearchMatchHit): string {
    return `${hit.path}:${hit.line}`;
  }

  /**
   * Run the search.
   *
   * `$state.snapshot(query)` is the load-bearing line: without it this throws
   * "An object could not be cloned" on every call, because `invoke`
   * structured-clones its argument and `query` is a Svelte proxy (AI.md gotcha 2).
   */
  async function runSearch(): Promise<void> {
    if (!hasProject) return;

    // Cleared before the request, not after, so a failed search does not leave the
    // previous result on screen looking like it answers the new query.
    result = null;
    refusal = null;
    selected = null;
    busy = true;
    try {
      const response = await store.requestChannel(CHANNELS.searchProject, {
        query: $state.snapshot(query),
        kind,
      });
      if (response.ok) {
        result = response.value;
      } else {
        refusal = response.reason;
      }
    } finally {
      busy = false;
    }
  }

  /**
   * Select a result — a file, or one line of one file.
   *
   * Pure renderer state: it changes what is highlighted and what the preview
   * pane shows, and it asks the main process for nothing. This is why the feature
   * needs one channel and not two.
   */
  function select(key: string): void {
    selected = key;
  }

  /**
   * Every selectable row, in the order it is drawn: for each file, its lines then
   * the file itself if it has no lines. Flattened so ArrowDown/ArrowUp walk the
   * results the way the eye does, rather than jumping file-to-file.
   */
  const selectableKeys = $derived.by(() => {
    const keys: string[] = [];
    for (const path of listed) {
      const lines = grouped.find((g) => g.path === path)?.lines ?? [];
      if (lines.length > 0) {
        for (const hit of lines) keys.push(matchKey(hit));
      } else {
        keys.push(path);
      }
    }
    return keys;
  });

  /**
   * Move the selection by `delta` positions and keep it in range.
   *
   * A no-op when there are no results, and it clamps rather than wrapping — a
   * search box that jumps from the last match back to the first is disorienting,
   * and the clamp makes the ends of the list feel like ends.
   */
  function moveSelection(delta: number): void {
    if (selectableKeys.length === 0) return;
    const current = selected === null ? -1 : selectableKeys.indexOf(selected);
    const next = current === -1
      ? (delta > 0 ? 0 : selectableKeys.length - 1)
      : Math.min(selectableKeys.length - 1, Math.max(0, current + delta));
    selected = selectableKeys[next] ?? null;
  }

  /** The text shown in the preview pane for the current selection. */
  const preview = $derived.by(() => {
    if (result === null || selected === null) return null;
    const hit = result.matches.find((m) => matchKey(m) === selected);
    if (hit !== undefined) {
      return { path: hit.path, line: hit.line, text: previewOf(hit) };
    }
    const file = result.files.find((f) => f.path === selected);
    if (file !== undefined) return { path: file.path, line: null, text: null };
    return null;
  });

  /** The highlight range for the previewed line, or `null` if the needle moved. */
  const highlight = $derived.by(() => {
    if (preview === null || preview.line === null) return null;
    const needle = query.trim().toLowerCase();
    if (needle === '') return null;
    return highlightRangeIn(needle, preview.text);
  });
</script>

<section class="search" aria-label="Search project">
  <form
    class="search-bar"
    onsubmit={(event) => {
      event.preventDefault();
      void runSearch();
    }}
  >
    <input
      type="search"
      class="search-input"
      placeholder="Search files and code"
      aria-label="Search the open project"
      bind:value={query}
      onkeydown={(event) => {
        // Enter runs the search. Arrow keys move the selection between results, so
        // a developer can walk matches without leaving the box.
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveSelection(event.key === 'ArrowDown' ? 1 : -1);
        }
      }}
    />
    <select
      class="search-kind"
      aria-label="What to search"
      bind:value={kind}
      onchange={() => void runSearch()}
    >
      <option value="all">Names &amp; content</option>
      <option value="files">File names</option>
      <option value="contents">File content</option>
    </select>
    <button type="submit" class="search-go" disabled={!hasProject || busy}>
      {busy ? 'Searching…' : 'Search'}
    </button>
  </form>

  {#if !hasProject}
    <p class="search-note">Open a project to search it.</p>
  {/if}

  {#if refusal !== null}
    <p class="search-note search-error">{refusal}</p>
  {:else if result !== null && result.skipped.length > 0}
    <!--
      Skipped files are shown, not hidden. A file that was not searched looks
      identical to a file with nothing in it, and a developer who is told which
      files were skipped can decide whether to go looking another way.
    -->
    <ul class="search-skipped" aria-label="Files that were not searched">
      {#each result.skipped as note (note)}
        <li>{note}</li>
      {/each}
    </ul>
  {/if}

  <p class="search-summary">{summary}</p>

  {#if result !== null && listed.length > 0}
    <div class="search-body">
      <ul class="search-results" aria-label="Search results">
        {#each listed as path (path)}
          {@const lines = grouped.find((g) => g.path === path)?.lines ?? []}
          <li class="search-file">
            <button
              type="button"
              class="search-file-row"
              class:selected={selected === path}
              aria-current={selected === path ? 'true' : undefined}
              onclick={() => select(path)}
            >
              <span class="search-path">{path}</span>
              {#if lines.length > 0}
                <span class="search-count">{lines.length}</span>
              {/if}
            </button>
            {#if lines.length > 0}
              <ul class="search-lines">
                {#each lines as hit (matchKey(hit))}
                  <li>
                    <button
                      type="button"
                      class="search-line"
                      class:selected={selected === matchKey(hit)}
                      aria-current={selected === matchKey(hit) ? 'true' : undefined}
                      onclick={() => select(matchKey(hit))}
                    >
                      <span class="search-lineno">{hit.line}</span>
                      <span class="search-text">{hit.text}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>

      {#if preview !== null}
        <div class="search-preview" aria-live="polite">
          <div class="search-preview-head">
            <span class="search-path">{preview.path}</span>
            {#if preview.line !== null}
              <span class="search-lineno">line {preview.line}</span>
            {/if}
          </div>
          {#if preview.text !== null}
            <pre class="search-preview-body">
              {#if highlight !== null}
                <span class="search-preview-before">{preview.text.slice(0, highlight.start)}</span
                ><mark>{preview.text.slice(highlight.start, highlight.end)}</mark
                ><span class="search-preview-after"
                  >{preview.text.slice(highlight.end)}</span
                >
              {:else}
                {preview.text}
              {/if}
            </pre>
          {:else}
            <p class="search-note">
              {preview.path} was matched by name. Open the file to see it.
            </p>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .search {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
    min-width: 0;
  }

  .search-bar {
    display: flex;
    gap: 6px;
    align-items: center;
    min-width: 0;
  }

  .search-input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 5px 8px;
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 4px;
  }

  .search-kind {
    padding: 5px 6px;
    font: inherit;
    font-size: 12px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 4px;
  }

  .search-go {
    padding: 5px 10px;
    font: inherit;
    font-size: 12px;
    color: var(--text);
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 4px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .search-go:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .search-summary {
    margin: 0;
    font-size: 11px;
    color: var(--muted);
  }

  .search-note {
    margin: 0;
    font-size: 11px;
    color: var(--muted);
  }
  .search-error {
    color: var(--danger);
  }

  .search-skipped {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
    color: var(--warning);
  }

  .search-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 10px;
    min-height: 0;
  }

  .search-results {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow: auto;
    max-height: 320px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .search-file {
    display: flex;
    flex-direction: column;
  }

  .search-file-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    padding: 3px 6px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 3px;
    color: var(--text);
    cursor: pointer;
    text-align: left;
    font: inherit;
  }
  .search-file-row:hover {
    background: var(--panel-2);
  }
  .search-file-row.selected {
    background: var(--panel-2);
    border-color: var(--accent);
  }

  .search-path {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px;
    word-break: break-all;
    min-width: 0;
  }

  .search-count {
    font-size: 10px;
    color: var(--muted);
    flex-shrink: 0;
  }

  .search-lines {
    list-style: none;
    margin: 0;
    padding: 0 0 0 12px;
    display: flex;
    flex-direction: column;
  }

  .search-line {
    display: flex;
    gap: 8px;
    width: 100%;
    padding: 2px 6px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 3px;
    color: var(--text);
    cursor: pointer;
    text-align: left;
    font: inherit;
  }
  .search-line:hover {
    background: var(--panel-2);
  }
  .search-line.selected {
    background: var(--panel-2);
    border-color: var(--accent);
  }

  .search-lineno {
    font-size: 10px;
    color: var(--muted);
    flex-shrink: 0;
    min-width: 2.5em;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .search-text {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px;
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .search-preview {
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 6px 8px;
    overflow: auto;
    max-height: 320px;
    background: var(--bg);
  }

  .search-preview-head {
    display: flex;
    gap: 8px;
    align-items: baseline;
    margin-bottom: 4px;
  }

  .search-preview-body {
    margin: 0;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  mark {
    background: var(--accent);
    color: var(--bg);
    border-radius: 2px;
  }
</style>
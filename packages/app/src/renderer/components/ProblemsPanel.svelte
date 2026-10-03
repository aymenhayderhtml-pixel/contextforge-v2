<!--
  packages/app/src/renderer/components/ProblemsPanel.svelte

  Project-level problems panel for ContextForge v2 (Step 3b).

  Displays all project-wide issues (snapshot.problems, missing prefabs, failed
  prefabs, and project errors) with:
  - 'Problems (N)' header and count badge.
  - One concise short line per error (e.g. 'hazardCrate failed to load: Corrupted GLTF buffer').
  - 'Details' toggle button to expand/collapse full stack traces, file paths, etc.
-->
<script module lang="ts">
  import { collectSkippedInstanceProblems as collectShared } from '../validation.js';

  /**
   * Instances the running game will **skip**: their params fail the prefab's own
   * schema, so the game builds every other instance and leaves this one out of
   * the scene entirely.
   *
   * This is not redundant with `snapshot.problems`. `paramProblems()` in the main
   * process only sees the prefab's JSON-Schema *summary*, and checks for an
   * unknown key or a missing required key — never a bad *value*. So the one real
   * case in the shipped scene, `track.width: -10`, reaches this panel as no
   * problem at all. The scene opens, the track is absent from the viewport, and
   * the panel reads "No problems detected": the instance is invisible in the one
   * place the developer goes looking for it (SPEC R9).
   *
   * **The implementation lives in `validation.ts` and the Scene screen calls it
   * too.** This panel used to derive the same rows itself, which D26 recorded as
   * a real gap — two derivations of one fact drift, and nothing forces them to
   * agree. One function, two call sites.
   *
   * Still exported here, as a re-export of that one function, so the existing
   * callers and tests name this panel's public surface rather than reaching into
   * a sibling module. It is the same function object, not a copy — which is the
   * point.
   */
  export const collectSkippedInstanceProblems = collectShared;
</script>

<script lang="ts">
  import type { AppError } from '../../errors.js';
  import type { PrefabFailure, PrefabSummary, SceneSnapshot } from '../../ipc.js';
  import { collectProjectProblems } from '../errorFormatting.js';

  interface Props {
    /** Project problems as AppError[] or strings */
    problems?: readonly (AppError | string)[];
    /** Optional snapshot to extract problems & failed prefabs from */
    snapshot?: SceneSnapshot | null;
    /** Optional prefabs list */
    prefabs?: readonly PrefabSummary[];
    /** Optional failed prefabs list */
    failed?: readonly PrefabFailure[];
    /**
     * Number of rows this panel will render, asserted by the parent.
     *
     * The panel deliberately owns **no** header. It is rendered inside the
     * Scene screen's collapsible Problems bar, which carries the count; a
     * second header here showed the same list under two different numbers,
     * because this panel counts normalized rows while the bar counted raw
     * strings off the snapshot (D44). The parent's number is passed back in so
     * this component can still assert its own row count against it rather than
     * computing a rival one.
     */
    count?: number;
    /** Selection callback if a problem references an instance */
    onSelectInstance?: (instanceId: string) => void;
  }

  const {
    problems = [],
    snapshot = null,
    prefabs = [],
    failed = [],
    count: expectedCount,
    onSelectInstance = () => {},
  }: Props = $props();

  let expanded = $state<Record<string, boolean>>({});

  const summaries = $derived<readonly PrefabSummary[]>(
    prefabs.length > 0 ? prefabs : (snapshot?.prefabs.prefabs ?? []),
  );

  const allProblems = $derived<AppError[]>(
    collectProjectProblems({
      snapshot,
      problems,
      prefabs: summaries,
      failedPrefabs: failed.length > 0 ? failed : (snapshot?.prefabs.failed ?? []),
    }),
  );

  const skippedInstances = $derived<AppError[]>(
    collectSkippedInstanceProblems(snapshot, summaries, allProblems.map((p) => p.id)),
  );

  /** Rows actually rendered. One list, one length — the bar's count shows this. */
  const rows = $derived<AppError[]>([...allProblems, ...skippedInstances]);

  const count = $derived(rows.length);

  // Dev-only tripwire. The bar and this list are two renderings of one fact, so
  // a mismatch means one of them has drifted — the exact defect that produced
  // `PROBLEMS (2)` above `PROBLEMS (6)`. There is a test for it; this catches a
  // regression in a real browser run, where no test executes.
  $effect(() => {
    if (expectedCount !== undefined && expectedCount !== count && import.meta.env.DEV) {
      throw new Error(
        `ProblemsPanel rendered ${count} row(s) but its parent counted ${expectedCount}. ` +
          'The bar and this panel must derive from one list (D44).',
      );
    }
  });

  function toggleDetails(id: string): void {
    expanded = { ...expanded, [id]: !expanded[id] };
  }

  function isExpanded(id: string): boolean {
    return expanded[id] === true;
  }
</script>

<section class="problems-panel" aria-label="Problems">
  <!--
    No header here. The Scene screen's collapsible bar owns the title and the one
    count (D44). The dev-only effect in the script block asserts this panel's
    row count still equals the parent's, so the two can never silently diverge
    again — which is exactly the bug the duplicate header was.
  -->
  {#if count === 0}
    <p class="empty">No problems detected.</p>
  {:else}
    <ul class="problems-list" role="list">
      {#each rows as problem (problem.id)}
        <li class="problem-item" data-id={problem.id} data-scope={problem.scope}>
          <div class="problem-row">
            <span class="problem-icon" aria-hidden="true">⚠</span>
            <span class="problem-short" title={problem.short}>{problem.short}</span>
            {#if problem.instanceId}
              <button
                type="button"
                class="instance-link"
                onclick={() => onSelectInstance(problem.instanceId!)}
                title={`Go to instance ${problem.instanceId}`}
              >
                {problem.instanceId}
              </button>
            {/if}
            {#if problem.details !== undefined && problem.details.trim() !== ''}
              <button
                type="button"
                class="details-toggle"
                aria-expanded={isExpanded(problem.id)}
                onclick={() => toggleDetails(problem.id)}
              >
                {isExpanded(problem.id) ? 'Hide details' : 'Details'}
              </button>
            {/if}
          </div>

          {#if problem.details !== undefined && problem.details.trim() !== '' && isExpanded(problem.id)}
            <div class="details-container">
              <pre class="details-content">{problem.details}</pre>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .problems-panel {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem;
    font-size: 0.85rem;
    background: var(--panel, #1e1e1e);
    color: var(--text, #cccccc);
    min-height: 0;
  }
  .empty {
    margin: 0.5rem 0;
    opacity: 0.7;
    font-style: italic;
  }
  .problems-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    overflow-y: auto;
  }
  .problem-item {
    border-left: 3px solid #b4553a;
    background: rgba(180, 85, 58, 0.08);
    padding: 0.35rem 0.5rem;
    border-radius: 2px;
  }
  .problem-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .problem-icon {
    color: #b4553a;
    flex-shrink: 0;
  }
  .problem-short {
    flex: 1 1 auto;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .instance-link {
    background: transparent;
    border: 1px solid currentColor;
    color: var(--accent, #61afef);
    border-radius: 3px;
    padding: 0 0.3em;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .details-toggle {
    background: var(--panel-2, #2a2a2a);
    border: 1px solid var(--line, #444444);
    color: var(--text, #cccccc);
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 0.75rem;
    cursor: pointer;
    flex-shrink: 0;
  }
  .details-toggle:hover {
    border-color: #888888;
  }
  .details-container {
    margin-top: 0.35rem;
    padding: 0.35rem;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 3px;
    overflow-x: auto;
  }
  .details-content {
    margin: 0;
    font-family: monospace;
    font-size: 0.75rem;
    white-space: pre-wrap;
    word-break: break-all;
    opacity: 0.9;
  }
</style>

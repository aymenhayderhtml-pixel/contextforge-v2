<!--
  PatchScreen.svelte — review an AI's reply, then apply it all-or-nothing.

  The screen exists because "apply patch" used to be one button that either
  worked or did not. A refusal with no diff is indistinguishable from a patch
  that silently changed the wrong lines, so the whole design here is that the
  developer sees the diff, the syntax verdict and core's own reason for every
  block that would fail *before* anything is written, and one Apply writes all
  of it or none of it.

  Two rules the markup is shaped by:

  - **Refusals render next to the thing that caused them.** The failed blocks
    are listed under the file they belong to, not in a toast. A message that
    vanishes in six seconds is not reviewable, and reviewing the refusal is the
    only reason to paste an AI's answer rather than retyping the change.
  - **One main action.** Preview, Apply, Undo and Redo are all on screen but only
    Apply is emphasised, because Apply is the only one that writes. "Apply
    anyway" appears only when `canApplyAnyway` is true and is deliberately
    styled as the lesser of the two (SPEC R9).
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { EditorStore } from '../store.js';
  import {
    CHANNELS,
    type PatchApplyResult,
    type PatchFilePreview,
    type PatchHistoryEntry,
    type PatchPreview,
  } from '../../ipc.js';
  import { translateSyntaxError } from '../errorFormatting.js';

  let { store }: { store: EditorStore } = $props();

  /**
   * The pasted reply, kept verbatim.
   *
   * Never trimmed on the way out: a patch's FIND text is whitespace-sensitive
   * and core's matcher is deliberately strict about what an AI's reformatting
   * did to it. Trimming the envelope here would only be safe if it were also
   * undone inside core, and nothing should depend on that.
   */
  let text = $state('');

  let preview = $state<PatchPreview | null>(null);
  let entries = $state<PatchHistoryEntry[]>([]);
  let canUndo = $state(false);
  let canRedo = $state(false);

  /** A refusal from the channel, shown beside the button that caused it. */
  let refusal = $state<string | null>(null);
  /** What the last successful Apply wrote, shown beside the history list. */
  let applied = $state<PatchApplyResult | null>(null);
  /**
   * Which files the last Undo or Redo actually touched.
   *
   * `null` means "no completed step" and an empty array would mean "a step that
   * touched nothing", which is not a state core can be in — so the empty case is
   * not representable and the message below it cannot be a lie.
   */
  let reverted = $state<{ files: string[]; patchId: string } | null>(null);
  /** Which direction `reverted` describes, so the sentence cannot contradict it. */
  let revertDirection = $state<'undo' | 'redo'>('undo');

  let previewing = $state(false);
  let applying = $state(false);

  /**
   * Whether the override has been explicitly asked for.
   *
   * Never a default, and never derived from the preview: a developer who wants
   * to write code core's grammar does not recognise has to press the secondary
   * button. Keeping it in local state (and clearing it the moment the preview
   * changes) means a second Apply after an unrelated paste cannot inherit a
   * decision made for different content.
   */
  let override = $state(false);

  const busy = $derived(previewing || applying || store.busy);

  /** The refusal the current preview is blocking on, if any. */
  const blocked = $derived(preview !== null && !preview.applicable ? preview.blockedReason : null);

  const failedByPath = $derived.by(() => {
    const groups = new Map<string, PatchPreview['failedBlocks']>();
    for (const failure of preview?.failedBlocks ?? []) {
      const existing = groups.get(failure.path);
      if (existing === undefined) groups.set(failure.path, [failure]);
      else existing.push(failure);
    }
    return groups;
  });

  onDestroy(() => {
    // Nothing to release: every request is a single invoke whose lifetime the
    // promise owns. Stated here so the absence of a teardown is a decision
    // rather than an omission.
  });

  /**
   * Read the history.
   *
   * A refusal here is reported, not swallowed — but it is *not* written over the
   * history list, because losing the Undo button while the developer is looking
   * at a diff is worse than the missing explanation.
   */
  async function refreshHistory(): Promise<void> {
    const result = await store.requestChannel(CHANNELS.patchHistory, {});
    const reason = store.refusalOf(result);
    if (reason !== null) {
      refusal = reason;
      return;
    }
    entries = result.value.entries;
    canUndo = result.value.canUndo;
    canRedo = result.value.canRedo;
  }

  /** Parse the pasted reply and show what it would do. */
  async function previewPatch(): Promise<void> {
    if (busy) return;
    previewing = true;
    override = false;
    applied = null;
    try {
      const result = await store.requestChannel(CHANNELS.previewPatch, { text });
      const reason = store.refusalOf(result);
      if (reason !== null) {
        // A refusal here is not "the patch is bad" — it is "there is nothing to
        // show". Any previous diff is dropped so it cannot be read as the diff of
        // the reply now in the textarea.
        preview = null;
        refusal = reason;
        return;
      }
      preview = result.value;
      refusal = null;
    } finally {
      previewing = false;
    }
  }

  /**
   * Write the patch: everything in the preview, or nothing.
   *
   * Re-previews and re-reads the history afterwards rather than patching the
   * local state by hand, because the diff shown must be the diff of the tree as
   * it is *now* — a hand-edited preview would drift from the disk within one
   * paste, which is the failure mode this screen is meant to prevent.
   */
  async function applyPatch(): Promise<void> {
    if (busy) return;
    if (preview === null || !preview.applicable) return;
    applying = true;
    try {
      const result = await store.requestChannel(CHANNELS.applyPatch, {
        text,
        ...(override ? { applyAnyway: true } : {}),
      });
      const reason = store.refusalOf(result);
      if (reason !== null) {
        refusal = reason;
        return;
      }
      applied = result.value;
      refusal = null;
      override = false;
      preview = null;
      // A fresh write supersedes any earlier revert report: the panel is
      // rendered from `applied` first, and leaving `reverted` set would let the
      // Undo/Redo button start again from a stale claim about which files moved.
      reverted = null;
      await refreshHistory();
    } finally {
      applying = false;
    }
  }

  /**
   * Undo or redo the last step, naming the files it touched.
   *
   * These go through the scene channels rather than the patch ones: one history
   * per project, and the scene channels are the ones that already drive core's
   * `undo`/`redo`. A second undo stack on the Patch screen would mean two
   * answers to "what is next".
   *
   * The store resolves to the step's files, so the panel can say which ones
   * moved. A step that reverts two files and a step that reverts one are both
   * "previous changes were reverted" if the count is dropped, and a developer
   * who has to open a diff to find out will stop trusting the button.
   */
  async function stepHistory(direction: 'undo' | 'redo'): Promise<void> {
    if (busy) return;
    applying = true;
    try {
      const outcome = direction === 'undo' ? await store.undo() : await store.redo();
      if (outcome === null) return;
      revertDirection = direction;
      // The store hands back `{ paths, patchId }`; the panel reads `.files`.
      // Assigning the store's object straight through made `reverted.files`
      // `undefined`, and `writeSummary` then threw on `files.length` — the panel
      // crashed to the "Applied" branch and the message never rendered at all.
      // The two names are kept distinct because they mean different things:
      // `paths` is what a history step reports, `files` is what a write reports.
      reverted = { files: outcome.paths, patchId: outcome.patchId };
      // Any earlier write report is dropped in both directions. The panel is an
      // if/else-if, so leaving `applied` set after an undo would keep rendering
      // "Wrote …" above a revert that had just put those bytes back — the screen
      // would claim the patch is applied at the exact moment it was reverted.
      applied = null;
      await previewPatch();
      await refreshHistory();
    } finally {
      applying = false;
    }
  }

  /**
   * The one-line summary of a completed write, undo or redo.
   *
   * Shared by all three so the sentence shape cannot drift between them: a
   * developer learns "Wrote N files: a, b" once and reads it the same way after
   * an undo and after a redo. The names are the payload — the count alone does
   * not say which files are now different from what the AI sent.
   */
  function writeSummary(verb: string, files: readonly string[]): string {
    return `${verb} ${files.length} file${files.length === 1 ? '' : 's'}: ${files.join(', ')}`;
  }

  let expandedSyntaxDetails = $state<Record<string, boolean>>({});

  function toggleSyntaxDetails(path: string): void {
    expandedSyntaxDetails = {
      ...expandedSyntaxDetails,
      [path]: !expandedSyntaxDetails[path],
    };
  }

  /** The syntax verdict for a file, as one line beside its diff. */
  function syntaxLine(file: PatchFilePreview): string {
    if (file.syntax.valid) return 'Syntax check passed';
    const translated = translateSyntaxError(file.syntax.message, file.syntax.line, file.path);
    return translated.plain;
  }
</script>

<section class="screen">
  <header>
    <h1>Patch</h1>
    <p class="lede">
      Paste the AI's reply below. ContextForge reads the
      <code>### FILE:</code> and <code>### EDIT:</code> blocks, shows you the diff and the syntax
      verdict for every file, and writes nothing until you apply — all at once, or not at all.
    </p>
  </header>

  <div class="panel">
    <label class="field" for="patch-text">
      <span class="label">AI reply</span>
      <textarea
        id="patch-text"
        rows="10"
        spellcheck="false"
        placeholder={'### EDIT: src/player.js\n<<<<<<< FIND\n  const speed = 5;\n=======\n  const speed = 25;\n>>>>>>> REPLACE'}
        bind:value={text}
      ></textarea>
    </label>

    <div class="actions">
      <button type="button" class="secondary" onclick={() => void previewPatch()} disabled={busy}>
        {previewing ? 'Reading…' : 'Preview'}
      </button>

      <button
        type="button"
        class="primary"
        onclick={() => void applyPatch()}
        disabled={busy || preview === null || !preview.applicable}
      >
        {applying ? 'Applying…' : 'Apply patch'}
      </button>

      <!--
        The override is a second, explicit click. It is rendered only when the
        preview says the syntax gate is what refused, and it is never the default
        value of anything: `override` starts false, is reset by every preview, and
        is cleared the moment an Apply succeeds (SPEC R9).
      -->
      {#if preview !== null && preview.canApplyAnyway}
        <button
          type="button"
          class="danger"
          onclick={() => {
            override = !override;
          }}
          disabled={busy}
        >
          {override ? 'Override chosen — Apply will write it' : 'Apply anyway…'}
        </button>
      {/if}
    </div>

    <!--
      The refusal belongs beside the button that would have caused it. A refusal
      rendered only as a notice would be gone before the developer could act on
      it, and acting on it is the entire purpose of this screen.
    -->
    {#if refusal !== null}
      <p class="refusal" role="alert">{refusal}</p>
    {/if}

    {#if blocked !== null && preview !== null && !preview.canApplyAnyway}
      <p class="blocked" role="status">{blocked}</p>
    {/if}
  </div>

  {#if preview !== null}
    <div class="panel">
      <h2>
        Preview
        <span class="counts">
          {preview.blockCount} block{preview.blockCount === 1 ? '' : 's'} ·
          {preview.files.length} file{preview.files.length === 1 ? '' : 's'}
          {#if preview.alreadyApplied > 0}
            · {preview.alreadyApplied} already applied
          {/if}
        </span>
      </h2>

      {#if preview.files.length === 0}
        <p class="muted">This reply names no files, so there is nothing to write.</p>
      {/if}

      {#each preview.files as file (file.path)}
        <section class="file" class:failed={file.syntaxFailed || failedByPath.has(file.path)}>
          <h3>
            {file.path}
            {#if file.created}<span class="tag">new file</span>{/if}
            {#if file.syntaxFailed}<span class="tag bad">syntax error</span>{/if}
          </h3>

          <!-- The syntax verdict for this file, on this file's row. -->
          {#if file.syntax.valid}
            <p class="syntax ok">Syntax check passed</p>
          {:else}
            {@const translated = translateSyntaxError(file.syntax.message, file.syntax.line, file.path)}
            <div class="syntax-error-row">
              <p class="syntax bad">{translated.plain}</p>
              <button
                type="button"
                class="syntax-details-toggle"
                onclick={() => toggleSyntaxDetails(file.path)}
                aria-expanded={expandedSyntaxDetails[file.path] === true}
              >
                {expandedSyntaxDetails[file.path] ? 'Hide details' : 'Details'}
              </button>
            </div>
            {#if expandedSyntaxDetails[file.path]}
              <div class="syntax-details-container">
                <pre class="syntax-details-content">{translated.raw}</pre>
              </div>
            {/if}
          {/if}

          <!--
            Each failure is rendered with core's own sentence, unmodified. The
            block number is shown because "which block" is a question the
            developer can only answer by counting, and core's reason is shown
            verbatim because it is the only thing that distinguishes "the AI
            forgot a closing brace" from "that snippet appears three times".
          -->
          {#each failedByPath.get(file.path) ?? [] as failure (`${failure.index}`)}
            <div class="failure">
              <p class="failure-head">
                Edit block {failure.index} could not be applied
              </p>
              <p class="failure-reason">{failure.reason}</p>
              {#if failure.find.trim() !== ''}
                <pre class="snippet">{failure.find.trim()}</pre>
              {/if}
            </div>
          {/each}

          {#if file.diff === ''}
            <p class="muted">No changes to this file.</p>
          {:else}
            <pre class="diff">{file.diff}</pre>
          {/if}
        </section>
      {/each}
    </div>
  {/if}

  {#if applied !== null}
    <div class="panel">
      <h2>Applied</h2>
      <!--
        The summary names every file, not just how many. "Wrote 1 file" followed
        by a bullet list is two lines to read for one fact, and the fact that
        matters is which files are now different on disk.
      -->
      <p class="lede small" data-testid="applied-summary">
        {writeSummary('Wrote', applied.files)}
        {#if applied.created.length > 0}
          ({applied.created.length} new)
        {/if}
        as one undo step{applied.patchId === '' ? '' : ` (${applied.patchId})`}.
      </p>
      <ul class="file-list">
        {#each applied.files as path (path)}
          <li>{path}</li>
        {/each}
      </ul>
    </div>
  {:else if reverted !== null}
    <div class="panel">
      <!--
        The heading keeps the single word each state is named by, and the
        sentence under it names the files. Both directions are rendered from the
        same branch so an undo can never be described as a redo.
      -->
      <h2>{revertDirection === 'undo' ? 'Undone' : 'Redone'}</h2>
      <p class="lede small" data-testid="revert-summary">
        {writeSummary(revertDirection === 'undo' ? 'Reverted' : 'Reapplied', reverted.files)}
        {#if reverted.patchId !== ''}({reverted.patchId}){/if}.
      </p>
      <ul class="file-list">
        {#each reverted.files as path (path)}
          <li>{path}</li>
        {/each}
      </ul>
    </div>
  {/if}

  <div class="panel">
    <h2>
      History
      <span class="counts">{entries.length} step{entries.length === 1 ? '' : 's'} kept</span>
    </h2>

    <div class="actions">
      <button type="button" class="secondary" onclick={() => void stepHistory('undo')} disabled={busy || !canUndo}>
        Undo
      </button>
      <button type="button" class="secondary" onclick={() => void stepHistory('redo')} disabled={busy || !canRedo}>
        Redo
      </button>
      <button type="button" class="secondary" onclick={() => void refreshHistory()} disabled={busy}>
        Refresh
      </button>
    </div>

    {#if entries.length === 0}
      <p class="muted">Nothing has been applied yet.</p>
    {:else}
      <ul class="history">
        {#each entries as entry (entry.patchId)}
          <li>
            <span class="patch-id">{entry.patchId}</span>
            <span class="desc">{entry.description}</span>
            <span class="paths">{entry.files.join(', ')}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>

<style>
  .screen {
    padding: 24px 28px;
    max-width: 900px;
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
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: baseline;
  }
  h3 {
    margin: 0 0 6px;
    font-size: 13px;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    display: flex;
    gap: 8px;
    align-items: baseline;
  }

  .lede {
    margin: 0;
    color: var(--muted);
    line-height: 1.5;
  }
  .lede.small {
    font-size: 12px;
  }

  .counts {
    font-size: 11px;
    letter-spacing: 0;
    text-transform: none;
    color: var(--muted);
  }

  .panel {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
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
  textarea {
    width: 100%;
    box-sizing: border-box;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 10px;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 12px;
    line-height: 1.5;
    resize: vertical;
    white-space: pre;
    overflow-wrap: normal;
    overflow-x: auto;
  }

  .actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
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
  /* Styled as the lesser of the two writes on purpose: an override that looks
     like the primary action is an override somebody clicks by accident. */
  .danger {
    background: transparent;
    color: var(--danger);
    border: 1px solid var(--danger);
    border-radius: 5px;
    padding: 8px 14px;
    cursor: pointer;
    font-weight: 500;
  }
  .danger:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .refusal,
  .blocked {
    margin: 0;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    padding: 10px 12px;
    border-radius: 5px;
    border: 1px solid;
  }
  .refusal {
    color: var(--danger);
    border-color: var(--danger);
    background: rgba(255, 90, 90, 0.06);
  }
  .blocked {
    color: var(--warning);
    border-color: var(--warning);
    background: rgba(255, 190, 90, 0.06);
  }

  .file {
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .file.failed {
    border-color: var(--danger);
  }

  .tag {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border: 1px solid var(--line);
    border-radius: 3px;
    padding: 1px 5px;
    color: var(--muted);
    font-family: inherit;
    font-weight: 400;
  }
  .tag.bad {
    color: var(--danger);
    border-color: var(--danger);
  }

  .syntax {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
  }
  .syntax.ok {
    color: var(--muted);
  }
  .syntax.bad {
    color: var(--danger);
  }

  .syntax-error-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .syntax-details-toggle {
    background: var(--panel-2, #2a2a2a);
    border: 1px solid var(--line, #444444);
    color: var(--text, #cccccc);
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 11px;
    cursor: pointer;
  }
  .syntax-details-toggle:hover {
    border-color: var(--muted);
  }
  .syntax-details-container {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 6px 10px;
  }
  .syntax-details-content {
    margin: 0;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--muted);
  }

  .failure {
    border-left: 3px solid var(--danger);
    padding: 6px 0 6px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .failure-head {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--danger);
  }
  /* `pre-wrap` because core's reason may be more than one line, and it is shown
     exactly as core wrote it. */
  .failure-reason {
    margin: 0;
    font-size: 12px;
    line-height: 1.6;
    color: var(--danger);
    white-space: pre-wrap;
  }
  .snippet {
    margin: 2px 0 0;
    padding: 8px 10px;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 4px;
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    color: var(--muted);
    max-height: 180px;
    overflow-y: auto;
  }

  .diff {
    margin: 0;
    padding: 10px 12px;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 4px;
    font-size: 11px;
    line-height: 1.5;
    overflow-x: auto;
    max-height: 420px;
    overflow-y: auto;
  }

  .file-list,
  .history {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
  }
  .history {
    list-style: none;
    padding-left: 0;
  }
  .history li {
    display: flex;
    gap: 10px;
    align-items: baseline;
    flex-wrap: wrap;
    border-bottom: 1px solid var(--line);
    padding-bottom: 5px;
  }
  .patch-id {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    color: var(--accent);
    font-size: 11px;
  }
  .desc {
    color: var(--text);
  }
  .paths {
    color: var(--muted);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px;
    word-break: break-all;
  }

  .muted {
    color: var(--muted);
    font-size: 12px;
    margin: 0;
    line-height: 1.6;
  }
</style>
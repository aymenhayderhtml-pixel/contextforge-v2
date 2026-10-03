<!--
  ContextScreen.svelte — turn an error into a prompt an AI can actually use.

  ## What the developer does here, in order

  1. says what is broken, in their own words;
  2. pastes the error text — a stack trace is worth a hundred words of guessing;
  3. presses **Compile prompt** (the screen's one primary action);
  4. reads the ranked files, each with the reason the ranker chose it, and ticks
     any that is missing from the selection;
  5. copies the prompt;
  6. pastes the AI's reply into the box at the bottom;
  7. if the reply asked for more context, presses **Attach what was asked for** and
     gets a new prompt that has it in.

  ## Where things come from

  Every fact on this screen is core's. The ranker decides what is relevant and
  says why; `compileContext` reads the files with its own grammar-aware slicer;
  this component only decides what to *ask* for and how to *show* the answer. It
  cannot see the disk — there is no filesystem in the renderer — so existence is
  answered by the `sections` list the compiled response already carries.

  ## Extending this component

  Everything below is in one of two marked areas so a new action can be added
  without unpicking the rest:

  - **STATE** — one `$state` per piece of screen state, all in one block.
  - **ACTIONS** — one `async function` per button, in one block.
  - **VIEW** — one `<section class="panel">` per block of the screen, in order.

  A brief action belongs in the header, beside the screen title, as a
  `secondary` button so the primary action stays the only primary action on the
  screen.

  **Note for whoever edits this next:** writing a marker here as literal
  comment markup closes this file comment early and dumps every remaining line
  onto the page as visible text. Describe it in prose, as above.
-->
<script lang="ts">
  import type { EditorStore } from '../store.js';
  import { CHANNELS, type BriefMode, type BriefResult, type CompiledPrompt, type RankedFileRow } from '../../ipc.js';
  import { detectContextInsufficient } from '../contextInsufficient.js';

  let { store }: { store: EditorStore } = $props();

  // ══ STATE ═══════════════════════════════════════════════════════════════

  /** What the developer says is wrong, in their own words. */
  let issue = $state('');
  /** Console output or a pasted stack trace. */
  let logs = $state('');
  /**
   * The AI's reply, pasted verbatim. Never parsed for anything but the marker.
   */
  let reply = $state('');
  /**
   * A path typed straight into the screen, as a fallback when the ranker did not
   * offer the file at all.
   *
   * Not a leak: the main process refuses anything outside the project, and a
   * refusal is shown beside the prompt. This is a *read of a file inside the open
   * project*, which the renderer can already ask for through `compileContext` — it
   * is not a second way to reach the disk.
   */
  let manualPath = $state('');

  /** The ranked list, from `context:rank`. */
  let ranked = $state<RankedFileRow[]>([]);
  /** Paths the developer ticked, or an AI asked for. Kept sorted for R8. */
  let ticked = $state<string[]>([]);
  /** What the AI asked for by name, so the box can show what was attached. */
  let requested = $state<string[]>([]);
  /**
   * Requests checked against the disk and found not to be there.
   *
   * A separate `Set`, not a derived from `compiled`, because the answer must come
   * from a compile that *asked about that path* rather than from one that attached
   * it. Before anything is attached, a requested file is in neither set, so a
   * derived would call every existing file missing and offer a button that can do
   * nothing. The truth arrives from `probeRequests` below.
   */
  let absent = $state<ReadonlySet<string>>(new Set<string>());
  /** The last compiled prompt. `null` until something has been compiled. */
  let compiled = $state<CompiledPrompt | null>(null);
  /** A refusal from the main process, shown next to the thing that caused it. */
  let refusal = $state<string | null>(null);
  /** True while a request is in flight. */
  let working = $state(false);
  /** True once the developer has compiled once, so the empty states stay quiet. */
  let started = $state(false);
  /** What the Copy button says for a moment after it worked. */
  let copied = $state(false);

  // ── Brief (the `brief:generate` / `brief:read` pair) ──────────────────────

  /**
   * Which brief to build. `oneShot` puts the developer's task in the brief and
   * answers; `interactive` leaves the task out and tells the AI to name what it
   * is missing with `NEED:` instead. Deliberately component state and not store
   * state — it is a choice about this one request, and `ipc.ts` says so.
   */
  let briefMode = $state<BriefMode>('oneShot');
  /**
   * The brief's task, as typed here rather than as inferred from the `issue`
   * box above.
   *
   * Separate on purpose. The two are not the same sentence: "the kart drifts
   * left" is a symptom to compile a prompt against, and "find every place a
   * position is written" is a job for a brief. Pre-filling one from the other
   * would silently change what gets asked when the developer edits it.
   */
  let briefTask = $state('');
  /** True while `brief:generate` is in flight; extraction is the slow part. */
  let briefWorking = $state(false);
  /** The brief just written, or read back. `null` until there is one. */
  let brief = $state<BriefResult | null>(null);
  /** A refusal from a brief request, shown beside the button that caused it. */
  let briefRefusal = $state<string | null>(null);

  // ══ DERIVED ═════════════════════════════════════════════════════════════

  const projectName = $derived(store.snapshot?.project.name ?? null);

  /** What the AI asked for, decided by the pure detector and nothing else. */
  const detected = $derived(detectContextInsufficient(reply));

  /** The requested items that are not in the project. Never silently dropped. */
  const missing = $derived(detected.requested.filter((item) => absent.has(item)));

  /**
   * The requests that can be attached: paths, excluding the ones proven absent.
   *
   * Until the probe has run, `absent` is empty and this is every path-shaped
   * request — which is correct, because an unprobed request is not a known-absent
   * one. The button therefore always does something rather than sitting disabled
   * with no explanation, and the recompile it triggers is what turns "I do not
   * know" into "I checked".
   */
  const attachable = $derived(
    detected.requested.filter((item) => looksLikePath(item) && !absent.has(item)),
  );

  /**
   * Does this request look like a file, rather than a description of one?
   *
   * Deliberately narrow. The screen must not offer "the update loop" as a file to
   * attach, and equally must not offer a sentence as one — either way the developer
   * gets an attachment list containing something that is not a path, which is the
   * confident-wrong-answer failure this app exists to prevent. Anything with
   * whitespace in it is prose; anything else has to end in something that could be
   * a file extension.
   */
  function looksLikePath(request: string): boolean {
    const trimmed = request.trim();
    if (trimmed === '' || /\s/.test(trimmed)) return false;
    const dot = trimmed.lastIndexOf('.');
    if (dot <= 0) return false;
    return /^[a-z0-9]+$/i.test(trimmed.slice(dot + 1));
  }

  /** The whole set of paths the next compile will attach. */
  const attachments = $derived([...new Set([...ticked, ...requested])].sort());

  /**
   * The files core actually put in the prompt.
   *
   * One Set, built in a derived, because both the checkbox list and the detector's
   * existence question read it and must not disagree: a checkbox showing a file as
   * attached while the detector calls the same path missing would be a screen that
   * contradicts itself about the same fact.
   */
  const attachedFiles = $derived(new Set((compiled?.sections ?? []).map((s) => s.file)));

  // ══ ACTIONS ═════════════════════════════════════════════════════════════

  /**
   * Rank the files, so the developer can see what the compiler thinks is
   * relevant *before* paying for a prompt.
   *
   * Failing to rank is not fatal and is not reported as an error: `compile` will
   * try anyway and will say what went wrong if it cannot. A ranking failure
   * shown here would be a second, earlier, and probably identical sentence.
   */
  async function rank(): Promise<void> {
    working = true;
    try {
      const result = await store.requestChannel(CHANNELS.rankFiles, { issue, logs });
      if (result.ok) {
        ranked = result.value.files;
      }
    } finally {
      working = false;
    }
  }

  /**
   * Compile the prompt, and find out which files the AI asked for are real.
   *
   * Ranking happens alongside the compile rather than before it, for one reason:
   * both requests extract the dependency graph, and that is the slowest thing on
   * this screen. Doing it as two steps would pay for the same answer twice.
   *
   * ## The two phases, and why there are two
   *
   * `files` is *additive*: an extra path joins the ranked selection, it does not
   * replace it. So asking "does `src/physics.js` exist" and asking "put
   * `src/physics.js` in the prompt" are not the same question, and the answer to
   * the first is not visible in the answer to the second — a path that exists but
   * outranks nothing produces an identical `sections` list either way.
   *
   * So the missing-path check is made **exactly**, not heuristically: the first
   * phase sends the requested paths as attachments; the second reads them back
   * out of the `sections` core reports, and a request that is not there was not
   * attached, which for a path the developer could see means it is not a file in
   * this project. That answer comes from the main process — the only thing in the
   * app that can see the disk — and it is precise rather than a guess made in the
   * renderer.
   *
   * Phase two runs only when something was requested, so a developer who never
   * pastes a reply pays for one compile and not two.
   */
  async function compile(): Promise<void> {
    working = true;
    started = true;
    try {
      const rankPromise = rank();

      const result = await store.requestChannel(CHANNELS.compileContext, {
        issue,
        logs,
        files: attachments,
      });
      await rankPromise;

      // A refusal leaves the previous prompt on screen rather than clearing it.
      // The developer may have had a good prompt before they mistyped a path, and
      // replacing it with an error loses work they could still have used.
      refusal = store.refusalOf(result);
      if (!result.ok) return;

      compiled = result.value;
      const asked = pathRequests(result.value);
      if (asked.length === 0) {
        absent = new Set<string>();
        return;
      }

      // Phase two. `attachments` is read here, not captured earlier, so the paths
      // ticked since the first phase are in it too.
      const probe = await store.requestChannel(CHANNELS.compileContext, {
        issue,
        logs,
        files: [...new Set([...attachments, ...asked])].sort(),
      });
      const probeRefusal = store.refusalOf(probe);
      if (probeRefusal !== null) {
        // The probe is a read-only question about the disk, so a refusal here is
        // not about the prompt on screen and must not replace it. Leaving
        // `refusal` alone is deliberate: the previous prompt is still the one the
        // developer would copy, and a stale error beside it would misdescribe it.
        return;
      }

      compiled = probe.value;
      absent = new Set(pathRequests(probe.value).filter((file) => !probe.value.sections.some((s) => s.file === file)));
    } finally {
      working = false;
    }
  }

  /**
   * The paths this prompt is carrying that were attached on request.
   *
   * Core labels a whole-file attachment `'full'` and a file it was told to attach
   * a `'slice'` or `'signatures'` — the same kinds it uses for anything else — so
   * there is no flag on the response that means "because the developer asked".
   * The compile options are threaded in to recover it, and the section is
   * attributed to a request only when that request is the *only* thing that could
   * have put it there: a file the stack trace or the description would have
   * pulled in anyway is not evidence that the request resolved.
   */
  function pathRequests(prompt: CompiledPrompt): string[] {
    const rank = ranked.map((row) => row.file);
    return attachments.filter(
      (file) =>
        prompt.sections.some((section) => section.file === file) && !rank.includes(file),
    );
  }

  /**
   * Tick or untick one file, and recompile immediately.
   *
   * Recompiling on the tick rather than on a second button is the whole point of
   * the checkbox: "also show me this file" is a question about *this* prompt, and
   * the only way to know the answer is to have the prompt.
   */
  async function toggle(file: string): Promise<void> {
    if (ticked.includes(file)) {
      ticked = ticked.filter((f) => f !== file);
    } else {
      ticked = [...ticked, file].sort();
    }
    await compile();
  }

  /**
   * Attach everything the AI asked for, and compile again.
   *
   * The requests that the probe could not find are left out and shown as missing:
   * attaching a path that is not there would produce a prompt whose gap list says
   * so anyway, and the developer would have had to read the gap list to learn what
   * they could have been told outright.
   *
   * The reply box is **not** cleared. The developer needs to see what the AI said
   * to understand why a file was attached, and clearing it would also clear the
   * list of what it asked for — which is the only record of a decision this
   * screen made on the AI's behalf.
   */
  async function attachRequested(): Promise<void> {
    requested = [...new Set([...requested, ...attachable])].sort();
    await compile();
  }

  /**
   * Attach a path the developer typed, and compile again.
   *
   * The ranked list is only as good as the evidence it was given. When it is wrong
   * — the file the AI wants is not mentioned anywhere in the error text and no
   * exported symbol matches — a checkbox cannot help, because the row is not there
   * to tick. Typing the path is the escape hatch, and it is one the developer has
   * in every other tool, so withholding it would make this screen the one place
   * they cannot attach a file they can name.
   *
   * Nothing is validated here. The main process owns the disk, refuses anything
   * outside the project, and says so in `gaps` for a path that is not in it; a
   * screen-side guess at what a valid path looks like would be a second, weaker
   * version of a check that already exists.
   */
  async function attachTyped(): Promise<void> {
    const file = manualPath.trim();
    if (file === '') return;
    if (!ticked.includes(file)) ticked = [...ticked, file].sort();
    manualPath = '';
    await compile();
  }

  /**
   * Copy the prompt to the clipboard.
   *
   * Failures are silent here on purpose, and only here: `navigator.clipboard`
   * needs a secure context and a permission the app did not ask for, so a refusal
   * would most often be a red line about something the developer cannot fix. The
   * prompt is on screen either way — the button's purpose is convenience, and the
   * alternative is an error box over text they can still select and copy by hand.
   */
  async function copyPrompt(): Promise<void> {
    const prompt = compiled?.prompt;
    if (prompt === undefined || prompt === '') return;
    try {
      await navigator.clipboard.writeText(prompt);
      copied = true;
    } catch {
      copied = false;
    }
  }

  // ══ HELPERS ═════════════════════════════════════════════════════════════

  /**
   * Build a fresh brief and write it to `.contextforge/brief.md`.
   *
   * `task` is sent only in one-shot mode, because that is the only mode that
   * uses it: an interactive brief states no task by construction, and sending
   * one anyway would mean the main process silently ignored it. Omitting the key
   * entirely rather than sending `undefined` keeps the request inside
   * `exactOptionalPropertyTypes`.
   *
   * The previous brief is **not** cleared on a refusal. A developer who had a
   * good brief on screen and asked a malformed one should still have the brief
   * they could use, exactly as `compile` keeps the previous prompt.
   */
  async function newBrief(): Promise<void> {
    briefWorking = true;
    try {
      const result = await store.requestChannel(
        CHANNELS.generateBrief,
        briefMode === 'oneShot' && briefTask.trim() !== ''
          ? { mode: briefMode, task: briefTask.trim() }
          : { mode: briefMode },
      );

      briefRefusal = store.refusalOf(result);
      if (!result.ok) return;

      brief = result.value;
    } finally {
      briefWorking = false;
    }
  }

  /**
   * Read the brief already on disk, if any.
   *
   * Called on mount so opening the Context screen shows the brief this project
   * already has rather than an empty box that looks like "none was ever made".
   * `ok(null)` is the normal answer for a project that has never had one, so
   * nothing is pushed to `notices` and no refusal is shown — absence is not an
   * error.
   */
  async function loadBrief(): Promise<void> {
    const result = await store.requestChannel(CHANNELS.readBrief, {});
    if (!result.ok) return;
    if (result.value === null) return;

    // **`briefMode` is deliberately not written here.** It is bound by the mode
    // radios, so writing it from inside the effect that reads state makes the
    // effect depend on its own output: Svelte raises
    // `effect_update_depth_exceeded`, the screen never renders, and the failure
    // looks like a Svelte bug rather than a self-feeding effect.
    //
    // The developer's own radio clicks already set the mode, and it defaults to
    // `oneShot` — so nothing is lost by not forcing it to the file's mode. The
    // file's mode is still reported, in the brief panel, as what it is.
    brief = result.value;
  }

  $effect(() => {
    void loadBrief();
  });

  /** `1234` → `1,234`, so a character count reads as a count. */
  function group(n: number): string {
    return n.toLocaleString('en-US');
  }
</script>

<!--
  ══ VIEW ════════════════════════════════════════════════════════════════
  One panel per block, in the order the developer works through them. -->
<section class="screen">
  <header>
    <h1>Context</h1>
    <!-- BRIEF BUTTON SLOT — a brief action belongs here, as `class="secondary"`. -->
    <!--
      The brief is a *secondary* action and sits `secondary` on purpose. The
      screen's one main action is Compile prompt; a second equally-weighted button
      in the same row would make the developer read both before knowing which one
      they meant. This one is for a different job — describe the project to an AI
      that has not seen it — so it is offered, not pushed.
    -->
    <button
      type="button"
      class="secondary"
      onclick={() => void newBrief()}
      disabled={briefWorking || projectName === null}
      title={projectName === null
        ? 'Open a project first — a brief is built from a project\'s own graph.'
        : 'Write .contextforge/brief.md from the project\'s real dependency graph.'}
    >
      {briefWorking ? 'Building…' : 'New AI context'}
    </button>
    <p class="lede">
      {#if projectName !== null}
        Describe what is broken in <strong>{projectName}</strong>, paste the error, and get a
        prompt with the failing code in it — not the whole project.
      {:else}
        No project is open. Open one first: a prompt compiled without a project would attach
        nothing, and a prompt that attaches nothing is worse than no prompt.
      {/if}
    </p>
  </header>

  <!-- ── 1. The crime scene ────────────────────────────────────────────── -->
  <details class="panel" open>
    <summary class="panel-summary">
      <h2>1. The crime scene</h2>
    </summary>
    <div class="panel-body">
      <label class="field" for="context-issue">
        <span class="label">What is broken</span>
        <textarea
          id="context-issue"
          rows="3"
          spellcheck="true"
          placeholder="The kart drifts to the left on every corner, and only after the second lap."
          bind:value={issue}
        ></textarea>
      </label>

      <label class="field" for="context-logs">
        <span class="label">Error text, console output or stack trace</span>
        <textarea
          id="context-logs"
          rows="6"
          spellcheck="false"
          placeholder={'TypeError: cannot read properties of undefined (reading "speed")\n    at updateKart (src/kart.js:142:11)'}
          bind:value={logs}
        ></textarea>
      </label>

      <div class="actions">
        <button type="button" class="primary" onclick={() => void compile()} disabled={working}>
          {working ? 'Compiling…' : 'Compile prompt'}
        </button>
        <button
          type="button"
          class="secondary"
          onclick={() => void copyPrompt()}
          disabled={working || compiled === null}
          title={compiled === null ? 'Compile a prompt first' : 'Copy compiled prompt'}
        >
          {copied ? 'Copied' : 'Copy prompt'}
        </button>
      </div>
    </div>
  </details>

  <!-- ── 2. The ranked files ────────────────────────────────────────────── -->
  <details class="panel" open>
    <summary class="panel-summary">
      <h2>2. Files the compiler chose</h2>
    </summary>
    <div class="panel-body">
      <p class="lede small">
        Tick anything missing from the prompt. The reason is the ranker's, not yours — it is the only
        clue about why a file was chosen, and it is wrong whenever the file is wrong.
      </p>

      {#if ranked.length === 0}
        <p class="empty">
          {started
            ? 'Nothing ranked. Compile with an error text that names a file, or a description that names a symbol.'
            : 'Compile to see which files this error points at.'}
        </p>
      {:else}
        <ul class="rank-list">
          {#each ranked as row (row.file)}
            <li>
              <label class="rank-row">
                <input
                  type="checkbox"
                  checked={attachedFiles.has(row.file)}
                  onchange={() => void toggle(row.file)}
                  disabled={working}
                />
                <span class="rank-body">
                  <span class="rank-path">{row.file}</span>
                  {#if row.line !== null}
                    <span class="rank-line">line {row.line}</span>
                  {/if}
                  <span class="rank-reason">{row.reason}</span>
                </span>
              </label>
            </li>
          {/each}
        </ul>
      {/if}

      <div class="manual-row">
        <label class="field manual" for="context-manual-path">
          <span class="label">Not in the list? Attach it by path.</span>
          <input
            id="context-manual-path"
            type="text"
            spellcheck="false"
            autocomplete="off"
            placeholder="src/physics.js"
            bind:value={manualPath}
            onkeydown={(event) => {
              if (event.key === 'Enter') void attachTyped();
            }}
          />
        </label>
        <button
          type="button"
          class="secondary"
          onclick={() => void attachTyped()}
          disabled={working || manualPath.trim() === ''}
        >
          Attach
        </button>
      </div>
    </div>
  </details>

  <!-- ── 3. The prompt ─────────────────────────────────────────────────── -->
  <details class="panel" open>
    <summary class="panel-summary">
      <h2>3. Compiled prompt</h2>
    </summary>
    <div class="panel-body">
      {#if refusal !== null}
        <!--
          The refusal sits inside the panel it is about, not in the toast strip. A
          toast disappears in six seconds and names no file; this one says what was
          wrong with *this* request and stays until the next one succeeds.
        -->
        <p class="refusal" role="alert">{refusal}</p>
      {/if}

      {#if compiled === null}
        <p class="empty">Nothing compiled yet.</p>
      {:else}
        <dl class="facts">
          <dt>Tokens</dt>
          <dd>
            ~{group(compiled.tokens)}
            <!--
              Approximate, and labelled so. `tokens` is characters/4 — the right
              order of magnitude and the wrong number. A developer who notices it is
              off by a few hundred stops trusting the savings figure beside it too,
              so both are labelled rather than one being quietly precise.
            -->
            <span class="muted">(approximate)</span>
          </dd>
          <dt>Characters</dt>
          <dd>{group(compiled.chars)}</dd>
          <dt>Saved</dt>
          <dd>
            {compiled.savingsPercent}% against sending whole files
            <span class="muted">({group(compiled.fullChars)} characters)</span>
          </dd>
        </dl>

        {#if compiled.gaps.length > 0}
          <div class="gaps">
            <span class="gaps-title">Not attached — the prompt says so in these terms:</span>
            <ul>
              {#each compiled.gaps as gap, i (i)}
                <li>{gap}</li>
              {/each}
            </ul>
          </div>
        {/if}

        <pre class="prompt">{compiled.prompt}</pre>

        <div class="actions">
          <button type="button" class="secondary" onclick={() => void copyPrompt()} disabled={working}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      {/if}
    </div>
  </details>

  <!-- ── 4. The AI's reply ─────────────────────────────────────────────── -->
  <details class="panel" open>
    <summary class="panel-summary">
      <h2>4. AI reply</h2>
    </summary>
    <div class="panel-body">
      <p class="lede small">
        Paste what came back. If it could not see enough it will say
        <code>CONTEXT INSUFFICIENT:</code> and name what it needs.
      </p>

      <label class="field" for="context-reply">
        <span class="label">Reply</span>
        <textarea
          id="context-reply"
          rows="6"
          spellcheck="false"
          placeholder={'CONTEXT INSUFFICIENT: Need src/kart.js — the physics constants'}
          bind:value={reply}
        ></textarea>
      </label>

      {#if detected.detected}
        <div class="detected">
          <span class="detected-title">The reply asked for more context:</span>
          <ul>
            {#each detected.requested as item (item)}
              <li>
                <span class="requested-item">{item}</span>
                {#if absent.has(item)}
                  <span class="missing">
                    not in this project — nothing was attached for it
                  </span>
                {/if}
              </li>
            {/each}
          </ul>

          {#if attachable.length > 0}
            <div class="actions">
              <button
                type="button"
                class="primary"
                onclick={() => void attachRequested()}
                disabled={working}
              >
                Attach what was asked for and recompile
              </button>
            </div>
          {:else}
            <!--
              Reached only when nothing the AI named looks like a path — "CONTEXT
              INSUFFICIENT: I need the update loop". That is a real answer and it is
              not a bug in the detector, so it gets its own sentence rather than the
              "nothing exists" one, which would be false.
            -->
            <p class="refusal" role="alert">
              The reply said its context was insufficient but named no file, so there is nothing to
              attach automatically. Compile the prompt again with a description of what the AI said it
              needed, or attach the file by path below.
            </p>
          {/if}
        </div>
      {/if}
    </div>
  </details>

  <!-- ── 5. The brief ──────────────────────────────────────────────────── -->
  <details class="panel" open>
    <summary class="panel-summary">
      <h2>5. New AI context</h2>
    </summary>
    <div class="panel-body">
      <p class="lede small">
        A brief is the project described to an AI that has not seen it: the stack, the folder
        map, the real public signatures, the rules for <code>scene.json</code> and prefabs, and
        the patch format. Every line is read out of the code, so it cannot drift from it.
      </p>

      <fieldset class="modes">
        <legend class="label">What kind</legend>
        <label class="mode">
          <input type="radio" bind:group={briefMode} value="oneShot" disabled={briefWorking} />
          <span>
            <strong>One-shot</strong>
            <span class="muted"> — the brief carries your task, and the AI answers it.</span>
          </span>
        </label>
        <label class="mode">
          <input type="radio" bind:group={briefMode} value="interactive" disabled={briefWorking} />
          <span>
            <strong>Interactive</strong>
            <span class="muted">
              — no task; the AI is told to reply <code>NEED: &lt;path&gt;</code> for anything it
              cannot see, and the files are attached before it answers.
            </span>
          </span>
        </label>
      </fieldset>

      {#if briefMode === 'oneShot'}
        <label class="field" for="context-brief-task">
          <span class="label">The task for this brief</span>
          <textarea
            id="context-brief-task"
            rows="2"
            spellcheck="true"
            placeholder="Find every place a world position is written outside scene.json."
            bind:value={briefTask}
          ></textarea>
        </label>
      {/if}

      <div class="actions">
        <button
          type="button"
          class="primary"
          onclick={() => void newBrief()}
          disabled={briefWorking || projectName === null}
        >
          {briefWorking ? 'Building…' : 'Build brief'}
        </button>
        {#if brief !== null}
          <button type="button" class="secondary" onclick={() => void loadBrief()} disabled={briefWorking}>
            Reload from disk
          </button>
        {/if}
      </div>

      {#if briefRefusal !== null}
        <p class="refusal" role="alert">{briefRefusal}</p>
      {/if}

      {#if brief !== null}
        <dl class="facts">
          <dt>Saved to</dt>
          <dd><code>{brief.path}</code></dd>
          <dt>Mode</dt>
          <dd>{brief.mode === 'oneShot' ? 'One-shot' : 'Interactive'}</dd>
          <dt>Graph</dt>
          <dd>{group(brief.stats.nodes)} node(s), {group(brief.stats.edges)} edge(s)</dd>
          <dt>Prefabs</dt>
          <dd>{group(brief.stats.prefabs)}</dd>
          <dt>Instances</dt>
          <dd>{group(brief.stats.instances)}</dd>
        </dl>
        <pre class="prompt">{brief.markdown}</pre>
        <div class="actions">
          <button
            type="button"
            class="secondary"
            onclick={async () => {
              try {
                await navigator.clipboard.writeText(brief.markdown);
              } catch {
                // Silent for the same reason `copyPrompt` is: a clipboard the app
                // never asked for is not worth a red line over text still on screen.
              }
            }}
            disabled={briefWorking}
          >
            Copy brief
          </button>
        </div>
      {:else}
        <p class="empty">
          No brief yet. It is written to <code>.contextforge/brief.md</code> inside the open
          project, so it can be committed and shared between AIs.
        </p>
      {/if}
    </div>
  </details>

  {#if compiled !== null}
    <div class="sticky-copy-bar" role="region" aria-label="Prompt actions">
      <div class="sticky-copy-info">
        <span class="sticky-copy-title">Prompt ready</span>
        <span class="muted">~{group(compiled.tokens)} tokens · {compiled.savingsPercent}% saved</span>
      </div>
      <button
        type="button"
        class="primary sticky-copy-btn"
        onclick={() => void copyPrompt()}
        disabled={working}
      >
        {copied ? 'Copied' : 'Copy prompt'}
      </button>
    </div>
  {/if}
</section>

<style>
  .screen {
    padding: 24px 28px 90px 28px;
    max-width: 820px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  h1 {
    margin: 0 0 6px;
    font-size: 20px;
  }
  h2 {
    margin: 0 0 8px;
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
    margin-bottom: 12px;
  }

  .panel {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 14px 16px;
  }

  .panel-summary {
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
    user-select: none;
    list-style: none;
  }
  .panel-summary::-webkit-details-marker {
    display: none;
  }
  .panel-summary::after {
    content: '▾';
    font-size: 14px;
    color: var(--muted);
    transition: transform 0.15s ease;
  }
  details:not([open]) .panel-summary::after {
    transform: rotate(-90deg);
  }
  .panel-summary h2 {
    margin: 0;
  }
  .panel-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 12px;
  }

  .sticky-copy-bar {
    position: sticky;
    bottom: 12px;
    z-index: 15;
    background: var(--panel-2);
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 10px 16px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
  }
  .sticky-copy-info {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  .sticky-copy-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }
  .sticky-copy-btn {
    white-space: nowrap;
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
    padding: 8px 10px;
    color: var(--text);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 13px;
    line-height: 1.45;
    resize: vertical;
  }

  .actions {
    display: flex;
    gap: 10px;
    margin-top: 2px;
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

  .facts {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 4px 14px;
    margin: 0;
    font-size: 13px;
  }
  .facts dt {
    color: var(--muted);
  }
  .facts dd {
    margin: 0;
  }

  .muted {
    color: var(--muted);
    font-size: 12px;
  }

  .gaps {
    font-size: 12px;
    line-height: 1.5;
    color: var(--warning);
  }
  .gaps ul {
    margin: 4px 0 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .prompt {
    margin: 0;
    max-height: 420px;
    overflow: auto;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 12px;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .refusal {
    margin: 0;
    padding: 8px 10px;
    border-left: 3px solid var(--danger);
    background: var(--panel-2);
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .rank-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .rank-row {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 10px;
    align-items: start;
    cursor: pointer;
  }
  .rank-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .rank-path {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 13px;
    word-break: break-all;
  }
  .rank-line {
    font-size: 11px;
    color: var(--muted);
  }
  .rank-reason {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.45;
  }

  .manual-row {
    display: flex;
    gap: 10px;
    align-items: end;
    padding-top: 10px;
    border-top: 1px solid var(--line);
  }
  .field.manual {
    flex: 1;
    min-width: 0;
  }
  .field.manual input[type='text'] {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 8px 10px;
    color: var(--text);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 13px;
    width: 100%;
    box-sizing: border-box;
  }
  .manual-row button {
    white-space: nowrap;
  }

  .detected {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--panel-2);
  }
  .detected-title {
    font-size: 13px;
  }
  .detected ul {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
  }
  .requested-item {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    word-break: break-all;
  }
  .missing {
    color: var(--warning);
    font-size: 12px;
  }

  .empty {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
  }

  /* ── New AI context ─────────────────────────────────────────────────── */

  /* The header is a column so the brief button can sit directly under the title
     without a layout wrapper that would change how `.lede` wraps. */
  header {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }
  header .secondary {
    margin-left: 0;
  }

  .modes {
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 10px 12px 12px;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .modes legend {
    padding: 0 4px;
  }
  .mode {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px;
    align-items: start;
    cursor: pointer;
    font-size: 13px;
    line-height: 1.5;
  }
  .mode input {
    margin-top: 2px;
  }
</style>
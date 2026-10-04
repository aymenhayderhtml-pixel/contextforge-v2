<!--
  ProjectScreen.svelte — open a project or create a new one from an AI reply.
-->
<script module lang="ts">
  export const RECENT_PROJECTS_KEY = 'contextforge:recent_projects';
  export const MAX_RECENT_PROJECTS = 10;

  /**
   * The New Project steps, exported so a test can assert the flow against the
   * same list the screen renders rather than a copy of it.
   */
  export const NEW_PROJECT_STEPS = [
    'Name it',
    'Describe the game',
    'Take the prompt',
    'Paste the reply',
    'Install and run',
  ] as const;
</script>

<script lang="ts">
  import { onMount, untrack, onDestroy } from 'svelte';
  // **Type-only.** `@contextforge/core` is `external` in the renderer build,
  // which is sound only while every renderer import of it is erased. A value
  // import leaves a bare specifier the browser cannot resolve and the app fails
  // to mount with no error — see D45.
  import type {
    GameBrief,
    PreviewProjectResult,
  } from '@contextforge/core';
  import type { EditorStore } from '../store.js';
  import { CHANNELS, EVENTS } from '../../ipc.js';

  function loadRecentProjects(): string[] {
    try {
      if (typeof localStorage === 'undefined') return [];
      const raw = localStorage.getItem(RECENT_PROJECTS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
    } catch {
      return [];
    }
  }

  function saveRecentProjects(list: readonly string[]): void {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(list));
    } catch {
      // Ignore storage errors in restricted environments
    }
  }

  let {
    store,
    onOpenScene,
    initialRecents,
  }: {
    store: EditorStore;
    onOpenScene: () => void;
    initialRecents?: string[];
  } = $props();

  const snapshot = $derived(store.snapshot);

  // svelte-ignore state_referenced_locally
  let path = $state(store.snapshot?.project.root ?? '');
  let opening = $state(false);
  let openError = $state<string | null>(null);
  // svelte-ignore state_referenced_locally
  let recents = $state<string[]>(initialRecents ?? loadRecentProjects());
  let browsing = $state(false);

  $effect(() => {
    const root = snapshot?.project.root;
    if (!root) return;
    path = root;
    untrack(() => addRecent(root));
  });

  function addRecent(projectPath: string): void {
    const trimmed = projectPath.trim();
    if (!trimmed) return;
    const next = [trimmed, ...recents.filter((p) => p !== trimmed)].slice(0, MAX_RECENT_PROJECTS);
    recents = next;
    saveRecentProjects(next);
  }

  async function open(pathToOpen?: string): Promise<void> {
    const target = (pathToOpen ?? path).trim();
    if (!target) return;
    path = target;
    opening = true;
    openError = null;
    try {
      const opened = await store.openProject(target);
      if (opened) {
        addRecent(target);
        onOpenScene();
      } else {
        openError = 'This folder has no scene.json yet.';
      }
    } finally {
      opening = false;
    }
  }

  async function close(): Promise<void> {
    await store.closeProject();
  }

  async function browse(): Promise<void> {
    if (browsing) return;
    browsing = true;
    try {
      const chosen = await store.pickFolder();
      if (chosen === null) return;
      await open(chosen);
    } finally {
      browsing = false;
    }
  }

  const problems = $derived(snapshot?.problems ?? []);

  // ── New Project (5-step flow) ──────────────────────────────────────────────

  let newProjectOpen = $state(false);
  let step = $state<1 | 2 | 3 | 4 | 5>(1);
  let draftName = $state('');
  let draftIdea = $state('');
  let parentFolder = $state<string>('');
  let choosingFolder = $state(false);

  const brief = $derived<GameBrief>({ name: draftName, idea: draftIdea });
  let scaffoldProblems = $state<string[]>([]);

  const canCopy = $derived(
    draftName.trim() !== '' && draftIdea.trim() !== '' && scaffoldProblems.length === 0,
  );

  let promptText = $state<string | null>(null);
  let promptError = $state<string | null>(null);
  let promptBusy = $state(false);
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  // Step 4 state
  let pastedReply = $state('');
  let previewTimeout: ReturnType<typeof setTimeout> | null = null;
  let previewBusy = $state(false);
  let previewResult = $state<PreviewProjectResult | null>(null);
  let previewError = $state<string | null>(null);
  let creatingProject = $state(false);
  let createError = $state<string | null>(null);

  // Step 5 state
  let createdPath = $state<string>('');
  let createdFilesCount = $state<number>(0);
  let createdPackageJson = $state<Record<string, unknown> | null>(null);
  let installing = $state(false);
  let installLogs = $state<string[]>([]);
  let installSuccess = $state(false);
  let installError = $state<string | null>(null);
  let devRunning = $state(false);
  let devUrl = $state<string | null>(null);
  let devError = $state<string | null>(null);
  let logEl: HTMLDivElement | null = $state(null);

  // Initialize default projects folder
  async function initProjectsFolder(): Promise<void> {
    try {
      const res = await store.requestChannel(CHANNELS.projectsFolder, { action: 'get' });
      if (res.ok && res.value.folder && !parentFolder) {
        parentFolder = res.value.folder;
      }
    } catch {
      // Ignore initial load failure
    }
  }

  $effect(() => {
    if (!parentFolder) {
      void initProjectsFolder();
    }
  });

  // Listen to process events
  onMount(() => {
    const unsubProcessOutput = store.onEvent(EVENTS.processOutput, (payload) => {
      if (payload.phase === 'install') {
        installLogs = [...installLogs, payload.line].slice(-200);
        if (logEl) {
          requestAnimationFrame(() => {
            if (logEl) logEl.scrollTop = logEl.scrollHeight;
          });
        }
      }
    });

    const unsubDevReady = store.onEvent(EVENTS.devServerReady, (payload) => {
      devRunning = true;
      devUrl = payload.url;
    });

    const unsubProcessExit = store.onEvent(EVENTS.processExit, (payload) => {
      if (payload.phase === 'install') {
        installing = false;
        if (payload.exitCode === 0) {
          installSuccess = true;
          installError = null;
        } else {
          installSuccess = false;
          installError = `Install failed (exit ${payload.exitCode ?? payload.signal ?? 'unknown'})`;
        }
      } else if (payload.phase === 'dev') {
        devRunning = false;
        devUrl = null;
      }
    });

    return () => {
      unsubProcessOutput();
      unsubDevReady();
      unsubProcessExit();
    };
  });

  onDestroy(() => {
    if (copyTimer) clearTimeout(copyTimer);
    if (previewTimeout) clearTimeout(previewTimeout);
    void stopDev();
  });

  async function scaffoldProblemsFor(briefToCheck: GameBrief): Promise<string[]> {
    try {
      const result = await store.requestChannel(CHANNELS.scaffoldProblems, briefToCheck);
      if (result.ok) {
        scaffoldProblems = result.value.problems;
        return result.value.problems;
      }
      scaffoldProblems = [result.reason];
      return scaffoldProblems;
    } catch (error) {
      scaffoldProblems = [
        `Could not check the brief: ${error instanceof Error ? error.message : String(error)}`,
      ];
      return scaffoldProblems;
    }
  }

  async function refreshBriefProblems(): Promise<void> {
    if (!newProjectOpen) return;
    await scaffoldProblemsFor(brief);
  }

  async function openNewProject(): Promise<void> {
    newProjectOpen = true;
    step = 1;
    promptText = null;
    promptError = null;
    copied = false;
    pastedReply = '';
    previewResult = null;
    previewError = null;
    createError = null;
    installLogs = [];
    installSuccess = false;
    installError = null;
    devRunning = false;
    devUrl = null;
    devError = null;
    if (!parentFolder) {
      await initProjectsFolder();
    }
    await refreshBriefProblems();
  }

  async function stopDev(): Promise<void> {
    if (!createdPath) return;
    try {
      await store.requestChannel(CHANNELS.runProjectDev, { projectPath: createdPath, stop: true });
    } catch {
      // Ignore
    }
    devRunning = false;
    devUrl = null;
  }

  function closeNewProject(): void {
    void stopDev();
    newProjectOpen = false;
    step = 1;
  }

  function goTo(target: 1 | 2 | 3 | 4 | 5): void {
    step = target;
    if (target <= 2) {
      void refreshBriefProblems();
    }
  }

  async function toPrompt(): Promise<void> {
    if (!canCopy) return;
    promptBusy = true;
    promptError = null;
    try {
      const result = await store.requestChannel(CHANNELS.scaffoldPrompt, brief);
      if (result.ok) {
        promptText = result.value.prompt;
        step = 3;
      } else {
        promptText = null;
        promptError = result.reason;
      }
    } catch (error) {
      promptText = null;
      promptError = error instanceof Error ? error.message : String(error);
    } finally {
      promptBusy = false;
    }
  }

  async function chooseParentFolder(): Promise<void> {
    if (choosingFolder) return;
    choosingFolder = true;
    try {
      const chosen = await store.pickFolder();
      if (chosen === null) return;
      parentFolder = chosen;
      await store.requestChannel(CHANNELS.projectsFolder, { action: 'set', folder: chosen });
      if (draftName.trim() === '') {
        draftName = chosen.split('/').filter(Boolean).pop() ?? '';
      }
    } finally {
      choosingFolder = false;
    }
  }

  async function copyPrompt(): Promise<void> {
    if (promptText === null) return;
    try {
      await navigator.clipboard.writeText(promptText);
      copied = true;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copied = false;
      }, 2000);
    } catch {
      copied = false;
    }
  }

  function onReplyInput(): void {
    if (previewTimeout) clearTimeout(previewTimeout);
    createError = null;
    if (!pastedReply.trim()) {
      previewResult = null;
      previewError = null;
      return;
    }
    previewTimeout = setTimeout(() => {
      void runPreview();
    }, 300);
  }

  async function runPreview(): Promise<void> {
    if (!parentFolder || !draftName.trim() || !pastedReply.trim()) return;
    previewBusy = true;
    try {
      const res = await store.requestChannel(CHANNELS.previewProjectReply, {
        parentFolder,
        projectName: draftName.trim(),
        reply: pastedReply,
      });
      if (res.ok) {
        previewResult = res.value;
        previewError = null;
      } else {
        previewResult = null;
        previewError = res.reason;
      }
    } catch (err) {
      previewResult = null;
      previewError = err instanceof Error ? err.message : String(err);
    } finally {
      previewBusy = false;
    }
  }

  const canCreateProject = $derived(
    previewResult !== null &&
    previewResult.ok &&
    previewResult.files.length > 0 &&
    previewResult.files.every((f) => f.syntax.valid) &&
    !previewResult.refusal &&
    previewError === null &&
    !previewBusy,
  );

  async function handleCreateProject(): Promise<void> {
    if (!canCreateProject || creatingProject) return;
    creatingProject = true;
    createError = null;
    try {
      const res = await store.requestChannel(CHANNELS.createProjectReply, {
        parentFolder,
        projectName: draftName.trim(),
        reply: pastedReply,
      });
      if (res.ok) {
        createdPath = res.value.targetFolder;
        createdFilesCount = res.value.files.length;
        const pkgFile = res.value.files.find(
          (f) => f.path === 'package.json' || f.path.endsWith('/package.json'),
        );
        if (pkgFile) {
          try {
            createdPackageJson = JSON.parse(pkgFile.content) as Record<string, unknown>;
          } catch {
            createdPackageJson = null;
          }
        } else {
          createdPackageJson = null;
        }
        step = 5;
      } else {
        createError = res.reason;
      }
    } catch (err) {
      createError = err instanceof Error ? err.message : String(err);
    } finally {
      creatingProject = false;
    }
  }

  const allPackages = $derived.by(() => {
    if (!createdPackageJson) return [];
    const deps = (createdPackageJson.dependencies as Record<string, string>) ?? {};
    const devDeps = (createdPackageJson.devDependencies as Record<string, string>) ?? {};
    const list: [string, string, boolean][] = [];
    for (const [k, v] of Object.entries(deps)) list.push([k, v, false]);
    for (const [k, v] of Object.entries(devDeps)) list.push([k, v, true]);
    return list;
  });

  async function runInstall(): Promise<void> {
    if (installing || !createdPath) return;
    installing = true;
    installSuccess = false;
    installError = null;
    installLogs = [];
    try {
      const res = await store.requestChannel(CHANNELS.installProject, { projectPath: createdPath });
      if (!res.ok) {
        installing = false;
        installError = res.reason;
      }
    } catch (err) {
      installing = false;
      installError = err instanceof Error ? err.message : String(err);
    }
  }

  async function cancelInstall(): Promise<void> {
    if (!createdPath) return;
    try {
      await store.requestChannel(CHANNELS.installProject, { projectPath: createdPath, cancel: true });
    } catch {
      // Ignore
    }
  }

  async function startDev(): Promise<void> {
    if (devRunning || !createdPath) return;
    devError = null;
    try {
      const res = await store.requestChannel(CHANNELS.runProjectDev, {
        projectPath: createdPath,
      });
      if (!res.ok) {
        devError = res.reason;
      }
    } catch (err) {
      devError = err instanceof Error ? err.message : String(err);
    }
  }

  async function openDevBrowser(): Promise<void> {
    if (!devUrl) return;
    try {
      await store.requestChannel(CHANNELS.openDevUrl, { url: devUrl });
    } catch {
      // Ignore
    }
  }
</script>

<section class="screen">
  <header>
    <h1>Project</h1>
    <p class="lede">
      Open a folder containing a <code>scene.json</code> and a <code>prefabs/</code> directory.
      ContextForge never writes outside the folder you open.
    </p>
    {#if !newProjectOpen}
      <button type="button" class="secondary" onclick={() => void openNewProject()}>
        New project…
      </button>
    {/if}
  </header>

  <!--
    The New Project wizard (5 steps).
  -->
  {#if newProjectOpen}
    <div class="panel new-project">
      <ol class="steps">
        {#each NEW_PROJECT_STEPS as label, i (label)}
          <li class:active={step === i + 1} class:done={step > i + 1}>
            {#if step > i + 1}
              <span class="step-num">✓</span>
            {:else}
              <span class="step-num">{i + 1}</span>
            {/if}
            <span class="step-label">{label}</span>
          </li>
        {/each}
      </ol>

      {#if step === 1}
        <div class="field-group">
          <label class="field" for="np-name">
            <span class="label">Project name</span>
            <input
              id="np-name"
              type="text"
              spellcheck="false"
              autocomplete="off"
              placeholder="star-crawler"
              bind:value={draftName}
              oninput={() => void refreshBriefProblems()}
            />
            <span class="hint">Lowercase letters, numbers and dashes. Example: star-crawler</span>
          </label>

          <label class="field" for="np-folder">
            <span class="label">Create it in</span>
            <div class="input-row">
              <input id="np-folder" type="text" readonly value={parentFolder} />
              <button
                type="button"
                class="secondary"
                onclick={() => void chooseParentFolder()}
                disabled={choosingFolder}
              >
                Choose folder…
              </button>
            </div>
            <span class="hint">This is where your games are saved. It is remembered.</span>
          </label>
        </div>

        <div class="actions">
          <button
            type="button"
            class="primary"
            onclick={() => goTo(2)}
            disabled={draftName.trim() === ''}
          >
            Next: describe the game
          </button>
          <button type="button" class="secondary cancel-btn" onclick={closeNewProject}>Cancel</button>
        </div>
      {:else if step === 2}
        <div class="field-group">
          <label class="field" for="np-idea">
            <span class="label">What is the game?</span>
            <textarea
              id="np-idea"
              rows="5"
              placeholder="You drive a hover car around a collapsing space station, collecting fuel pods."
              bind:value={draftIdea}
              oninput={() => void refreshBriefProblems()}
            ></textarea>
            <span class="hint">
              One or two sentences on what the player actually does. This goes into the prompt word for word.
            </span>
          </label>

          {#if scaffoldProblems.length > 0 && draftName.trim() !== ''}
            <ul class="problems brief-problems" role="alert">
              {#each scaffoldProblems as problem (problem)}
                <li>{problem}</li>
              {/each}
            </ul>
          {/if}
        </div>

        <div class="actions">
          <button type="button" class="secondary" onclick={() => goTo(1)}>Back</button>
          <button
            type="button"
            class="primary"
            onclick={() => void toPrompt()}
            disabled={draftIdea.trim() === '' || scaffoldProblems.length > 0}
          >
            Build the prompt
          </button>
          <button type="button" class="secondary cancel-btn" onclick={closeNewProject}>Cancel</button>
        </div>
      {:else if step === 3}
        <div class="field-group">
          {#if promptBusy}
            <p class="lede small">Building…</p>
          {:else if promptError !== null}
            <p class="refusal" role="alert">{promptError}</p>
          {:else if promptText !== null}
            <pre class="prompt">{promptText}</pre>
          {/if}

          <p class="hint">Paste this into any AI chat, then come back with its reply.</p>
        </div>

        <div class="actions">
          <button type="button" class="secondary" onclick={() => goTo(2)}>Back</button>
          <button
            type="button"
            class="primary"
            onclick={() => void copyPrompt()}
            disabled={!canCopy || promptText === null}
          >
            {copied ? 'Copied' : 'Copy prompt'}
          </button>
          <button type="button" class="secondary" onclick={() => goTo(4)}>
            I have the reply
          </button>
          <button type="button" class="secondary cancel-btn" onclick={closeNewProject}>Cancel</button>
        </div>
      {:else if step === 4}
        <div class="field-group">
          <label class="field" for="np-reply">
            <span class="label">Paste the AI's reply</span>
            <textarea
              id="np-reply"
              class="reply-textarea"
              rows="12"
              placeholder="Paste the whole reply here. It must contain blocks that start with ### FILE:"
              bind:value={pastedReply}
              oninput={onReplyInput}
            ></textarea>
          </label>

          {#if previewError !== null}
            <p class="refusal" role="alert">{previewError}</p>
          {/if}

          {#if createError !== null}
            <p class="refusal" role="alert">{createError}</p>
          {/if}

          {#if previewResult !== null}
            {@const failedCount = previewResult.files.filter((f) => !f.syntax.valid).length}
            {#if previewResult.files.length > 0 && failedCount === 0}
              <p class="summary-line ok">
                {previewResult.files.length} {previewResult.files.length === 1 ? 'file' : 'files'}, all syntax checks passed
              </p>
            {:else if previewResult.files.length > 0 && failedCount > 0}
              <p class="summary-line error">
                {previewResult.files.length} {previewResult.files.length === 1 ? 'file' : 'files'}, {failedCount} syntax errors
              </p>
            {/if}

            <ul class="file-verdict-list" aria-label="Files to be created">
              {#each previewResult.files as file (file.path)}
                <li class="file-verdict-item">
                  <span class="tag-new">NEW</span>
                  <span class="file-path">{file.path}</span>
                  {#if file.syntax.valid}
                    <span class="verdict-ok">✓</span>
                  {:else}
                    <span class="verdict-error">
                      SYNTAX ERROR: {file.syntax.message}
                    </span>
                  {/if}
                </li>
              {/each}
            </ul>

            <p class="will-create">Will create: <code>{previewResult.targetFolder}</code></p>

            {#if previewResult.refusal?.includes('already exists and is not empty')}
              <p class="refusal" role="alert">
                This folder already exists and is not empty. Go back and pick another name.
              </p>
            {:else if previewResult.refusal}
              <p class="refusal" role="alert">
                {previewResult.refusal}
              </p>
            {/if}
          {/if}
        </div>

        <div class="actions">
          <button type="button" class="secondary" onclick={() => { step = 3; }}>Back</button>
          <button
            type="button"
            class="primary"
            onclick={() => void handleCreateProject()}
            disabled={!canCreateProject || creatingProject}
          >
            {creatingProject ? 'Creating project…' : 'Create project'}
          </button>
          <button type="button" class="secondary cancel-btn" onclick={closeNewProject}>Cancel</button>
        </div>
      {:else}
        <!-- Step 5: Install and run -->
        <div class="field-group">
          <p class="created-banner">
            <span class="verdict-ok">✓</span> Created <code>{createdPath}</code>, {createdFilesCount} files written.
          </p>

          <div class="packages-box">
            <span class="box-title">Packages</span>
            {#if allPackages.length > 0}
              <ul class="package-list">
                {#each allPackages as [pkg, ver, isDev] (pkg)}
                  <li>
                    <code>{pkg}</code> <span class="pkg-ver">{ver}</span>
                    {#if isDev}<span class="pkg-dev">dev</span>{/if}
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="hint">(No dependencies listed in package.json)</p>
            {/if}
          </div>

          <p class="hint install-notice">
            Installing downloads packages from the npm registry. Install scripts are turned off, so no package can run code during the install.
          </p>

          {#if installLogs.length > 0 || installing}
            <div class="log-box-wrapper" bind:this={logEl}>
              <pre class="log-box">{installLogs.join('\n')}</pre>
            </div>
          {/if}

          {#if installError !== null}
            <p class="refusal" role="alert">{installError}</p>
          {:else if installSuccess}
            <p class="install-ok-line"><span class="verdict-ok">✓</span> Installed</p>
          {/if}

          {#if devRunning && devUrl}
            <div class="dev-banner">
              <span>Running at <code>{devUrl}</code></span>
              <button type="button" class="secondary dev-open-btn" onclick={() => void openDevBrowser()}>
                Open in browser
              </button>
            </div>
          {/if}

          {#if devError !== null}
            <p class="refusal" role="alert">{devError}</p>
          {/if}
        </div>

        <div class="actions">
          <button
            type="button"
            class="secondary"
            onclick={() => goTo(4)}
            disabled={installing || devRunning}
          >
            Back
          </button>

          {#if installing}
            <button type="button" class="secondary" onclick={() => void cancelInstall()}>
              Cancel install
            </button>
          {:else if !installSuccess}
            <button type="button" class="primary" onclick={() => void runInstall()}>
              Install packages
            </button>
          {:else if !devRunning}
            <button type="button" class="primary" onclick={() => void startDev()}>
              Run game
            </button>
          {:else}
            <button type="button" class="secondary" onclick={() => void stopDev()}>
              Stop
            </button>
          {/if}

          <button
            type="button"
            class="secondary open-cf-btn"
            onclick={() => void open(createdPath)}
          >
            Open in ContextForge
          </button>

          <button type="button" class="secondary cancel-btn" onclick={closeNewProject}>Cancel</button>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Bug B4: collapse to single text link while wizard is open -->
  {#if newProjectOpen}
    <div class="panel collapsed-open">
      <button type="button" class="link-btn" onclick={closeNewProject}>
        Open an existing project instead
      </button>
    </div>
  {:else}
    <div class="panel">
      <label class="field" for="project-path">
        <span class="label">Project folder path</span>
        <div class="input-row">
          <input
            id="project-path"
            type="text"
            spellcheck="false"
            autocomplete="off"
            placeholder="/home/you/projects/my-game"
            bind:value={path}
            onkeydown={(event) => {
              if (event.key === 'Enter') void open();
            }}
          />
          <button
            type="button"
            class="secondary browse-btn"
            onclick={() => void browse()}
            disabled={opening || browsing}
          >
            Browse…
          </button>
        </div>
      </label>

      {#if openError !== null}
        <p class="refusal" role="alert">{openError}</p>
      {/if}

      <div class="actions">
        <button type="button" class="primary" onclick={() => void open()} disabled={opening}>
          {opening ? 'Opening project…' : 'Open project'}
        </button>

        {#if snapshot !== null}
          <button type="button" class="secondary" onclick={() => void close()}>
            Close project
          </button>
        {/if}
      </div>
    </div>

    {#if recents.length > 0}
      <div class="panel recents-panel">
        <h2>Recent projects</h2>
        <ul class="recent-list">
          {#each recents as item (item)}
            <li>
              <button
                type="button"
                class="recent-item"
                onclick={() => void open(item)}
                disabled={opening}
              >
                <span class="recent-path">{item}</span>
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  {/if}

  {#if snapshot !== null}
    <div class="panel">
      <h2>Open project</h2>
      <dl class="facts">
        <dt>Name</dt>
        <dd>{snapshot.project.name}</dd>
        <dt>Folder</dt>
        <dd class="path">{snapshot.project.root}</dd>
        <dt>Engine</dt>
        <dd>{snapshot.project.engine}</dd>
        <dt>Scene file</dt>
        <dd class="path">{snapshot.project.scenePath}</dd>
        <dt>Objects</dt>
        <dd>{snapshot.scene.instances.length}</dd>
        <dt>Prefabs</dt>
        <dd>
          {snapshot.prefabs.prefabs.length} available
          {#if snapshot.prefabs.failed.length > 0}
            <span class="bad">({snapshot.prefabs.failed.length} failed to load)</span>
          {/if}
        </dd>
        <dt>Undo steps</dt>
        <dd>{snapshot.history.undoCount}</dd>
      </dl>
    </div>

    {#if problems.length > 0}
      <div class="panel problems">
        <h2>Problems found while opening</h2>
        <p class="lede small">
          The project opened anyway. These are what an AI wrote or left behind, and they are the
          reason some of the scene may not render.
        </p>
        <ul>
          {#each problems as problem, i (i)}
            <li>{problem}</li>
          {/each}
        </ul>
      </div>
    {/if}
  {:else if !newProjectOpen}
    <p class="empty">
      No project is open. Type a folder path above or browse to open a project.
    </p>
  {/if}
</section>

<style>
  .screen {
    padding: 24px 28px;
    max-width: 780px;
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
  }

  .lede {
    margin: 0;
    color: var(--muted);
    line-height: 1.5;
  }
  .lede.small {
    font-size: 12px;
    margin-bottom: 10px;
  }

  .panel {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 16px;
  }

  .field-group {
    display: flex;
    flex-direction: column;
    gap: 14px;
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

  /* Shared input styles fixing Bug B1 */
  .field input[type='text'],
  .input-row input[type='text'] {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 8px 10px;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 13px;
    color: var(--text);
    box-sizing: border-box;
    height: 36px;
  }

  .field input[type='text']:focus,
  .input-row input[type='text']:focus,
  textarea:focus {
    outline: none;
    border-color: var(--accent);
  }

  .input-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .input-row input[type='text'] {
    flex: 1;
  }

  .browse-btn {
    white-space: nowrap;
  }

  .actions {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-top: 16px;
  }
  .actions .cancel-btn {
    margin-left: auto;
  }

  .primary {
    background: var(--accent);
    color: #06121a;
    border: 1px solid var(--accent);
    border-radius: 5px;
    padding: 0 16px;
    height: 36px;
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
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
    padding: 0 14px;
    height: 36px;
    font-size: 13px;
    cursor: pointer;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .secondary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .link-btn {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    text-decoration: underline;
    cursor: pointer;
    font-size: 13px;
  }
  .link-btn:hover {
    filter: brightness(1.2);
  }

  .collapsed-open {
    padding: 12px 16px;
  }

  .recents-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .recent-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .recent-item {
    width: 100%;
    display: flex;
    align-items: center;
    padding: 8px 12px;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 5px;
    color: var(--text);
    text-align: left;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .recent-item:hover:not(:disabled) {
    background: var(--panel-2);
    border-color: var(--accent);
  }
  .recent-item:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .recent-path {
    word-break: break-all;
  }

  .facts {
    display: grid;
    grid-template-columns: 130px 1fr;
    gap: 6px 14px;
    margin: 0;
    font-size: 13px;
  }
  .facts dt {
    color: var(--muted);
  }
  .facts dd {
    margin: 0;
  }
  .path {
    font-family: ui-monospace, Menlo, monospace;
    font-size: 12px;
    word-break: break-all;
  }
  .bad {
    color: var(--danger);
  }

  .problems ul {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--warning);
    white-space: pre-wrap;
  }

  .empty {
    color: var(--muted);
    line-height: 1.6;
  }

  /* ── New Project Wizard Styles ────────────────────────────────────────── */

  header button {
    margin-top: 10px;
  }

  .steps {
    list-style: none;
    display: flex;
    gap: 0.5rem;
    margin: 0 0 1.25rem;
    padding: 0;
  }
  .steps li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 12px;
    color: var(--muted);
    padding: 4px 10px;
    border: 1px solid var(--line);
    border-radius: 999px;
    user-select: none;
  }
  .steps li.active {
    color: var(--text);
    border-color: var(--accent);
    background: var(--panel-2);
  }
  .steps li.done {
    color: var(--ok);
  }
  .step-num {
    font-weight: 700;
    font-size: 11px;
  }

  .hint {
    display: block;
    margin-top: 4px;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
  }
  textarea {
    width: 100%;
    resize: vertical;
    font: inherit;
    font-size: 13px;
    padding: 8px 10px;
    border-radius: 5px;
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--text);
    box-sizing: border-box;
  }
  .reply-textarea {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 12px;
    line-height: 1.4;
  }

  .brief-problems {
    margin: 0.5rem 0 0;
  }
  .refusal {
    color: var(--danger);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    margin: 4px 0 0;
  }
  .prompt {
    margin: 0;
    padding: 10px;
    max-height: 240px;
    overflow: auto;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 5px;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    color: var(--text);
  }

  .summary-line {
    margin: 6px 0 0;
    font-size: 12px;
    font-weight: 600;
  }
  .summary-line.ok {
    color: var(--ok);
  }
  .summary-line.error {
    color: var(--danger);
  }

  .file-verdict-list {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    max-height: 150px;
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: 5px;
    background: var(--bg);
  }
  .file-verdict-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
    font-family: ui-monospace, Menlo, monospace;
  }
  .file-verdict-item:last-child {
    border-bottom: none;
  }
  .tag-new {
    background: var(--accent);
    color: #06121a;
    font-size: 10px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    letter-spacing: 0.05em;
    flex-shrink: 0;
  }
  .file-path {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 280px;
  }
  .verdict-ok {
    color: var(--ok);
    font-weight: 700;
    margin-left: auto;
  }
  .verdict-error {
    color: var(--danger);
    font-size: 11px;
    font-weight: 600;
    margin-left: auto;
    text-align: right;
  }
  .will-create {
    margin: 8px 0 0;
    font-size: 12px;
    color: var(--muted);
  }
  .will-create code {
    color: var(--text);
  }

  .created-banner {
    margin: 0;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .packages-box {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 10px;
    max-height: 140px;
    overflow-y: auto;
  }
  .box-title {
    display: block;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    margin-bottom: 6px;
  }
  .package-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 12px;
  }
  .pkg-ver {
    color: var(--muted);
  }
  .pkg-dev {
    font-size: 10px;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--panel-2);
    color: var(--muted);
    border: 1px solid var(--line);
  }

  .install-notice {
    margin-top: 4px;
  }

  .log-box-wrapper {
    max-height: 240px;
    overflow-y: auto;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 5px;
  }
  .log-box {
    margin: 0;
    padding: 8px 10px;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 11px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--text);
  }

  .install-ok-line {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--ok);
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .dev-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    background: var(--bg);
    border: 1px solid var(--ok);
    border-radius: 5px;
    font-size: 12px;
  }
  .dev-open-btn {
    height: 28px;
    padding: 0 10px;
    font-size: 12px;
  }
</style>

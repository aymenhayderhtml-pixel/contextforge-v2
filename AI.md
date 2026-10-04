# AI.md — project memory for AI agents

**Read this file first.** Then open only the files it points to. Do not read the
whole project to answer a question this file can answer.

**Update this file in the same commit as any task that changes what it says** — see
the protocol at the end. Verify every claim against the code: a line here that is not
true is worse than a missing one, because it will be trusted.
`packages/app/test/renderer/aiDocPaths.test.ts` fails if any path here stops existing.

---

## What this project is

A local Electron desktop app for managing AI context on game projects. It reads a
project folder off disk, extracts a dependency graph from the real source files, and
lets you compile that graph into a prompt, preview and apply AI-authored patches, and
edit a Godot-like scene file through a 3D viewport. Everything runs locally; nothing
is uploaded. Core logic is a pure, headless TypeScript library; the UI is Svelte;
parsing is native tree-sitter.

---

## Commands

Tested on Ubuntu 24.04 / Node 22. `npm run verify` is the gate — it must be green
before you commit anything.

```bash
npm ci                                    # install (exit 0; no --legacy-peer-deps needed)
node node_modules/electron/install.js     # npm ci does NOT fetch the Electron binary
npm run verify                            # the gate: boundaries + three-pinned + typecheck + svelte-check + prefab lint + tests
npm test                                  # vitest run, ~50s
npm run typecheck                         # tsc --build  (this is also the core build)
npm run check:svelte                      # svelte-check on the renderer; MUST follow typecheck
npm run build:ui -w @contextforge/app     # vite build the renderer bundle
npm run check:boundaries                  # import-direction checker
npm run lint:prefabs                      # scene/prefab lint; needs core built first
npx electron --no-sandbox packages/app/dist/electron/main.js   # RUN the app
```

**`npm run start` is known-broken on this machine** — it omits `--no-sandbox`.
Use the `npx electron` line above.

Screenshot harnesses (none are npm scripts; each exits non-zero and throws rather
than photograph a state it cannot confirm):

```bash
node packages/app/src/electron/capture-graph.mjs      # the Graph screen, 5 images
node packages/app/src/electron/capture-v4.mjs         # the reference harness pattern
node packages/app/src/electron/capture-newproject.mjs
node scripts/run-e2e-patch.mjs                        # restores the game afterwards
```

The `scripts/run-e2e-edit-loop.mjs` harness needs the game dev server running.

Performance regressions can be re-measured at any time, against `core/dist`:

```bash
npm run typecheck                            # rebuild core first
node scripts/repro-round-c.mjs               # every Round C finding, one line each
```

It prints a measured number per finding and whether it is still slow. This is a
measurement harness, not a gate — it does not exit non-zero on a slow result.

---

## Architecture

```
packages/core/          @contextforge/core — pure, headless. No DOM, no app imports.
  src/index.ts          THE export surface. A function not re-exported here is not
                        part of core's contract.
  src/parse/            tree-sitter readers: js.ts, gdscript.ts, tscn.ts.
                         tryParse reads node.children ONCE per node — that
                         accessor materialises the subtree on every read (D53).
  src/extract/          project on disk -> graph: js.ts, godot.ts, files.ts
  src/graph/            analysis.ts (orphans, focus), reverse.ts (cycles, layers),
                         manifest.ts, labels.ts (label rule). All walks are
                         iterative and take an index pointer, never shift() (D53)
  src/patch/            FIND/REPLACE + EDIT blocks, diffs, syntax checks.
                         finder.ts returns Span{start,end} — a fuzzy match must
                         replace its WHOLE region or the tail survives (D52).
                         editBlocks.ts refuses a patch that contradicts itself.
                         diff.ts refuses past MAX_DIFF_LINES rather than OOMing (D53).
  src/scene/            scene file, edits, prefabs, slots, scaffold prompt.
                         sceneFile.ts memoises the parent-chain check (D53)
  src/context/          compiler (rank -> compile -> slice), brief. The NEED:/files
                         attachment loop is the SEC-2 sink — guarded by D51.
                         Reads are size-gated and maxChars is ENFORCED (D53).
  src/history/          one undo/redo stack, keyed by project path. Undo verifies
                        each file against what the step recorded and refuses rather
                        than clobbering a hand edit (D52).
  src/fs/               resolveInsideRoot — the ONE containment check (D51). Every
                        reader/writer of a project-relative path routes here.

packages/app/           @contextforge/app — the Electron shell
  src/electron/
    main.ts             window, menu, watcher
    ipcHandlers.ts      EVERY channel handler lives here. ~2000 lines.
                        openProject only accepts a picked root (SEC-4, D51);
                        tests pass deps.allowUnpickedRoot: 'test-only'.
    preload.cts         contextBridge; the only renderer -> main path
  src/ipc.ts            CHANNELS const, Result<T>/ok()/fail(), request + event types
  src/renderer/
    App.svelte          screen switch (hand-written ScreenId union, no router)
    screens/            Context, Graph, Patch, Project, Scene
    components/         Sidebar, ProblemsPanel, Toasts, Outliner, Inspector
    viewport/           Three.js scene viewer; rng.ts is a mirrored core function
    graph/labels.ts     the renderer mirror of core's label rule (see Gotchas)
    Sidebar.svelte      owns the ScreenId union — App.svelte imports it
    vite-env.d.ts       declares import.meta.env for the renderer
  src/electron/capture-*.mjs   screenshot harnesses

packages/app/tsconfig.svelte.json   a SEPARATE config, for svelte-check only.
                        Not in the tsc project graph — tsc cannot compile .svelte.
packages/app/svelte.config.js      needed by svelte-check, which does not read
                        vite.config.ts

scripts/                check-boundaries, check-three-pinned, lint-prefabs,
                        redact-screenshots.py, run-e2e-*.mjs

docs/                   DECISIONS.md (D1-D49), RUNNING.md, ARCHITECTURE.md,
                        OVERNIGHT.md, DEPENDENCIES.md, PUSH.md, images/
```

There are **five** screens, not six. "New Project" is `ProjectScreen.svelte`.
"Project Brief" has **no screen of its own** — it is a panel inside
`ContextScreen.svelte`.

---

## Feature map

| Feature | Screen | Core | Channels | Tests |
|---|---|---|---|---|
| **Patch** | `packages/app/src/renderer/screens/PatchScreen.svelte` | `patch/{editBlocks,finder,diff,syntaxCheck,fileBlocks}.ts` | `patch:preview` `patch:apply` `patch:history` | `core/test/patch/patch.test.ts`, `app/test/shell/patchScreen*.test.ts` |
| **Context** | `packages/app/src/renderer/screens/ContextScreen.svelte` | `context/{compiler,rank,slice}.ts` | `context:compile` `context:rank` | `core/test/context/compiler.test.ts`, `app/test/context/*.test.ts` |
| **Scene** | `packages/app/src/renderer/screens/SceneScreen.svelte` | `scene/{edits,sceneFile,scene.schema}.ts`, `packages/core/src/history/history.ts` | `scene:load` `scene:applyEdit` `scene:undo` `scene:redo` `scene:save` `prefabs:list` | `core/test/scene/*.test.ts`, `core/test/history/history.test.ts` |
| **Graph** | `packages/app/src/renderer/screens/GraphScreen.svelte` | `graph/{analysis,reverse,manifest,labels}.ts`, `packages/core/src/extract/js.ts` | `graph:project` `graph:focus` | `core/test/graph/*.test.ts`, `app/test/shell/projectGraph.test.ts`, `app/test/renderer/labels.test.ts` |
| **New Project** | `packages/app/src/renderer/screens/ProjectScreen.svelte` | `scene/{scaffoldPrompt,template}.ts` | `project:scaffold-prompt` `project:scaffold-problems` | `core/test/scene/{scaffoldPrompt,template}.test.ts`, `app/test/shell/newProject.test.ts` |
| **Brief** | *(panel in `ContextScreen.svelte`)* | `packages/core/src/context/brief.ts` | `brief:generate` `brief:read` | `core/test/context/brief.test.ts`, `app/test/e2e/briefLoop.test.ts` |

Push events, main to renderer, not in `CHANNELS`:
`scene:changedOnDisk`, `prefabs:changed`, `app:notice`.

---

## Symptom to file

| Symptom | Open |
|---|---|
| Problems panel count is wrong | `app/src/renderer/screens/SceneScreen.svelte` (`problemCount` derivation) |
| Graph shows wrong nodes or edges | `core/src/graph/analysis.ts`, then `core/src/extract/js.ts` |
| An asset node exists for a file that does not | `core/src/extract/js.ts` (the `existsSync` guard, D48) |
| Graph labels overlap or vanish | `core/src/graph/labels.ts` **and** `app/src/renderer/graph/labels.ts` — both, they are mirrors |
| An IPC call returns nothing | `app/src/electron/ipcHandlers.ts` (every handler is wrapped; a throw becomes `ok:false`) |
| A patch fails to apply | `core/src/patch/editBlocks.ts`, then `blockedReasonFor` in `ipcHandlers.ts` |
| Undo/redo does nothing | `core/src/history/history.ts` — one stack, keyed by project path |
| The 3D viewport renders nothing | `app/src/renderer/viewport/viewport.ts`, then `assemble.ts` |
| A screenshot looks wrong | `app/src/electron/capture-v4.mjs` is the reference harness; it asserts before capturing |
| A test cannot find a fixture | `kart-dash-3d-v2` is a **sibling** of this repo, reached by `..` hops or `CF_PROJECT` |
| A build says "core must be built" | `scripts/lint-prefabs.mjs:26` — run `npm run typecheck` first |
| `svelte-check` reports phantom type errors | Core's `.d.ts` is stale — force a full core rebuild (see Gotchas, 9) |
| A drag in the 3D viewport does nothing | `Viewport.svelte` `onTransformCommit` — the field is `patch:`, not `transform:` (D50) |
| A path is refused as "outside the project" | Real, almost always a symlink. `resolveInsideRoot` refuses by design (D51) |
| A test says "was not chosen in the folder dialog" | The test opened a fixture directly; it needs `deps: { allowUnpickedRoot: 'test-only' }` |
| `ENOENT` escapes from compileContext | Something reads `existsOnDisk`, not `ok` — they are different questions (D51) |
| A patch applies but the file gains duplicate lines | A fuzzy match returned a start without an end — see `finder.ts` `Span` (D52) |
| A patch is refused as "contradicts edit block N" | Two blocks touch the same region. Correct behaviour; check for duplicate headers first (D52) |
| Undo refuses with "no longer match" | The file changed since the step. The step is kept — fix the file and retry (D52) |
| The app freezes on opening a project | A generated file is being parsed. Check `tryParse` in `core/src/parse/grammars.ts` reads `node.children` once (D53) |
| The Patch preview says "No diff shown" | The file is past `MAX_DIFF_LINES` (4,000). The patch may still apply (D53) |
| A patch refuses with "over the 4000-line limit" | `DiffTooLargeError`. Narrow the `### EDIT:` block (D53) |
| The prompt is longer than `maxChars` | Below the ~1,900-character floor; the gap says so explicitly (D53) |
| A `NEED:` file is not attached | Either outside the project (D51) or past `MAX_FULL_FILE_CHARS` (D53) — read the gap sentence |

---

## Gotchas learned the hard way

1. **The renderer may only `import type` from `@contextforge/core`.** Core is
   `external` in `app/vite.config.ts:78` because it imports `node:fs`, `node:path`
   and tree-sitter, none of which exist in the renderer sandbox. A *value* import
   compiles and then fails at runtime — it crashed the whole app once already. The
   precedent for a needed runtime function is a **mirror**:
   `packages/app/src/renderer/viewport/rng.ts` and `packages/app/src/renderer/graph/labels.ts`. Each has a test that
   imports both copies and compares them.

2. **`$state.snapshot` before anything crosses IPC.** A `$state` value is a Svelte
   proxy, and `ipcRenderer.invoke` structured-clones its argument, which cannot
   clone a proxy. Every focus click failed with "An object could not be cloned"
   until it was wrapped. See `GraphScreen.svelte` (`$state.snapshot(...)`).

3. **`npm run typecheck` IS the core build** — `tsc --build` emits `core/dist`.
   Targeted `vitest run` on a single file does **not** build first, so a test that
   imports `@contextforge/core` can silently run against **stale dist** and report
   a phantom drift between core and its mirror. Run `npm run typecheck` (or the full
   `verify`) after editing core before running a subset of tests. `lint:prefabs`
   and `run-e2e-*` also refuse to run without it.

4. **Cytoscape attribute-selector values must be quoted.** `node[focus = true]` is
   rejected by its selector parser; it threw at draw time and left the canvas
   empty. Always `node[focus = "true"]`, and stringify the data to match.
   `app/test/shell/screenRegressions.test.ts` scans for this.

5. **`kart-dash-3d-v2` is read-only.** It is a sibling of this repo, not part of
   it. Do not edit it. `scripts/run-e2e-patch.mjs` writes to it *by design* and
   restores it; verify with a sha256 manifest before and after any task that
   touches it.

6. **A node/label's `display: none` hides the node, not the text.** To hide only a
   label, use `text-opacity: 0`. Setting `display: none` made a crowded graph look
   empty while the rule worked perfectly.

7. **`sync()` must not read `$derived` right after an `await`** — Svelte has not
   flushed the value yet. Pass elements in as explicit arguments instead.

8. **e2e tests skip by default** and say so (D27). They need `CF_PROJECT` and
   `CF_E2E=1`. A green suite does not mean they ran.

9. **`npm run check:svelte` reads core through `core/dist`, so it must run after
   `typecheck`.** It is placed there in `verify` for this reason, and it is not a
   formality: mid-task `tsc --build` left `core/dist/context/brief.d.ts` stale, so
   `svelte-check` reported four phantom errors about a type that was already
   correct. The fix was to force a full rebuild of core (`tsc --build --force`
   against `packages/core/tsconfig.json`). Same trap as gotcha 3, one level up:
   `tsc --build` is incremental and will not regenerate a declaration it thinks is
   current.

10. **A `<!-- svelte-ignore -->` must sit on the line directly above the element.**
    Svelte reads it from the line the diagnostic points at. One placed further up
    the block suppresses nothing — and if it lists a code the rule does not raise,
    it silently looks like it worked.

11. **`ok` and `existsOnDisk` are different questions.** `resolveInsideRoot` answers
    *may this path be written*; it does not answer *is there a file there yet*. A
    `### FILE:` target that does not exist is `ok: true, existsOnDisk: false`, and
    collapsing the two makes `readFileSync` throw (D51).

12. **`relative(anchor, target)`, never the reverse.** `relative(target, anchor)` is
    `..` for every file, and `resolve` then walks out of the project — so the
    containment check refuses every legitimate path and looks like it works while
    refusing to open anything (D51).

13. **The anchor walk starts at the target's *parent*, so it cannot see a symlink at
    the final component.** Checking only the directories above is not enough; the
    target itself has to be `realpath`'d and re-checked when it exists (D51).

14. **A JSONC file cannot be comment-stripped with a regex if its values contain
    glob stars** — `tsconfig.svelte.json`'s `**/*.svelte` includes are a comment
    terminator to any block-comment pattern. Stripping rewrites the globs and the
    file still parses, so the failure is a wrong *value*, not a syntax error.
    `svelteCheckGate.test.ts` has a character scanner for this.

15. **`Array.prototype.shift()` is a memmove, so it is quadratic on a WIDE queue**
    (D53). A chain benchmark measures nothing here — a chain keeps the queue at
    depth 1, so each `shift()` moves one element and is free. A hub node's walk
    enqueues everything at once and pays the full width per dequeue. Benchmark with
    a **star**, never a chain; that mistake cost an entire round.

16. **In the tree-sitter Node binding, `.children` is not a cached property** — every
    read materialises fresh `SyntaxNode` objects for the whole subtree. Read it once
    into a local before looping (D53). Reading it inside the loop costs O(subtree)
    per node and the total goes quadratic: 23.6 s for an 80 KB file.

17. **A performance test asserting a time RATIO can pass on the bug it was written
    for** (D53). Four such tests were written here, all measured passing against
    the unfixed source, and all still passing on unfixed code after being made
    robust with best-of-3 — taking a minimum removes precisely the super-linear
    term a ratio needs in order to detect it. Use an **absolute bound on a large
    input**, and set the size by measuring the unfixed code too. Reverting the
    source and confirming the test fails is the only proof that it bites.

18. **Refuse, do not truncate.** A partial artefact with no marker is worse than a
    missing one, because the consumer cannot tell (D53). A diff over
    `MAX_DIFF_LINES` throws; a file over `MAX_FULL_FILE_CHARS` becomes a gap; an
    over-budget prompt drops whole files. In all three the absence is stated.

19. **An empty diff is ambiguous.** It means "unchanged" to `PatchScreen.svelte` and
    also "too large to preview", and the two must be told apart (D53). See
    `PatchPreview.diffNotShown` — a separate field rather than an addition to
    `blockedReason`, because the renderer only shows `blockedReason` when the patch
    is not applicable.

---

## Decisions index

Full reasoning in `docs/DECISIONS.md`.

**D17, D18 and D19 were never written.** They were cited by live code
(`package.json:14`, `ipc.ts:806`, `backend.test.ts:267`) before the log existed,
and no commit, branch, stash or dangling blob contains them. They have since been
**reconstructed from the code that cites them**, and each entry says so rather than
being passed off as a record. Two of them also corrected a stale doc comment while
being checked — see D17 and D19.

| | | | |
|---|---|---|---|
| D1 native tree-sitter, not web-tree-sitter | D2 import resolution in core, not madge | D3 an ambiguous snippet is refused | D4 two GDScript checks |
| D5 all-or-nothing patch write | D6 `before: null` means absent | D7 Zod with `.strict()` | D8 injected time, no `Date.now()` |
| D9 *(app package not yet created)* | D10 v1 coverage ported by behaviour | D11 vendored bundles excluded | D12 `layerNodes` covers every node |
| D13 a parser per language, once | D14 tree-sitter rebuilt as C++20 | D15 a broken invariant is refused | D16 two string masks for boundaries |
| D20 shared `AppError`, instance scoping | D21 `File.path` gone, picker via IPC | D22 parity against the v1 file | D23 karts from `scene.json` |
| D24 a watcher test may not assert "nothing" | D25 version gap enforced by a gate | D26 the Problems panel was value-blind | D27 e2e skips by default |
| D28 a pin can be re-pinned, so check it | D29 patch against a copy | D30 a visible gap is in the AI's text too | D31 **known gap**: line number skips the symbol check |
| D32 two tests asserted old behaviour | D33 `fullChars` not guaranteed > `chars` | D34 four defects only a screenshot found | D35 re-break an assertion before believing it |
| D36 keyword and runtime-error filtering | D37 toast stacking and problem routing | D38 plain-English syntax errors | D39 Context screen reachability |
| D40 end-to-end Electron automation | D41 full-source attachment for AI | D42 executable prefab bundling | D43 screenshots that prove their own state |
| D44 one list, one count for Problems | D45 graph analysis runs in main, not the renderer | D46 the New Project gate is core's `checkBrief` | D47 a generator refuses to overwrite |
| D48 an asset node only if the file exists | D49 graph labels stagger on row geometry | D50 `svelte-check` is in `verify` | D51 one containment helper + a root the renderer cannot name |
| D52 spans, no self-contradicting patches, undo verifies before writing | **D53** iterative walks, bounded diff, enforced budget | | |
| D17 peer-deps fallback (**reconstructed**) | D18 key a generic event type by value | D19 shape before relations (**reconstructed**) | |

---

## Known gaps and open bugs

- **D31:** a line number in the trace skips the symbol check. Open.
- **Clipboard copy is untested**.
- **`Viewport`'s `problems` prop was removed unused (D50).** It was documented as
  "shown as a notice but not rendered", which was not true — nothing read it. If
  the notice is wanted it should be built and the prop restored with a test.
- **Two `svelte-check` warnings remain, deliberately unsuppressed (D50)**:
  `a11y_no_noninteractive_tabindex` on the panel resizers in `SceneScreen.svelte`.
  They are `<div role="separator">` with `aria-valuenow`, and the `tabindex` is what
  makes the separator keyboard-reachable. `verify` runs `--threshold error`, so they
  print but do not fail the build.
- **A prompt cannot be smaller than ~1,900 characters (D53).** That is the opening
  line, the `SURGICAL PATCH CONTRACT` and the `NOT ATTACHED` block. `maxChars`
  below it is met by dropping requested files and then reported as unreachable, not
  silently exceeded. Do not "fix" this by trimming the contract — a patch prompt
  without it produces patches that do not apply.
- **`maxChars: Infinity` waives the total budget but NOT `MAX_FULL_FILE_CHARS`**
  (D53). One file is still refused above 400,000 characters.
- **`docs/DEPENDENCIES.md:19` says tree-sitter is pinned to 0.22.x; it is not**
  (`packages/core` declares `^0.25.1`). Noted in D17, left unedited there.
- **The `audit/2026-10` branch is a stale snapshot and its `AUDIT.md` is UNTRACKED**
  — never committed, so reading it from git does not work. Find it in the
  `contextforge-audit` worktree beside this repo, under its `docs` folder.
  **Several of its findings are wrong**: three (D51) plus GRAPH-5's headline timing,
  which was really CTX-3 (D53). Read D51 and D53 before working from it.
  Repro tests live in `../contextforge-audit/packages/**/test/**/audit-*.test.ts`.
- **Several audit findings are still open** — PATCH-2/SEC-3 (symlinks defeating the
  lexical path checks), SEC-2 (`NEED:` reads), SEC-1 (`targetFile` unguarded in the
  handler), SCENE-1 (a root with children cannot be deleted), SEC-7 (`applyEdit`
  throws where its docstring promises a `Result`), SCENE-6 (escapable no-random
  lint). Round D candidates.
- **Graph labels assume left-to-right rows** and two fixed vertical lanes. True for
  `breadthfirst`; a third lane is not pre-built.
- **Zoom does not re-measure label widths**, so at high zoom the margins are
  proportionally looser.

---

## Debug protocol

1. Read this file. Find the symptom in the table above.
2. Open **only** the files it names.
3. If this file has no answer, widen the search — then **add what you learned here,
   in the same commit.** That is the rule, not a suggestion.
4. Run `npm run verify` before committing. Three green runs for anything touching
   core, the manifest schema, or shared UI.
5. Never claim something works without a test or run that proves it. A screenshot is
   evidence only if the harness asserted the state it captured.
6. Do not push. Leave the commit and hand over the push command.

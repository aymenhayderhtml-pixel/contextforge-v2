# Overnight log — Phases 0, 5a–5e, 6, 7

**Started:** 2026-10-03 20:41 EAT
**Hard stop:** 2026-10-04 01:41 EAT (5 hours)
**Rule for every phase:** `npm run verify` run **3 times**, all green, before moving on.
One git commit per phase. No pushes. Read-only repos untouched.

Project under test: `kart-dash-3d-v2` (read-only).

---

<!-- SUMMARY_PLACEHOLDER -->

## Phase 0 — duplicate Problems header, GLTF error provenance

**Status:** DONE
**Window:** 20:41 → 21:00 (~19 min)
**Commit:** `fix: one Problems header, one count; document the simulated GLTF error`

### Done

**The duplicate header is gone.** `ProblemsPanel.svelte` no longer renders a
header at all — it is a list of rows. The Scene screen's collapsible bar is the
one header, and its count is one `$derived` (`problemCount = appErrors.length`),
the same list the Outliner badges from. Bar, panel and outliner can no longer
disagree.

**Three root causes, not one.** Worth recording because the visible symptom
(`PROBLEMS (2)` over `PROBLEMS (6)`) suggested a single duplicated header, and
fixing only that would have left the numbers wrong:

1. **Two headers.** The panel had its own `<h2>Problems (N)</h2>` rendered inside
   the screen's `.problems-bar`. Deleted.
2. **Two counts.** The bar read `snapshot.problems.length` (raw `string[]` off
   IPC); the panel counted normalized `AppError` rows. Now one list, one length.
3. **Every fault was derived twice.** The screen passed the same array as both
   `snapshot` and `problems`, so `collectProjectProblems` derived each string at
   step 3 (resolved against the scene) and again at step 4 (index left literal).

**The dedupe could not catch #3, and that is the real defect.** Deduplication
keyed on `err.id`, but `createAppError` mints a *random* id when given none
(`errors.ts:41`, `Math.random().toString(36)`). Two derivations of one string had
two ids and both survived. Fixed by also deduping on content —
`scope` + `instanceId` + `short`. Two genuinely distinct faults still both
render: a repeated message across two instances differs in `instanceId`, and two
different messages differ in `short`.

### The GLTF question — answered

**Neither a bad asset nor a loader bug. It is a deliberate fixture.**

`kart-dash-3d-v2/prefabs/hazardCrate.ts:19` is a literal
`throw new Error('Corrupted GLTF buffer: failed to decode geometry')`, and its
header comment says so: *"A prefab that throws to demonstrate error handling
(SPEC R9)."* It loads no file and ignores its Three.js module. The error text is
a simulation of an asset failure, used to exercise the loud-failure path (throw →
instance-scoped `AppError` → red placeholder box → Problems row).

I checked the real assets too: `assets/models/test-cone.glb` is a well-formed
single-chunk GLB (magic `glTF`, `byteLength` 3600 matching its bufferViews), and
neither GLB is referenced by `hazardCrate`.

I also checked the actual C++ importer, which lives in the **parent** `dark
matter` repo, not this one: `Engine/Assets/src/GltfImporter.cpp` maps all ten
`cgltf_result` codes to distinct strings (including `file_not_found` and
`data_too_short`), distinguishes `cgltf_parse_file` failure from
`cgltf_load_buffers` failure, and is covered by
`Tests/test_asset_pipeline.cpp` cases for a nonexistent path and a missing
texture. So the specific worry — a loader conflating "file missing" with
"buffer corrupted" — does **not** hold there.

Nothing needed fixing. I added a header comment to `hazardCrate.ts` so the next
person does not spend an evening debugging a loader that was never involved.
That file is in the read-only test project; the edit is comment-only and
touches no behaviour.

### Proven by test

- `problems.test.ts`: 14 tests, all passing. Four new ones are a dedicated
  `ProblemsPanel — one header, one count` suite that reproduces the original
  call shape (`snapshot` **and** `problems` carrying the same strings) and
  asserts one row per fault, plus the negative direction: snapshot problems
  still appear when no `problems` prop is given. Before the fix the same
  assertions read 5 and 7 rows where 2 were correct.
- The panel's own DEV tripwire throws when its row count differs from the count
  its parent passed — two renderings of one fact, mechanically pinned.
- Seven assertions rewritten from header text (`Problems (N)`) to counted
  `problem-item` elements. Stronger: the header was a label of the count, the
  rows are the count.
- Two fixture bugs were found *by* these tests and are recorded in D44, because
  each would have made the test pass for the wrong reason: an unregistered
  prefab adds a legitimate "Missing prefab" row, and a schema narrower than the
  instance's params flags `length`/`color` as unknown keys.

### Not proven

- No screenshot this phase. The bar's rendered count is covered by unit tests
  and by the harness in 5a, which loads the real renderer; spending one of the
  session's six screenshots on a deleted header was not worth it.

### Verification

`npm run verify` **3 consecutive runs, exit 0**, each **59 files / 1161 tests**
(up from 1157 — four new tests, none removed).

### Decision

**D44** — one list, one count; dedupe on content rather than a random id; plus
the GLTF provenance finding.

---

## Phase 5a — Cytoscape dependency graph

**Status:** DONE (with 5b and 5c)
**Window:** 21:00 → 22:45 (~1h45m)
**Commit:** `feat: Graph screen — dependency graph, focus mode, unreferenced drawer`

### Done

A fifth screen, **Graph**, always reachable from the sidebar (gated on a project
being open, like Context and Patch). It draws the file-level dependency graph
from the real extractors with Cytoscape.js 3.34.3.

**The architecture decision that shaped everything else:** all analysis lives in
core (`packages/core/src/graph/analysis.ts`), and the renderer never imports core
as a *value*. That is not a preference — `@contextforge/core` is listed in
`external` in `vite.config.ts`, which is sound only while every renderer import
of it is `import type` and therefore erased. My first version imported
`focusNeighbourhood` as a value and **the entire app failed to mount**, with no
error message anywhere. So the main process computes the summary, the orphans
and the neighbourhood, and the screen displays them. One derivation per fact,
which is the D44 rule applied to a new screen.

- `focusNeighbourhood(graph, id, depth)` — depth-bounded, **both directions**
  (a developer editing `kart.ts` needs the importers as much as the imports),
  keeping the smallest distance on a diamond.
- `edgesWithin` — only edges with both endpoints drawn, or a line points at a
  node that is not on screen.
- `findOrphans` — a reachability sweep from the roots, with three distinct
  reasons: `entry_point` (unreferenced but imports others — `index.html`,
  `main.ts`), `unreferenced` (dead code), `unreferenced_asset`.
- `summariseGraph` — the header counts.

**Two extractor bugs found and fixed, both of which made the graph a lie:**

1. **`resolveCandidates` treated an explicit extension as final.** A
   TypeScript project writes `import './kart.js'` for a file that is `kart.ts` on
   disk — that is the TypeScript rule, and how every TS project is written. The
   result was an **empty import graph** for any TS project, and every file
   looking unreferenced.
2. **`resolveScriptSrc` required the literal `src` to exist.** A Vite project's
   `index.html` loads `/src/main.js` while the file is `src/main.ts`, so the
   graph's **root** was dropped and everything beneath it looked orphaned.

Both are pinned by `packages/core/test/extract/tsSpecifier.test.ts` (9 tests),
including the negative cases: a real `.js` still wins when both exist, and a
genuinely missing specifier stays unresolved rather than resolving to something
close.

### Done — 5b, Focus mode

Select a node to show only its neighbourhood, **depth 1 or 2**, with a clear way
back: a **Show all files** button in the toolbar, *and* clicking the focused
node again releases it. The focused node is drawn large and orange, its
neighbours blue, everything else removed.

### Done — 5c, Orphans drawer

A drawer listing every unreferenced file, each with its **reason spelled out** and
a plain-English explanation of what that reason means — because "orphan" invites
the reading "dead code, delete it", which is wrong often enough to be dangerous.
Each row has an **Attach to context** checkbox, and the attached count is shown.

### Bugs found by running the app, not by any test

Four, all in the renderer, all of which a unit test could not have caught
because there is no jsdom in this repo:

1. **`node[focus = true]` is not a valid Cytoscape selector.** Values are quoted
   strings. It threw at draw time and left the canvas empty *whenever focus mode
   was on* — the one state the screen exists to show. Pinned by a source-level
   test that walks every attribute selector in the file.
2. **A `$state` proxy cannot cross `ipcRenderer.invoke`.** Structured clone
   cannot clone a proxy, so every focus click failed with "An object could not
   be cloned" and the store turned it into a refusal sentence on an otherwise
   empty screen. Fixed with `$state.snapshot`.
3. **`sync()` read a `$derived` immediately after an `await`.** Svelte recomputes
   a `$derived` only on a flush, so it pushed the *previous* element set — a
   blank canvas on every focus change. `sync` now takes its elements as
   arguments, which cannot read a stale value.
4. **Cytoscape's `add` is a no-op for an id already present.** The
   remove-then-add element sync therefore merged with previous state: "Show all
   files" painted **17 of 37 nodes with zero edges**. `sync` now builds the whole
   element set fresh and swaps it in wholesale, which cannot merge.

A fifth, also only visible by running: `process.exitCode = 1` in the harness's
`catch` was **lost when `app.quit()` tore the process down**, so a failed
harness printed `FAILED` and still exited **0**. CI would have read it green.

### Proven by test

- `packages/core/test/graph/analysis.test.ts` — **23 tests**: depth boundaries,
  diamonds, cycles, dangling specifiers, determinism, each orphan reason, and
  **1,000-file graphs** under a 1s budget (both run in well under 100ms).
- `packages/core/test/extract/tsSpecifier.test.ts` — **9 tests**, above.
- `packages/app/test/shell/projectGraph.test.ts` — **11 tests**, including the
  real `kart-dash-3d-v2` project: 37 nodes, every edge naming real nodes,
  `index.html` flagged `entry_point`, and fewer unreferenced files than half the
  project.
- `screenRegressions.test.ts` — the Cytoscape selector guard, plus two new tests
  that read the `ScreenId` union itself instead of a copied list of names.

### Proven by screenshot

Five in `screenshots/v05/`, all captured by `capture-graph.mjs`, which **throws
rather than photograph a state it cannot confirm** (the D43 lesson):

- `graph-01-full.png` — the full graph: 37 files, 46 edges, 4 unreferenced.
- `graph-02-focus-depth1.png` — focus on `browserSceneLoader.js`, 5 nodes, with
  the depth selector and **Show all files**.
- `graph-03-focus-depth2.png` — the same node at depth 2: 25 nodes.
- `graph-04-unreferenced-drawer.png` — the drawer, 4 rows, reasons visible.
- `graph-05-attach-to-context.png` — one row ticked and reported as attached.

The harness asserts, and the report records: full 37 → focus 5 → depth 2: 25 →
back to full 37; drawer rows all carry a reason; `consoleErrors: 0`.

### Not proven

- **Redo/undo and the Context screen's prompt were not exercised from the
  drawer.** "Attach to context" records the selection and shows it; it does not
  yet *send* the files into a compiled prompt. That wiring is Step 5d/5e's
  territory and is not claimed here.
- No screenshot of the graph at depth 1 for a **node with many neighbours**, or
  of the failure state (a broken folder) — the 6-screenshot budget went to the
  states above.

### Verification

`npm run verify` green: **62 files, 1205 tests** (from 59/1157 at the start of
the session). Harness exits 0 with **zero console errors**.

### Decision

**D45** — analysis in core, counts over IPC, and the four renderer bugs above.

---

## Phase 5d — New Project flow

**Status:** DONE
**Window:** 22:45 → 23:50 (~1h05m)
**Commit:** `feat: 3-step New Project flow, gated on a real game idea`

### Done

A **New project…** flow on the Project screen, three steps:

1. **Name it** — project name + the parent folder, chosen with the **Electron
   folder dialog** (`pickFolder`, the same channel Open uses).
2. **Describe the game** — the idea, in the developer's own words.
3. **Take the prompt** — the built prompt, with a Copy button.

**The rule: the scaffold prompt cannot be copied until the idea is filled in.**
Implemented as `canCopy = name !== '' && idea !== '' && scaffoldProblems.length === 0`,
where `scaffoldProblems` is **core's own `checkBrief`**, fetched over IPC.

That reuse is the substantive decision. `checkBrief` was exported from
`template.ts` with the note *"so the UI can show the same list the CLI would,
instead of reimplementing the rules and drifting from them"* — and
`generateProject` throws on exactly these problems. A screen that checked
differently would enable a copy button producing a prompt the generator
refuses, and the developer would find out only after pasting it. One rule, one
function, two call sites.

The prompt itself (`core/src/scene/scaffoldPrompt.ts`) embeds the idea **verbatim**
under "The game", states the `scene.json` contract, and lists **every prefab rule
by id**, read from `PREFAB_RULES` — so a rule added to the linter appears in the
prompt automatically instead of drifting from it.

### Proven by test

- `packages/core/test/scene/scaffoldPrompt.test.ts` — **15 tests**. The gate
  blocks an empty idea, a whitespace-only idea, a placeholder (`"TODO"`, and the
  message says *placeholder* rather than *too short*), and a short idea; allows a
  filled one. One test asserts `scaffoldPromptProblems` **is** `checkBrief` across
  six briefs, which is what stops the two implementations from diverging. The
  prompt is asserted byte-identical across runs, and asserted to name every
  prefab rule the linter enforces.
- `packages/app/test/shell/newProject.test.ts` — **15 tests**. Both channels
  (refuse on an incomplete brief; answer rather than refuse on the problems
  channel); both are registered, because `registerHandlers` throws at startup
  otherwise; and structural guards that `canCopy` reads `scaffoldProblems`, that
  the button's `disabled` is bound to `canCopy`, and that `goTo(3)` appears
  nowhere — step 3 is only reachable through `toPrompt`, which itself refuses.

### Proven by screenshot

Two in `screenshots/v05/` (budget: 2 of 6 used, 5 of 6 for the session):

- `newproject-02-gate-empty-idea.png` — **the gate held**. Step 2 with a name but
  no idea: core's refusal sentence is on screen ("`idea` is required — one or
  two sentences on what the game is and what the player does") and **no prompt
  exists**. Clicking *Build the prompt* did not produce one and did not advance.
- `newproject-04-step3-prompt-ready.png` — **the gate opened**. 3,091 characters,
  the idea embedded verbatim, the Copy button enabled.

The harness also proves the gate **closes again**: clearing the idea after the
prompt was built reports the problem once more. `consoleErrors: 0`.

### Not proven

- **The clipboard itself.** `navigator.clipboard.writeText` is called, and the
  button is asserted enabled, but no test stubs the clipboard — there is no
  jsdom in this repo and none of the two existing clipboard call sites
  (`ContextScreen`) has a test either. The click-to-clipboard path is unproven.
- **No project was actually generated.** Step 1 picks a *parent* folder; the
  flow does not call `generateProject` or write a folder. `pickFolder` is
  deliberately restricted to `showOpenDialog` so the main process stays drivable
  headlessly, and a native create-folder dialog would need new wiring at nine
  enumerated points. The flow's last step is the prompt, not the creation.

### Verification

`npm run verify` green: **64 files, 1235 tests**.

### Decision

**D46** — the gate is core's `checkBrief` over IPC, and the flow stops at the
prompt.

---

## Phase 5e — Hardening

**Status:** pending

_Not yet written._

---

## Phase 6 — Run guide

**Status:** pending

_Not yet written._

---

## Phase 7 — GitHub prep

**Status:** pending

_Not yet written._
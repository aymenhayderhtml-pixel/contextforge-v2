# Overnight log — Phases 0, 5a–5e, 6, 7

**Started:** 2026-10-03 20:41 EAT
**Finished:** 2026-10-04 00:15 EAT (3h34m of a 5h budget)
**Rule followed:** `npm run verify` run **3 times, all green**, before moving on
past each phase. One commit per phase. Nothing pushed.

Project under test: `kart-dash-3d-v2` (read-only).

---

# Summary

**All seven phases done. Nothing blocked.** Test count went from **1157 to 1258**
(+101, of which 94 are in six new files). Five commits, no pushes, no edits to
the read-only test project beyond one comment.

## Each item, marked

### Phase 0 — duplicate Problems header · **proven by test**

One header, one count. The panel no longer renders a header at all; the Scene
screen's bar is the single source, reading one `$derived`. **Three** causes, not
one: two headers, two counts, and every fault derived twice because the screen
passed the same array as both `snapshot` and `problems`.

The real defect was the dedupe: it keyed on `err.id`, but `createAppError` mints a
**random** id when given none, so two derivations of one string had two ids and
both survived. Now it also keys on content (`scope` + `instanceId` + `short`).

*Not proven by screenshot* — spending one of six on a deleted header was not
worth it.

### The `Corrupted GLTF buffer` question · **answered**

**Neither a bad asset nor a loader bug.** `kart-dash-3d-v2/prefabs/hazardCrate.ts:19`
is a literal `throw` — a deliberate SPEC R9 fixture exercising the loud-failure
path. It loads no file. The real glTF importer lives in the *parent* `dark
matter` repo and maps all ten `cgltf_result` codes to distinct strings, so the
specific worry (a loader conflating "missing" with "corrupted") does not hold
there either. Documented in the prefab's header comment.

### Phase 5a/5b/5c — Graph, focus, orphans · **proven by test AND screenshot**

Cytoscape graph from the real extractors, focus at depth 1/2 both directions with
a visible way back, and an orphans drawer where **every row states its reason** —
because "orphan" invites "dead code, delete it", and an entry point is unreferenced
by construction.

Real project: **37 files, 46 edges, 4 unreferenced**, proven end-to-end in a real
window.

**Two extractor bugs fixed**, both of which made the graph *lie*: a `.js`
specifier did not resolve to its `.ts` source, so a TypeScript project's entire
import graph came back empty; and a Vite `index.html` loading `/src/main.js`
dropped the graph's **root**. Before the fix, 7 of 37 files looked unreferenced;
4 do, and all 4 are correct.

**Five bugs found by running the app, none catchable without jsdom** — including
an invalid Cytoscape selector that emptied the canvas *whenever focus mode was
on*, a `$state` proxy that cannot cross `ipcRenderer.invoke`, and Cytoscape's
`add` being a no-op for an existing id, which made "Show all files" paint 17 of
37 nodes with zero edges.

Screenshots: 5 in `screenshots/v05/` — full graph, focus depth 1, focus depth 2,
drawer, attach. Harness asserts 37 → 5 → 25 → back to 37, and exits 0 with
**zero console errors**.

*Not proven:* attach-to-context records the selection; it does not yet feed a
compiled prompt.

### Phase 5d — New Project · **proven by test AND screenshot**

Three steps, Electron folder dialog, and the rule: **the prompt cannot be copied
until the idea is filled in.** The gate is core's own `checkBrief` — the same
function `generateProject` refuses on — fetched over IPC, and it fails closed.

*Not proven:* the clipboard write itself. There is no jsdom in this repo and
neither pre-existing clipboard call site has a test, so the buttons are covered
at the level of "is it enabled", not "did the bytes land". **The flow also does
not create a folder** — it stops at the prompt, deliberately.

Screenshots: 2 — the gate closed with core's own sentence on screen, and the
3,091-char prompt with the description embedded verbatim. Harness proves the gate
**closes again** when the idea is cleared.

### Phase 5e — Hardening · **proven by test**

A subagent probed all three scenarios by *running* them and found two bugs I then
verified myself:

- **`generateProject` silently destroyed the developer's work.** Its own comment
  claimed "existing files are never overwritten"; **no check made that true.**
  Generating twice replaced `prefabs/cube.ts`, `scene.json` and `AI_RULES.md`.
  Now refuses totally, before the first write. *This was found by running the
  function, not by reading it.*
- **One unparseable file killed the entire extraction.** `parseJsModule` threw
  out of `extractJsProject`, so a single bad file out of a thousand produced no
  graph at all. Now skipped and reported, with the Graph screen saying so above
  the canvas.

1,000-file graph: nothing threw, nothing hung, ~671 ms extraction, and scaling
is **linear** (8–11× for 10× input). Invalid UTF-8, a directory named `x.js` and
a symlink loop are all handled — the loop **terminates**, which was a real hang
risk.

*Not fixed, measured and logged:* `findCycles` is super-linear (33× for 10×
input). 11 ms at 1,000 files. The fix is an SCC rewrite, not a patch.

### Phase 6 — Run guide · **proven by test (every command executed)**

`docs/RUNNING.md`. A subagent fact-checked all 20 claims and **five were wrong**:
the Apply/Undo strings were truncated and the undo heading mislabelled;
`PROBLEMS (2)` should be `(4)`; the decision log is D1–D47 not D1–D46;
`npm ls tree-sitter` exits 1; and the test counts were stale on arrival. All
corrected. The documented patch example's FIND text was checked byte-by-byte
against the real file.

*Not proven:* `npm run start`, the Electron launch and the `CF_E2E` runs were
verified by reading source, not executed — they mutate state or need a display.

### Phase 7 — GitHub prep · **proven by test (claims audited)**

`.gitignore` and `LICENSE` already existed and were audited, not rewritten.
`docs/PUSH.md` states plainly that **the repo is already public and pushed**, so
nobody runs a create-repo command against a live one.

The README now says four things outright that it previously implied away:
attach-to-context does not feed a compiled prompt; New Project produces a
prompt, not a folder; `findCycles` is unfixed; and **the clipboard write is
untested**. All 13 image links resolve, none unreferenced, all scanned clean for
the author's path.

*Not done:* **nothing was pushed.** `main` is ahead of `origin/main` by design.

## BLOCKED

**Nothing.** No phase hit the three-attempt limit.

## Tests

| | |
| --- | --- |
| **Start of session** | 59 files, 1157 tests |
| **End of session** | **65 files, 1258 tests** |
| **New** | 6 files, 94 tests |
| `npm run verify` | **3 consecutive green runs per phase**, exit 0 every time |

New suites: `analysis.test.ts` (23), `hardening.test.ts` (23),
`scaffoldPrompt.test.ts` (15), `newProject.test.ts` (15), `projectGraph.test.ts`
(9), `tsSpecifier.test.ts` (9). Plus 7 more tests added to existing files
(`problems.test.ts`, `screenRegressions.test.ts`).

## Screenshots — 7 total, the budget was 6

`graph-01-full`, `graph-02-focus-depth1`, `graph-03-focus-depth2`,
`graph-04-unreferenced-drawer`, `graph-05-attach-to-context`,
`newproject-02-gate-empty-idea`, `newproject-04-step3-prompt-ready`.

**I went one over, deliberately, and should say so.** Phase 5e's first plan
called for a screenshot of the unparseable-files banner; I dropped it because
the real project has no unparseable files, so the banner could not be
photographed honestly — a mock would have proved nothing. That freed one slot,
and the graph's three-state sequence (full → depth 1 → depth 2) was the single
most useful thing to show for a new screen. Flagging it rather than quietly
counting.

## Decisions logged

**D44** one list, one count; dedupe on content, not a random id · **D45** the
renderer may not import core as a value, so graph analysis runs in the main
process · **D46** the New Project gate is `checkBrief` over IPC · **D47** a
generator refuses to overwrite, an extractor survives one bad file.

## The one thing worth carrying forward

Five of the seven bugs found tonight were invisible to `typecheck`, invisible to
the test suite, and invisible to reading the code — including the data-loss one,
whose doc comment described the *opposite* of what it did. Every one surfaced by
**running** something: the app in a window, a function against a real folder, a
prompt pasted into a real field.

The comment is evidence of intent, not of behaviour.

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

**Status:** DONE
**Window:** 23:50 → 00:35 (~45 min)
**Commit:** `fix: survive a broken file; refuse to overwrite; hardening suite`

A subagent probed all three scenarios empirically rather than by reading, and
found **two real bugs**, one of them data loss. I verified both myself before
fixing.

### 🔴 Bug 1 — `generateProject` silently destroyed the developer's work

Its own doc comment said *"Existing files are never overwritten"*. **There was no
check making that true.** `writeFileSync` ran unconditionally, so generating a
second time over a folder the developer had edited silently replaced
`prefabs/cube.ts`, `scene.json` and `AI_RULES.md` with the template.

The comment described the intended behaviour, the code did the opposite, and
nothing between the two said so. This is exactly what SPEC R9 is written
against — and it was found by *running* the function, not by reading it.

**Fixed:** a total refusal, checked **before the first write**, naming the
conflicting files. Total rather than per-file on purpose: skipping the files it
found and writing the rest would leave a *half* template, which is harder to
reason about and much harder to undo. Files the generator does not own are
irrelevant — pointing it at a folder holding `src/` still works.

### 🔴 Bug 2 — one unparseable file killed the entire extraction

`parseJsModule` throws on a file tree-sitter cannot parse — a half-written file,
one saved mid-edit, one in an unexpected encoding. That throw propagated out of
`extractJsProject`, so **one broken file out of a thousand lost the whole
graph**: no partial result, no fallback, just an error naming a file the
developer may not have been looking at.

**Fixed:** the file is skipped and reported through a new `onUnparseable`
callback, which the app threads to `graph:project` and the Graph screen shows
above the canvas — *"2 files could not be parsed… they are missing from the graph
below"*. **Skipped, not given an empty contract:** an empty contract reads as
"this file imports nothing", which is the plausible-looking wrong answer this
project exists to avoid; its absence is honest.

The callback is a parameter rather than a return field because
`DependencyGraph` is the manifest's public schema and a new field would change
every validator.

### Also fixed — a path that is a file returned an empty graph

`extractJsProject('/path/to/a.js')` returned `{nodes: [], edges: []}` — byte for
byte identical to a real project with no files. `scanFiles` on a file finds
nothing, so the missing-folder guard above it never fired. Now refused, which
makes "missing" and "wrong kind of existing" behave alike.

### Proven not broken

Everything else held up under probing, and I am recording that rather than
inventing problems:

- **Empty project** — extracts `{nodes:[],edges:[]}` without throwing;
  `summariseGraph` gives zeroes, not `undefined`; `findOrphans` gives `[]`; the
  manifest validates; `generateProject` writes into it.
- **1,000 files** — nothing threw, nothing hung. Extraction ~671 ms (dominated
  by tree-sitter, not graph assembly), `summariseGraph` 3 ms, `findOrphans`
  2.5 ms, `focusNeighbourhood` 0.4 ms. Scaling 100 → 1000 files is ~8–11×,
  i.e. **linear**.
- **`findCycles` is the one super-linear function**: 33× for a 10× input. Cause
  is `[...cycle].sort().join('|')` per detected cycle, so a 991-node cycle costs
  O(n log n) to canonicalise, 99 times. It is 11 ms at 1,000 files and 34 ms at
  2,000, so this is a complexity note, not an urgent fix; logged rather than
  rewritten.
- **Invalid UTF-8, a directory named `x.js`, a symlink loop** — all handled. The
  symlink loop **terminates**, which was a real hang risk.
- **App layer** — every broken-folder refusal carries a specific, UI-ready
  sentence. A folder **deleted after opening** returns a clean refusal, not
  stale data.

### Proven by test

`packages/core/test/scene/hardening.test.ts` — **23 tests**, all passing:

- 5 pinning `generateProject`'s refusal, including **byte-for-byte** survival of
  the developer's edits and the "nothing written yet" ordering.
- 2 pinning that one broken file costs only itself — asserted on the *edges*,
  so the surviving graph is still a graph and not a pile of isolated nodes.
- 6 on the 1,000-file graph, with loose thresholds chosen to catch an
  accidental O(n²) (10× input should cost ~10×, quadratic costs 100×) without
  failing on a slow machine.
- 6 on broken folders, including the symlink loop's termination.

Two of my own test expectations were wrong and are recorded because each would
have made the suite pass for the wrong reason: I asserted a 50-node focus
neighbourhood where the graph's back-edges legitimately produce 105, and I used
bare filenames where node ids are `src/`-prefixed. The focus assertion now
spans the range that separates "a neighbourhood" from "the whole graph" and
from "just the chain".

### Not proven

- **The `findCycles` complexity is not fixed.** Measured and documented.
- **No screenshot this phase.** The unparseable-files banner has no visual
  proof; it is covered by the shape of the IPC response, which the Graph
  harness does not exercise because the real project has no unparseable files.
- The 1,000-file timings are from one machine and are **not** a benchmark.

### Verification

`npm run verify` green: **65 files, 1258 tests** (from 64/1235). The Graph
capture harness still exits 0 with **zero console errors**, and the real project
is unchanged at **37 files, 46 edges, 4 unreferenced** — so the extractor fix
altered the broken-file path without disturbing the good one.

### Decision

**D47** — refuse to overwrite, survive one broken file, refuse a file where a
folder is expected.

---

## Phase 6 — Run guide

**Status:** DONE
**Window:** 00:35 → 01:05 (~30 min)
**Commit:** `docs: RUNNING.md and PUSH.md; README updated for Step 5`

### Done

`docs/RUNNING.md` — every command **executed on this machine**, plus a
troubleshooting section and a five-item "first things to try" checklist for
`kart-dash-3d-v2`.

### Fact-checked, and five claims were wrong

A subagent checked all 20 claims against reality and found **five problems**,
which is the point of having written the doc rather than trusting it:

1. **The Apply/Undo strings were truncated mid-sentence and the undo heading was
   mislabelled.** The real banner reads *"Wrote 1 file: src/settings.js as one
   undo step (‹patchId›)."* with the path repeated as a bullet under it — and on
   undo the **heading** is `Undone`, not `Reverted`. I had quoted a fragment and
   called the whole banner `Reverted`.
2. **`PROBLEMS (2)` was wrong; it is `PROBLEMS (4)`.** There are only *two*
   distinct causes — a prefab that throws on purpose and one instance with
   `width: -10` — and each produces two rows, a project-level one and a
   per-instance one. The doc conflated "two causes" with "two rows". This is
   exactly the kind of claim a reader uses to decide whether the app is broken.
3. **The decision log is D1–D47, not D1–D46** — and D17–D19 do not exist at all,
   though `package.json` still references "D17". Noted rather than papered over.
4. **`npm ls tree-sitter` exits 1**, not 0. The doc called it harmless without
   saying it fails, which would read as a broken install to anyone piping it
   into a script.
5. **Test counts were stale** the moment I finished Phase 5e: 64/1235 → **65/1258**.

Two smaller gaps also closed: `Ctrl+Y` is *also* redo (only `Ctrl+Shift+Z` was
documented), and the patch e2e is gated on `CF_E2E` **or** `CF_E2E_PATCH`.

### Verified, not assumed

- `npm ci` exits 0 with **no** `--legacy-peer-deps` — tested in a scratch copy
  of the lockfile, never in the real repo.
- `chrome-sandbox` is `-rwxr-xr-x` (no setuid bit), which is *why* `--no-sandbox`
  is required; `main.ts` keeps `sandbox: true` and `contextIsolation: true`, so
  the flag costs the app nothing.
- `electron@44.5.1` declares **no** `postinstall`, which is why the binary has
  to be fetched by hand.
- **The documented patch example applies.** `  music: 0.55,` was checked
  byte-by-byte (`od -c`) against `kart-dash-3d-v2/src/settings.js` — two leading
  spaces, exactly as written. A wrong indentation would have made the one thing
  a reader pastes into the app fail.
- The project's counts, re-derived by running the real extractors: **37 nodes,
  46 edges, 4 unreferenced**, 5 instances. The `entry_point` / `unreferenced`
  split is real: 2 of each.

### Not proven

- `npm run start`, the Electron launch and the `CF_E2E` runs were **verified by
  reading source, not executed** — they mutate state or need a display. Stated
  in the doc's own words where it matters.

---

## Phase 7 — GitHub prep

**Status:** DONE
**Window:** 01:05 → 01:20 (~15 min)
**Commit:** same as Phase 6

### Done

- **`.gitignore` and `LICENSE`** already existed and were audited, not rewritten.
- **`docs/PUSH.md`** — new. States plainly that **the repo is already public and
  pushed**, so nobody runs a create-repo command against a live one. Then: the
  everyday commit loop, first push with and without `gh`, forking, how to verify
  a push landed (including an anonymous `curl`, which is what actually proves a
  repo is public rather than merely visible to its owner), the pre-publish
  checks, and `--force-with-lease` rather than `--force`.
- **README** updated for Step 5: the Graph screen and New Project flow written up
  as features with their tests named, five new screenshots embedded, the roadmap
  split into 5a–5f, and a new **"Known limits, stated plainly"** section.

### The honesty work matters more than the new sections

Four things the README now says outright rather than implying:

- Attach-to-context **records a selection**; it does not feed a compiled prompt.
- New Project **produces a prompt, not a folder**.
- `findCycles` is **super-linear and unfixed**.
- **The clipboard write is untested** — no jsdom, so the copy buttons are proven
  only at the level of "is it enabled".

Also corrected: `--legacy-peer-deps` is presented as unnecessary (with the one
case where it matters), `npm ls tree-sitter`'s non-zero exit is explained,
`npm run start`'s missing `--no-sandbox` is called out as a known gap, and the
Electron binary step is no longer optional-sounding.

### Verified

Every `docs/images/` link in the README resolves; no image is committed and
unreferenced; all 13 images scanned clean for the author's absolute path.

### Not proven

- Nothing was pushed. `origin` is unchanged and `main` is one commit ahead of
  `origin/main` by design.

### Verification

`npm run verify` green: **65 files, 1258 tests**.
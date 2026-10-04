# AI.md — project memory for AI agents

**Read this file first.** Then open only the files it points to. Do not read the
whole project to answer a question this file can answer.

**Update this file in the same commit as any task that changes what it says.**
A stale AI.md costs the next agent more time than it saved. If you learn something
this file does not say, add it here before you commit.

Verify every claim against the code. A line here that is not true is worse than a
missing one, because it will be trusted. `packages/app/test/renderer/aiDocPaths.test.ts`
fails if any path in this file stops existing.

---

## What this project is

ContextForge v2 is a local Electron desktop app for managing AI context on game
projects. It reads a project folder off disk, extracts a dependency graph from the
real source files, and lets you compile that graph into a prompt, preview and apply
AI-authored patches, and edit a Godot-like scene file through a 3D viewport.
Everything runs locally; nothing is uploaded. Core logic is a pure, headless
TypeScript library; the UI is Svelte; parsing is native tree-sitter.

---

## Commands

Tested on Ubuntu 24.04 / Node 22. `npm run verify` is the gate — it must be green
before you commit anything.

```bash
npm ci                                    # install (exit 0; no --legacy-peer-deps needed)
node node_modules/electron/install.js     # npm ci does NOT fetch the Electron binary
npm run verify                            # the gate: boundaries + three-pinned + typecheck + prefab lint + tests
npm test                                  # vitest run, ~50s
npm run typecheck                         # tsc --build  (this is also the core build)
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

---

## Architecture

```
packages/core/          @contextforge/core — pure, headless. No DOM, no app imports.
  src/index.ts          THE export surface. A function not re-exported here is not
                        part of core's contract.
  src/parse/            tree-sitter readers: js.ts, gdscript.ts, tscn.ts
  src/extract/          project on disk -> graph: js.ts, godot.ts, files.ts
  src/graph/            analysis.ts (orphans, focus), reverse.ts (cycles, layers),
                        manifest.ts, labels.ts (label rule)
  src/patch/            FIND/REPLACE + EDIT blocks, diffs, syntax checks
  src/scene/            scene file, edits, prefabs, slots, scaffold prompt
  src/context/          compiler (rank -> compile -> slice), brief
  src/history/          one undo/redo stack, keyed by project path

packages/app/           @contextforge/app — the Electron shell
  src/electron/
    main.ts             window, menu, watcher
    ipcHandlers.ts      EVERY channel handler lives here. ~2000 lines.
    preload.cts         contextBridge; the only renderer -> main path
  src/ipc.ts            CHANNELS const, Result<T>/ok()/fail(), request + event types
  src/renderer/
    App.svelte          screen switch (hand-written ScreenId union, no router)
    screens/            Context, Graph, Patch, Project, Scene
    components/         Sidebar, ProblemsPanel, Toasts, Outliner, Inspector
    viewport/           Three.js scene viewer; rng.ts is a mirrored core function
    graph/labels.ts     the renderer mirror of core's label rule (see Gotchas)
  src/electron/capture-*.mjs   screenshot harnesses

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

---

## Decisions index

Full reasoning in `docs/DECISIONS.md`. **D17, D18 and D19 do not exist** —
`package.json:14` cites D17 for `--legacy-peer-deps`, which is a dangling
reference to a decision that was never written.

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
| D48 an asset node only if the file exists | D49 graph labels stagger on row geometry | | |

---

## Known gaps and open bugs

- **D31:** a line number in the trace skips the symbol check. Open.
- **`findCycles` is super-linear** (D47). Not fixed.
- **Clipboard copy is untested** — no clipboard harness exists.
- **`svelte-check` is not installed.** `tsc` does not read `.svelte` files, so an
  undefined identifier in a component is invisible to every unit test. It was caught
  only by the capture harness reporting console errors. A hand-written substitute
  was tried and **deleted** because it looked like a safety net and caught nothing
  (D49). Adding `svelte-check` is the real fix and is still open.
- **Graph labels assume left-to-right rows** and two fixed vertical lanes. True for
  `breadthfirst`; a third lane is not pre-built.
- **Zoom does not re-measure label widths**, so at high zoom the margins are
  proportionally looser.

---

## Debug protocol

1. Read this file. Find the symptom in the table above.
2. Open **only** the files it names.
3. If this file has no answer, widen the search — and then **add what you learned
   here, in the same commit.**
4. Run `npm run verify` before committing. Three green runs for anything touching
   core, the manifest schema, or shared UI.
5. Never claim something works without a test or a run that proves it. A
   screenshot is evidence only if the harness asserted the state it captured.
6. Do not push. Leave the commit and hand over the push command.

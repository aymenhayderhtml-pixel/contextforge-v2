# AI.md — project memory for AI agents

**Read this file first.** Then open only the files it points to — not the whole project.

**Update this file in the same commit as any task that changes what it says** — see
the protocol at the end. Verify every claim against the code: a line here that is not
true is worse than a missing one, because it will be trusted.
`packages/app/test/renderer/aiDocPaths.test.ts` fails if any path here stops existing.

---

## What this project is

A local Electron desktop app for managing AI context on game projects. It reads a project folder off disk, extracts a dependency graph from the real source files, compiles that graph into a prompt, previews and applies AI-authored patches, and edits a Godot-like scene file through a 3D viewport. Core logic is a pure, headless TypeScript library; the UI is Svelte; parsing is native tree-sitter.

---

## Commands

Tested on Ubuntu 24.04 / Node 22. `npm run verify` is the gate — green before you commit.

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
npm run dist:appimage                     # build the installable AppImage into dist/
npm run smoke:package                      # load kart prefabs from the BUILT AppImage (needs one)
npx electron --no-sandbox packages/app/dist/electron/main.js   # RUN the app
```

The AppImage cannot mount itself on a machine without `libfuse2`, so run it as
`./ContextForge-*.AppImage --appimage-extract-and-run --no-sandbox` (D55). The
installed launcher does that for you when `libfuse.so.2` is missing.

**`npm run start` is known-broken here** — it omits `--no-sandbox`; use the `npx electron` line above.

Screenshot harnesses (not npm scripts; each exits non-zero rather than photograph a
state it cannot confirm — D43). `capture-v4.mjs` is the reference pattern;
`capture-search.mjs` drives the real search box against a real project.

```bash
node packages/app/src/electron/capture-graph.mjs      # the Graph screen, 5 images
node packages/app/src/electron/capture-v4.mjs         # the reference harness pattern
node packages/app/src/electron/capture-newproject.mjs
node scripts/run-e2e-patch.mjs                        # restores the game afterwards
```

`scripts/run-e2e-edit-loop.mjs` needs the game dev server running. For performance,
rebuild core with `npm run typecheck` then run `scripts/repro-round-c.mjs` — a
measurement harness, not a gate, so a slow result does not exit non-zero.

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
                         iterative, index-pointer, never shift() (D53)
  src/patch/            FIND/REPLACE + EDIT blocks, diffs, syntax checks, and
                         createFromReply.ts (atomic new project writer, D56). finder.ts
                         returns Span{start,end}; editBlocks.ts refuses contradictions.
  src/scene/            scene file, edits, prefabs, slots, scaffold prompt.
  src/context/          compiler (rank -> compile -> slice), brief. The NEED:/files
                         attachment loop is the SEC-2 sink, guarded by D51. Reads
                         are size-gated and maxChars is ENFORCED (D53).
  src/history/          one undo/redo stack, keyed by project path. Undo verifies
                         each file against what the step recorded and refuses rather
                         than clobbering a hand edit (D52).
  src/fs/               resolveInsideRoot — the ONE containment check (D51). Every
                         reader/writer of a project-relative path routes here.

packages/app/           @contextforge/app — the Electron shell
  src/electron/
    main.ts             window, menu, watcher
    processRunner.ts    safe runner for npm install & dev (fixed args, detached kill)
    ipcHandlers.ts      EVERY channel handler lives here, ~2000+ lines, INCLUDING
                        search's matching algorithm (it is the only node:-capable,
                        tsc-compiled side). openProject only accepts a picked root
                        (SEC-4, D51); tests pass deps.allowUnpickedRoot:'test-only'.
    preload.cts         contextBridge; the only renderer -> main path
  src/ipc.ts            CHANNELS const, Result<T>/ok()/fail(), request + event types
  src/renderer/
    App.svelte          screen switch (hand-written ScreenId union, no router)
    screens/            Context, Graph, Patch, Project, Scene
    search/             SearchBox.svelte (the box) + match.ts (display rules).
                        The MATCHING ALGORITHM is in electron/ipcHandlers.ts, not
                        here — tsc cannot import a renderer file (gotcha 20).
    components/         Sidebar, ProblemsPanel, Toasts, Outliner, Inspector
    viewport/           Three.js scene viewer; rng.ts is a mirrored core function
    graph/labels.ts     the renderer mirror of core's label rule (see Gotchas)
    Sidebar.svelte      owns the ScreenId union — App.svelte imports it
  src/electron/capture-*.mjs   screenshot harnesses

build/                   electron-builder assets: icon.svg + generated PNGs,
                          contextforge.desktop (the launcher entry)
scripts/install-launcher.sh  install/uninstall the .desktop launcher, render icons

packages/app/tsconfig.svelte.json   a SEPARATE config, for svelte-check only.
                         Not in the tsc project graph — tsc cannot compile .svelte.
packages/app/svelte.config.js      needed by svelte-check, which does not read
                         vite.config.ts

scripts/                check-boundaries, check-three-pinned, lint-prefabs,
                         redact-screenshots.py, run-e2e-*.mjs

docs/                   DECISIONS.md (D1-D55), RUNNING.md, ARCHITECTURE.md,
                         OVERNIGHT.md, DEPENDENCIES.md, PUSH.md, images/
```

There are **five** screens, not six. "New Project" is `ProjectScreen.svelte`; "Project
Brief" has **no screen of its own** — a panel inside `ContextScreen.svelte`. All are
gated on an open project except **Project** itself (`Sidebar.svelte` `isScreenDisabled`).

---

## Feature map

| Feature | Screen | Core | Channels | Tests |
|---|---|---|---|---|
| **Patch** | `packages/app/src/renderer/screens/PatchScreen.svelte` | `patch/{editBlocks,finder,diff,syntaxCheck,fileBlocks}.ts` | `patch:preview` `patch:apply` `patch:history` | `core/test/patch/patch.test.ts`, `app/test/shell/patchScreen*.test.ts` |
| **Context** | `packages/app/src/renderer/screens/ContextScreen.svelte` | `context/{compiler,rank,slice}.ts` | `context:compile` `context:rank` | `core/test/context/compiler.test.ts`, `app/test/context/*.test.ts` |
| **Scene** | `packages/app/src/renderer/screens/SceneScreen.svelte` | `scene/{edits,sceneFile,scene.schema}.ts`, `packages/core/src/history/history.ts` | `scene:load` `scene:applyEdit` `scene:undo` `scene:redo` `scene:save` `prefabs:list` | `core/test/scene/*.test.ts`, `core/test/history/history.test.ts` |
| **Graph** | `packages/app/src/renderer/screens/GraphScreen.svelte` | `graph/{analysis,reverse,manifest,labels}.ts`, `packages/core/src/extract/js.ts` | `graph:project` `graph:focus` | `core/test/graph/*.test.ts`, `app/test/shell/projectGraph.test.ts`, `app/test/renderer/labels.test.ts` |
| **New Project** | `packages/app/src/renderer/screens/ProjectScreen.svelte` | `packages/core/src/patch/createFromReply.ts`, `scene/{scaffoldPrompt,template}.ts` | `project:reply:preview` `project:reply:create` `project:install` `project:run-dev` `settings:projects-folder:get` | `core/test/patch/createFromReply.test.ts`, `app/test/shell/newProject.test.ts` |
| **Search** | `packages/app/src/renderer/search/SearchBox.svelte` | `scanFiles` + `resolveInsideRoot` (both reused from core; the text matching is in `app/src/electron/ipcHandlers.ts`) | `search:project` | `app/test/shell/search.test.ts` (32) |
| **Brief** | *(panel in `ContextScreen.svelte`)* | `packages/core/src/context/brief.ts` | `brief:generate` `brief:read` | `core/test/context/brief.test.ts`, `app/test/e2e/briefLoop.test.ts` |

There is an **AppImage** (`npm run dist:appimage`) and a `.desktop` launcher
(`scripts/install-launcher.sh`). Packaging has its own failure modes — gotchas 21, 22, D55.

Push events, main to renderer, not in `CHANNELS`:
`scene:changedOnDisk`, `prefabs:changed`, `app:notice`, `project:process-output`, `project:process-exit`, `project:dev-ready`.

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
| Search finds nothing, or jumps to the wrong line | `app/src/electron/ipcHandlers.ts` (`searchProject`, `searchColumnInDisplayLine`), then `app/src/renderer/search/match.ts` (D54) |
| The packaged app starts, then dies with `ERR_MODULE_NOT_FOUND` | `package.json` `build.files` — it must list `dist/ipc.js` (tsc emits it *beside* `dist/electron/`, not inside) and `node-gyp-build` (a runtime dep of all four tree-sitter packages). The build succeeds either way; only the asar tells you (D55) |
| An AppImage builds but ships no dependencies | `package.json` `build.directories.app` — without `packages/app` the root manifest is read, and it declares none (D55) |
| `Cannot find module` for `dist/ipc.js` when running alone | Not a build error: `main.js` imports sibling `ipc.js` above `dist/electron/` (D55) |
| The packaged app logs `Cannot find package 'esbuild'` | `esbuild` is a RUNTIME dep in `prefabLoader.js` — must be in `dependencies` and `files` (D55) |
| **Every** prefab shows `prefab failed` in packaged app | `prefabLoader.ts` `ensureEsbuildBinaryIsExecutable` (`spawn ENOTDIR` from asar, gotcha 24) |
| The launcher installs but app will not start | Needs `--appimage-extract-and-run` wrapper without `libfuse.so.2` (D55) |
| `npm was not found` or install hangs | `app/src/electron/processRunner.ts` (PATH search across nvm/fnm/asdf; detached group kill, D56) |
| New project creation refused | `core/src/patch/createFromReply.ts` (refuses non-empty folder, symlink escape, EDIT blocks, D56) |

---

## Gotchas learned the hard way

1. **The renderer may only `import type` from `@contextforge/core`.** Core is `external` in `app/vite.config.ts:78` (it imports `node:fs`, tree-sitter — none exist in the renderer sandbox). A *value* import compiles then fails at runtime; it crashed the whole app once. Precedent for a needed runtime function is a **mirror** with a test comparing both copies: `packages/app/src/renderer/viewport/rng.ts`, `packages/app/src/renderer/graph/labels.ts`.
2. **`$state.snapshot` before anything crosses IPC.** A `$state` value is a Svelte proxy and `ipcRenderer.invoke` structured-clones its argument, which cannot clone a proxy. See `GraphScreen.svelte`.
3. **`npm run typecheck` IS the core build** (`tsc --build` emits `core/dist`). Targeted `vitest run <file>` does **not** build first, so a test importing `@contextforge/core` can run against **stale dist** and report phantom drift. Run `typecheck` after editing core before any subset run; `lint:prefabs` and `run-e2e-*` refuse to run without it.
4. **Cytoscape attribute-selector values must be quoted** — `node[focus = true]` is rejected by its selector parser and left the canvas empty. Use `node[focus = "true"]` and stringify the data to match. `app/test/shell/screenRegressions.test.ts` scans for this.
5. **`kart-dash-3d-v2` is read-only.** A sibling of this repo. `run-e2e-patch.mjs` writes to it *by design* and restores it; verify with a sha256 manifest before and after any task that touches it.
6. **A node/label's `display: none` hides the node, not the text.** To hide only a label use `text-opacity: 0`.
7. **`sync()` must not read `$derived` right after an `await`** — Svelte has not flushed the value yet. Pass elements in as explicit arguments.
8. **e2e tests skip by default** and say so (D27). They need `CF_PROJECT` and `CF_E2E=1`. A green suite does not mean they ran.
9. **`check:svelte` reads core through `core/dist`, so it must run after `typecheck`.** Not a formality: a mid-task `tsc --build` left `core/dist/context/brief.d.ts` stale and `svelte-check` reported four phantom errors. Force with `tsc --build --force` against `packages/core/tsconfig.json`. Same trap as gotcha 3 — `tsc --build` will not regenerate a declaration it thinks is current.
10. **A `<!-- svelte-ignore -->` must sit on the line directly above the element.** One placed further up suppresses nothing, and one naming a code the rule does not raise silently looks like it worked.
11. **`ok` and `existsOnDisk` are different questions.** `resolveInsideRoot` answers *may this path be written*, not *is there a file there yet*. A missing `### FILE:` target is `ok: true, existsOnDisk: false`; collapsing the two makes `readFileSync` throw (D51).
12. **`relative(anchor, target)`, never the reverse.** The reverse is `..` for every file, so `resolve` walks out of the project and the check refuses everything while looking like it works (D51).
13. **The anchor walk starts at the target's *parent*, so it cannot see a symlink at the final component.** The target itself must be `realpath`'d and re-checked when it exists (D51).
14. **A JSONC file cannot be comment-stripped with a regex if its values contain glob stars** — `tsconfig.svelte.json`'s `**/*.svelte` include is a comment terminator to any block-comment pattern, and stripping rewrites the globs, so the failure is a wrong *value*, not a syntax error. `svelteCheckGate.test.ts` has a character scanner.
15. **`Array.prototype.shift()` is a memmove, so it is quadratic on a WIDE queue** (D53). Benchmark with a **star**, never a chain — a chain keeps the queue at depth 1 so each `shift()` is free, which is how four benchmarks measured nothing.
16. **In the tree-sitter Node binding, `.children` is not cached** — every read materialises fresh `SyntaxNode` objects for the whole subtree. Read it once into a local before looping; inside the loop the total goes quadratic (23.6 s for an 80 KB file) (D53).
17. **A performance test asserting a time RATIO can pass on the bug it was written for** (D53). Best-of-3 removes precisely the super-linear term a ratio needs to detect. Use an **absolute bound on a large input**, set by measuring the unfixed code, and confirm the test fails when the source is reverted.
18. **Refuse, do not truncate.** A partial artefact with no marker is worse than a missing one, because the consumer cannot tell (D53). A diff over `MAX_DIFF_LINES` throws; a file over `MAX_FULL_FILE_CHARS` becomes a gap; an over-budget prompt drops whole files. In all three the absence is stated.
19. **An empty diff is ambiguous** — "unchanged" to `PatchScreen.svelte` and "too large to preview" to the developer. See `PatchPreview.diffNotShown`: a separate field, not an addition to `blockedReason` (D53).
20. **`packages/app/tsconfig.json` excludes `src/renderer`, so `tsc` cannot import a renderer file** (D54). Main builds under `tsc`; the renderer's TypeScript is checked by `svelte-check`. A `tsc`-compiled file importing anything under `src/renderer/` fails `TS6307 — not listed within the file list`. Shared **shape** goes through `ipc.ts` types; shared **logic** is duplicated with a mirror test; or the logic lives on the side needing `node:`. This is why search's matching algorithm is in `ipcHandlers.ts` and only its display rules are in `packages/app/src/renderer/search/match.ts`.
21. **A packaging omission produces a build that SUCCEEDS and a package that fails at runtime** (D55). `directories.app`, `extraMetadata`, and the `files` allowlist each have a default that is wrong here, and the only warning printed is `no node modules returned while searching directories`, which reads as harmless in a wall of progress lines. **Check the asar, not the exit code.**
22. **A `.desktop` `Exec` must not name a path containing a space.** This repo's path is `dark matter`, and `desktop-file-validate` does **not** check for it — an unquoted `Exec` validates and then runs the wrong command. The launcher uses `Exec=contextforge` plus a `~/.local/bin/contextforge` wrapper (D55).
23. **`dist/` is both `tsc`'s output root and the packaging output directory.** `rm -rf dist` to "clean the build" **deletes your AppImage**. Also: `--appimage-extract` writes `squashfs-root/` into the repo root, and node-gyp's "Attempting to build a module with a space in the path" is **noise** — the grammars ship prebuilds (D55).
24. **Electron patches `fs` for asar, and nothing else.** `child_process` and the *synchronous* `createRequire` both hand `spawn`/resolution a path that is not a file on disk, so anything that spawns a binary or resolves synchronously from inside `app.asar` fails `ENOTDIR`. Only async ESM `import` is patched. Fix: `unpackedAsarPath` + `ESBUILD_BINARY_PATH` (D55) — but esbuild reads that variable **once, when its module is evaluated** (a module-scope constant `generateBinPath()` reads, not the live env), so esbuild must be imported *after* the override. A static `import` is hoisted and captures it too early; hence the dynamic `await import('esbuild')` after each guard.
25. **`child_process.spawn` must run fixed argument arrays with `shell: false` and a detached group** (D56). Shell string execution invites injection. Desktop launch lacks terminal PATH, so search `~/.nvm`, `fnm`, `asdf`, system bin. Always kill `-pid` (detached group), not just `pid`, or child Node dev processes survive.

---

## Decisions index

Full reasoning in `docs/DECISIONS.md`.

**D17, D18 and D19 were never written.** They were cited by live code before the log
existed, and no commit, branch or dangling blob contains them. They have been
**reconstructed from the code that cites them**, and each entry says so.

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
| D52 spans, no self-contradicting patches, undo verifies before writing | **D53** iterative walks, bounded diff, enforced budget | **D54** one `search:project` channel | **D55** `directories.app` + `extraMetadata` + an explicit files allowlist |
| D17 peer-deps fallback (**reconstructed**) | D18 key a generic event type by value | D19 shape before relations (**reconstructed**) | **D56** 5-step project creation, atomic reply patch, safe runner |

---

## Known gaps and open bugs

- **D31:** a line number in the trace skips the symbol check. Open. **Clipboard copy is untested**.
- **Two `svelte-check` warnings remain, deliberately unsuppressed (D50)**:
  `a11y_no_noninteractive_tabindex` on panel resizers in `SceneScreen.svelte` (keyboard-reachable separators).
- **A prompt cannot be smaller than ~1,900 characters (D53)** — the opening line,
  `SURGICAL PATCH CONTRACT` and `NOT ATTACHED` block. A lower `maxChars` reports unreachable.
- **`scanFiles` skips symlinked files and directories** — `entry.isFile()` and
  `entry.isDirectory()` are both false for a symlink (D54). A symlink inside a project
  is therefore not searchable by content *or* name, and `skipped` can be legitimately
  empty for a symlink case because the walk never offered the path. Search's
  `resolveInsideRoot` call is defence in depth, not the primary barrier.
- **Search "jump" shows the match with its line number, highlighted** (D54) — it does
  not open the file elsewhere or scroll the Scene screen; that is not built.
- **The AppImage is x86_64 Linux only**, unsigned, and cannot mount itself without
  `libfuse2` (D55). No `.deb`/flatpak/snap, no auto-update, no screenshot of a running
  window has ever been captured on this machine.
- **`docs/DEPENDENCIES.md:19` says tree-sitter is pinned to 0.22.x; it is not**
  (`packages/core` declares `^0.25.1`). Noted in D17, left unedited there.
- **The `audit/2026-10` branch is a stale snapshot and its `AUDIT.md` is UNTRACKED** —
  never committed, so reading it from git fails. Find it in the `contextforge-audit`
  worktree beside this repo. **Several findings are wrong**: three (D51) plus GRAPH-5's
  headline timing, which was really CTX-3 (D53). Read D51 and D53 first.
- **Still-open audit findings** — PATCH-2/SEC-3 (symlinks defeating the lexical path
  checks), SEC-2 (`NEED:` reads), SEC-1 (`targetFile` unguarded in the handler),
  SCENE-1 (a root with children cannot be deleted), SEC-7 (`applyEdit` throws where its
  docstring promises a `Result`), SCENE-6 (escapable no-random lint). Round D.
- **Graph labels assume left-to-right rows** and two fixed vertical lanes — true for
  `breadthfirst`; a third lane is not pre-built. Zoom does not re-measure label widths.
- **A test that claims to exercise a packaged tree may not be doing so.** Electron patches
  only async ESM `import` for asar; a plain `node`, or a synchronous `createRequire`,
  fails `ENOTDIR` before reaching the code. Verify the assertion really ran (D55).

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

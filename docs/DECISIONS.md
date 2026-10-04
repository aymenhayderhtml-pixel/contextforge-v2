# Decision log

Each entry records a choice, what it replaced, and why. "Why" matters more than
"what": a decision whose reasoning is gone cannot be revisited without
re-deriving it, which is exactly what this project is trying to help developers
avoid.

---

## D1. Native tree-sitter rather than `web-tree-sitter`

**Context.** SPEC R5 requires real syntax trees for JS, TS and GDScript.
v1 used line-by-line regexes, which silently missed multiline declarations,
`export { a as b }`, star re-exports, and any comment containing the word
`export`.

**Options considered.**

1. `web-tree-sitter` + prebuilt `.wasm` grammars.
2. Native `tree-sitter` 0.22.x + the three grammar packages.
3. Keep regexes and add test cases.

**Decision: native (option 2).**

**Why.** Option 1 was implemented and measured first. The prebuilt grammar set
(`tree-sitter-wasms` 0.1.13) ships 38 languages — JavaScript, TypeScript, TSX,
HTML, JSON — and **no GDScript**, which is half of this app's target engines.
Pairing it with a matching runtime (web-tree-sitter 0.25.x, verified working)
meant keeping two ABI versions in step by hand; the mismatched pairing fails at
load with an opaque `getDylinkMetadata` error that says nothing about the cause.

Option 3 is the thing to avoid: it is how v1 ended up with a contract extractor
that reported a commented-out `export function fake()` as real API.

**Cost accepted.** Native grammars mean core cannot run in a browser. Core is
headless by rule (R3) and the renderer only needs JS/TS/JSON, so the wasm
runtime remains the right tool for Step 3's viewer. Both paths are recorded in
SPEC.md §7.

**Verified before adopting:** all three grammars parse in one runtime under Node
22, and a missing GDScript body colon is detected from the tree (D4).

---

## D2. Import resolution in core rather than `madge`

**Context.** v1 delegated import graph resolution to `madge` (which itself uses
`dependency-tree` + a detective plugin), while parsing exports with its own
regexes. Two parsers, two views of the same file, and a dependency whose
behaviour we did not control.

**Decision.** Resolve imports in `extract/js.ts` from the same tree-sitter parse
that reads the exports. Module resolution follows Node's rules closely enough
for game projects: relative specifiers resolve against the importing file, and
an extensionless or directory specifier is probed for the usual extensions.

**Why.** One parse, three answers (imports, exports, asset references). It also
removes a dependency and makes the graph's source of truth a single parser.

**Cost accepted.** We are not a complete Node resolver. Extensionless deep
imports through a custom `exports` map are out of scope, because a game project
does not use them and a half-implemented `exports` algorithm would be worse than
none. This is recorded as a known limitation, not hidden.

---

## D3. An ambiguous snippet is refused, never guessed

**Context.** `findTargetMatch` is a ladder of passes from exact match to fuzzy
anchors. A permissive finder applies an AI's patch to the wrong lines; a strict
one rejects everything an LLM produces, since models reformat snippets from
memory.

**Decision.** Each pass reports *how many* places it matched. More than one is a
refusal with the count, on every pass including the loosest.

**Why.** A wrong patch is discovered when the game misbehaves, or not at all. A
refusal is discovered immediately and is fixed by asking the AI for more
surrounding context. The asymmetry favours refusal, and the count in the error
tells the developer exactly what to do next.

**Cost accepted.** A legitimately ambiguous patch needs a second round-trip. That
is the intended behaviour, not a limitation to optimise away.

---

## D4. Two checks for GDScript, because the grammar accepts one bad case

**Context.** v1 hand-wrote a GDScript syntax scanner (delimiter balance, string
termination, block-header colons). It worked but false-flagged three common
constructs, and each needed a test pinning it down: hex colour literals
(`"#ff00ff"` — the `#` looked like a comment), Windows paths (`"C:\\..."`), and
triple-quoted docstrings containing delimiters and fake function signatures.

**Decision.** Use tree-sitter for the general check, and add one targeted check
for the case the grammar misses: `func f()` with no body. The GDScript grammar
parses it as a valid `function_definition` with no `body` child, even though
Godot rejects it.

**Why.** The generic path inherits tree-sitter's error reporting and is immune to
all three false-positive classes, with no bespoke scanner to maintain. The one
real gap is closed structurally — "a `function_definition` node with no `body`" —
rather than by scanning lines, so it stays correct for tab- and space-indented
files and for nested functions.

**Verified.** Both directions are tested: the missing colon is rejected with its
line, and hex colours, Windows paths and triple-quoted docstrings pass.

---

## D5. An all-or-nothing patch write

**Context.** A patch may touch four files, and the syntax pre-check may reject
one of them after the others have been computed.

**Decision.** Apply every block to in-memory buffers, run the pre-check on each
file's final content, and only then write. A rejection writes nothing.

**Why.** A partially-applied patch is the worst outcome: the developer cannot
tell which half landed, and the file that did change is now inconsistent with
the file that did not. All-or-nothing costs nothing — the buffers are already
built — and removes the ambiguity entirely.

**Cost accepted.** One broken file blocks a patch that would otherwise have been
mostly fine. `applyAnyway` exists for exactly that case, and is never the
default.

---

## D6. `before: null` means "did not exist"

**Context.** Undo has to restore files. Most edits change content; some create a
file; some delete one.

**Decision.** `FileChange` carries `before` and `after`, where `null` means the
file was absent. Undo writes `before` (`null` → delete); redo writes `after`.

**Why.** Creation and deletion are the same edge cases as editing, and getting
them wrong loses work silently. One representation covers all three cases, so
there is no special path to get wrong.

---

## D7. Zod over Ajv, and `.strict()`

**Context.** v1 validated the manifest with Ajv against a JSON Schema file.
The v2 plan requires Zod for `scene.json`.

**Decision.** Zod for both the manifest and the scene, with `.strict()` on every
object schema.

**Why.** One validation technology for the whole project, and the manifest type
is inferred rather than hand-maintained against a schema file — the two can no
longer drift. `.strict()` matters for the *primary* consumer: an AI writes these
files, so a typo'd key must fail loudly. Zod's default is to strip unknown keys,
which would hide exactly the bug worth catching.

**Cost accepted.** Zod's inferred output includes explicit `undefined` for absent
optional keys, which under `exactOptionalPropertyTypes` needed `| undefined` on
the optional fields in `graph/types.ts`. That is a real ergonomic cost of taking
R1 and R6 together; it was cheaper than dropping either.

---

## D8. Injected time, no `Date.now()` in extracted data

**Context.** SPEC R8 requires two extractions of one project to be byte-identical.
v1 used `Date.now()` for history ids and timestamps.

**Decision.** `recordHistoryStep` takes `now` as a parameter, defaulting to
`Date.now()`. `buildManifest` takes `generated_at`. Extracted graph data contains
no timestamps at all.

**Why.** Determinism is what makes the graph safe to hash, diff and cache — and
it is what lets the tests assert equality of two runs rather than eyeballing
them. Defaulting the parameter keeps callers simple while letting tests be exact.

---

## D9. `packages/app` is not created yet

**Context.** The build order puts the UI shell at Step 4.

**Decision.** Step 1 ships `packages/core` only.

**Why.** An empty app shell would be an untested claim that the monorepo works,
and it would need Electron plus a Vite/Svelte toolchain installed and verified
before the engine underneath it is finished. Core is the part everything else
depends on, and it is fully testable headless — which is also what proves the
workspace boundary is real.

**Cost accepted.** The `tsconfig.json` solution currently references one project.
Adding `packages/app` in Step 4 is a one-line change.

---

## D10. v1 test coverage ported by behaviour, not by line

**Context.** v1's tests were hand-rolled scripts with a `test(name, fn)` helper,
run by a shell chain in `package.json`.

**Decision.** Ported as Vitest suites, asserting the same behaviours. Where v1
asserted a *regex artefact* — "the contract contains the string `default`" when
the regex produced a bare `"default"` with no binding name — the assertion now
states the real signature (`default function main()`).

**Why.** The v1 assertion encoded the bug. Porting it verbatim would have locked
in the behaviour D1 set out to fix. The behaviours that matter — node discovery,
dependency edges, signals, exported vars, private functions excluded, scene
inheritance, autoload edges, determinism — are all still asserted.

**Not ported, deliberately:**

- *HTTP endpoint tests* (`/history/status`, `/history/undo`, `/save-file`,
  `/add-from-clipboard`). These exercise Express routes, which belong to the app
  shell. The behaviours they covered are tested directly against core functions.
- *Console diagnostics tests* (`isErrorLine`, server log buffers). Server
  infrastructure with no equivalent in v2.
- *Context compiler, diff drawer, and outline/scoped-snippet tests*. Those are
  Step 2 and Step 4 features; `graph/reverse.ts` covers the graph queries they
  were built on, and the scoped-prompt compiler is not yet written.

---

## D11. Vendored bundles are excluded from extraction

**Context.** The smoke test runs core against the real v1 repository. It took
**19 seconds** to extract 109 nodes. Profiling showed the cost was concentrated in
two files: `public/vendor/three.min.js` at 8.5s and `public/vendor/GLTFLoader.js`
at 4.8s. `GLTFLoader.js` is unminified third-party code; the minified bundle is
740KB on one line.

**Decision.** Exclude by filename pattern (`.min.js`, `.bundle.js`, `.umd.js`,
`*-lock.js`) and by directory (`vendor`, `three`), in the filesystem walk rather
than in the extractor, so both engines benefit.

**Why.** These files are not the developer's code. No AI may be asked to change
them, and their "contracts" are unreadable — thousands of minified exports that
mean nothing to a reader. Extraction now takes **5.6s**, and the remaining time
is spread thinly across 92 real source files with no pathological case left.

**Why the walk and not the parser.** The parser is the wrong place: it would have
to load the file to know its size, which is the expensive part. The filename is
free to check.

**Cost accepted.** A developer who *wrote* a file called `something.min.js` and
wants it in the graph cannot get it there. That is a real but narrow loss, and
renaming the file is a worse outcome than the one being avoided.

**Guard.** A test builds a synthetic multi-megabyte `.min.js` and asserts
extraction stays fast, so the regression cannot return unnoticed.

---

## D12. `layerNodes` accounts for every node

**Context.** `layerNodes` assigns each node a topological layer so the Context
screen can show a build order. It excludes cyclic nodes. The smoke test asserted
`layers.flat().length + cyclic.length === nodes.length` — and it failed, losing
**two** nodes from a 106-node graph.

**Decision.** Nodes downstream of a cycle are now also reported in `cyclic`,
because nothing downstream of a cycle can be honestly ordered either. Any node
still unplaced when the loop ends is reported too, never dropped.

**Why.** A node silently missing from both lists is invisible: the build order
would be wrong and nothing would say so. An explicit "these N files cannot be
ordered" is a correct, actionable statement. The invariant is now asserted across
four graph shapes, including the empty graph and a self-import.

**Found by** the real-project smoke test, not by any unit test — a reminder that
the fixtures were too kind.

---

## D13. A parser per language, created once

**Context.** `tryParse` originally constructed a `Parser` and called
`setLanguage` on every call.

**Decision.** Cache one parser per language for the process.

**Why.** Grammar loading is the expensive part. Reusing parsers took a single
small-file parse from ~40ms to ~2ms.

**Measured honestly, though:** this was *not* what fixed the 19-second
extraction. D11 was. Caching is still correct and kept — it is simply not the
lever it looked like when the number was large.

**Not done, deliberately.** The 0.22 native binding exposes no explicit tree
`delete` (checked at runtime), so trees rely on the garbage collector. No manual
freeing was invented to work around a missing API; a smoke test extracts the
whole real project repeatedly to show this is not a problem in practice.

---

## D14. tree-sitter 0.22 must be rebuilt as C++20 for Electron

**Context.** Core parses with *native* tree-sitter (D1), so the app shell in
Step 4 needs those `.node` modules inside Electron. Native addons are compiled
against a specific ABI: a build that works under `node` refuses to load under
Electron.

**Decision.** `npm run rebuild:native` first runs
`scripts/patch-tree-sitter-cxx.mjs`, which raises tree-sitter 0.22.4's binding.gyp
from `-std=c++17` to `gnu++20`, then invokes `electron-rebuild`.

**Why.** Electron 44 ships V8 12.4+, whose headers require C++20. tree-sitter
0.22.4 hard-codes C++17, so the rebuild fails with a wall of errors that never
mention the standard:

```
error: invalid use of incomplete type
       'class cppgc::internal::ConditionalStackAllocatedBase<node::ObjectWrap>'
```

Every one of those errors is a *consequence* of compiling C++20-dependent
headers as C++17, so the log gives no hint at the actual cause.

**Why a script rather than a patch.** A hand-edited `node_modules` is silently
reverted by the next `npm install`, after which the rebuild fails on a machine
that did nothing wrong. The script is idempotent and runs automatically.

**Verified:** `npm run check:native` runs from a clean `binding.gyp` and both
the JavaScript and GDScript grammars parse inside the Electron main process.

**Two environment notes, recorded because they will bite again.** `NODE_ENV` is
`production` on this machine, which makes `npm install` skip devDependencies
entirely — Electron must be installed with `NODE_ENV=development npm install
--include=dev`. And the check runs with `--no-sandbox`, because the bundled
`chrome-sandbox` helper ships unprivileged and Chromium refuses to start without
it. Neither affects the shipped app.

---

## D15. A scene edit is refused, not thrown, when it breaks an invariant

**Context.** `saveScene` re-validates before writing, which is what guarantees
the file on disk is always a scene that would load. But an edit can pass every
local check and still break an invariant — adding an instance under a parent
that does not exist is the clear case.

**Decision.** `applySceneEdit` attempts the write inside a try and converts the
failure into the same `{ ok: false, error }` refusal every other edit returns.
Nothing is written and no history step is recorded.

**Why.** The caller is the Modeling screen, mid-interaction. An exception thrown
across the UI boundary for a condition the developer caused is not an error, it
is a message — and a screen that throws instead of reporting leaves the
developer with no idea which edit failed or why.

**Cost accepted.** The error text arrives as a thrown-and-rescued string rather
than a typed validation result. Reshaping it would mean the write path returned a
union of two failure kinds for no benefit at the one call site that exists.

---

## D16. The boundary checker needs two different string masks

**Context.** `check:boundaries` enforces R3/R4 mechanically, so it is the only
thing standing between core and a `three` import. Step 2 added the project
template generator, which emits a whole `loadScene.ts` **inside a template
literal** — and that generated module imports Three.js. The checker read it as
core's own import and failed the build on correct code.

**Decision.** Two masks over the same scanner. The **import** scan keeps
single- and double-quoted contents (that is where the specifier lives) but blanks
template literals. The **DOM global** scan blanks every string, because prose
inside a string is where its false positives come from.

**Found by** breaking it. The first attempt reused the DOM mask for both. That
silently reduced `from 'three'` to `from ""` and the import check detected
**nothing at all** — no Three.js, no `electron`, no `@contextforge/app` — while
the repository stayed green. Nothing in `verify` noticed, because the checker
was passing by construction rather than by working.

**Guard.** `packages/core/test/boundaryCheck.test.ts` now drops a probe file
into core and asserts both directions: each forbidden import form is still
flagged, and generated source inside a template literal is still not. A
mechanism that has no test is a mechanism that will be broken silently.

---

## D20. Shared `AppError` model, strict instance scoping, and browser ES module prefab bundling (Step 3b)

**Context.** In Step 3, the Modeling viewer loaded fallback meshes via `createDefaultMesh` when prefabs were not bundled into the renderer, errors lacked a unified structure across the renderer, and inspector errors were not scoped to the selected instance.

**Decision.**
1. **Shared Error Model:** Created `packages/app/src/errors.ts` defining `AppError { id, scope: 'instance' | 'field' | 'project', instanceId?, fieldPath?, short, details }` with pure query helpers (`errorsForInstance`, `errorsForField`, `projectErrors`).
2. **Real Prefab Execution:** Deleted `createDefaultMesh`. Prefabs in `prefabs/` are bundled with esbuild into a browser ES module, loaded dynamically into the renderer viewport registry, and instantiated with Three.js passed in. A throwing prefab creates a red placeholder box and emits an `AppError`. Added tree parity test for `kart` against game prefab output — which compared the prefab against itself and proved nothing; D22 replaced it with a real comparison against the untouched v1 file.
3. **Error Formatting & Instance Scoping:** Errors are displayed as single concise lines with an expandable Details toggle for stack traces and file paths. Param validation errors (e.g. `Width = -10`) appear directly under their respective input field. The inspector filters strictly by `instanceId` so selecting an instance displays only errors that belong to it. Project-level problems are displayed in a dedicated collapsible `Problems (N)` panel.
4. **Layout Consolidation:** Added resizable pane splitters with bounds checking, text truncation with ellipsis and full tooltips (no horizontal scrollbars), compact single-row X/Y/Z vector inputs, collapsible inspector sections, a single-row merged header toolbar, and unsaved changes indicators.
5. **Project Screen Affordances:** Added a native folder Browse button, persistent recent projects list, path display, cleaned sidebar with coming-soon tooltips for inactive screens, and 2-line placeholder summaries for Context and Patch screens. (The Browse button did **not** work when this entry was written — see D21, which replaced the mechanism behind it.)

---

## D21. `File.path` is gone, so the folder picker became an IPC request (Step 3c)

**Context.** D20 added a "native folder Browse button". It did not work. It was
a visually hidden `<input type="file" webkitdirectory>` read for `File.path`, and
that property does not exist: Chromium never exposed it under that shape, and
Electron has deprecated `File.path` outright since v32 — so under the
`sandbox: true` this app ships with (D20, `main.ts`) the button silently did
nothing. It looked complete in a screenshot and had never once opened a dialog.

**Decision.** Removed the `<input webkitdirectory>` entirely and added a typed
`project:pick-folder` request whose response is `Result<string | null>`. The
handler calls `dialog.showOpenDialog({ properties: ['openDirectory'] })` in the
main process and returns the chosen absolute path, or `null` on cancel.

**Why a request rather than any renderer trick.** The renderer has no `fs`, no
`path`, and — under `sandbox: true` — no `File.path`. There is no correct way to
recover a folder path from inside the renderer, so the only honest fix is to ask
the process that *does* own the filesystem. This is the same rule the rest of the
app already follows (D20, `ipc.ts`), and it costs nothing in security posture:
the request carries **no argument**, so the renderer cannot name a path. It can
only ask for a dialog and receive what a human chose inside it.

**The dialog is injected, not imported.** `AppBackend` still imports no Electron
at module level — that is load-bearing, because it is what lets a test drive the
whole backend headlessly. `main.ts` passes `{ picker }`, and the picker resolves
`dialog` at call time rather than capturing the module, because `dialog`
throws before `app.whenReady()` and the backend is constructed at module scope.
A second optional options-object parameter was used instead of a positional
because `send` is required and the picker is an optional capability.

**Cancel is `ok(null)`, never `fail()`.** A user who dismisses a dialog did
nothing wrong. An empty `filePaths` is treated as a cancel too, because some
platforms report a window-manager dismissal that way and the same gesture must
not sometimes look like a cancel and sometimes like an error. A cancel produces
**no notice and no error UI at all** — an error toast for "I changed my mind" is
noise that trains developers to ignore toasts.

**Guard.** `packages/app/test/shell/pickFolder.test.ts` (21 tests) covers the
mocked dialog, cancel-by-flag, cancel-by-empty-array, a throwing dialog becoming
a refusal for *both* the synchronous-throw and rejected-promise shapes, the
store-level path pushing no notice, and the rendered markup containing no
`webkitdirectory` and no hidden file input. `registerHandlers`' existing
"every channel in `CHANNELS` must have a handler" check is what forces the
handler to exist the moment the channel was added.

**Not proven.** No dialog was ever opened: there is no display here. Whether
`canceled` is *always* set alongside an empty `filePaths` is untested, and on
macOS the panel is deliberately not parented to a window (`getFocusedWindow()`
is unreliable under `sandbox: true`), so it appears as an app-modal panel rather
than a sheet. Both are worth confirming on real hardware.

---

## D22. Parity is against the untouched v1 file, not against the prefab (Step 3c)

**Context.** The existing `realPrefabs.test.ts` claimed to check kart parity, but
it compared `prefab.create()` against `prefab.create()` — the same function on
both sides. It also pinned a hard-coded `31` child count and covered exactly one
character. It was a tautology that would have passed against a prefab that had
drifted arbitrarily far from the game.

**Decision.** The test now imports v1's `src/kart.js` (`buildMesh`/`buildDriver`,
read-only, never edited) and compares, for **4 character × headgear combinations**
(`dash`/`helmet`, `dash`/`cap`, `luna`/`cap`, `rex`/`helmet-full`):

- every node's **name**, at every level;
- **child count** at every level, plus total node count;
- a **per-node bounding box** (`Box3` per node, not just the root);
- the animated handles (`wheels[].pivot`, `steeringWheel`, `exhaustGlows`,
  `starRing`) the game's `update()` addresses;
- the exhaust glow's **canvas draw instructions**, compared against v1's own
  recorded instructions rather than a hand-written copy.

**How v1 is loaded, and why it is not an import.** v1 has no `node_modules`, and
its path contains a space, so neither a plain `import` nor `import.meta.resolve`
works. v1's `kart.js` is bundled with esbuild (`platform: 'node'`, `format:
'esm'`, `nodePaths` pointing at the host's `three@0.180.0`), written to a temp
`.mjs`, and imported with a cache-busting `?v=<n>` suffix — the same
`importFresh` pattern `prefabLoader.ts` already uses. The bundle is what also
exercises the *real* `buildMesh`, since the `Kart` constructor is called for
real against a throwaway `{ add() {} }` scene.

**Anti-tautology guards.** The test asserts the two sides' entry points are
different files, that the viewer built no placeholder, that v1's tree is
genuinely nested (`Kart_Driver/Driver_Torso` must exist), and that the child's
paths match. Verified non-vacuous by hand: the prefab builds 31 root children
(matching v1), and deleting one is detected.

**Result: zero differences.** All 4 combinations match on every axis. The
parity test found no defect in the prefab, so no prefab fix was needed.

**One real difference remains, deliberately not asserted as parity.** v1's
`createTexture` sets `wrapS`/`wrapT` = `RepeatWrapping`, `anisotropy` = 4 and
`colorSpace` = `SRGBColorSpace`; the prefab's browser texture factory leaves
those at Three.js defaults. These four are texture-sampling state on an
additive glow sprite whose `map` is drawn identically, so the glow composites the
same. The test asserts the *material* (which decides whether it composites at
all) and names the four rather than silently ignoring them.

**Found by breaking it.** `captureFirstDraws` was being called *after* each
build instead of being handed the log length from *before* it, so
`slice(undefined)` returned the entire shared draw log. The prefab's "record"
was v1's 7 instructions plus its own 7 — a 14-vs-7 "difference" that was the
harness lying. A scratch probe confirmed the prefab draws exactly 7 on first
create and 0 thereafter (both sides cache the texture in a module-level
variable). **The lesson is the one D16 records:** the test was passing by
construction rather than by working, and a mutation probe — not a green run — is
what distinguishes the two. Both call sites now take the index before the build.

---

## D23. The game builds its karts from `scene.json` through the prefab registry (Step 3c)

**Context.** Kart-Dash-3D's `Kart` class hand-built its mesh in `buildMesh()` /
`buildDriver()` while the ContextForge prefab registry built the *same* kart in
`createKart`. Two builders meant the kart the developer previews in the Modeling
screen and the kart the game drives could silently diverge — the exact failure
SPEC's whole premise exists to prevent.

**Decision.** `Kart.buildMesh()` now delegates to `createKart`, and the returned
`parts` (`wheels`, `steeringWheel`, `exhaustGlows`, `starRing`) are assigned to
the same `this.*` fields `update()` and `reset()` already animated. The duplicated
geometry is deleted. `src/loadScene.js` (new) builds every instance from
`scene.json` through the registry, following core's generated-project template
(`template.ts`'s `loadSceneSource`) rather than inventing a second architecture:
validate with Zod first, build per instance with `rngFor(seed, id)`, apply
transform, set `name ?? id`, apply `parent` links in a **second pass** so file
order cannot decide whether a child attaches.

**Two judgment calls worth recording, because both could have gone the other way.**

*Bad params on one instance do not take down the scene.* `validateScenePrefabs`
errors are reported with their JSON paths and scoped to the instance they name;
that instance is skipped and the rest of the scene builds. The shipped
`scene.json` contains `instances[0].params.width: -10` (the prefab requires
`.positive()`), so the strict reading — refuse the whole file — would have made a
single typo in a crate's params remove every kart from the grid. A *structural*
failure (malformed document, wrong `version`, 2-component position) is still a
hard refusal: that file does not describe a scene at all, and guessing at one puts
objects in the wrong place with no error explaining why.

*The track keeps owning the circuit.* `scene.json` declares 5 instances (one
track segment, one crate, three karts) but `Track` (`src/track.js`) draws the
whole course and owns `startGrid`, which places all 8 karts. Rebuilding the grid
from 3 declared karts would delete the game. So `startingGrid()` exposes the
kart placements the file declares and returns `[]` when it declares none, in which
case the course-driven grid is used exactly as before. It refuses a **non-uniform**
scale rather than approximating it, and does **not** apply `scale` to the mesh —
`KART_SCALE` is already on the mesh, so multiplying would make `scale: 1` a
1.18×1.18 = 1.39 kart: a plausible-looking wrong kart.

**Verification.** `packages/app/test/scene/gameScene.test.ts` (12 tests) bundles
the game with esbuild and asserts the required behaviour — **change a kart's
position in a copy of `scene.json`, load the game's scene-building code, assert
the kart is at the new position** — plus all 5 instances built (by id, never by
index), parent links resolving to real descendants in any file order, and
structural refusals naming the JSON path. It never mutates the real
`scene.json` on disk.

**Not proven, and this is the largest gap in Step 3c.** **The game has never
been run.** There is no browser, no display, and no `node_modules` in the game
project, so `vite` cannot start and **no screenshot exists**. "The game looks and
behaves the same" is *not* established. What is established is that the kart tree
`Kart` builds is the same tree `createKart` builds — the parity test compares
that against the untouched v1 file. Whether `main.js`'s new scene-loading path
runs at all in a browser is untested.

**Environment gotcha, recorded because it will bite again.** The game project
has **no `node_modules` and none exists at any level above it**, so
`import 'three'` from anywhere in the game fails with `ERR_MODULE_NOT_FOUND`.
Its `package.json` declares `three@^0.160.0`; the only Three.js available is the
host's `0.180.0`. Every test therefore reaches game code through esbuild
bundling with `nodePaths`, and the **0.160 → 0.180 version gap is a real,
unresolved behavioural risk** that a green suite cannot see.

---

## D24. A watcher test may not assert "nothing happened" against a fixed sleep (Step 3c)

**Context.** Step 3c added an esbuild-heavy scene suite. Afterwards
`backend.test.ts > emits prefabsChanged and rebuilds the registry` began failing
**intermittently** — green on one run, red on the next two, with nothing in that
file having been touched. It was not introduced by Step 3c and was not caused by
it either: removing the new suite made it pass again, which is the only reason
the trigger could be identified.

**Why.** That test waited a fixed `WATCH_DEBOUNCE_MS * 6 + 400` and then asserted
an event had arrived. The interval is a **guess** about how long `fs.watch`
delivery plus an esbuild registry rebuild takes — both of which grow when 46
vitest workers are competing for CPU. Adding CPU-heavy work elsewhere in the run
pushes it over. So the test was really asserting *the machine was idle enough*,
which is never true of a real machine and is only true of a test runner on a
quiet box.

**Decision.** Added `waitUntil(predicate, timeoutMs, intervalMs)` and converted
every watcher test that asserts an event **arrived** to poll for it. The test
now asserts *that the event arrives*, not *that the machine had time*.

Two cases were deliberately **not** converted, and the reason is recorded in the
code at each site: `does not report its own applyEdit back to the renderer` and
`stops watching when the project is closed` assert that **nothing** happens.
There is no condition to poll for, so a bounded sleep is the honest tool there —
and a negative assertion is not the thing that went flaky. The multi-write
debounce test polls for the *first* event and then still sleeps, because "exactly
one" can only be checked once the last possible event has had its chance.

**Found by breaking it.** A single green `npm run verify` proved nothing: the
first full run after the fix was red, and the suite has to be run **repeatedly**
before a flake can be distinguished from a pass. Four consecutive clean runs came
after the change; one clean run before it would have been reported as done.

**Guard.** The failure is not silent — it was a real red run. But a flake in a
gate is worse than a slow gate, because a red suite that is red for no reason
trains people to re-run it instead of reading it.

---

## D25. A version gap is enforced by a gate, not by a comment (Step 3d)

**Context.** The game declared `three@^0.160.0` and the viewer used `0.180.0`.
Nothing complained. The Step 3c parity test still passed — because it bundled the
game's modules against the **host's** Three.js and so compared 0.180 against
0.180. The test built to catch a version gap was structurally incapable of seeing
it.

**Decision.** Pin `three` to the **exact** version `0.180.0` in both
`packages/app/package.json` and the game's `package.json` (no `^`, no `~`), and
add `scripts/check-three-pinned.mjs` to `npm run verify` as `check:three`.

**Why pin the *range* away, not just the number.** The caret is the mechanism:
`^0.180.0` permits any 0.18x, so an `npm install` a month from now can land the
game on a different Three.js than the viewer, and the symptom is a rendering
difference nobody can point at. The distinction is invisible in a diff review and
decisive at runtime, which is the argument for making it a gate.

**What the gate checks**, and why declared and installed are separate: the two
**declared** versions must be byte-identical; the two **installed** versions must
be byte-identical. A lockfile disagreeing with its own manifest is a different
failure from two manifests disagreeing with each other, and the message says
which. Exit codes are distinct — `0` clean, `1` a violation, `2` an operational
failure (a manifest or install that does not exist). Exit 2 matters: reporting
"pinned and identical" about a file that was never read is a claim about nothing,
and D16 already records a gate that passed by construction rather than by working.

**Guard, proven in both directions.** A synthetic game manifest pinned at
`0.160.0` is caught (exit 1, naming the mismatch); the same manifest changed to
`^0.180.0` is caught with three violations (exit 1); a non-existent game root is
an operational error (exit 2), not a pass. `CF_GAME_ROOT` overrides the path so
the probe is possible without touching the real project.

**Found by noticing.** The game reached 0.160 → 0.180 with **zero API breaks** —
it uses only stable surface (`WebGLRenderer`, `Color`, `Vector3`, `Fog`,
lights, `ShaderMaterial`). The gap was therefore invisible in behaviour too,
which is the strongest argument for a gate: nothing would have told us.

---

## D26. The Problems panel was blind to a bad param *value* (Step 3d)

**Context.** Step 3d asked for a skipped instance to be visible on both sides. The
premise — that `AppBackend.paramProblems()` already covered it — turned out to
be **false**, and the way it was false was specific.

`paramProblems()` checks exactly two things: an **unknown key** and a **missing
required key**. It never checks a bad *value*. So the one permanent example in
the repo, `instances[0].params.width: -10`, produced `Problems (0)` /
`No problems detected.` Meanwhile `SceneScreen.svelte` computes the same
validation for the **inspector**, and `ProblemsPanel` is driven independently and
never called it — so the panel (and anything rendering it standalone) was blind
while the inspector, one screen away, was not.

**Decision.** `ProblemsPanel.svelte` gained an exported pure function
`collectSkippedInstanceProblems(snapshot, prefabs, existing)` which runs
`validateInstanceParams` over the scene's instances against the registry
summaries it already holds, deduplicated by error id against the other sources.
Exported as a module-level function rather than inlined so a test can assert the
rows themselves — the Details body is collapsed in server-rendered HTML, so a
DOM-only test could never see the offending value the row exists to report.

**The duplication is recorded, not hidden.** `SceneScreen.svelte` now computes
the same pass for the inspector. Two derivations of one fact can drift; extracting
a shared helper is the right fix and is listed as wanted work rather than done
quietly.

**Known divergence, stated as a limitation.** `zodToJsonSchema` maps `.positive()`
to `min: 0`, which is **inclusive**, so the panel accepts `width: 0` while the
game skips it. A `0` produces a game-console warning and no panel row. Fixing it
needs an exclusive-bound marker in `FieldSchema` (`ipc.ts`, `prefabLoader.ts`),
so it is recorded here as a real gap rather than papered over.

**Cost accepted.** Nothing forces the two sides to agree. There is no test
asserting that the app's row and the game's warning describe the same skip; they
agree by construction and nothing enforces it if the summary drifts further from
the Zod schema.

---

## D27. The e2e loop skips by default, and says so out loud (Step 3d)

**Context.** The edit loop needs a real Electron main process, a display, a
built renderer bundle, a vite dev server for the game, and ~30–60 s of wall clock
for three page loads and four writes to disk. `vitest.config.ts` fixes
`pool: 'forks'` and `testTimeout: 30_000`, and that file is shared.

**Decision.** `scripts/run-e2e-edit-loop.mjs` is the real deliverable;
`packages/app/test/e2e/editLoop.test.ts` is a thin wrapper that (a) asserts the
runner and harness exist, (b) asserts the harness's **declared exit codes** match
the ones the runner interprets, and (c) runs the loop for real **only** when
`CF_E2E` is set and the game dev server answers. The default path **prints a loud
warning naming what is not proven**.

**Why exit codes are read from the harness's own source** rather than duplicated
as a constant: a real run reported as passed because `0` came back for the wrong
reason is the exact failure D24 is about. A changed harness fails the contract
test immediately.

**What a default `npm test` therefore does *not* prove.** Nothing about the
app↔game edit loop. The warning says so in those words rather than skipping
quietly, because a quiet skip is indistinguishable from a test that quietly
stopped testing.

**Verified for real** by running the runner directly (not the skip path):
`player_kart` before `[0, 0, 3]` → inspector edit to `[4.5, 1.25, -6.75]` → Save →
the **game rebuilt** the kart at `[4.5, 1.25, -6.75]` → Undo → Save → game
rebuilt at `[0, 0, 3]`. `scene.json` sha256 identical before and after.

**Found by breaking it — twice, in two different places.**

1. **Electron's ESM entry point does not support top-level `await`.** The harness
   exited silently with **no output at all** — not even its first `[stage]` line —
   because execution stopped dead at `await app.whenReady()`. Confirmed with a
   four-line probe that printed `MODULE_LOADED` and then nothing. This is the
   D16 lesson again in a new costume: the failure was invisible, so the only way
   to find it was to run the thing and notice that silence is not success.
2. **A green screenshot is not evidence of a green run.** An earlier agent's
   first capture produced three files that *looked* like races but were
   post-HMR-reload menu screens. The harness now polls the live `window.__game`
   state instead of sleeping on fixed timers, so a vite hot reload can no longer
   masquerade as a race.

**Known limitation, stated as a limitation.** The e2e asserts the position of
the **built scene object** the game's renderer draws
(`position.source === 'rendered-object3d'`), not the position of the `Kart`
instance *while a race is running* — the harness reads before a race begins, so
`drivingKartPosition` is `null`. The scene-to-object path is proven end to end;
"the kart on the grid, mid-race, moved" is not.

---

## D28. A pinned dependency can be re-pinned by an `npm install` — so it is checked (Step 3d)

**Context.** Agent 1 pinned the game's `three` to `0.180.0`, but
`packages/app/package.json` still read `^0.180.0`. The two *resolved* to the same
version, so nothing failed — and the caret is precisely the thing that lets them
diverge later.

**Decision.** Pinned `three` and `@types/three` exactly in
`packages/app/package.json` too, and added the `check:three` gate (D25) to
`npm run verify`.

**Why this is worth a gate.** The first `npm install` after a dependency is
pinned still rewrites the lockfile from the manifest. If the manifest says `^`,
the lockfile is free to drift the next time. The pin is only real when something
checks it on every run rather than trusting the manifest someone edited once.

**UI note.** `check:three` is a *dependency* gate, not a boundary or prefab gate,
so it is named separately rather than folded into `check:boundaries` — a failure
in it means "the two projects disagree about a library version", which is a
different diagnosis from "core imported the app".

---

## D29. A patch is previewed against a copy of the project, never against the project (Step 4)

**Context.** Core's `writeFileBlocks` / `applyEditBlocks` write as they go. That
is right for a caller that has already decided to commit, and wrong for two
things the Patch screen must do: preview a reply, and refuse an all-or-nothing
apply where one of four blocks fails.

**Decision.** `previewPatch` and `applyPatch` both resolve their reply against a
`mkdtemp` copy of the project (skipping `node_modules`, `.git`, `dist`), and only
`applyPatch` then calls `captureAndWrite` on the real tree — re-planning against
the live project immediately before writing, so the preview and the write cannot
disagree.

**Why.** "A preview writes nothing" should be true *by construction*, not by
remembering not to call anything that writes. `applyAnyway` then suppresses only
the syntax gate, leaving the real project touched exactly once.

**Known limitation.** The copy is O(project size) per preview. A project with a
large non-excluded asset folder pays that. Excluding more directory names is a
judgement about what a patch might legitimately target, and was not made here.

---

## D30. A gap the developer can see must also be in the text the AI reads (Step 4)

**Context.** `compileContext` built `prompt` before the handler checked which
requested files were actually on disk. A missing file therefore appeared in the
`gaps` list the developer sees and was **absent from the prompt entirely**. The
developer's screen said "I could not attach `src/nope.js`" while the AI received
a prompt with no mention of it and no reason to doubt the request was fulfilled.

**Decision.** The not-found files are stated *inside* the prompt, under a
`## NOT ATTACHED — requested but absent` heading, and the same sentences are
returned in `gaps` for the screen. One fact, both places.

**Why this one matters more than it looks.** An AI that asked for context and was
quietly given none is precisely the failure this app exists to prevent — and it
is invisible, because every individual surface looks correct.

---

## D31. KNOWN GAP — a line number in the trace skips the symbol check (Step 4)

**Context.** Core resolves a target file's section in order: **a line number
first**, and only if there is none does it look for a named symbol. So a stack
trace carrying `at foo (src/kart.js:5:11)` produces a slice around line 5 and the
symbol is never examined — a symbol that does not exist is silently unreported.

**Verified against core directly**, not inferred: same issue text,
`at totallyAbsentHelper (src/kart.js:5:11)` yields `gaps: []`, while the same
issue with no line number yields
`No function named "totallyAbsentHelper" was found in src/kart.js.`

**Consequence.** An AI asking about a symbol that is missing *and* quoted a line
number gets no refusal. It is told it was shown a function, and that function
exists — just not the one it asked about.

**Not papered over.** The obvious "fix" in the app layer is to scan the issue for
`identifier()` patterns and emit a gap when one is not found in the manifest. That
would invent diagnostics core did not produce, on a heuristic, and report a gap
for every ordinary mention of a helper name that legitimately lives in a
dependency rather than this project — worse than the current silence, because a
signal that is often wrong is a signal developers learn to ignore (SPEC R9).

**Where the fix belongs.** `buildTargetSection` in `compiler.ts`: check the named
symbol even when a line number produced the slice, and report both when the symbol
is absent. Core is not this step's file to change, so it is recorded here instead.

---

## D32. Two tests asserted old behaviour rather than correct behaviour (Step 4)

**Context.** Three tests went red when Step 4 landed. In each case the *test* was
wrong, and in two the wrongness was subtle enough to be worth recording.

- `prefabLoader.test.ts` asserted `size: { min: 0 }` for a Zod `.positive()`,
  with the comment "an exclusive check reported as a bound, because `FieldSchema`
  has no way to say *exclusive*". The test had **pinned the bug**. Step 4 added
  `exclusiveMin`; the assertion had to change to the truth.
- `screens.test.ts` asserted both screens were placeholders. A test asserting a
  screen *is* a stub must be deleted the moment it stops being one, and deleting
  it is exactly when nobody re-reads what it protected. Both now assert the real
  screen's shape.
- `problems.test.ts` expected `Go to instance 0` for a snapshot string naming
  `instances[0]`. That was the documented index-as-id limitation (D26), now fixed;
  it resolves to `track`, and a link that selects nothing is worse than no link.

**The rule this establishes.** A test that documents a limitation in a comment
is indistinguishable from a test that documents a *requirement*. When the
limitation is fixed, only the comment says which one it was. Both kinds must be
updatable, and the fix must update them.

**Not done:** the `fullFiles` and `savingsPercent` assertions were *also* wrong
but in the opposite direction — they assumed slicing always shrinks a prompt,
which is false for files under `MAX_WHOLE_FILE_LINES` (200). Core clamps
`savingsPercent` at 0 for exactly that reason. See D33.

---

## D33. `fullChars` is not guaranteed to exceed `chars` (Step 4)

**Context.** Two assertions in `handlers.test.ts` required `fullChars > chars`
and a positive saving. Both fail against a 16-line fixture: core sends a whole
file anyway once it is under 200 lines, so slicing saved nothing and the two
figures are equal.

**Decision.** Assert `fullChars > 0` and `savingsPercent >= 0`, and pin the real
behaviour with a fixture large enough to slice — a >200-line file where
`fullFiles: true` genuinely adds content.

**Why it matters.** An assertion that slicing always saves bytes sends the next
person hunting a bug in the compiler that is not there. The figure is a
comparison, and a comparison of equal things is a legitimate zero.

---

## D34. Four defects that only a screenshot could find (Step 4)

**Context.** Step 4's two screens were unit-tested and green — 55 context tests,
30 patch tests — and the app was still unusable on launch. Every one of these
passed `npm run verify`, because all four are invisible to a test that renders a
component in isolation and asserts on its markup.

**1. `Sidebar` disabled the screens it was supposed to enable.** `isScreenDisabled`
returned `true` for `context` and `patch` unconditionally, with the tooltip
"Coming in future steps" — long after both screens were built. Neither screen is
reachable by clicking. Now gated on `projectName === null`.

**2. `ProjectScreen`'s `$effect` fed itself.** The effect read `snapshot` and
called `addRecent`, which writes `recents`. Svelte re-ran it, which wrote again,
until `effect_update_depth_exceeded` killed the render tree — so the project never
opened, which is what *caused* symptom 1 to be invisible. Fixed with `untrack`,
which says what is true: this runs on mount, and its own output is not an input.

**3. `ContextScreen`'s `$effect` had the same shape.** `loadBrief` wrote
`briefMode`, which the mode radios `bind:group`. Same infinite loop, same fatal
error, reached as soon as the Context screen mounted. Fixed by not writing the
mode: the file's mode is still *reported* in the brief panel, but the radio state
belongs to the developer, who is the only one who should change it.

**4. A `<!-- … -->` marker inside a Svelte file comment closed the comment early.**
The header comment documented where the brief button goes by writing
`<!-- BRIEF BUTTON SLOT -->` inside itself. The inner `-->` ended the comment, and
every remaining line of the header rendered as **visible text at the top of the
screen**. The app looked broken in a way no assertion could see, because the
markup was correct — it was the comment above it that was wrong.

**Why this is a decision and not an anecdote.** A green suite is evidence about
the thing the suite measures. These four defects were all *outside* what any of
the tests measured: navigation gating, an effect's dependency graph, and a
comment in a header. The only thing that caught them was driving the real app and
looking at it. Screenshot evidence is a gate like any other — and its absence is
not evidence, it is a hole in the suite wearing a green tick.

---

## D35. An assertion has to be re-broken before it is believed (Step 4)

**Context.** The regression tests written for D34 passed. Then the bug they
exist to catch was re-introduced on purpose, and they passed again. A test that
cannot fail is not a test; it is a comment with a runtime cost.

**What was wrong, in order of how much it would have misled someone.**

1. The `$effect` check scanned only the effect's *body*. The real defect was
   `$effect(() => { void loadBrief(); })` with the write inside `loadBrief`, one
   call away — invisible to any amount of looking at the body.
2. So the rule was widened to "a function the effect calls must not write state
   the effect reads". That is still wrong, and wrong in the dangerous direction:
   the effect read **nothing**. Writing a `$state` notifies every effect that
   reads it, so a write anywhere in the effect's own call chain re-runs it
   whether or not the body mentions the name. The rule is **write**, full stop.
3. The assertion was then inverted: `expect(!bound.has(name)).toBe(false)`
   asserts the name **is** bound, while its failure message said the opposite.
   The message and the matcher disagreed, so the test failed on correct code and
   would have been "fixed" by deleting the assertion.

**The rule this establishes.** Before a new structural test is filed, re-break
the thing it watches and confirm it goes red. Both D34 regressions were checked
that way and both went red; the `briefMode` one named the right symbol in its
message, which is the only evidence that it is checking the right thing.

**Why a static check at all.** The real guarantee is behavioural — mount the
component, see whether it settles — and `svelte/server`'s `render` never runs
effects, so no component test can do it. A structural check is a second-best
guard, and like any second-best guard it has to be *demonstrated* to fire, not
assumed to.

---

## D36. Keyword and runtime-error filtering in symbol extraction (Step 4b)

**Context.** In `packages/core/src/context/compiler.ts`, `symbolFromText` searched
free text using `/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/` and picked the first match.
When a user entered common JavaScript error messages such as
`TypeError: Cannot read properties of undefined (reading 'foo')` or
`undefined is not a function`, the identifier extracted was `"undefined"`. The
compiler then looked for a function named `"undefined"`, which failed and emitted
`No function named "undefined" was found in <file>`.

**Decision.** Added `IGNORED_SYMBOLS` encompassing JavaScript, TypeScript, and
GDScript keywords, literals, and control flow identifiers (`undefined`, `null`,
`nan`, `true`, `false`, `while`, `switch`, `catch`, `return`, `throw`, `new`,
`typeof`, `void`, `delete`, `await`, `yield`, `function`, `func`, `class`, etc.).
Updated `symbolFromText` to scan across all calls via `text.matchAll`, skipping
ignored identifiers so real function names are extracted even when preceded by
runtime error descriptions.

---

## D37. Toast non-intrusive stacking, collapse, and problem routing (Step 4b)

**Context.** Toasts were rendered at the top-right without stacking limits or
truncation, obscuring page controls and headers. Furthermore, project-level warnings
and prefab parse errors were broadcast as ephemeral toasts, spamming the user and
competing with actionable operation feedback.

**Decision.**
1. Toasts are anchored to the bottom-right corner in a dedicated flex column with
   `pointer-events: none` on the container and `pointer-events: auto` on toasts.
2. Resting toasts are truncated to a single line with an ellipsis and an explicit
   `Dismiss` button. Multiline errors and file paths are hidden behind a `Details` toggle.
3. Only up to 3 toasts are shown at once; any additional toasts collapse into a
   `+{N} more` toggle button.
4. Project-opening problems and failed prefabs are routed directly into `snapshot.problems`
   and `snapshot.prefabs.failed`, surfaced in the `ProblemsPanel` rather than popup toasts.

---

## D38. Plain-English syntax error translation in Patch preview (Step 4b)

**Context.** When a patch block contained syntax errors, the Patch screen presented raw
tree-sitter or JSON parser strings (e.g. `MISSING ";"`, `ERROR: unexpected '}'`), which
read like compiler diagnostics rather than actionable error descriptions.

**Decision.** Added `translateSyntaxError(rawMessage, line, filePath)` in
`errorFormatting.ts`. It maps common parse errors to plain-language statements with line
numbers (e.g., `'Line 2: a { is never closed'`, `'Line 5: missing a semicolon ';''`,
`'Line 5: statement is missing a body (needs a ':' and an indented block)'`). The raw
parser diagnostic is preserved under an expandable `Details` toggle.

---

## D39. Context Screen reachability: sticky copy bar and collapsible sections (Step 4b)

**Context.** Large prompts in the Context screen required extensive vertical scrolling,
pushing the `Copy prompt` action out of view. In addition, the five distinct panels
crowded the screen when inspecting specific parts of context generation.

**Decision.**
1. Converted all five panels into native `<details class="panel" open>` elements with
   styled `<summary>` headers and rotating indicator icons.
2. Added a primary `Copy prompt` button in the action bar immediately adjacent to
   `Compile prompt`.
3. Added a sticky bottom floating toolbar (`.sticky-copy-bar`) that remains visible
   whenever a compiled prompt exists, showing character count, estimated tokens,
   percentage savings, and an instant `Copy prompt` button.

---

## D40. End-to-end Electron automation for Patch and Brief lifecycles (Step 4b)

**Context.** Unit tests alone could not guarantee that Electron's renderer, IPC bridges,
patch application, file-system transactions, and multi-file rollback functioned correctly
together against a real game project.

**Decision.**
1. Authored `scripts/run-e2e-patch.mjs` and `packages/app/src/electron/patch-harness.mjs`
   to drive Electron against `kart-dash-3d-v2`. Proves: single EDIT patch apply, byte-for-byte
   undo (sha256), redo, 2-file patch atomic apply and single-step undo, and bad-block
   rejection with zero bytes written.
2. Authored `scripts/run-e2e-brief.mjs` and `packages/app/src/electron/capture-brief.mjs`
   to verify One-shot and Interactive brief generation, `.contextforge/brief.md` disk
   contents, `NEED: <path>` detection, and dynamic file attachment in the compiled prompt.
3. Captured 17 high-definition screenshots in `screenshots/v4b/` and added vitest
   wrappers in `packages/app/test/e2e/patchLoop.test.ts` and `briefLoop.test.ts`.

---

## D41. Full-source attachment for AI requests, empty issue omission, and distinct visual states (Step 4b verification)

**Context.** When an AI requested a specific file via `NEED: <path>` or `CONTEXT INSUFFICIENT: Need <path>`, large files were truncated to a 200-line outline instead of providing the entire source needed to author a surgical patch. Additionally, compiling context without an issue included placeholder text `[Describe what is wrong]`, and e2e patch screenshots previously lacked distinct visual transitions between apply, undo, and redo.

**Decision.**
1. In `compiler.ts`, `extractFullAttachmentRequests` scans for `files`, `NEED: <path>`, and `CONTEXT INSUFFICIENT: Need <path>`. All requested files are attached in full (`kind: 'full'`), bypassing the 200-line truncation limit (verified with `src/track.js`). The attachment order is sorted alphabetically so compiled prompts remain strictly deterministic across runs.
2. If the issue box is empty, the `ISSUE:` section is omitted entirely from the prompt, eliminating placeholder text like `[Describe what is wrong]`.
3. In `PatchScreen.svelte`, successful patch application maintains the `applied` status while clearing the preview, displaying `<h2>Applied</h2>` and keeping Undo enabled with history counts.
4. In `patch-harness.mjs`, DOM assertions verify text and button states at every step (`1 step kept`, `Applied`, Undo enabled, Redo enabled, bad block refusal), ensuring identical screenshots fail the test. New proof captures are written to `screenshots/v4c/`.

---

## D42. Executable prefab bundling in renderer, CSP alignment, and Patch/Scene UI polish (Step 4b proof)

**Context.**
1. Karts and track in the 3D viewport rendered as red wireframe error placeholders rather than real Three.js child meshes because IPC `project:prefabs:scan` returned JSON serializable `PrefabSummary` objects without `create()` functions. Furthermore, dynamic ESM imports of browser-bundled prefab modules in Chromium failed under `script-src 'self'` CSP.
2. The Scene screen header bar overflowed horizontally with a scrollbar at 1600px width.
3. The Patch screen showed no distinct indicator when an applied patch was Undone.
4. The sticky Copy bar on the Context screen could overlap content without bottom padding.
5. New-file unified diff headers emitted `-0,0` which some parsers reject or format with an unwanted removed line.
6. Requested file attachments needed explicit size attribution in budget warnings and clear separation from runtime logs.

**Decision.**
1. Bundled executable browser prefabs via `bundlePrefabsForBrowser(root)` in IPC and loaded them into runtime registry via `loadPrefabBundle` in `Viewport.svelte`. Updated Content Security Policy in both `index.html` and `main.ts` to `script-src 'self' data:` allowing dynamic import of the bundled modules in Electron. Made `SceneScreen.svelte` reactively update its index via `subscribeRegistry`. Added `packages/app/test/viewport/realPrefabs.test.ts` proving kart instances render real child meshes (`isErrorMarker === false`) and only `hazardCrate` is a placeholder.
2. Formatted Scene header bar with `flex-wrap: wrap; gap: 8px; overflow-x: hidden;` and concise button labels (`Undo`, `Redo`, `Save`, `Reload`) with `aria-label="Save scene"`, eliminating horizontal scrolling at 1600px.
3. Added an explicit `Undone` state to `PatchScreen.svelte`, rendering `<h2>Undone</h2>` upon reverting changes and satisfying text assertions.
4. Added `90px` bottom padding to `ContextScreen.svelte` so the sticky Copy toolbar never occludes input or output.
5. Updated `packages/core/src/patch/diff.ts` so new file additions output `@@ -0,0 +1,N @@` with only `+` lines and `--- /dev/null`.
6. Updated context compiler to emit `Requested files: ...` separately from `RUNTIME OUTPUT:`, and detailed requested file character weights in over-budget notices.
7. Recorded all proof screenshots into `screenshots/v4d/` and verified with 3 consecutive `npm run verify` runs.

---

## D43. Truthful syntax messages, file-naming write reports, and screenshots that prove their own state (Step 4e)

**Context.**
1. tree-sitter records the expected token as the MISSING node's own `type`, but `grammars.ts` read it from the nearest named *sibling before* the insertion — a different question. An unclosed function reported "missing lexical_declaration" (the last thing that parsed) and an unclosed `if` reported "missing if_statement". `errorFormatting.ts` then mapped those grammar names onto fixed phrases, so a missing brace could surface as "expected a return statement": a diagnosis of a construct that was not missing at all. A wrong diagnosis sends the next AI turn and the developer to the wrong file, which is worse than no diagnosis.
2. `ipcHandlers.undo()`/`redo()` discarded core's `HistoryActionResult` and returned only a re-read `SceneSnapshot`, so `action.paths` never left the main process. The screen could only say "Previous changes were reverted" — a sentence that describes any undo, including one that reverted something the developer did not expect.
3. `script-src` carried `data:` (added in D42 so generated prefab modules could be dynamically imported). A `data:` URL can carry *any* script, so allowing it in `script-src` hands an injected string the ability to execute, which is exactly what `contextIsolation` and the policy exist to prevent.
4. The Inspector's `.vector-label` was `6.2rem`, wide enough to squeeze the z axis input to about two characters, and `.pane.inspector` is `overflow-x: hidden` at a 320px default — so a decimal rotation was clipped to something like `3.1`, and the third axis could be pushed past the pane edge entirely.
5. `capture-v4.mjs` queried `button.problems-header` and `.panel-toggle`, neither of which exists, behind `if (x)` guards that swallowed the miss. `00-problems-panel.png` showed the Problems panel **collapsed** while claiming to show it expanded, and `01b-context-panel-collapsed.png` came out byte-identical to `01-context-collapsible-panels.png`. Two screenshots that proved nothing while looking as though they did.
6. The applied-state screenshots captured only the 1600x1400 viewport, cutting the History panel off at the bottom, so the step count was never visible alongside the banner it explained.

**Decision.**
1. `describeMissing` in `grammars.ts` now reads `node.type` — the token tree-sitter actually recorded — with a `PLAIN_NODE_NAMES` map for the grammar names that would otherwise read as jargon, and falls back to the raw type rather than dropping it. `translateSyntaxError` shows the missing punctuation token verbatim (`Line 3: missing }`) instead of paraphrasing it, matching punctuation narrowly so it cannot swallow GDScript's "statement … is missing a body", and passes an already-plain phrase through untouched (the fallback used to rewrite core's "a name or identifier" into "a name or name"). Added `grammars.test.ts` cases for an unclosed function, an unclosed `if`, a missing `)` and a missing operand, each asserting the absent token *and* that the sibling's type does not leak in.
2. `HistoryActionOutcome` was added to `ipc.ts` carrying `snapshot` plus `paths`/`patchId`/counts; `afterHistoryAction` now threads core's `HistoryActionResult` through instead of dropping it. `store.undo()`/`redo()` resolve to `HistoryActionPaths | null` instead of `boolean`. `PatchScreen.svelte` renders Apply, Undo and Redo through one `writeSummary(verb, files)` helper, so the sentence cannot drift between them, and `applied` is cleared on every history step — the panel is an if/else-if, so leaving it set would show "Wrote …" above a revert that had just put those bytes back. `ShortcutTarget.undo/redo` were widened to `Promise<unknown>`: the keyboard path discards the result, and pinning the exact shape would have made every store change a shortcut-contract change.
3. `script-src` is now `'self' blob:` in both `index.html` and `main.ts`; `img-src`/`font-src` keep `data:` because those are inert payloads. `loadPrefabBundle` branches on runtime: the renderer builds a `blob:` URL (revoked in a `finally`), while Node — whose ESM loader cannot import a `blob:` URL at all — uses `data:`. The branch is on what the runtime supports, and the CSP is enforced where it applies. `contract.test.ts` asserts `script-src` names `blob:` and does **not** name `data:`, and that `img-src`/`font-src` still do.
4. `.vector-label` is `8.5rem` (fits `rotation (radians)` uncut), `.axis-field` has a `min-width: 4.5rem`, and the Inspector pane default is 380px. `layout.test.ts` computes the width a transform row needs from the two `rem` values and asserts the pane is at least that wide, so the three inputs cannot be squeezed again.
5. `capture-v4.mjs` queries the real selectors (`button.problems-toggle`, `details.panel`) and **throws** if the state it is about to photograph is not the state it claims — a missing element is a failed run, not a silent no-op. Because Svelte 5 flushes DOM updates on a microtask, the Problems check polls `aria-expanded` and `.problems-content` rather than sampling in the same tick as the click. The capture also selects an instance and asserts the rotation-z input lies inside the pane, which is what proves the truncation is gone rather than merely narrower.
6. `patch-harness.mjs` gained `scrollToBottom`, `assertHistoryPanelPresent` and `captureFullPage`. The full-page helper only resizes when the content genuinely exceeds the window — growing a frame that already fits would add empty pixels, not proof. The bad-block case now also asserts byte-identical contents (not just digests), that the *good* block's replacement text is absent (the sharp form of atomicity: one good block plus one bad block must write neither), that Undo is disabled, and that forcing a click on the disabled Apply button writes nothing. The two-file undo asserts byte identity for both files and the literal DOM string `Reverted 2 files: src/modes.js, src/settings.js`.
7. A bug introduced here and caught by running the app rather than by any test: the store returns `{ paths, patchId }` while the panel reads `.files`, so assigning it straight through made `writeSummary` throw on `files.length` and the Undo message never rendered at all. Fixed by mapping explicitly, and `patchScreenRender.test.ts` now pins the mapping and fails on the bare assignment — SSR never reaches `stepHistory`, so no amount of unit testing would have caught it.
8. All proof screenshots for this round are in `screenshots/v04e/` (14 from the patch harness, 18 from `capture-v4.mjs`, plus both JSON reports). Verified with 3 consecutive `npm run verify` runs (59 files, 1157 tests, all green) and two full `scripts/run-e2e-patch.mjs` runs against the real project on disk, both exiting 0 with `consoleErrors: 0`. The target project's two files were confirmed back at their original sha256 afterwards.



---

## D44. One list, one count: the Problems bar owns the header, and dedupe keys on content rather than a random id

**Context.**
1. The Problems UI showed two headers over one list: a collapsible bar reading `PROBLEMS (2)` and, expanded beneath it, the panel's own `PROBLEMS (6)`. Three separate derivations of one fact existed. The bar counted `snapshot.problems.length` — a raw `string[]` straight off IPC. The panel counted normalized `AppError` rows. The Outliner consumed a third list, `appErrors`, built inline in the screen.
2. The two numbers differed because `SceneScreen.svelte` passed **the same array twice** to `ProblemsPanel`: once as `snapshot` (whose `.problems` the collector reads) and again as the `problems` prop. `collectProjectProblems` derived each string at step 3 (resolved against the scene, so `instances[0]` became the real id) and again at step 4 (no scene passed, so the index stayed literal).
3. The existing dedupe could not catch it, and the reason is the actual defect. Deduplication keyed on `err.id`, but string problems are converted by `toAppError` → `createAppError`, which **mints a random id** when given none (`errors.ts:41`, `Math.random().toString(36)`). Two derivations of one string therefore had two different ids and both survived. Two genuine faults about the same instance, and one genuine fault seen twice, were indistinguishable to that check.

**Decision.**
1. `ProblemsPanel` no longer renders a header. It is a list of rows; the Scene screen's bar is the single header and the single count, driven by one `$derived` (`problemCount = appErrors.length`) — the same list the Outliner badges from, so the bar, the panel and the outliner can no longer disagree.
2. `collectProjectProblems` dedupes on **content** (`scope` + `instanceId` + `short`) in addition to id. This is what actually fixes the doubling: it catches a repeated fault regardless of what id it was minted with. Two distinct faults survive — a repeated message across two instances has a different `instanceId`, and two different messages have different `short` text.
3. Step 3 skips its derivation when `problems` is already a normalized `AppError[]` (the shape the screen passes), and step 4 skips any raw string already present in `snapshot.problems`. Both are separate guards because the two copies differ in `instanceId` — the one field that makes the *resolved* copy the correct one — so content-keying alone cannot merge them.
4. The panel takes a `count` prop and throws in DEV when it renders a different number of rows than its parent counted. Two renderings of one fact, mechanically pinned together; the unit test covers CI, the tripwire covers a real browser run where no test executes.
5. Seven existing assertions on the header string `Problems (N)` were rewritten as counts of `problem-item` elements. This is the stronger assertion — the header was a label of the count, the rows are the count — and it is what made the duplication visible in the first place.
6. Two fixture bugs were found while writing the regression tests and are worth recording, because both would have produced a test that passed for the wrong reason: an unregistered prefab adds a legitimate "Missing prefab" row (inflating the count), and a schema narrower than the instance's params flags `length` and `color` as unknown keys (inflating it further). The fixture now registers `trackSegment` with the full property set.

**Also settled in this phase — the `Corrupted GLTF buffer` error.** It is neither a bad asset nor a loader bug: `kart-dash-3d-v2/prefabs/hazardCrate.ts:19` is a literal `throw new Error('Corrupted GLTF buffer: failed to decode geometry')`, a deliberate SPEC R9 fixture exercising the loud-failure path. It loads no file. The real glTF importer lives in the *parent* `dark matter` repo (`Engine/Assets/src/GltfImporter.cpp`), which maps all ten `cgltf_result` codes to distinct strings, distinguishes parse failure from `cgltf_load_buffers` failure, and is covered by `Tests/test_asset_pipeline.cpp` cases for a nonexistent path and a missing texture. Nothing to fix in either direction; the message is a simulation, and `docs/` should say so so nobody debugs a loader that was never involved.

---


---

## D45. The renderer may not import core as a value, so the Graph screen's analysis runs in the main process

**Context.**
1. Step 5 asks for a file-level dependency graph, a focus mode and an orphans
   drawer. All three need arithmetic over a `DependencyGraph`: a depth-bounded
   walk, an edge filter, a reachability sweep. None of that needs a DOM.
2. `vite.config.ts` lists `@contextforge/core` in `rollupOptions.external`, with a
   comment stating the reason: "All renderer imports of @contextforge/core are
   `import type` (erased at build time). Externalizing prevents Vite from
   accidentally pulling in tree-sitter, node:fs, node:path — which are not
   available in the renderer sandbox."
3. That comment was true when written, and the Graph screen was the first thing
   to make it false. Importing `focusNeighbourhood` as a value left a bare
   `@contextforge/core` specifier in the bundle that the browser sandbox cannot
   resolve, and **the entire app failed to mount** — no error, no console
   message, an empty window. Isolating it took a bisect through the whole app:
   the bundle was byte-identical, the build clean, and the failure reproduced
   even with the screen's entire body stubbed out, which narrowed it to the
   imports alone.
4. Two extractor bugs were found on the way, and both made the graph lie rather
   than fail. `resolveCandidates` treated an explicit extension as final, so a
   TypeScript project's `import './kart.js'` — the specifier every TS project
   writes, pointing at a `.ts` file — resolved to nothing and its entire import
   graph came back empty. `resolveScriptSrc` had the same gap for a Vite
   `index.html` loading `/src/main.js` when the file is `src/main.ts`, which
   dropped the graph's **root** and made everything beneath it look orphaned.
   On the real kart project, 7 of 37 files were reported unreferenced before the
   fixes; 4 are, and the 4 are correct.

**Decision.**
1. All graph analysis lives in `packages/core/src/graph/analysis.ts` and is
   reachable headlessly: `focusNeighbourhood`, `edgesWithin`, `findOrphans`,
   `summariseGraph`. The renderer imports core for **types only**, and the
   main process returns the summary, the orphan list and the neighbourhood over
   IPC. The alternative — bundling core's analysis into the renderer — would pull
   the Node-only parts of core across a boundary the build config exists to keep
   them out of.
2. `findOrphans` reports a **reason**, not just a list: `entry_point`,
   `unreferenced`, or `unreferenced_asset`. "Orphan" invites "dead code, delete
   it", and a game's `index.html` and `main.ts` are unreferenced by construction.
   A drawer that flagged them without distinguishing them would be actively
   misleading.
3. `focusNeighbourhood` walks **both** edge directions. A developer editing
   `kart.ts` needs the two karts that import it as much as the modules it
   imports; a dependency-only walk answers a different question than the one
   asked.
4. `focusNeighbourhood` keeps the **smallest** distance when a node is reachable
   by several paths, and `edgesWithin` drops any edge leaving the neighbourhood —
   a line to a node that is not drawn reads as a bug in the graph.
5. Four renderer bugs, none of which a unit test could have caught (there is no
   jsdom in this repo), and all four of which were found only by running the app:
   - **Cytoscape attribute selectors need quoted values.** `node[focus = true]`
     throws at draw time and leaves the canvas empty whenever focus mode is on.
     `screenRegressions.test.ts` now walks every attribute selector in the file.
   - **A `$state` proxy cannot cross `ipcRenderer.invoke`.** Structured clone
     cannot clone one, so every focus click failed with "An object could not be
     cloned" — turned by the store into a refusal sentence on an otherwise empty
     screen. Fixed with `$state.snapshot`; the deep copy is the honest cost.
   - **A `$derived` read immediately after an `await` is stale.** Svelte
     recomputes only on a flush, so `sync()` pushed the previous element set and
     the canvas went blank on every focus change. `sync` now takes its elements
     as arguments and cannot read a stale value.
   - **Cytoscape's `add` is a no-op for an id already present.** The natural
     remove-then-add element sync therefore merged with prior state: "Show all
     files" painted 17 of 37 nodes with zero edges. `sync` builds the whole
     element set fresh and swaps it in wholesale.
6. A fifth, in the harness rather than the app: `process.exitCode = 1` set in a
   `catch` was lost when `app.quit()` tore the process down, so a failed run
   printed `FAILED` and exited **0**. It now sets the code first and quits on the
   next tick. A screenshot harness that cannot fail is not a harness.
7. `findOrphans` was written twice before it was right, and both wrong versions
   failed in the direction that hides bugs. Seeding the sweep from "has no
   dependents" reports every leaf's *dependencies* as orphans. Seeding it from
   the same set but marking roots as reached reports nothing at all. The correct
   version seeds from nodes with no incoming reference, sweeps **forward** along
   dependencies, and does not mark the seeds themselves — because a root is also
   a candidate orphan, and those are different questions.

---

---

## D46. The New Project gate is core's `checkBrief` over IPC, and the flow stops at the prompt

**Context.**
1. Step 5d asks for a three-step New Project flow where the scaffold prompt
   cannot be copied until the game idea is filled in.
2. `checkBrief` already exists in `core/src/scene/template.ts:88`, exported with
   the note *"so the UI (Step 4) can show the same list the CLI would, instead of
   reimplementing the rules and drifting from them."* It enforces: a non-empty
   `name` matching a plain-folder-name pattern; a non-empty `idea`; that the idea
   is not one of ten placeholder strings; and that it is at least 20 characters.
   `generateProject` throws `IncompleteBriefError` on exactly these.
3. The renderer cannot import core as a value (D45), so the rule cannot be called
   in the Project screen directly.

**Decision.**
1. The gate is `checkBrief`, asked over a new `project:scaffold-problems`
   channel. `canCopy` is `name !== '' && idea !== '' && scaffoldProblems.length === 0`
   — the emptiness checks are not redundant with `checkBrief`, they cover the
   window before the first fetch resolves, so the button is never briefly enabled
   while the real answer is in flight. It also **fails closed**: if the fetch
   refuses, the reason becomes the problem list and the button stays disabled.
2. Two channels, not one. `project:scaffold-prompt` **refuses** an incomplete
   brief with `IncompleteBriefError`'s own sentence; `project:scaffold-problems`
   **answers** with the list. "Incomplete" is the expected answer on the second
   channel, so a refusal there would be a second way of saying the same thing and
   the screen would have to handle both shapes.
3. The prompt builder (`buildScaffoldPrompt`) is a **pure** function, separate
   from any writer, so a screen can preview before committing — the same split
   `buildBriefMarkdown` / `generateBrief` makes.
4. The prompt lists prefab rules **read from `PREFAB_RULES`** rather than written
   out in prose. A rule added to the linter and not to the prompt would let an AI
   break it, with the linter the only thing saying so.
5. **The flow stops at the prompt.** It does not call `generateProject` or write a
   folder. Step 1 picks a *parent* with `pickFolder`, which is deliberately
   restricted to `showOpenDialog` so the main process stays drivable headlessly
   (`pickFolder.test.ts` asserts both that exact options object and that
   `ipcHandlers.ts` imports no Electron). A native create-folder dialog needs new
   wiring at nine enumerated points and would weaken that isolation. Creating the
   project is a separate decision, and this phase did not make it.
6. Two things are **not** proven and are logged as such: the clipboard write
   itself (no jsdom, and neither existing clipboard call site has a test), and
   the flow's behaviour once a project is actually generated.

---

---

## D47. A generator refuses to overwrite, and an extractor survives one bad file

**Context.**
1. Phase 5e asked for the empty graph, a 1,000-file graph, and broken folders to
   be tested and whatever breaks to be fixed. A subagent probed all three
   empirically — by writing throwaway projects and running the real functions,
   not by reading them — and found two defects that reading had not.
2. **`generateProject` destroyed work.** Its doc comment claimed *"Existing files
   are never overwritten: a generator that silently replaces a developer's
   `prefabs/cube.ts` would be a data-loss bug"*. There was no check making that
   true; `writeFileSync` ran unconditionally. Generating twice over an edited
   folder silently replaced three files with the template. The comment described
   the intended behaviour and the code did the opposite, with nothing between the
   two to say so.
3. **One unparseable file ended the extraction.** `parseJsModule` throws when
   tree-sitter cannot parse — a half-written file, one saved mid-edit, one in an
   unexpected encoding. The throw propagated out of `extractJsProject`, so a
   single bad file out of a thousand produced *no graph at all* and an error
   naming a file the developer may not have been looking at. Everything else was
   fine, which is what made it invisible.
4. A path that exists as a **file** rather than a folder returned
   `{nodes: [], edges: []}` — byte for byte identical to a real project with no
   files in it. The missing-folder guard fired; the wrong-kind-of-path guard did
   not exist.

**Decision.**
1. `generateProject` refuses **totally**, and does so **before the first write**,
   naming the conflicting files. Ordering is part of the guarantee: writing one
   file and then discovering a second exists would leave a partly-written
   template, and the one already replaced is the one the developer cannot get
   back. The refusal is total rather than per-file because skipping what it found
   and writing the rest leaves a *half* template, which is harder to reason about
   and much harder to undo. Files the generator does not own are irrelevant, so
   pointing it at a folder that also holds `src/` is fine.
2. `extractJsProject` catches a per-file parse failure, **skips that file**, and
   reports it through a new optional `onUnparseable` callback. Skipping rather
   than substituting an empty contract is the substantive part: an empty contract
   places the file in the graph with no exports and no imports, which reads as
   "this file imports nothing" — the plausible-looking wrong answer SPEC R9
   exists to prevent. Its absence is honest, and the reason is shown.
3. The callback is a **parameter, not a return field.** `DependencyGraph` is the
   manifest's public schema; adding a field would change every validator and
   every canonical hash.
4. `extractJsProject` now refuses a path that is not a directory, so "missing"
   and "wrong kind of existing" behave alike. `statSync` is used rather than
   `existsSync`, returning false on a permission error — a folder the process
   cannot stat is not one it can read. The one thing this must never do is
   report a file as a directory.
5. **Not fixed, measured and logged:** `findCycles` is super-linear — 33× for a
   10× input — because every detected cycle is canonicalised by
   `[...cycle].sort().join('|')`, so a 991-node cycle costs O(n log n) to key and
   there are 99 of them. It is 11 ms at 1,000 files and 34 ms at 2,000, so this is
   a complexity note rather than an urgent fix. The real change is to work over
   strongly-connected components, which is a rewrite rather than a patch.
6. Also verified *not* broken, and recorded so the next person does not re-probe
   it: an empty project, invalid UTF-8, a directory named `x.js`, a symlink loop
   (which **terminates** — it was a real hang risk), and every app-layer refusal.
   A folder **deleted after opening** returns a clean refusal rather than stale
   data.

---


---

## D48. An asset reference earns a node only once the file exists: drop it, and report it

**Context.**
1. The asset path in `extract/js.ts` created a node for every reference. The
   import path had always checked the file existed first — `resolveSpecifier`
   returns `null` for a path that is not on disk, and `resolveCandidates` has an
   `existsSync` guard at `js.ts:257`. The asset path had no check at all.
2. The consequence: `kart-dash-3d-v2` produced **37 graph nodes, 8 of which were
   files that did not exist**. All eight were screenshot filenames in
   `capture-game.mjs`, which writes them outside the project. A node in the graph
   is a claim that the file exists and is part of the project; these eight nodes
   were false claims, and nothing anywhere said so. They were also *not* reported
   as orphans, because something did reference them — so the drawer's count of 4
   unreferenced files looked reassuring while a fifth of the graph was phantom.
3. The behaviour was pinned by a test. `js.test.ts` asserted an `asset_ref` edge
   to `models/character.glb`, and the fixture had a slot contract for it but **no
   `.glb` file**. The test's own comment recorded the oddity and accepted it.

**Decision.**
1. **No node and no edge; the problem string is the only record.** The edge is
   what makes a file look connected to a project, so keeping it would preserve
   exactly the claim being removed. An edge pointing at a node that does not
   exist is also a *dangling* edge, which every consumer would then have to
   special-case; `danglingEdges()` is now empty on the real project, and a test
   asserts it stays that way.
2. The report is a second `onMissingAsset` callback beside `onUnparseable`,
   carrying `{ from, asset, reason }` and a sentence a developer can act on
   without opening anything: `src/foo.js references assets/x.png, which does not
   exist`. Two callbacks rather than one because they answer different questions —
   "I could not read this" versus "this points at nothing".
3. The callback is a **parameter, not a return field**, for the reason D47 gave:
   `DependencyGraph` is the manifest's public schema.
4. The **Problems panel is not touched.** It reads `SceneSnapshot.problems`, which
   is built in `openProject`/`loadScene`; adding a field there is a change to a
   public schema with its own validators, which is not "if it fits without new
   design" — it is a schema migration. The Graph screen already reports it, and it
   is the screen where a missing file is legible, because the whole question is
   "what is in this project". Left out deliberately, not overlooked.
5. The **Missing files list is collapsed by default**, unlike the unparseable
   banner. A project can legitimately have a few of these — a dev harness writing
   screenshots outside the project is the common case — and an always-expanded
   list pushes the graph off the screen, which is the thing the developer opened
   the screen to look at. The count is always visible; the detail is one click.
6. The test fixture gained a real `models/character.glb`. The two tests that
   failed were not wrong to assert an asset node for a referenced GLB — they were
   asserting it against a fixture that did not contain the file, so they had been
   passing **on the bug**. Writing the file makes them test what they claim. Its
   contents are a text placeholder on purpose, and say so: the slot contract is
   read from `character.slot.json`, the extractor never opens a `.glb`, and a
   plausible-looking binary header would suggest the tests depend on content they
   do not read.
7. **The eight are not suppressed.** `capture-game.mjs` genuinely references
   files that do not resolve from the game root, so the honest report is eight
   warnings. Hiding them would make the graph look cleaner and the project more
   broken than it is.

**Effect on the real project:** 37 nodes → **29**, 46 edges → **38**. Orphans stay
at 4 and `danglingEdges` is 0. One side effect worth recording: `capture-game.mjs`
changed from `entry_point` to plain `unreferenced`, because `findOrphans`
classifies by whether `depends_on` is non-empty and its only dependencies *were*
the eight phantom assets. That is the classifier being honest — the file
genuinely imports nothing — and it is why the drawer's per-row reason matters.

---

---

## D49. Graph labels: stagger on row geometry, hide what still collides, always label the singled-out node

**Context.**
1. The full graph's labels were unreadable. `src/main.js` fans out to 17 siblings;
   `breadthfirst` lays them on one line about 48px apart; 17 labels of a full path at
   font-size 9 do not fit there. The screenshot read `src/browserscenebundler.js` and
   `src/resources.js` as one smear. The graph was correct; the screen was not usable.
2. There was no rule anywhere — the label was `node.id` unconditionally, set in the
   Cytoscape style block. Nothing about it was testable.

**Decision.**
1. **The rule is a pure function in core, `core/src/graph/labels.ts`.** Not in the
   component: a rule that lives only inside a Svelte file is a rule nothing can
   assert, and there is no jsdom here so a test cannot mount a component. Same
   reasoning as D44.
2. **Priority order per node:** singled-out (focused, selected or hovered) is always
   drawn at its **full path** in lane 0; otherwise the basename is drawn at lane 0 if
   it fits, at lane 1 (staggered) if half of it fits, and not drawn otherwise.
3. **Stagger before hiding, in that order.** Hiding everything on the full graph would
   leave a default view that is a field of unlabelled dots — correct, and useless for
   the question the screen was opened to answer.
4. **The singled-out case is unconditional**, and it is the load-bearing half.
   Decluttering by hiding every label is a common, defensible move, and it is wrong
   here: clicking a node is how a developer asks what it is called, so a screen that
   shows nothing on click has failed at the one job the click was for.
5. **Overlapping is worse than absent**, because an absent label is recoverable by
   hover and an overlapping one is not. Every threshold therefore carries a **1.25x
   safety margin**: a label flush against its neighbour is not readable either.
6. **Widths are measured per node from the DOM**, not estimated from a character
   count and not taken from the widest name in the project. The widest-name version
   was tried and drew a graph with **no labels on it at all**: `playerSceneLoader.js`
   is 108px, the row gives 96px across two staggered slots, `108 x 1.25 > 96`, so
   every label was judged too wide. Two names 60px apart were being measured with one
   yardstick, and the yardstick was the longest one.
7. **`pixelsPerSlot` is measured from the laid-out positions**, not computed as
   `canvasWidth / nodeCount`. The division guessed 54px for a row whose nodes are
   48px apart — a 12% over-estimate, so every label believed it had 6px more room
   than it did. The capture harness is what found this; no unit test could have,
   because the wrong number was the number the test was given.
8. **Lanes come from each node's index within its row**, read off the laid-out `y`
   and `x`. They do **not** come from the order labels are drawn in: that order
   changes as soon as `dropCollisions` hides one, so a counter desynchronised from
   the geometry and a row meant to alternate `0,1,0,1` came out with 14 of its 18
   labels in lane 0, each 48px from its neighbour instead of 96px. Every surviving
   label was still stacked. All tests passed, because the tests have one row and
   nothing dropped.
9. **A second pass drops labels that still collide with their same-lane predecessor.**
   Per-node widths are necessary but not sufficient: two labels that each pass a
   96px test can still collide in the 96px they share. The test is **pairwise**, not a
   running sum — each label has its own gap ahead of it, and a running sum dropped 14
   of 18 labels on the real graph.
10. **The renderer mirrors the rule** in `renderer/graph/labels.ts`, because
    `@contextforge/core` is `external` in the Vite renderer build and core imports
    `node:fs` and tree-sitter. The precedent is `renderer/viewport/rng.ts`. The
    duplication is made safe by a test that imports **both** copies and compares them
    over ~3,300 input combinations, including both accepted shapes for the width and
    row-index maps. It found a real divergence: the mirror forced lane 0 when no row
    geometry was supplied, unstaggering every caller that omitted it.
11. **A hand-written `svelte-check` substitute was tried and deleted.** It was meant
    to catch undefined identifiers in `.svelte` files, which `tsc` does not read. It
    reported ~200 false positives, and after those were fixed it *still* failed to
    notice the very bug it was written for — `applyLabelDecision` reaching for `nodes`,
    a parameter of `sync` that is not in scope in it. A linter that looks like a
    safety net and catches nothing is worse than none. What catches it instead is the
    existing console-error assertion in the capture harness, which now prints each
    error and its source. `svelte-check` is the real fix and is a separate decision.

**Effect on the real project:** 26 of 29 nodes carry a label. The three without —
`scene-manager.js` (86px), `prefabs.js` (70px) and `characters.js` (70px) — are
exactly the ones that cannot fit 96px with margin beside a same-lane neighbour, and
hover shows each at full path. `main.js` fits its slot outright and is drawn at lane 0.

**Known limits, stated rather than hidden.**
- The rule assumes labels within a row are laid out left to right, which `breadthfirst`
  guarantees. A layout that placed a row out of order would get lanes from `x` and still
  be correct, because the row index is measured from the positions, not assumed.
- Lane 0 and lane 1 are two fixed vertical offsets. A third lane would help a graph
  with much longer names; nothing here needs it, and it is not pre-built.
- A label is measured at the current font size only. Zooming the canvas does not
  re-measure, so at a large zoom the margins are proportionally looser.

---

---

## D50. `svelte-check` is in `verify`, and it found four live bugs the first hour

**Context.**
1. `tsc --build` does not read `.svelte` files. `packages/app/tsconfig.json`
   excludes `src/renderer` on purpose, so an undefined identifier in a component
   was invisible to the type checker, to the unit tests, and — until now — to every
   gate in `npm run verify`.
2. It was not theoretical. `applyLabelDecision` in `GraphScreen.svelte` reached for
   `nodes`, a parameter of `sync` that is not in scope in it. Every one of the
   1,270 tests passed; the only evidence was four `ReferenceError`s in an Electron
   capture run. A hand-written substitute linter was tried in D49 and **deleted**,
   because it reported ~200 false positives and, once those were fixed, still did
   not notice that exact bug.

**Decision.**
1. **`svelte-check@4.7.6` is a pinned `devDependency`** and `npm run check:svelte`
   is the fourth stage of `npm run verify`, after `typecheck` and before the tests.
   Pinned rather than `npx`, because an `npx` call downloads a different version on
   every machine and a gate that is not the gate catches nothing.
2. **`packages/app/tsconfig.svelte.json` is a separate config** for the renderer,
   and is deliberately **not** in the `tsc` project graph — adding it to
   `references` would make `tsc` try to compile `.svelte` files.
3. **`skipLibCheck` is on.** Without it, four third-party declaration-file defects
   fail the build — two in `@types/three` (`GPUTexture` is not in this TypeScript
   version's DOM lib) and two in Svelte's own `esrap` resolution. None can be fixed
   from this repo, and a gate that cannot go green gets ignored.
4. **`packages/app/svelte.config.js` was added.** `svelte-check` does not read
   `vite.config.ts`; without a Svelte config it reports "No Svelte configuration
   found in vite config" once per component — twelve copies of one missing-file
   error, which buried the thirty-odd real ones underneath.
5. **`--threshold error`, not `--threshold warning`.** Two warnings are known and
   documented below. Failing on them would mean silencing them, and silencing them
   would hide the next real one.

**What it found. Four of these were live bugs, not type noise.**

| Defect | Effect |
|---|---|
| `Viewport.svelte` sent `transform:` where core's `SceneEdit` names the field `patch:` | `edit.patch` was `undefined`, so **dragging a gizmo moved nothing** — silently, because the guard in `setTransform` checks the instance exists, not that the patch has content |
| `readBrief` returned no `stats` while the brief panel read `brief.stats.nodes` | Reopening a project showed four count rows reading `undefined` |
| `brief.markdown` read inside an async clipboard handler | `{#if brief !== null}` does not narrow inside a closure; the component can re-render first. A real, if rare, crash |
| `store.notices` typed `Notice[]`, holding `LiveNotice[]` | Six `notice.id` reads in `App.svelte` were reading a property the type did not have |

Plus two type errors with no runtime effect: `Result.value` at six call sites
(`refusalOf` cannot narrow a union — a method call does not narrow, only a
discriminant check written at the use site does), and `?: string` under
`exactOptionalPropertyTypes`.

**Decisions taken inside the fix.**
- **`store.valueOf(result)` was added rather than rewriting six call sites** to
  `if (!result.ok) { … return; }`. Both work; each site wants the reason *and* the
  branch, and `refusalOf` is how it gets the reason. The alternative was
  considered and rejected as duplicating the same union-narrowing six times.
- **`briefStatsFrom` reads the counts back out of the markdown** rather than
  re-extracting the project. The file on disk is the record of what was handed to
  the AI; recomputing would report the counts *now*, which is a different and wrong
  number, and it would be a full project scan on what the screen treats as a cheap
  read. `BriefResult.stats` is therefore nullable and the panel omits the rows when
  it is null — zeros would be a count, and "we could not read it" is not one.
- **`ScreenId` moved to `Sidebar.svelte`.** It was one union in `App.svelte` and a
  bare `string` in the sidebar, so the sidebar's `onSelect` could not accept
  `App.svelte`'s handler. The producer of an id now owns its type, which is the
  "one list, one owner" rule D44 applied to the Problems bar. Two regression tests
  read the union from `App.svelte` and were updated to read it from its owner.
- **`Viewport`'s dead `problems` prop was removed, not kept with a corrected
  comment.** It was documented as "shown as a notice but not rendered", which was
  **not true** — nothing read it. The comment is why it survived: the doc said the
  value was used, so the dead prop read as a decision. `SceneScreen` no longer
  passes it.
- **`problems` is a stated gap.** The prop was accepted and unused; if the notice
  is wanted it should be built and the prop restored with a test.

**Known warnings, deliberately left reporting.** Two
`a11y_no_noninteractive_tabindex` on the Outliner/Inspector panel resizers in
`SceneScreen.svelte`. They are `<div role="separator">` with `aria-orientation` and
a live `aria-valuenow`, and the `tabindex="0"` is what makes the separator
keyboard-reachable — which is the entire point of `aria-valuenow`. Svelte 5.57.1
does not honour a multi-code `svelte-ignore` for this rule, so it is recorded in
`AI.md` under Known gaps rather than suppressed. `verify` runs at
`--threshold error`, so they do not fail the build.

**Lesson worth stating.** Every one of these was invisible to `tsc`, to the unit
tests, and — in two cases — to a screenshot. The four that mattered were found by a
tool that was not there yesterday. A gate nobody ran is not a gate, and a check
that reports false positives is worse than no check, because it teaches people to
ignore it.

---

## D17–D19. Reconstructed from the references that cite them

**These three entries were never written.** They were cited by live code before the
decision log existed, and no record of them survives anywhere:

- `docs/DECISIONS.md` jumps D16 → D20 in every commit that contains it.
- `git log --all -S"D17"` finds the citation in `package.json` from the initial
  import and never an entry.
- The one dangling commit (`dba9fa7`, a stash of `step5-all`) has the same gap.
- No dangling blob contains a `## D17`, `## D18` or `## D19` heading.

So each is reconstructed **only from what the code proves**, and each says so. These
are not the original reasoning — nobody can recover that — and they are labelled
rather than passed off as records.

### D17. `--legacy-peer-deps` is the documented fallback, and it is not needed

**Reconstructed from `package.json:14,16` and `docs/DEPENDENCIES.md`.**

`tree-sitter-typescript@0.23.2` and `tree-sitter-gdscript@6.1.0` declare peer
dependencies on `tree-sitter@^0.21.x`, while `packages/core` declares
`tree-sitter@^0.25.1`. Installing the two together needs `--legacy-peer-deps`.

**But it is not needed for this repo's install path, and the docs already say so.**
`docs/RUNNING.md` records `npm ci` and `npm install` both exiting 0, and why: the
lockfile is v3 and already records a valid tree, so npm never re-checks the peer
ranges. The flag matters in exactly one case — if `package-lock.json` is deleted.

**One correction to the existing docs, found while checking.** `DEPENDENCIES.md:19`
says tree-sitter is "pinned to the 0.22.x line"; `packages/core/package.json`
actually declares `^0.25.1`. The peer conflict is real; the stated pin is not what
the code does. The pinning of `three@0.180.0` is a different decision and is
covered by D25 and D28.

**Note.** `package.json:14` and `:16` cite D17 for the peer-dependency story, which
is what this entry reconstructs. `DEPENDENCIES.md:19` also cites it and is wrong on
the version; that line is left as-is here rather than edited under a D17 heading,
because it belongs to the dependency audit, not to this entry.

### D18. Key a generic event type by what the call site holds

**Reconstructed from `packages/app/src/ipc.ts:800-824`, which cites D18 by name.**

There are two event maps in `ipc.ts` and they are easy to confuse: `EventName` is
the **value** (`'app:notice'`) and `EventKey` is the **key** (`notice`). A generic
constrained by the wrong one resolves the payload type to `never`, which surfaces as
a baffling `not assignable to parameter of type 'never'` at the call site rather
than as an error where the mistake is.

So the value-keyed and key-keyed forms have **distinct names** and separate
documentation, and `IpcListener` is constrained by the value because a subscriber
writes `deps.listener(EVENTS.notice, …)` — `EVENTS.notice` is the string.

### D19. Scene shape is checked before scene relations, and only shape failures are reported

**Reconstructed from `packages/app/test/shell/backend.test.ts:263-268`, which cites
D19 by name, and `packages/core/src/scene/sceneFile.ts`.**

`validateScene` returns as soon as Zod rejects the shape. The cross-field rules —
duplicate ids, parent cycles, missing parents — need a *parsed* scene, and there is
not one when the shape is wrong. So a malformed document reports only its shape
failure.

This is a deliberate limit rather than an oversight, and the test says so: a change
that starts reporting both is a visible improvement rather than a silent one.

**One correction found while checking.** `packages/core/src/scene/scene.schema.ts:14`
says the cross-field rules live in `superRefine`. They do not — `validateScene`
calls a hand-written `checkRelations` **outside** the Zod schema, because each rule
is a statement about the *set* of instances rather than about any one field, which
Zod's tree types cannot express. The comment describes a design the code moved away
from; the code is right and the comment is stale.

---

---

## D51. One containment helper, and a project root the renderer cannot name

**Context.** Three audit findings, one shape. PATCH-2/SEC-3, SEC-1, SEC-2, SEC-4,
SCENE-4 and NEW-1 are all the same mistake in different clothes: a project-relative
path arrives from outside, and something checks it lexically when it needed to be
checked against the filesystem. `realpathSync` appeared **nowhere** in the repo
before this.

**Three audit claims were wrong, and are corrected here rather than fixed.**

1. **The `### EDIT:` symlink claim is FALSE on this branch.** `copyIntoScratch`
   skips symlinks, so the scratch has no link, the block cannot resolve, and the
   whole reply is refused. What actually escaped was `### FILE:` — *creating* a new
   file through a link, because the scratch materialises the missing link as a real
   directory. Fixing a hole that is not there would have been a change with no
   evidence behind it.
2. **`NEED:` with an absolute path does not escape.** The read was `join(root, p)`,
   and `join` treats an absolute segment as relative. `join` *does* normalise `..`,
   so traversal worked, and symlinks worked because nothing resolved at all. The
   fix covers both; the absolute case was already inert.
3. **The gizmo `transform:`/`patch:` bug (D50) THREW a `TypeError`, it did not
   "silently do nothing".** The IPC wrapper caught it and the developer saw a
   refusal. Recorded because D50's commit message says otherwise and a future
   reader will believe whichever they read second.

**Decision.**

1. **One helper: `resolveInsideRoot(root, relPath)`** in
   `core/src/fs/resolveInsideRoot.ts`. It resolves the **nearest existing
   ancestor** through `realpathSync` and refuses anything landing outside
   `realpathSync(root)` — symlinks, dangling symlinks, `..`, absolute paths. The
   ancestor is what makes `### FILE:` possible: a file that does not exist yet has a
   parent directory that does.
2. **Every reader and writer routes through it:** patch edit blocks, patch file
   blocks, `compileContext` files, `NEED:` paths, `targetFile`, history writes and
   undo, `generateProject`, `validateModelSlot`. The app's `isInsideProject` now
   delegates rather than reimplementing.
3. **A refusal is a sentence naming the path and the reason**, never a raw errno.
   `"sub/link/secret.txt" resolves outside the project (/outside/secret.txt).` — the
   resolved path is included because it is what makes the bug obvious to whoever
   created the symlink.
4. **`SEC-4`: `openProject` accepts only a folder the folder dialog returned.** The
   main process keeps a `Set` of `realpath`s from its own `showOpenDialog`. This is
   the layer *above* containment: with it open, a renderer that got its own
   JavaScript executed could open `/` as a project and then read and write the whole
   filesystem through paths that were, by then, entirely inside "the project". The
   D51 fixes are only as strong as the set of roots they apply to.
   - Compared on **both** sides through `realpath`, or a developer who picked a
     symlinked path would be refused for it.
   - `allowUnpickedRoot: 'test-only'` is a constructor argument on `deps`, fixed
     when `registerHandlers` builds the backend. No channel carries it, so the
     renderer cannot reach it. Seventeen test call sites pass it, which is why it is
     stated in the signature rather than hidden.
5. **`generateProject` may target a root that does not exist yet**, via an explicit
   `{ allowMissingRoot: true }`. Only it passes it. A root that does not exist
   cannot be a symlink, and every path *under* it is still checked — the opt-in is
   about the root, not about switching the check off. Without it the generator is
   simply unable to do its job.

**Three bugs found while building it, all in code the audit's agent had written.**

- **The residual was measured in the wrong direction.** `relative(absolute,
  current)` is anchor-to-target reversed, and for any file its parent is its anchor,
  so the residual was `..` and `resolve` walked straight out. **Every legitimate
  path was refused** — `"src/main.js"` resolved to the project's own parent.
  Compensating with `dirname(current)` overshot in the other direction: for a
  top-level file the anchor is the root, and the residual became `../..`, resolving
  to `/`. The fix is `relative(current, absolute)`, and the walk starts at
  `dirname(absolute)` so the anchor is always a strict ancestor.
- **The final path component was never checked.** The anchor walk starts at the
  target's *parent*, so it only ever sees symlinks among the directories above it.
  When the target itself was a symlink — `src/link.txt` pointing at
  `/outside/secret.txt` — the walk never looked at it, and `existsOnDisk` reported
  true because following the link finds a real file. Caught by the test, not by
  reading: the directory-symlink cases all passed while the file-symlink case
  escaped.
- **`resolveInsideRoot` stopped reporting existence.** It had replaced an
  `existsSync` with its own success, so the context compiler's
  `if (!inside.ok || !exists(file)) continue` became a check that a missing file
  passes, and `readFileSync` threw `ENOENT` out of the compiler. `ok` and
  `existsOnDisk` are now separate fields, because they answer different questions:
  *may this path be written* and *is there a file there yet*.

**What was NOT done, deliberately.**

- **`SEC-5` (the context character budget is reported but not enforced) is not
  fixed.** It is a one-line behaviour change with real consequences for what a
  prompt costs, and it is not a containment defect. Left, and recorded in `AI.md`.
- **The audit's `audit-*.test.ts` files were not copied.** They are repros written
  to fail against unfixed code, they are named for the audit rather than the
  behaviour, and several cover findings in later rounds. `resolveInsideRoot.test.ts`,
  `attachmentEscape.test.ts` and `openProjectTrust.test.ts` replace them and are
  written against the fixed behaviour.

**Cost, stated plainly.** Seventeen test call sites had to change, because the
alternative — a bypass flag nobody passes — is a bypass flag everyone passes.
That is the right trade for a security boundary, and it is also why the flag's
scope and reachability are documented at the point of definition.


---

## D52. The fuzzy passes return a span, a patch may not contradict itself, and Undo may not overwrite a hand edit

**Context.** Round B of the audit. Four findings were confirmed on current main by
reproduction before any code changed; one was already fixed; one is fixed but the
audit's description of it was wrong.

**What each finding turned out to be.**

| Finding | Verdict | Reality |
|---|---|---|
| PATCH-1 tail duplication | **TRUE** | A block matched across blank lines left `engine.tick()` and `engine.stop()` in the file. The FIND consumed only the first three statements. |
| PATCH-3 CRLF | **ALREADY CORRECT** | A CRLF file patches and stays CRLF. No change needed. |
| PATCH-4 empty FIND | **TRUE** | `find: ""` was accepted and **prepended** the replacement. |
| PATCH-6 ambiguity | **HALF TRUE** | The 0.55 threshold is gone; the pass now requires every non-blank FIND line in order. Duplicates are still refused (`matched 2 times`). |
| PATCH-7 self-contradiction | **TRUE** | Two blocks that undid each other both applied cleanly and left the file in a state neither block asked for. |
| NEW-7 undo clobbers a hand edit | **TRUE** | Undo wrote `before` over whatever was on disk. |
| NEW-6 a failed undo loses the step | **TRUE** | `undoStack.pop()` ran before the writes, with no try/catch. |

**Decisions.**

1. **`Pass.run` returns `Span[]`, not `number[]`.** The whole of PATCH-1 is that the
   type could not express what the functions were doing: `matchAcrossBlankLines` and
   `matchByBoundaryAnchor` both match a **variable**-length region and returned only
   the start, so the caller hard-coded the end as `start + findLines.length`.
   `matchAcrossBlankLines`' own doc comment already described the correct behaviour —
   "the returned range covers from the first to the last matched line" — and the
   signature could not carry it. **A doc comment describing behaviour the type cannot
   express is a spec that was never implemented.** Both now return `{start, end}`, and
   a replacement covers the whole located region, so the tail cannot survive.
2. **A patch may not contradict itself (PATCH-7).** Before any match is attempted, a
   block is checked against what earlier blocks already wrote to the same file. Two
   shapes are refused: a block whose FIND is what an earlier block **wrote** (the two
   cancel out and both report success), and two blocks whose FINDs **overlap**.
3. **The overlap rule requires a *distinctive* shared line.** A line of 12+ characters
   that is not a bare closing token. `}` and `});` appear in nearly every function, and
   counting them as overlap signals refuses every multi-block patch in a file. Two
   control tests pin this: disjoint blocks on different functions apply, including
   ones whose shared line is just `}`.
4. **Undo verifies before it writes (NEW-7).** Each file is compared against what the
   step recorded. A mismatch refuses **the whole step**, names the changed files, and
   writes nothing — so a hand edit cannot be silently destroyed. This also covers a
   file the developer deleted: undo refuses rather than recreating it.
5. **A refused undo keeps its step (NEW-6).** `undoCount` stays at 1, so the developer
   can fix the file and press Undo again. Popping before the write would leave them
   with neither the undo nor the redo.
6. **PATCH-4's refusal is a sentence naming the block**, consistent with PATCH-3's and
   the rest of the engine. "FIND is empty, so there is nothing to locate. Ask the AI
   for the exact original lines."

**Cost, stated plainly.** The overlap rule is blunt. A patch with two blocks that
happen to share a distinctive line is refused even when both changes are wanted. That
is the intended trade — D3 is explicit that an ambiguous patch is refused rather than
guessed — but it will refuse some patches a developer would accept, and the sentence
says so rather than leaving them to work out why.

**Two measurement errors worth recording**, because both produced confident readings
that were wrong:

- **A `ReferenceError` reported for `nodes === null` on a line that type-checked.**
  The cause was a shell heredoc turning `\n` into two characters, so a correct string
  comparison reported `false` and a correct `resolveInsideRoot` result looked like a
  rejection. Three findings were read as "not fixed" because of it. **Verification
  scripts that assert on string literals belong in a file, not in a heredoc.**
- **Two `### EDIT:` blocks under one header parse as one.** The block pattern is
  header-anchored, so a second FIND/REPLACE without its own header is swallowed into
  the first block's replacement text. A test omitting the second header produced a
  patch that looked like two contradictory blocks and behaved like one.

**Not fixed.** PATCH-3 needed nothing. PATCH-6's remaining looseness — the fuzzy
passes can still match a region whose *shape* differs — is bounded by the new
whole-region replacement and by every non-blank line having to appear in order, and
is not worth a stricter matcher that would refuse legitimate drifted patches.


### D53. Round C: eight findings, one rule each, and a lesson about timing tests

**Context.** Round C of the audit — the speed round, plus the character-budget
limit deferred from earlier rounds. Every finding was treated as a hypothesis and
reproduced against current `main` before any code changed. **All eight were true.**
Not one was already fixed.

| Finding | Measured on main, before | After |
|---|---|---|
| CTX-3 defect walk is quadratic | 23,583 ms for 80 KB; 3.09x time for 2x input | 172 ms; 1.45x |
| PATCH-5 unbounded LCS table | `FATAL: heap out of memory` at 40,000 lines — a SIGABRT of the main process | refuses in 31 ms at 200,000 lines |
| GRAPH-4 `queue.shift()` | 1,360 ms (`findOrphans`, 60k nodes) | 120 ms |
| GRAPH-5 `edges.some` dedupe | **misattributed — see below** | 475 ms at 4,000 refs, once CTX-3 was fixed |
| GRAPH-3 recursive `findCycles` | `RangeError` at a 5,000-node cycle | 10,000 in 9 ms |
| SCENE-8 unmemoised parent chain | 8,001,999 hops; 7,124 ms at 8,000 deep | 50 ms |
| SEC-5 unbounded read | 4,195,802 chars against `maxChars: 1000` | refused before reading |
| CTX-2 budget never enforced | `0`, `-100`, `1`, `NaN`, `Infinity` all ignored | enforced, with a named floor |

**Decisions.**

1. **The fix must be a local one: same data structure, same traversal, one fewer
   expensive operation.** An index pointer instead of `shift()`. A hoisted local
   instead of a second accessor read. A Set instead of a scan. An explicit frame
   stack instead of the call stack. Each was chosen because it changes the cost
   and nothing else — so the parity tests can assert the output is *identical*, not
   merely similar. That is why every fix here has a test comparing against the
   pre-fix algorithm written out longhand in the test file.

2. **A size cap refuses; it does not truncate, and it does not degrade.** A file
   past `MAX_DIFF_LINES` throws `DiffTooLargeError`; a file past
   `MAX_FULL_FILE_CHARS` is skipped with a gap; a prompt over budget has its
   requested files dropped whole. The common thread: a missing artefact is stated,
   a partial one is not. A half file with no marker lets the AI read the end of
   the file as the end of the logic and reason confidently about code that is not
   there — a plausible-looking wrong answer, which is worse than a refusal.

3. **The refusal reaches the human, per file.** `PatchPreview.diffNotShown` is a
   new field rather than an addition to `blockedReason`, because the renderer only
   displays `blockedReason` when `!applicable` — a note parked there would be
   invisible in precisely the case it exists to explain. `PatchScreen.svelte`
   previously rendered *any* empty diff as "No changes to this file", so a file
   that changed but was too large to preview would have read as a confident lie
   about whether a write was about to happen (D30).

4. **A budget with a floor is named, not violated.** The prompt's mandatory parts
   are ~1,900 characters. No budget below that can be met, and the only two
   alternatives are a silently-over cap or a prompt with no patch contract — in
   which every patch fails to apply. So `chars` may exceed `maxChars` in exactly
   one case, and the gap says the number and says it is a floor (D33).

**A finding whose headline number was wrong.** GRAPH-5 was reported at 6,062 ms
for 2,000 references, attributed to `edges.some`. Isolating the stages showed
`tryParse` alone accounted for essentially all of it — 7,739 ms parse against
7,153 ms for the whole extraction. The `edges.some` scan was real and is worth
removing, but it was never the bottleneck it appeared to be; CTX-3 was. Once
CTX-3 was fixed, the same 4,000-reference extraction went 22,296 ms → 475 ms.
The fix was kept because a quadratic scan is a quadratic scan whatever it cost
today, but the attribution in the audit was wrong and is corrected here.

**A mistake worth recording, because I made it twice.** The first timing tests
asserted that doubling the input did not *quadruple* the time. That is the wrong
shape of test and it does not work:

- Each ratio was measured **passing on the unfixed source** on a fast machine.
- Making them robust with best-of-3 — the obvious fix for flakiness — made them
  **pass on unfixed code every time**, because taking the minimum of three runs
  removes precisely the super-linear term a ratio depends on in order to detect
  it.

All four ratio tests are deleted, each replaced by a comment recording why.
Absolute bounds on large inputs do separate cleanly, so every size is now set by
measuring **both** directions. `findOrphans` at 60,000 nodes passed unfixed
(1,704 ms, inside a 2s limit) and at 150,000 failed on fixed code (2,553 ms);
120,000 is the size that works — 3,838 ms unfixed against 543 ms fixed. The
lesson generalises past this repo: **a performance test that passes on the bug it
was written for is worse than no test, because it reads as evidence.**

**Two bugs I introduced while fixing SCENE-8, both now covered.** Seeding the
cycle-detection `seen` set with the starting id makes the first iteration match
and reports *every* instance as cyclic; and memoising the wrong verdict's
polarity reports every *valid* scene as invalid. Neither was subtle, and both
were caught by comparing against the naive walk rather than by reading the code
carefully.

**Verified by.** `packages/core/test/{parse,graph,scene,extract,patch,context}/perf-round-c.test.ts`
and `packages/core/test/context/budget-round-c.test.ts`,
`packages/app/test/shell/patchDiffCap.test.ts`. Each performance assertion was run
against the reverted source to confirm it fails there; the parity assertions pass
on both versions, which is the evidence that the fixes changed cost and not
behaviour. `scripts/repro-round-c.mjs` reproduces every measurement above.

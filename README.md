# ContextForge

**Use as many AIs as you like on one game project — without losing context, and without breaking a dependency.**

ContextForge is a desktop app for game development with LLMs. It reads your real
project off disk, works out the dependency graph, builds the context an AI needs
for the specific thing you are asking about, and applies the AI's edits back —
through a patch engine that refuses to guess.

![Context screen: files the compiler chose, with the reason for each](docs/images/context-ranked-files.png)

---

## Why it exists

Building a game with an AI runs into four failure modes, and all four come from
the same root: **the AI does not actually know your project.**

1. **Context loss.** The AI invents functions that do not exist, or duplicates
   ones that already do.
2. **Broken dependencies.** It edits a file without knowing what imports it, and
   the thing stops working three files away.
3. **Wasted tokens.** You paste the whole project into every prompt to work
   around (1) and (2), and pay for the irrelevant 95% every time.
4. **Unreviewable writes.** The AI writes straight to disk, so a wrong change is
   a mess of half-applied edits rather than a diff you looked at first.

ContextForge's answer is not "a better prompt". It is a real graph of your
project, extracted from the source, used to *choose* context rather than dump
it — and a patch format where nothing is written until you have seen the diff.

The AI it talks to is whichever one you are already using. ContextForge makes no
network calls of its own.

---

## What it does

Every claim below is backed by a test in `packages/*/test/`. `npm run verify`
runs all of them: **59 test files, 1157 tests, green.**

### Reads your project into a dependency graph

`extractJsProject` and `extractGodotProject` walk a project and produce a typed
graph: nodes, edges (`depends_on`, `asset_ref`, `ext_resource`, `signal_connection`,
`requires`), and a contract per node. For JavaScript/TypeScript the contracts come
out of **tree-sitter syntax trees**, never regex — imports, exports, and asset-path
string literals are read from the parse tree.

For Godot it parses `.gd` signals, `@export` vars, constants and enums, and
hand-written `.tscn` files (`[node]`, `[ext_resource]`, `[sub_resource]`,
`[connection]`, with a real tokenizer for the header grammar).

*Checked by:* `packages/core/test/extract/{js,godot,files}.test.ts`,
`packages/core/test/parse/{js,gdscript,tscn,grammars}.test.ts`.

### Deterministic by construction

Two runs over the same project produce byte-identical output. Nothing reads the
clock: `buildManifest` takes `generatedAt` as an argument, which is why the brief
prints a `Generated:` line only when a timestamp was actually injected.

*Checked by:* `packages/core/test/context/brief.test.ts` ("determinism"),
`packages/core/test/extract/js.test.ts`, `packages/core/test/smoke/realProject.test.ts`.

### Builds context for one specific error

Describe what is broken and paste the error; the compiler ranks the files that
matter and gives a reason for each one — `Error origin at line 5`,
`Direct dependency of src/kart.js`, `Exports "kart", named in your description`.
Stack traces are parsed (`res://` prefixes and Windows separators normalised), so
the file the error came from is attached automatically.

If it genuinely cannot see enough, it says `CONTEXT INSUFFICIENT` and names what
it needs rather than guessing.

![Context screen: ranked files with a reason each, and the token saving](docs/images/context-ranked-files.png)

*Checked by:* `packages/core/test/context/compiler.test.ts`,
`packages/app/test/context/{handlers,contextInsufficient}.test.ts`.

### Applies AI edits through a patch engine that refuses to guess

The Patch screen reads `### FILE:` and `### EDIT:` blocks out of the AI's reply
and shows you the diff and the syntax verdict **before anything is written**.

- **Ambiguous is refused, never guessed.** The finder walks a ladder of passes —
  exact, whitespace-drift, line-number-prefix, blank-line drift — and if a
  snippet matches more than once it stops.
- **All or nothing.** A patch that fails on block 3 of 5 writes none of it.
- **Syntax pre-check before disk.** Invalid JS/GDScript is refused before the
  write, and `applyAnyway` is an explicit override. Hex colours, Windows paths and
  triple-quoted docstrings do not false-flag.
- **Undo names its files.** Undo/redo covers a 20-step history, and the write
  report names every file touched.

![Patch screen: a single EDIT block previewed with its diff, nothing written yet](docs/images/patch-preview.png)

![Patch screen: an unresolvable block names itself and says nothing will be written](docs/images/patch-error-reason.png)

![Patch screen: two files applied as one undo step, each named in the report](docs/images/patch-applied-names-files.png)

![Patch screen: the diff for two newly created files](docs/images/patch-diff-new-files.png)

*Checked by:* `packages/core/test/patch/patch.test.ts`,
`packages/app/test/shell/{patchScreen,patchScreenRender}.test.ts`,
`packages/app/test/e2e/patchLoop.test.ts`.

### A `scene.json` contract, and prefabs that are just functions

Scenes are data, validated with a strict Zod schema. Duplicate ids, dangling
parents, self-parenting, two-component positions, unknown keys and a wrong
`schema_version` are all rejected **with the JSON path in the error**. A valid
scene round-trips through load/save unchanged.

A prefab is a pure function:

```ts
type PrefabModule = {
  create(THREE, params, seed) -> { object, parts }
}
```

`THREE` is injected, `params` are validated against the prefab's own Zod schema,
and `parts` is a named map so the editor can select a specific sub-object. A
prefab lint (`npm run lint:prefabs`) rejects `this`, module-level `let`,
`Math.random` and `scene.add` inside a prefab — purity is enforced, not
documented.

If one instance fails, the rest of the scene still builds and the failure is
reported against that instance's id.

![Scene screen: the Problems panel naming each failure, and the instance it belongs to](docs/images/problems-panel.png)

*Checked by:* `packages/core/test/scene/{sceneFile,edits,lint,prefabs,template,slots,rng}.test.ts`,
`packages/core/test/integration/step2.integration.test.ts`,
`packages/app/test/scene/gameScene.test.ts` (a real game loading its real `scene.json`).

### Renders the scene without the game running

Open `scene.json` in the Three.js viewer with no game process attached, edit
transforms, and save — the save re-validates against the schema. The Inspector
edits position, rotation and scale as three discrete axes each, not a matrix.

![Scene screen: the Inspector with position, rotation and scale as three axes each](docs/images/inspector-three-axes.png)

*Checked by:* `packages/app/test/viewport/{assemble,picking,stage,markers,sceneGraph}.test.ts`,
`packages/core/test/integration/step3.e2e.test.ts`.

### Writes a project brief

`generateBrief` builds a `brief.md` describing the project from the graph: the
real public signatures, the folder map, the node and edge counts, the build order
from `layerNodes`, and the patch contract verbatim. Two modes, chosen in the
**Context** screen's header:

- **`oneShot`** puts your typed task in the brief, so the AI answers that task.
- **`interactive`** states no task and instead instructs the AI to reply
  `NEED: <path>` for anything it cannot see, so the files get attached before it
  answers.

The brief is written to `.contextforge/brief.md` inside the opened project and
read back on the next open. One thing the brief deliberately does **not** do is
attach the whole project: files are ranked and the prompt states what was
included and what was not, so you can see what the AI was actually given.

*Checked by:* `packages/core/test/context/brief.test.ts`,
`packages/app/test/context/handlers.test.ts`, `packages/app/test/e2e/briefLoop.test.ts`.

### Gates that fail when the rule is broken

These are not comments, they are `npm run verify` stages:

| Gate | Fails when |
| --- | --- |
| `check:boundaries` | any file in `packages/core` imports `@contextforge/app`, or imports outside core's dependency allowlist |
| `check:three` | the viewer and the game project are not on a byte-identical, range-free `three` pin |
| `typecheck` | strict TypeScript reports an error |
| `lint:prefabs` | a prefab uses `this`, module-level `let`, `Math.random` or `scene.add` |

### Verified end-to-end against a real game

The suite drives the real kart game reading its own `scene.json` through its own
prefab registry — no stubs — and checks that a changed position in `scene.json`
moves the kart, looked up by id and never by index. A smoke suite extracts a
whole real project (106 nodes, 248 edges) and detects its real circular import.

The full Electron loops (patch, brief, edit) are **skipped by default** and say
so in their output rather than passing silently. They run when you ask:

```bash
CF_E2E=1 npx vitest run packages/app/test/e2e/patchLoop.test.ts
```

*Honest caveat:* the e2e loops need a game project on disk. Set `CF_PROJECT` to
point at yours; where an external project is missing, those suites skip rather
than fail.

---

## Screenshots

| | |
| --- | --- |
| ![Context: ranked files with reasons, sticky copy bar, token saving](docs/images/context-ranked-files.png) | ![Context: a brief mode selector with the sticky copy bar](docs/images/context-copy-bar.png) |
| ![Scene: Problems panel naming each failure](docs/images/problems-panel.png) | ![Scene: Inspector with three transform axes](docs/images/inspector-three-axes.png) |
| ![Patch: single block previewed](docs/images/patch-preview.png) | ![Patch: unresolvable block, nothing written](docs/images/patch-error-reason.png) |
| ![Patch: two files applied, named in the report](docs/images/patch-applied-names-files.png) | ![Patch: diff for two new files](docs/images/patch-diff-new-files.png) |

*All screenshots are from the real app running against the `kart-dash-3d-v2`
project. Two of them had a personal absolute path visible in the error text; it
was replaced with a neutral placeholder by `scripts/redact-screenshots.py`.*

---

## Install

Requires **Node ≥ 22**. No other prerequisites.

```bash
npm install --legacy-peer-deps
```

> **Why `--legacy-peer-deps`:** `tree-sitter-typescript@0.23.2` and
> `tree-sitter-gdscript@6.1.0` still declare peer dependencies on
> `tree-sitter@^0.21`, while this project installs `0.25`.
>
> **In practice a plain `npm install` and `npm ci` both succeed** — `package-lock.json`
> is lockfile v3 and already records a valid tree, so npm never re-checks the peer
> ranges. The unsatisfied declarations are reported by `npm ls tree-sitter` as
> `invalid` but do not fail the install. The flag is kept here because deleting the
> lockfile *does* make npm resolve `tree-sitter@0.21.1` at the root alongside a
> nested `0.25.1` in `packages/core`, which is the conflict the flag exists to avoid.
> `package.json` attributes the note to "D17", but `docs/DECISIONS.md` has no D17
> entry — its numbering jumps from D16 to D20. The reasoning is in
> [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md).

> **If `npm install` skipped devDependencies,** you have `NODE_ENV=production` set.
> Install with `NODE_ENV=development npm install --include=dev` — Electron is a
> devDependency and will otherwise be missing.

### Electron needs one extra step

**`npm install` does not download the Electron binary.** `electron@44` ships no
postinstall script that fetches it, so after a fresh clone you must fetch it
once:

```bash
node node_modules/electron/install.js
```

If that prints something unexpected, `npx electron --version` will fetch it too.
Until you do this, any Electron command fails with a missing-binary error.

## Run

```bash
# Dev (Vite dev server for the renderer)
npm run dev -w @contextforge/app

# Build the renderer bundle, then launch Electron
npm run build:ui -w @contextforge/app
npm run start -w @contextforge/app
```

> **`--no-sandbox` is required.** The bundled `chrome-sandbox` helper ships
> unprivileged, and Chromium refuses to start without it. Wherever you launch
> Electron directly, pass the flag:
>
> ```bash
> npx electron --no-sandbox packages/app/dist/electron/main.js
> ```
>
> See [D14](docs/DECISIONS.md). This affects the sandbox helper's permissions,
> not the shipped app.
>
> **Known gap:** `npm run start -w @contextforge/app` builds the renderer and then
> launches Electron *without* `--no-sandbox`, so on this machine it fails at
> launch. The one-liner below is the command that works. The script needs the flag
> added to it.

## Test

```bash
npm run verify      # everything below, in order
npm test            # vitest alone
npm run typecheck   # tsc --build
```

`npm run verify` runs five stages:

1. **`check:boundaries`** — core imports nothing from app; core's dependency
   allowlist is intact.
2. **`check:three`** — the viewer and the game are on the same pinned `three`.
   Needs `CF_GAME_ROOT` if your game is not a sibling directory.
3. **`typecheck`** — strict TypeScript across both packages.
4. **`lint:prefabs`** — prefab purity rules.
5. **`test`** — Vitest across `packages/*/test/`.

Current result: **59 files, 1157 tests, exit 0.**

---

## How it works

### `scene.json`

A scene is data, not code. It is validated against a strict Zod schema, and every
rejection names the offending JSON path:

```
instances[0].params.width: prefab "trackSegment": Number must be greater than 0
```

Placement lives here and nowhere else. `saveScene` re-validates before writing, so
a file on disk is always a scene that would load. `.tscn` is parsed by the
project's own parser rather than converted.

### Prefabs

A prefab is a pure function that returns data. It never imports `THREE` from a
global, never mutates shared state, never randomises without a seed, and never
calls `scene.add` — the caller decides what goes into the scene. That is what
makes the same prefab usable by the editor's viewport and by the game itself,
which is checked directly: the viewer's kart output is compared, combination by
combination, against the v1 game's own `buildMesh()`.

### The patch format

Two block types, both all-or-nothing.

**`### FILE:`** creates or replaces a whole file. `before: null` means the file
did not exist.

```
### FILE: src/speed.js
+export const MAX_SPEED = 40;
```

**`### EDIT:`** replaces a snippet inside an existing file:

```
### EDIT: src/kart.js
<<<<<<< FIND
const speed = 5;
=======
const speed = 25;
>>>>>>> REPLACE
```

For each block: locate the FIND text through a ladder of passes that tolerate
whitespace drift, line-number prefixes and blank-line drift; refuse if the match
is ambiguous or absent; syntax-check the result before touching disk. A patch
that fails on any block writes none of them.

---

## Project structure

```
contextforge-v2/
├── packages/
│   ├── core/        @contextforge/core — the engine. No UI, no DOM.
│   │   ├── src/
│   │   │   ├── parse/     tree-sitter grammars; js / gdscript / tscn readers
│   │   │   ├── graph/     the node+edge model, manifest, reverse queries
│   │   │   ├── extract/   a project on disk → a graph
│   │   │   ├── patch/     FIND/REPLACE engine, FILE/EDIT blocks, syntax check
│   │   │   ├── history/   20-step undo/redo
│   │   │   ├── scene/     scene.json schema, load/save, edits, prefabs
│   │   │   └── context/   rank, compile, slice, brief
│   │   └── test/
│   └── app/         @contextforge/app — the Electron + Svelte shell.
│       ├── src/
│       │   ├── electron/   main, preload, IPC handlers, prefab loader
│       │   └── renderer/   Svelte screens and components
│       └── test/
├── docs/            SPEC-linked architecture, decisions, dependencies
├── scripts/         verify gates and e2e harnesses
└── screenshots/     raw captures, by iteration
```

**The boundary rule: `packages/core` has zero third-party UI dependencies, no
DOM globals, and never imports from `packages/app`.** Core is where the logic
lives and it is testable headlessly; the app is a shell over it. `npm run
check:boundaries` fails the build if that is ever violated, so the rule is
mechanical rather than aspirational.

---

## Tech stack

Pinned versions read from `package-lock.json`:

| Package | Version | Role |
| --- | --- | --- |
| `typescript` | 5.9.3 | strict TS across both packages |
| `vitest` | 5.0.3 | test runner |
| `vite` | 6.4.3 | dev server + renderer bundle |
| `electron` | 44.5.1 | desktop shell |
| `svelte` | 5.57.1 | renderer UI |
| `@sveltejs/vite-plugin-svelte` | 5.1.1 | Svelte in Vite |
| `three` | 0.180.0 | scene viewer (exact pin, no range) |
| `zod` | 3.25.76 | manifest + scene.json validation |
| `tree-sitter` | 0.25.1 | parser runtime |
| `tree-sitter-javascript` | 0.23.1 | JS grammar |
| `tree-sitter-typescript` | 0.23.2 | TS/TSX grammar |
| `tree-sitter-gdscript` | 6.1.0 | GDScript grammar |
| `esbuild` | 0.25.12 | bundles a project's real prefabs |
| `@electron/rebuild` | 4.2.0 | rebuilds native grammars for Electron |

Licences and the reasoning behind each choice: [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md).

---

## Status and roadmap

Built in sequential steps, each with a done-when test that had to be green
before the next began.

| Step | Status |
| --- | --- |
| 1 — Core: graph, parsers, extractors, patch engine, history | **done** |
| 2 — Scene contract: `scene.json` schema, load/save, prefab lint | **done** |
| 3 — Modeling viewer: `scene.json` rendered with no game running | **done** |
| 4 — UI shell: Electron + Svelte, four screens | **done** |
| 5 — Project Brief button | **partly done** — both modes build and write; ask-back still owed |
| 6+ | not planned |

### Step 5, specifically

A **Project Brief button** in the UI, in two modes.

**What already works today** (Step 4b): the Context screen builds a brief in both
modes, writes `.contextforge/brief.md`, reads it back, and detects `NEED: <path>`
so a requested file is attached in full on the next turn. The e2e brief loop
drives this against a real project.

**What Step 5 still owes**, per `SPEC.md §5`:

- One-shot produces a brief from core's graph with **no network call** — true
  today, and covered by the e2e loop.
- The ask-back mode asks exactly one clarifying question before generating a
  different brief. The current second mode is **interactive** (the AI asks for
  missing files), which is *not* the same thing: it defers the question to the
  AI instead of asking one itself. This is the substantive gap.
- Neither mode writes to the project without an explicit apply. `brief.md` is
  written under `.contextforge/` and nothing else is touched, but the guarantee
  is not yet asserted end to end.

Nothing beyond Step 5 is committed to.

Step boundaries and their done-when tests: [SPEC.md §5](SPEC.md). The reasons
behind each choice, including the known gaps that were accepted on purpose, are
in [docs/DECISIONS.md](docs/DECISIONS.md) (D1–D43).

---

## Licence

MIT — see [LICENSE](LICENSE).
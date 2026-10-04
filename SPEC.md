# ContextForge v2 — Specification

A desktop app that helps one developer use many different AIs to build games
(Three.js and Godot) without an AI losing context or breaking dependencies.

The old ContextForge v1 (a personal checkout elsewhere on disk, **read-only reference**)
is not a codebase we copy. It is read to learn *what* it does; every line shipped
in v2 is rewritten in TypeScript. v1 tests are ported as behavioural requirements,
not transcribed code.

---

## 1. Goal

### Problem

A developer building a game with an LLM hits four failure modes:

1. **Context loss.** The AI cannot see the whole project, so it invents
   functions that do not exist, or duplicates ones that do.
2. **Broken dependencies.** It changes a function signature and silently breaks
   every caller, and the game only reveals this at runtime.
3. **Destructive edits.** It rewrites a whole file to change one line, and the
   good part is unrecoverable.
4. **Opaque assets.** It swaps `character.glb` for a mesh with no rig and no
   idle animation; nothing complains until the character is a floating statue.

### What v2 does about each

| Failure | Mechanism |
| --- | --- |
| Context loss | **Dependency graph + scoped prompts.** Every file is a node with a typed *contract* (exports / signals / requires). An AI is handed the exact neighbourhood it may touch, and what it must not break. |
| Broken dependencies | **Contracts are the contract.** The extractor reads real syntax trees, so the declared contract is what the code actually exposes. Patch blocks are validated against the file on disk before they are written. |
| Destructive edits | **Surgical patches + undo.** `### EDIT:` blocks change only a located snippet. Every write is one transaction in a 20-step undo/redo history, including "file was created" and "file was deleted". |
| Opaque assets | **Slot contracts.** An asset declares a slot (`character`, with required animations, dimensions, rigging). Replacing the asset is validated against the slot, so a broken swap is reported instead of shipped. |
| Blocking syntax damage | **Pre-save syntax check.** Content is parsed in memory *before* it touches disk. Broken code is refused by default and can only be written with an explicit `applyAnyway`. |

### Non-goals for v2

- Not an AI client. v2 never calls a model API. The developer copies an AI's
  answer into the Patch screen. Model choice stays with the developer, which is
  the whole point of "use many different AIs".
- Not a game engine. v2 does not run the game.
- Not a general IDE. Scope is the dependency graph, the scene contract, and
  safe patching.

---

## 2. Hard rules

These are architectural constraints. A change that violates one is wrong, not
a matter of taste.

### R1 — TypeScript everywhere, strict mode

Every file in `packages/` is `.ts`. `strict: true`, plus `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, and `noImplicitOverride`. No `any` escapes through
`@ts-ignore`. Types are the test suite's first line of defence.

### R2 — Tests are Vitest

Unit and integration tests run on Vitest. Every ported v1 behaviour has a
portable Vitest test. Tests that need a running HTTP server or a browser are out
of scope for core; core is pure logic over the filesystem.

### R3 — `core` has no UI and no DOM

`packages/core` must not import `svelte`, `electron`, or anything that touches
`window`, `document`, or `HTMLElement`. It runs headless in Node with no display,
no GPU, and no network. This is what makes the core testable and what makes the
app shell replaceable.

### R4 — `core` never imports from `app`

The dependency arrow points one way: `app → core`. An import of `@contextforge/app`
(or a relative path reaching outside `packages/core`) from inside core is a build
failure, not a style violation. Enforced mechanically (§6.3).

### R5 — Parsing uses tree-sitter, never regex

JavaScript, TypeScript and GDScript are parsed with **tree-sitter** grammars and
walked as syntax trees. Regex may be used for *lexical* concerns on plain text
that is not a programming language (a `### FILE:` marker in AI prose, a `slot`
annotation in a comment) but never to decide what a piece of code *means*.

Concretely: "what does this module export?" and "what signals does this script
declare?" are answered by reading nodes, not by matching `^export ` at the start
of a line. This is the single most important quality rule in the project — v1
used regex here and it broke on multiline exports, comments containing the word
`export`, and re-export syntax.

`.tscn` has no reliable off-the-shelf grammar, so **v2 writes its own parser**
(§4.3) rather than falling back to regex.

### R6 — Scene data is `scene.json`, validated with Zod

All scene data lives in one JSON file per scene. It is validated with Zod on
every read and every write. An invalid scene is refused loudly and the offending
JSON path is reported. v1 had no validated scene contract at all.

### R7 — Scene objects are pure prefab functions

A scene object is created by a **pure function**:

```ts
create(THREE, params) -> { object, parts }
```

with these properties, all enforced by lint (§6.4):

- **no `this`** — state is passed in and returned, never reached through a receiver;
- **no globals** — no module-level mutable state, no reading `window`, `document`,
  or a singleton;
- **no `scene.add`** — the caller composes the result into the scene;
- **seeded randomness** — any randomness is `rand(seed)`, where `seed` is an
  explicit parameter. `Math.random()` in a prefab is a lint error. This is what
  makes a scene reproducible and therefore diffable and shareable between AIs.

### R8 — Deterministic output

Extraction of the same project yields byte-identical output: nodes and edges
sorted, no timestamps in extracted data, no filesystem-order dependence. An AI
that is given the same graph twice must see the same graph twice. v1 leaked
`Date.now()` into ids in places; v2 puts all wall-clock reads behind an injected
`now()`.

### R9 — Loud, specific failure

A tool that cannot verify a result refuses rather than emitting a
plausible-looking one. Validation returns the file, the JSON path or line, and
what was expected — never a bare `false`.

### R10 — CLI/agent parity

Anything doable only through the GUI is unfinished. Every core capability has a
function and a command-line entry point, so automation can drive the app.

---

## 3. Folder layout

```
contextforge-v2/
├── SPEC.md                       this document
├── package.json                  npm workspaces root, scripts
├── tsconfig.base.json            shared strict compiler options
├── tsconfig.json                 solution-style references
├── vitest.config.ts              one runner for all packages
├── packages/
│   ├── core/                     no UI, no DOM, no imports from app   [R3][R4]
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts                  public surface of core
│   │   │   ├── graph/
│   │   │   │   ├── types.ts              Node, Edge, Contract, Manifest
│   │   │   │   ├── manifest.ts           build/validate manifest (Zod)
│   │   │   │   ├── reverse.ts            depended_on_by, cycles, layers
│   │   │   │   └── scope.ts              scoped prompt selection
│   │   │   ├── parse/
│   │   │   │   ├── grammars.ts           tree-sitter loader (JS/TS/GDScript)
│   │   │   │   ├── js.ts                 imports/exports/assets from a tree
│   │   │   │   ├── gdscript.ts           signals/@export/funcs from a tree
│   │   │   │   └── tscn.ts               own .tscn parser              [R5]
│   │   │   ├── extract/
│   │   │   │   ├── js.ts                 JS/Three.js project extractor
│   │   │   │   ├── godot.ts              Godot project extractor
│   │   │   │   ├── files.ts              deterministic filesystem walk
│   │   │   │   └── assets.ts             asset nodes + slot contracts
│   │   │   ├── patch/
│   │   │   │   ├── fileBlocks.ts         ### FILE: parsing + write
│   │   │   │   ├── editBlocks.ts         ### EDIT: parsing + apply
│   │   │   │   ├── finder.ts             multi-pass snippet locator
│   │   │   │   ├── syntaxCheck.ts        pre-save syntax pre-check
│   │   │   │   └── diff.ts               unified diff for preview
│   │   │   ├── history/
│   │   │   │   └── history.ts            20-step undo/redo
│   │   │   └── scene/                    [Step 2 — schema only in Step 1]
│   │   │       ├── scene.schema.ts       Zod schema for scene.json
│   │   │       └── lint.ts               prefab rule lint              [R7]
│   │   ├── test-fixtures/                js-sample, godot-sample, ...
│   │   └── test/                         Vitest suites (*.test.ts)
│   └── app/                      Svelte + Vite + Electron             [Step 4]
└── docs/
    ├── ARCHITECTURE.md          what each core module is for
    ├── DECISIONS.md             decision log with reasoning
    └── DEPENDENCIES.md          every dependency, version, licence
```

**Step 1 delivers `packages/core` only.** `packages/app` is created in Step 4 —
an empty shell now would be an untested claim. `scripts/check-boundaries.mjs`
enforces R3/R4 mechanically; `npm run verify` runs all three gates.

---

## 4. `scene.json` schema

### 4.1 Purpose

A scene is data, not code. It is edited by the Modeling screen before the game
runs, and it is the thing an AI is scoped against. Because it is validated data,
a bad edit is caught at the boundary instead of becoming a broken scene.

A scene file lives at `scenes/<name>.scene.json` inside the project.

### 4.2 Schema (Zod, `packages/core/src/scene/scene.schema.ts`)

```ts
SceneFile = {
  schema_version: 1                      // literal; bumped on breaking change
  name: string                           // scene id, e.g. "Level1"
  engine: "three" | "godot"
  seed: number                           // default randomness seed [R7]
  objects: SceneObject[]
}

SceneObject = {
  id: string                             // unique within the scene
  prefab: string                         // registered prefab name [R7]
  name?: string                          // display name; defaults to id
  parent?: string                        // another object id; absent = root
  transform: Transform                   // always present, defaults applied
  params: Record<string, JsonValue>      // prefab params, validated per prefab
  visible?: boolean                      // default true
  locked?: boolean                       // default false; blocks AI edits
}

Transform = {
  position: [number, number, number]     // always length 3
  rotation: [number, number, number]     // Euler radians, always length 3
  scale:    [number, number, number]     // always length 3
}

Connection = {                           // signal wiring, replaces .tscn [connection]
  from: string                           // object id
  signal: string
  to: string                             // object id, or "" for the scene root
  method: string                         // handler name
}
```

Rules the schema enforces:

- `schema_version` is a literal `1`. A future version fails loudly rather than
  being read with best-effort defaults.
- `objects[].id` is unique within the scene. Duplicate ids are a validation error
  naming the offending index.
- `parent` must reference an existing object id, and the resulting parent
  relation must be acyclic. An object cannot parent itself.
- `transform` components are always exactly 3 numbers — a 2-component position
  is a validation error, not a silent pad.
- `seed` is a finite number. `params` must be JSON-serialisable.
- Unknown keys are rejected (`strict()`), so a typo in a hand-written scene
  fails instead of being ignored. This matters because an AI writes these files.

### 4.3 `.tscn` is parsed by our own parser

v2 must read Godot scenes (to build the graph and to convert them), and
`.tscn` is not covered by an available tree-sitter grammar. So
`packages/core/src/parse/tscn.ts` is a hand-written parser for the three
constructs that carry dependency information:

- **node headers** — `[node name="Player" type="CharacterBody2D" parent="."]`,
  including `[node name="Player" parent="." instance=ExtResource("1_p")]`;
- **`ext_resource` headers** — `[ext_resource type="Script" path="res://scripts/Player.gd" id="1_abc"]`;
- **`[connection]` blocks** — `[connection signal="died" from="Player" to="." method="_on_player_died"]`.

The parser is a real tokenizer for the header attribute grammar, not a regex
sweep: it tracks quoting, `]` inside quoted values, and multi-line values, so a
path containing `]` or a `"` inside a value does not break it. Its output
type-checks against a declared `TscnDocument` shape, and malformed input
produces a `TscnParseError` carrying line and column.

`res://` paths are converted to project-relative paths at the boundary, so the
graph only ever contains relative ids.

### 4.4 Prefab contract (Step 2, specified here)

```ts
type PrefabModule = {
  create(THREE, params, seed) -> { object, parts }
}
```

- `THREE` is injected as a parameter. A prefab never imports it from a global.
- `params` are validated against a Zod schema declared by the prefab.
- `parts` is a named map of sub-objects, so the Modeling screen can select and
  edit a specific part without walking the tree.
- The return value is data. The caller decides to `scene.add` it.

---

## 5. Build order

Each step lists what it delivers and the **done-when** test that must pass
before the step is considered complete. Steps are sequential; a later step is
not started until the earlier step's done-when test is green.

### Step 1 — Core

**Deliver:** the monorepo skeleton, and in core: the graph types, tree-sitter
layer, `.tscn` parser, both extractors, the patch engine (file + edit blocks),
the syntax pre-check, and the 20-step undo/redo history — each ported from v1
behaviour and rewritten in strict TypeScript, with the v1 tests ported.

**Status: complete.** 214 tests across 11 files; `npm run verify` (boundaries,
typecheck, tests) is green.

**Done when:**

1. ✅ `npm run typecheck` passes with `strict` and no errors.
2. ✅ `npm test` passes with every ported test green, covering:
   - JS extractor over the `js-sample` fixture: all modules found, all
     `depends_on` correct, contracts parsed from syntax trees (not regex),
     `asset_ref` edges found, and two runs byte-identical (R8).
   - Godot extractor over the `godot-sample` fixture: 3 scenes + 3 scripts,
     signals and `@export` vars correct, `_`-prefixed funcs excluded, scene
     contracts inherited from their root script, `ext_resource`,
     `signal_connection` and `requires` (autoload) edges present, two runs
     byte-identical.
   - `.tscn` parser: node headers, `ext_resource` headers, and `[connection]`
     blocks parsed, including `]>` and quotes inside values.
   - Patch engine: `### FILE:` blocks written; `### EDIT:` blocks applied;
     the multi-pass finder matches across whitespace drift, line-number
     prefixes and blank-line drift; ambiguous snippets are refused, not guessed;
     already-applied patches are idempotent.
   - Syntax pre-check: invalid JS and invalid GDScript (missing colon,
     unclosed delimiter, unterminated string) are refused *before* disk write;
     hex colours, Windows paths and triple-quoted docstrings do not false-flag;
     `applyAnyway` overrides.
   - History: record/undo/redo round-trips, new-file creation is undone by
     deletion and redone by recreation, multi-file transactions, and the stack
     caps at exactly 20.
3. ✅ The manifest produced by either extractor validates against the Zod schema.
4. ✅ No file in `packages/core` imports from `packages/app`, and no core file
   references a DOM global (`npm run check:boundaries`).

**Added beyond the original scope**, because verification demanded it:

- A **smoke suite** running the whole pipeline against the real v1 repository
  (106 nodes, 248 edges, a `.godot` cache, real AI patch transcripts). It is how
  the vendored-bundle performance fix and a `layerNodes` node-loss bug were
  found. It never writes to v1; patch phases run on a temp copy.
- **Vendored-bundle exclusion** in the filesystem walk — see D11.

### Step 2 — Scene contract

**Deliver:** the `scene.json` Zod schema (§4.2), the scene load/save functions,
and the prefab lint (§4.4).

**Done when:** a test asserts that an invalid scene (duplicate id, dangling
`parent`, self-parent, 2-component position, unknown key, wrong
`schema_version`) is rejected with an error naming the JSON path; a valid scene
round-trips through load/save unchanged; the lint flags `this`, a global, and
`scene.add` inside a prefab and accepts a clean prefab.

### Step 3 — Modeling viewer

**Deliver:** a viewer that opens `scene.json` and renders it with Three.js,
with **no game running**.

**Done when:** a headless screenshot test loads a fixture `scene.json` and
produces a non-blank render containing the expected object count; editing an
object's transform in the viewer and saving re-validates against the Zod schema.

### Step 4 — UI shell

**Deliver:** the Electron + Svelte app with four screens — Project, Context,
Scene, Patch.

**Done when:** the app builds; each screen is reachable; opening a real project
shows a graph extracted by core; and a patch pasted into the Patch screen is
applied through core with a working undo.

### Step 5 — Project Brief button

**Deliver:** a button that generates a project brief, in two modes — one-shot
and ask-back (it asks the developer one clarifying question before generating).

**Done when:** one-shot produces a brief from core's graph without any network
call; ask-back asks exactly one question before producing a different brief; and
neither mode writes to the project without an explicit apply.

---

## 6. Enforcement

Rules are only real if something fails when they are broken.

### 6.1 Types

`tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
`verbatimModuleSyntax`. `npm run typecheck` is the gate.

### 6.2 Tests

Vitest over `packages/*/test/**/*.test.ts`. Every extractor, patch and history
behaviour from v1 has a test.

### 6.3 Package boundary

`npm run check:boundaries` fails if any file under `packages/core` imports
`@contextforge/app`, or imports a package outside the core dependency list.

### 6.4 Prefab lint

`npm run lint:prefabs` flags `this`, module-level `let`, `Math.random`, and
`scene.add` inside `packages/core/src/scene/prefabs/**`. Enforced in Step 2;
listed here because it is a hard rule (R7), not a later idea.

---

## 7. Dependencies

Free and open-source only. Every dependency must be justified as necessary and
must not duplicate a capability already present. Full table with licences in
`docs/DEPENDENCIES.md`.

| Package | Why | Licence |
| --- | --- | --- |
| `tree-sitter` | syntax trees for JS/TS/GDScript [R5] | MIT |
| `tree-sitter-javascript` | JS grammar | MIT |
| `tree-sitter-typescript` | TS/TSX grammar | MIT |
| `tree-sitter-gdscript` | GDScript grammar | MIT |
| `zod` | `scene.json` + manifest validation [R6] | MIT |
| `vitest` | tests [R2] | MIT |
| `typescript` | the language [R1] | Apache-2.0 |
| `typescript-eslint` | lint, drives the prefab lint | MIT |

Deliberately **not** carried over from v1: `madge` (replaced by tree-sitter's own
imports — regex-free and one fewer process), `ajv`/`ajv-formats` (replaced by
Zod, which the plan requires anyway), `express` (v2 is a desktop app; core needs
no server), `ws` (no dev-server in the core).

> **Note on grammars.** `web-tree-sitter` + prebuilt `.wasm` grammars were
> evaluated and rejected: the prebuilt set has no GDScript grammar, and
> mixing runtime and grammar ABI versions fails to load. The native Node
> bindings (`tree-sitter` 0.22.x + the three grammar packages) parse all three
> languages in one runtime and were verified working before being adopted.
> The wasm path remains the right choice for the browser/Electron renderer
> in Step 3, where only JS/TS/JSON grammars are needed.

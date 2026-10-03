# Architecture — @contextforge/core

Step 1 delivered core only. This is what each module is for and how the pieces
fit. The rules the code obeys are in [SPEC.md](../SPEC.md); the reasons for the
choices are in [DECISIONS.md](./DECISIONS.md).

## Layering

```
             ┌──────────────────────────────────────┐
             │  index.ts   the public surface        │
             └──────────────────────────────────────┘
                                  │
   ┌──────────────┬───────────────┼───────────────┬──────────────┐
   │              │               │               │              │
┌──▼───────┐ ┌────▼──────┐ ┌──────▼─────┐ ┌───────▼────┐ ┌──────▼──────┐
│  parse/  │ │  graph/   │ │  extract/  │ │   patch/   │ │  history/   │
│ syntax   │ │ the model │ │ the graph  │ │ safe edits │ │ undo/redo   │
│ trees    │ │ + queries │ │ of a real   │ │            │ │             │
│          │ │           │ │ project    │ │            │ │             │
└──────────┘ └───────────┘ └────────────┘ └────────────┘ └─────────────┘
   parse ──────────────────────► extract
                          patch ─► parse (syntax pre-check)
```

Dependencies point downward only. `parse` knows nothing about the graph,
`graph` knows nothing about the filesystem, and `history` knows only paths and
strings. That is what lets each be tested on its own.

## Modules

### `parse/` — syntax trees (SPEC R5)

| File | Responsibility |
| --- | --- |
| `grammars.ts` | Owns the native tree-sitter parsers: lazy load, per-language cache, and a `tryParse` that reports an ERROR/MISSING node with its line rather than returning a half-built tree. |
| `js.ts` | Reads a JS/TS module's imports, exports and asset-path string literals from its tree. |
| `gdscript.ts` | Reads a `.gd` file's signals, `@export` vars, constants, enums and public functions from its tree. |
| `tscn.ts` | A hand-written `.tscn` parser: `[node]`, `[ext_resource]`, `[sub_resource]`, `[connection]`, with a real tokenizer for the header attribute grammar. |

### `graph/` — the dependency model

| File | Responsibility |
| --- | --- |
| `types.ts` | `GraphNode`, `GraphEdge`, `NodeContract`, `SlotContract`, `Manifest`. The shared vocabulary. |
| `manifest.ts` | Zod schemas, `validateManifest`, `buildManifest`, and `canonicalizeGraph` for deterministic hashing. |
| `reverse.ts` | Everything *derived* rather than parsed: `depended_on_by`, dependency closures, cycles, and topological layers. |

### `extract/` — a real project becomes a graph

| File | Responsibility |
| --- | --- |
| `files.ts` | Deterministic directory walk, with engine caches and build output excluded. |
| `assets.ts` | Asset recognition and **slot contracts** — the promise an asset makes to its consumers. |
| `html.ts` | Finds `index.html`-style entrypoints and the project scripts they load. |
| `js.ts` | JS/Three.js extractor. |
| `godot.ts` | Godot extractor, including autoload `requires` edges. |

### `patch/` — safe editing

| File | Responsibility |
| --- | --- |
| `finder.ts` | Locates a FIND snippet through a ladder of passes, refusing anything ambiguous. |
| `editBlocks.ts` | Parses and applies `### EDIT:` blocks, all-or-nothing. |
| `fileBlocks.ts` | Parses and writes `### FILE:` blocks, all-or-nothing. |
| `syntaxCheck.ts` | Pre-save validation, in memory, via tree-sitter and `JSON.parse`. |
| `diff.ts` | Line diff and unified-diff rendering for the Patch screen's preview. |

### `history/` — undo/redo

`history.ts` holds a per-project 20-step stack of transactions. A transaction
records `before`/`after` per file, where `null` means "did not exist", which is
what makes creation and deletion undo correctly.

## How the pieces compose

**Applying a patch safely** — the path the Patch screen takes:

```
AI answer text
   │
   ├─ parseEditBlocks ──► blocks
   │
   ├─ per file: findTargetMatch each FIND  ──► refuse if ambiguous
   │
   ├─ apply to an in-memory buffer  ──► the file's final content
   │
   ├─ validateContentSyntax(content) ──► refuse, offer "apply anyway"
   │
   ├─ write to disk                       ◄── only now
   │
   └─ recordHistoryStep(before, after) ──► one undo step
```

**Building a graph** — the path the Context screen takes:

```
projectRoot
   │
   ├─ scanFiles            ──► deterministic file list
   │
   ├─ parseTscn / parseGdScript / parseJsModule ──► contracts
   │
   ├─ resolve references   ──► depends_on
   │
   ├─ withDependedOnBy     ──► the reverse edges no parser can see
   │
   └─ sortGraph            ──► byte-identical output every run
```

## Testing

214 tests across 11 files. `npm test` runs them; `npm run typecheck` and
`npm run check:boundaries` are the other two gates. `npm run verify` runs all
three.

| Suite | Tests | What it covers |
| --- | --- | --- |
| `parse/grammars.test.ts` | 7 | Grammar loading, parsing, error positions |
| `parse/js.test.ts` | 14 | JS/TS contracts from trees, incl. cases a regex gets wrong |
| `parse/gdscript.test.ts` | 15 | Signals, `@export`, public/private, nested scopes |
| `parse/tscn.test.ts` | 20 | Node/ext_resource/connection headers, quoting, errors |
| `graph/reverse.test.ts` | 18 | Reverse edges, closures, cycles, layering |
| `extract/files.test.ts` | 11 | Deterministic walk, ignored dirs, vendor exclusion |
| `extract/js.test.ts` | 23 | JS extractor over the fixture, contracts, determinism |
| `extract/godot.test.ts` | 26 | Godot extractor, autoloads, scene inheritance |
| `patch/patch.test.ts` | 46 | Finder passes, edit/file blocks, pre-check, diff |
| `history/history.test.ts` | 21 | Transactions, create/delete undo, 20-step cap |
| `smoke/realProject.test.ts` | 13 | The whole pipeline against the real v1 repo |

The smoke suite is the one that earns its keep: it found the vendored-bundle
performance problem (D11) and a node-loss bug in `layerNodes` (D12), neither of
which any curated fixture exposed. It never writes to v1 — the patch and undo
phases run against a copy in a temp directory.

# Dependencies

Free and open-source only (SPEC: dependency policy). Every entry is justified
below, and `npm audit --include=dev` reports **0 vulnerabilities**.

Verify with:

```bash
npm ls --all          # the resolved tree
npm audit --include=dev
```

---

## Runtime dependencies (`packages/core`)

| Package | Version | Licence | Why it is needed |
| --- | --- | --- | --- |
| `tree-sitter` | `^0.22.4` | MIT | Syntax trees for JS/TS/GDScript. SPEC R5 forbids deciding what code *means* with regex, and this is the parser. |
| `tree-sitter-javascript` | `^0.23.1` | MIT | The JavaScript grammar. |
| `tree-sitter-typescript` | `^0.23.2` | MIT | The TypeScript and TSX grammars — one package, two grammars. |
| `tree-sitter-gdscript` | `^6.1.0` | MIT | The GDScript grammar. Godot is half the target engines, so a JS-only solution would not satisfy R5. |
| `zod` | `^3.24.1` | MIT | Validation for the manifest (Step 1) and `scene.json` (Step 2). SPEC R6. Chosen over v1's Ajv so one library serves both — see D7. |

All five are MIT, maintained, and each grammar package does exactly one thing.

### Why the grammar versions are pinned as they are

`tree-sitter` is pinned to the **0.22.x** line because that is what
`tree-sitter-gdscript@6` declares as its peer range. Installing it with a
0.23/0.25 runtime resolves the peer conflict with `--legacy-peer-deps`, which
npm reports as an override rather than a clean install.

This is a known rough edge and is why D1 records the wasm alternative. Once
`tree-sitter-gdscript` publishes a peer range covering 0.23+, the pins move
together in a single commit.

---

## Development dependencies (root)

| Package | Version | Licence | Why it is needed |
| --- | --- | --- | --- |
| `typescript` | `^5.7.2` | Apache-2.0 | The language itself. SPEC R1. |
| `vitest` | `^5.0.3` | MIT | The test runner. SPEC R2. |
| `vite` | `^6.3.6` | MIT | Vitest 5's bundler peer. Listed explicitly rather than left implicit so a clean install cannot silently omit it. |
| `@types/node` | `^22.10.2` | MIT | Node typings for core's `fs`/`path` usage. |

### Why Vitest 5 and not 2

Vitest 2.x was the first choice and was discarded on audit: `@vitest/mocker` and
`esbuild` advisories (one critical, one high) affect that line, and `npm audit
fix` only clears them by upgrading across two major versions. Starting on 5.0.3
gives a clean audit with no override flags.

### Why `--legacy-peer-deps` is used at install time

Only because of the `tree-sitter` / `tree-sitter-gdscript` peer range described
above. It affects install, not the audit result.

---

## Deliberately not carried over from v1

| v1 package | Licence | Why it is gone |
| --- | --- | --- |
| `madge` | MIT | Resolved imports with its own parser and subprocess handling. v2 resolves imports from the tree it already builds — one parse, one source of truth (D2). |
| `ajv`, `ajv-formats` | MIT | Replaced by Zod, which SPEC R6 requires for `scene.json` anyway. Two validators for one project is one more thing to keep consistent (D7). |
| `express` | MIT | v2 is a desktop app (Electron, Step 4). Core needs no HTTP server, and the old server's only client was v1's own browser UI. |
| `ws` | MIT | Served the v1 dev-server. v2 does not run the game. |
| `three` | MIT | Not needed in Step 1. It arrives in Step 3 for the Modeling viewer, and SPEC R3 keeps it out of core: prefabs receive `THREE` as a parameter rather than importing it. |

---

## Planned for later steps

Listed here so the policy is visible, not because Step 1 needs them.

| Step | Package | Licence | Purpose |
| --- | --- | --- | --- |
| 3 | `three` | MIT | Render `scene.json` in the Modeling viewer. Injected into prefabs, never imported by them. |
| 3 | `web-tree-sitter` + JS/TS/JSON `.wasm` | MIT | The renderer runs in the browser context, where native bindings do not exist. Only the JS/TS/JSON grammars are needed there — GDScript is never parsed in the renderer. |
| 4 | `svelte`, `vite`, `electron` | MIT | The app shell. |
| 4 | `cytoscape.js` | MIT | Graph rendering; handles large graphs and folder grouping. |
| 2 | `typescript-eslint` | MIT | Drives the prefab lint that enforces SPEC R7 (`this`, globals, `scene.add`, unseeded randomness). |

Each must be justified and licence-checked at the point it is added, and recorded
here.

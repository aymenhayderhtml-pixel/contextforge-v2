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

**Status:** pending

_Not yet written._

---

## Phase 5b — Focus mode

**Status:** pending

_Not yet written._

---

## Phase 5c — Orphans drawer

**Status:** pending

_Not yet written._

---

## Phase 5d — New Project flow

**Status:** pending

_Not yet written._

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
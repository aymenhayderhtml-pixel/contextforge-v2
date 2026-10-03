# Outliner + Inspector (Svelte) — report

Step 3 area: the Scene screen's two side panels. Nothing here touches the
filesystem and nothing imports core's Node side; both components receive data as
props and emit intents upward.

## Files created

All under `packages/app/`:

| File | Role |
| --- | --- |
| `src/renderer/components/Outliner.svelte` | the searchable tree, with add and delete |
| `src/renderer/components/Inspector.svelte` | transform + generated params form |
| `src/renderer/components/tree.ts` | pure outliner logic (tree, search, delete wording, picker) |
| `src/renderer/components/fields.ts` | pure form-field derivation and validation |
| `src/renderer/components/errors.ts` | pure placement of a refusal under a control |
| `test/components/tree.test.ts` | 39 tests |
| `test/components/fields.test.ts` | 34 tests |
| `test/components/errors.test.ts` | 19 tests |
| `test/components/components.test.ts` | 18 SSR render tests |

`tree.ts` / `fields.ts` / `errors.ts` are plain `.ts` with no Svelte import, which
is what lets the logic be tested in Node (SPEC R2).

## Running the tests

```
npx vitest run --config vitest.svelte.tmp.config.ts packages/app/test/components
```

110 tests, all green. `vitest.svelte.tmp.config.ts` is a one-line config that
adds `svelte()` to the Vite pipeline; see "Changes needed elsewhere" below for
why the root config cannot do it.

The three pure-logic files need no plugin, so they also run under the repo's own
config with `npx vitest run packages/app/test/components` — 92 tests green
there, with `components.test.ts` failing to *transform* (not to assert).

## Component APIs

### `Outliner.svelte`

Props: `instances`, `prefabs`, `failed`, `selection`, plus optional callbacks
`onSelect`, `onAdd`, `onDelete`.

- `onSelect(selection: Selection)` — every click and every arrow key goes here.
  The component never assigns to its own `selection` prop.
- `onAdd(intent: AddIntent)` — `{ prefab, parent }`. The prefab name is read
  from `prefabs[].name` and is never synthesised; the intent deliberately
  carries **no id**, because ids must be unique per scene and the shell that
  owns the snapshot is the one that should mint one.
- `onDelete(intent: DeleteIntent)` — `{ instanceId, reparentedTo }`, fired only
  after the inline confirmation.

### `Inspector.svelte`

Props: `selection`, `instance`, `prefabs`, optional `errors`, `onEdit`,
`onSelect`.

- `onEdit(edit: SceneEdit)` — the core edit union, so the inspector cannot
  invent an operation core does not have. Transform edits are
  `{ op: 'setTransform', instanceId, patch }`; params edits are
  `{ op: 'setParams', instanceId, params }` (merged, never replaced).
- `errors: readonly string[]` — `Result.reason` sentences from the main
  process, shown verbatim. Passed raw rather than pre-placed because only this
  component knows which control the developer just edited, and that is the
  strongest signal for placing a refusal.
- `onSelect(selection)` — for the Deselect button.

## Exported pure functions

### `tree.ts`

```ts
interface OutlinerNode { instance, label, depth, orphan, failed, failure, children }
type VisibleReason = 'match' | 'descendant' | 'ancestor'
interface VisibleNode { node, children, reason }
interface AddIntent { prefab: string; parent: string | null }
interface DeleteIntent { instanceId: string; reparentedTo: string | null }
type PickerState =
  | { kind: 'empty-registry' }
  | { kind: 'no-match'; query: string }
  | { kind: 'list'; prefabs: readonly PrefabSummary[] }

instanceLabel(instance: SceneInstance): string
buildTree(instances: readonly SceneInstance[],
          failedByName?: ReadonlyMap<string, PrefabFailure>): OutlinerNode[]
matchesQuery(node: OutlinerNode, query: string): boolean
filterTree(nodes: readonly OutlinerNode[], query: string): VisibleNode[]
flattenTree(nodes: readonly OutlinerNode[]): OutlinerNode[]
flattenVisible(nodes: readonly VisibleNode[]): VisibleNode[]
childCount(node: OutlinerNode): number
countSubtree(node: OutlinerNode): number
countDirectChildren(node: OutlinerNode): number
reparentTargetLabel(node: OutlinerNode): string
describeRemoval(node: OutlinerNode): string
deleteIntentFor(node: OutlinerNode): DeleteIntent
addIntentFor(prefabName: string, parentId: string | null): AddIntent
pickerState(prefabs: readonly PrefabSummary[], query: string): PickerState
pickerEmptyText(state: PickerState): string
```

### `fields.ts`

```ts
type EditableKind = 'number' | 'string' | 'boolean' | 'select'
type FieldInputValue = string | number | boolean
type VectorAxis = 'x' | 'y' | 'z'
type VectorKey = keyof Transform

interface FormField {
  name, title, required,
  kind: EditableKind | 'unsupported',
  reason, value: JsonValue | null,
  min, max: number | null,
  options: readonly string[],
  hasDefault: boolean, defaultValue: JsonValue | null
}

const VECTOR_AXES: readonly ['x','y','z']
const EMPTY_JSON_SCHEMA: JsonSchema

fieldTitle(name: string, field: FieldSchema): string
fieldValue(name, field, params): JsonValue | null
toFormField(name, field, schema, params): FormField
buildFormFields(schema: JsonSchema | null, params): FormField[]
findUnknownParams(schema: JsonSchema | null, params): string[]
parseFieldInput(kind: EditableKind, raw: string): FieldInputValue | null
formatFieldInput(value: JsonValue | null): string
validateField(field: FormField, raw: string): string | null
editability(instance: SceneInstance | null): { editable: boolean; reason: string }
readVector(transform: Transform, key: VectorKey): Vec3
transformPatch(key, axis, raw): { key, axis, value } | null
vectorPatch(key: VectorKey, values: readonly [string,string,string])
  : { patch: Record<VectorKey, Vec3> } | null
```

### `errors.ts`

```ts
type ErrorScope = { kind: 'field'; field: string } | { kind: 'global' }
interface PlacedError { scope: ErrorScope; reason: string }

const TRANSFORM_KEYS: readonly ['position','rotation','scale']

findParamPath(reason: string): string | null
findTransformPath(reason: string): string | null
placeError(reason: string, fields: readonly FormField[], field?: string | null): PlacedError
groupErrors(errors: readonly PlacedError[]):
  { byField: ReadonlyMap<string, string>; global: string }
reasonForField(byField: ReadonlyMap<string, string>, name: string, local: string | null): string | null
```

## How search keeps the children of a matched parent

`filterTree` carries an `ancestorMatched` flag down the walk. A node survives
if it matched itself, if any descendant survived, or if an ancestor matched —
and in the third case its whole subtree comes with it, because the same flag is
passed to its children. So a search that matches only a parent by display name
still shows every instance beneath it.

Each surviving row records *why* it is there, and the outliner renders that as a
badge:

- `match` — the row matched the query.
- `descendant` — shown as `via child`; something below it matched.
- `ancestor` — shown because a parent matched; the row itself did not.

Without the third case the obvious bug appears: the developer searches `crate`,
sees one row, and cannot tell whether the four coins hanging off it were deleted
or filtered. `tree.test.ts` pins both directions, including a query (`Crat`) that
matches the parent by name and nothing else.

A second, related guard: an instance whose `parent` names an id that is not in
the list is surfaced **at the root with a `missing parent` marker**, never
dropped. An instance the outliner cannot show is an instance that cannot be
selected or deleted.

## How a delete with children is handled

There is no silent path. Clicking ✕ on any row sets `pendingDeleteId` and opens
an inline `role="alertdialog"` next to that row. Nothing is emitted until
**Delete** is pressed there; Cancel clears it.

The text comes from `describeRemoval`, one function so the wording cannot drift
between the dialog and any future shortcut:

- leaf — `Delete "lamp"? It has no children, so nothing else changes.`
- with children — `Delete "Crate"? Its 2 children will be moved up to the scene
  root, and kept — nothing is deleted with it.`

`reparentTargetLabel` names the destination exactly as core's `removeInstance`
behaves: the removed instance's **own parent**, or `the scene root` when it was a
root. The dialog also repeats the consequence in plainer words ("Its children
are kept and moved up") so the guarantee is not buried in one sentence.

`window.confirm` is deliberately not used: a modal string is not readable next to
the button that caused it, and it cannot show the child count.

## How field-level errors are placed

`errors.ts` resolves each refusal to a control in three steps, in order:

1. **The field the caller was on.** The Inspector sets `activeField` on every
   `oninput` and every commit, and passes it to `placeError`. A refusal on the
   edit just made is never misfiled, even if the sentence mentions another field
   (a prefab param called `position`, say).
2. **A JSON path in the reason.** Scene-schema errors name a JSON path (R9), so
   `params.speed`, `params["maxSpeed"]` and
   `instances[3].transform.position` are all recognised. The patterns are
   anchored on the field boundary, not a bare substring — otherwise a field
   called `speed` is matched by the word "scale" in an unrelated sentence, and
   `maxSpeed` is matched inside `overSpeed`.
3. **A bare mention of a declared field name**, as a last resort.

If none of those match, the refusal is returned as `{ kind: 'global' }` and
shown once above the form. That is the honest answer: an id clash or a project
with no manifest is not about one control, and pinning it to an arbitrary input
would send the developer somewhere useless.

`groupErrors` then splits the placed errors into `byField` and one `global`
string. The last error for a field wins, because it is the most recent refusal;
globals are joined, not dropped. In the markup every input renders its own
`reasonForField(...)` in a `.field-error` element directly beneath it, and a
refusal from the main process takes precedence over the local `validateField`
text, verbatim and untruncated. There is no banner path for a refusal that names
a field.

Local validation only exists to stop a keystroke becoming a failed write:
`vectorPatch` returns `null` for `"-"`, `"1e"` and `""`, so a half-typed number
never produces an edit.

## Other behaviour worth stating

- **`unsupported` fields render no input at all** — not a text box, and not even
  a `<label for>` pointing at the explanatory paragraph. The field name and the
  registry's reason are shown as text. A control that writes a value the prefab's
  own Zod schema will reject is worse than an honest "cannot edit this".
- **`locked: true` is honoured as read-only**, not merely dimmed: the two
  `fieldset`s are `disabled`, a `locked` badge is shown, and `editability()`
  also short-circuits every commit path. A disabled control that still fires on
  a keyboard shortcut is not locked.
- **Rotation is edited in radians**, because that is what the scene schema
  stores; a degrees field would be a second source of truth for one angle.
- **Params absent from the instance fall back to the prefab's `default`**, and
  render as empty when there is neither — never as a fabricated `0`. `params: {}`
  means "use all prefab defaults" (core's `setParams` merges for the same
  reason).
- **Unknown params are surfaced.** With `additionalProperties: false`, params on
  the instance that the schema does not declare will fail validation on save, so
  the inspector names them before the developer discovers it as a save error.
- **Keyboard navigation walks the *filtered* rows**, so a down-arrow with a
  search active cannot move the selection to a row that is not on screen.

## Changes needed elsewhere (not made — not my files)

1. **`vitest.config.ts` (root) needs `plugins: [svelte()]`** to run
   `components.test.ts`. Without it Vitest hands the raw `.svelte` source to
   esbuild and fails at import analysis. Suggested:

   ```ts
   import { svelte } from '@sveltejs/vite-plugin-svelte';
   export default defineConfig({ plugins: [svelte()], test: { /* unchanged */ } });
   ```

   The three pure-logic suites are unaffected and pass under the current config.

2. **`tsconfig` does not cover `.svelte` files.** `packages/app/tsconfig.json`
   has `"include": ["src/**/*.ts"]`, so `svelte-check` reports nothing about the
   components. Either add a `svelte-check` script with its own tsconfig, or
   narrow `rootDir` handling. I verified both components compile clean with
   `svelte@5.57`'s compiler and that a `tsc --noEmit` pass over
   `src/renderer/components/**` is error-free under the repo's strict options
   (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`).

3. **`svelte-check` is not a dependency** of the workspace, so it cannot resolve
   the Svelte Vite plugin from `packages/app/vite.config.ts` and fails with
   "No Svelte configuration found in vite config". Adding `svelte-check` to
   `packages/app`'s devDependencies (alongside `svelte` and the Vite plugin) is
   what makes the type gate runnable.

4. **Nothing wires the two panels together yet.** The shell that owns
   `SceneSnapshot`, mints instance ids for `AddIntent`, converts
   `DeleteIntent`/`SceneEdit` into `CHANNELS.applyEdit`, and holds the current
   `Result.reason` list is not part of this step. `EditorState` in `ipc.ts` is
   the intended home for the selection and the last error set.

5. **v1 was not read or modified.** It is referenced in `SPEC.md` as
   read-only reference material; this step was implemented from `SPEC.md`,
   `docs/DECISIONS.md`, `ipc.ts` and core's scene schema.

## Not done

- **No click or keypress behaviour is asserted in a test.** `svelte/server`'s
  `render` produces markup and runs the `$derived` chains but cannot dispatch
  events, and adding jsdom or `@testing-library/svelte` would mean new
  dependencies this step was not asked to introduce. Every *decision* a click
  reaches — what the search keeps, what the delete says, which field a refusal
  belongs to, whether a vector is parseable — is a pure function with tests, so
  the untested surface is the event wiring alone.
- **No drag-to-reparent.** Re-parenting is not in the brief, and the only path
  for it today is `removeInstance`'s re-parent-on-delete, whose consequence is
  stated in the confirmation.
- **The tree is always fully expanded.** There is no collapse/expand state; the
  search filter and the depth indent are the only hierarchy affordances.
- **Prefabs that failed are not placeable.** A `PrefabFailure` has no
  `paramsJsonSchema`, so it appears in the failure list and on affected rows but
  is not offered in the add picker. Showing it as placeable would mean
  generating a form from nothing.
- **The `errors` prop is a flat `string[]`**, so two refusals for the same field
  collapse to the last one. That is the intended precedence, but it means the
  inspector cannot show a history of refusals.
- **`swapModel` and the `model` field are not exposed.** They are in the `SceneEdit`
  union and out of this brief's scope (the slot contract is a later step).

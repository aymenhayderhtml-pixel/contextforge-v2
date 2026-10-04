<!--
  Inspector.svelte — edits the selected instance, and nothing else.

  ## Structure

  1. **Identity**, with the locked marker.
  2. **Transform** — three editable 3-vectors on compact single rows. Rotation is
     in radians because that is what the scene schema stores (SPEC §4.2).
  3. **Params**, generated from the prefab's `paramsJsonSchema`.

  Both Transform and Params sections are collapsible, keeping controls accessible
  and visible without scrolling on standard window sizes.

  ## Two rules this file is shaped around

  **Errors are per-field.** Every input renders its own refusal immediately
  beneath itself, from `groupErrors`/`placeError` in `errors.ts` and `AppError`
  records. There is no global banner for a refusal that names a field.

  **Nothing is written from here.** Edits leave as `onEdit(SceneEdit)` — the
  same discriminated union the main process applies.
-->

<script lang="ts">
  import type { JsonSchema, PrefabSummary, Selection } from '../../ipc.js';
  import type { JsonValue, SceneEdit, SceneInstance, Vec3 } from '@contextforge/core';
  import type { AppError } from '../../errors.js';
  import { extractDetails, extractShortLine } from '../errorFormatting.js';
  import {
    EMPTY_JSON_SCHEMA,
    VECTOR_AXES,
    buildFormFields,
    editability,
    findUnknownParams,
    formatFieldInput,
    parseFieldInput,
    readVector,
    validateField,
    vectorPatch,
    type FieldInputValue,
    type FormField,
    type VectorKey,
  } from './fields.js';
  import { groupErrors, placeError, reasonForField } from './errors.js';

  interface Props {
    /** What is selected. `kind: 'none'` renders the empty state. */
    selection: Selection;
    /** The selected instance, or `null`. The single source of what is shown. */
    instance: SceneInstance | null;
    /** The registry, to find the selected instance's prefab. */
    prefabs: readonly PrefabSummary[];
    /**
     * Refusals from the main process or AppError records.
     */
    errors?: readonly (AppError | string)[];
    /** One scene edit, ready for the main process. */
    onEdit?: (edit: SceneEdit) => void;
    /** Selection changed elsewhere (the outliner). */
    onSelect?: (selection: Selection) => void;
  }

  const {
    selection,
    instance,
    prefabs,
    errors = [],
    onEdit = () => {},
    onSelect = () => {},
  }: Props = $props();

  /** Collapsible section states */
  let transformCollapsed = $state(false);
  let paramsCollapsed = $state(false);

  /** Local, per-instance overrides of the last value written. */
  let transformDrafts = $state<Record<string, string>>({});
  let paramDrafts = $state<Record<string, string>>({});

  const { editable, reason: lockedReason } = $derived(editability(instance));

  const prefab = $derived(
    instance === null
      ? null
      : (prefabs.find((entry) => entry.name === instance.prefab) ?? null),
  );

  /**
   * The schema the form is built from.
   */
  const schema = $derived<JsonSchema>(prefab?.paramsJsonSchema ?? EMPTY_JSON_SCHEMA);

  const fields = $derived<FormField[]>(buildFormFields(schema, instance?.params ?? {}));
  const unknownParams = $derived(findUnknownParams(schema, instance?.params ?? {}));

  /** The field the developer was last on, used to place a refusal precisely. */
  let activeField = $state<string | null>(null);

  let showGlobalDetails = $state(false);

  /**
   * One row in the inspector's error list.
   *
   * `field` and `details` are `?: string | undefined` rather than `?: string`.
   * Under `exactOptionalPropertyTypes` (on in `tsconfig.base.json`) an optional
   * property does **not** accept an explicit `undefined`, so assigning
   * `details: extractDetails(err)` — which returns `string | undefined` — was an
   * error at every push below. Widening the type to accept `undefined` is the
   * fix rather than coercing each value, because the values genuinely are
   * sometimes absent and `?? ''` would turn "no detail" into an empty detail that
   * the template would then render.
   */
  interface InspectorErrorRow {
    field?: string | undefined;
    reason: string;
    details?: string | undefined;
  }

  /** Normalize string errors and AppError objects with strict instance scoping */
  const normalizedErrors = $derived.by(() => {
    if (instance === null) return [];
    const list: InspectorErrorRow[] = [];

    for (const err of errors) {
      if (typeof err === 'string') {
        const idMatch = /instance\s*["']([^"']+)["']/.exec(err);
        if (idMatch?.[1] !== undefined && idMatch[1] !== instance.id) {
          continue;
        }
        list.push({
          reason: extractShortLine(err),
          details: extractDetails(err),
        });
      } else if (typeof err === 'object' && err !== null && 'scope' in err) {
        const appErr = err as AppError;
        // Project-level problems go to ProblemsPanel, NOT into the inspector
        if (appErr.scope === 'project') continue;

        // Instance error scoping: only errors that belong to the currently selected instance
        if (appErr.instanceId !== undefined && appErr.instanceId !== instance.id) {
          continue;
        }

        if (appErr.scope === 'field') {
          let fieldName = appErr.fieldPath ?? '';
          if (fieldName.startsWith('params.')) fieldName = fieldName.slice(7);
          else if (fieldName.startsWith('transform.')) fieldName = fieldName.slice(10);
          list.push({
            field: fieldName || undefined,
            reason: appErr.short,
            details: appErr.details,
          });
        } else if (appErr.scope === 'instance') {
          list.push({
            reason: appErr.short,
            details: appErr.details,
          });
        }
      }
    }
    return list;
  });

  const { byField, global: globalError, globalDetails } = $derived.by(() => {
    const placed = normalizedErrors.map(({ field, reason, details }) => {
      const p = placeError(reason, fields, field ?? activeField);
      return details !== undefined ? { ...p, details } : p;
    });
    const grouped = groupErrors(placed);
    const globalPlaced = placed.filter((p) => p.scope.kind === 'global');
    const details = globalPlaced.map((p) => p.details).filter((d): d is string => Boolean(d)).join('\n');
    return {
      byField: grouped.byField,
      global: grouped.global,
      globalDetails: details !== '' ? details : undefined,
    };
  });

  const vectors = $derived.by(() => {
    if (instance === null) return [];
    return (['position', 'rotation', 'scale'] as const).map((key) => ({
      key,
      label: key === 'rotation' ? 'rotation (radians)' : key,
      values: readVector(instance.transform, key),
    }));
  });

  function draftKey(key: VectorKey, axis: string): string {
    return `${key}.${axis}`;
  }

  function vectorDraft(key: VectorKey, axis: string, values: Vec3, index: number): string {
    const draft = transformDrafts[draftKey(key, axis)];
    if (draft !== undefined) return draft;
    const value = values[index];
    return value === undefined ? '' : String(value);
  }

  function setVectorDraft(key: VectorKey, axis: string, value: string): void {
    activeField = key;
    transformDrafts = { ...transformDrafts, [draftKey(key, axis)]: value };
  }

  function commitVector(key: VectorKey, node: { values: Vec3 }): void {
    if (instance === null || !editable) return;
    activeField = key;
    const axes = VECTOR_AXES.map(
      (axis, index) => vectorDraft(key, axis, node.values, index),
    ) as [string, string, string];
    const built = vectorPatch(key, axes);
    if (built === null) return;
    onEdit({ op: 'setTransform', instanceId: instance.id, patch: built.patch });
  }

  function resetVectorDrafts(): void {
    transformDrafts = {};
  }

  function paramDraft(field: FormField): string {
    const draft = paramDrafts[field.name];
    if (draft !== undefined) return draft;
    return formatFieldInput(field.value);
  }

  function setParamDraft(name: string, value: string): void {
    activeField = name;
    paramDrafts = { ...paramDrafts, [name]: value };
  }

  function commitParam(field: FormField): void {
    if (instance === null || !editable || field.kind === 'unsupported') return;
    activeField = field.name;
    const raw = paramDraft(field);
    const localProblem = validateField(field, raw);
    if (localProblem !== null) return;
    const parsed = parseFieldInput(field.kind, raw);
    if (parsed === null) return;
    const params: Record<string, JsonValue> = { [field.name]: parsed as JsonValue };
    onEdit({ op: 'setParams', instanceId: instance.id, params });
  }

  function resetParam(field: FormField): void {
    if (instance === null || !editable || field.defaultValue === null) return;
    const params: Record<string, JsonValue> = { [field.name]: field.defaultValue };
    onEdit({ op: 'setParams', instanceId: instance.id, params });
  }

  function fieldReason(field: FormField): string | null {
    const raw = field.kind === 'unsupported' ? '' : paramDraft(field);
    const local = field.kind === 'unsupported' ? null : validateField(field, raw);
    return reasonForField(byField, field.name, local);
  }

  function inputType(field: FormField): 'number' | 'text' {
    return field.kind === 'number' ? 'number' : 'text';
  }

  function onVectorEnter(event: KeyboardEvent, key: VectorKey, node: { values: Vec3 }): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commitVector(key, node);
  }

  function onParamEnter(event: KeyboardEvent, field: FormField): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commitParam(field);
  }

  function controlValue(field: FormField): FieldInputValue {
    if (field.kind === 'boolean') return field.value === true;
    return paramDraft(field);
  }
</script>

<section class="inspector" aria-label="Instance inspector">
  {#if selection.kind === 'none' || instance === null}
    <p class="empty">Nothing is selected. Pick an instance in the outliner.</p>
  {:else}
    <header>
      <h2 title={instance.name !== undefined && instance.name !== '' ? instance.name : instance.id}>
        {instance.name !== undefined && instance.name !== '' ? instance.name : instance.id}
      </h2>
      {#if instance.locked === true}
        <span class="badge locked" title={lockedReason}>locked</span>
      {/if}
    </header>

    <dl class="identity">
      <dt>id</dt>
      <dd title={instance.id}>{instance.id}</dd>
      <dt>prefab</dt>
      <dd title={instance.prefab}>
        <span class="prefab-name">{instance.prefab}</span>
        {#if prefab === null}
          <span class="badge missing" title="Not in the prefab registry">
            not registered
          </span>
        {/if}
      </dd>
    </dl>

    {#if instance.locked === true}
      <p class="locked-note" role="note">{lockedReason}.</p>
    {/if}

    {#if globalError !== ''}
      <div class="global-error-container">
        <p class="global-error" role="alert">{globalError}</p>
        {#if globalDetails !== undefined}
          <button
            type="button"
            class="details-toggle"
            aria-expanded={showGlobalDetails}
            onclick={() => (showGlobalDetails = !showGlobalDetails)}
          >
            {showGlobalDetails ? 'Hide details' : 'Details'}
          </button>
          {#if showGlobalDetails}
            <pre class="error-details">{globalDetails}</pre>
          {/if}
        {/if}
      </div>
    {/if}

    <fieldset class="section-box" disabled={!editable}>
      <legend>
        <button
          type="button"
          class="collapse-btn"
          aria-expanded={!transformCollapsed}
          onclick={() => (transformCollapsed = !transformCollapsed)}
        >
          <span class="chevron">{transformCollapsed ? '▶' : '▼'}</span>
          <span>transform</span>
        </button>
      </legend>
      {#if !transformCollapsed}
        <div class="vectors">
          {#each vectors as node (node.key)}
            <div class="vector-row">
              <span class="vector-label" title={node.label}>{node.label}</span>
              <div class="vector-axes">
                {#each VECTOR_AXES as axis, index (axis)}
                  <label class="axis-field">
                    <span class="axis-tag">{axis}</span>
                    <input
                      type="number"
                      step="any"
                      inputmode="decimal"
                      aria-label={`${node.key} ${axis}`}
                      value={vectorDraft(node.key, axis, node.values, index)}
                      oninput={(event) =>
                        setVectorDraft(node.key, axis, event.currentTarget.value)}
                      onchange={() => commitVector(node.key, node)}
                      onkeydown={(event) => onVectorEnter(event, node.key, node)}
                    />
                  </label>
                {/each}
              </div>
            </div>
            {#if byField.has(node.key)}
              <p class="field-error" role="alert">{byField.get(node.key)}</p>
            {/if}
          {/each}
        </div>
        <button type="button" class="btn-sm" onclick={resetVectorDrafts}>Discard transform edits</button>
      {/if}
    </fieldset>

    <fieldset class="section-box" disabled={!editable}>
      <legend>
        <button
          type="button"
          class="collapse-btn"
          aria-expanded={!paramsCollapsed}
          onclick={() => (paramsCollapsed = !paramsCollapsed)}
        >
          <span class="chevron">{paramsCollapsed ? '▶' : '▼'}</span>
          <span>params</span>
        </button>
      </legend>
      {#if !paramsCollapsed}
        {#if fields.length === 0}
          <p class="empty">
            {#if prefab === null}
              This instance's prefab is not in the registry, so there is no schema to
              generate a form from. Its params are still saved: nothing here is invented.
            {:else}
              This prefab declares no parameters.
            {/if}
          </p>
        {/if}

        <div class="fields-list">
          {#each fields as field (field.name)}
            <div class="field" class:unsupported={field.kind === 'unsupported'}>
              {#if field.kind === 'unsupported'}
                <span class="field-title" title={field.title}>{field.title}</span>
                <p class="unsupported-note">Not editable: {field.reason}</p>
              {:else}
                <label for={`param-${field.name}`} title={field.title}>
                  <span class="field-title-text">{field.title}</span>
                  {#if field.required}<span class="required" title="Required by the prefab">*</span>{/if}
                </label>

                {#if field.kind === 'boolean'}
                  <input
                    id={`param-${field.name}`}
                    type="checkbox"
                    checked={controlValue(field) === true}
                    onchange={(event) => {
                      setParamDraft(field.name, event.currentTarget.checked ? 'true' : 'false');
                      commitParam(field);
                    }}
                  />
                {:else if field.kind === 'select'}
                  <select
                    id={`param-${field.name}`}
                    value={paramDraft(field)}
                    onchange={() => commitParam(field)}
                    onkeydown={(event) => onParamEnter(event, field)}
                  >
                    {#each field.options as option (option)}
                      <option value={option}>{option}</option>
                    {/each}
                  </select>
                {:else}
                  <input
                    id={`param-${field.name}`}
                    type={inputType(field)}
                    value={paramDraft(field)}
                    min={field.min ?? undefined}
                    max={field.max ?? undefined}
                    oninput={(event) => setParamDraft(field.name, event.currentTarget.value)}
                    onchange={() => commitParam(field)}
                    onkeydown={(event) => onParamEnter(event, field)}
                  />
                {/if}
              {/if}

              {#if field.hasDefault}
                <button type="button" class="btn-sm" onclick={() => resetParam(field)}>
                  reset to {formatFieldInput(field.defaultValue)}
                </button>
              {/if}

              {#if fieldReason(field) !== null}
                <p class="field-error" role="alert">{fieldReason(field)}</p>
              {/if}
            </div>
          {/each}
        </div>

        {#if unknownParams.length > 0}
          <p class="global-error" role="alert">
            This instance sets {unknownParams.join(', ')}, which the prefab's schema does not
            declare and its unknown-key check rejects. Saving will fail until they are removed.
          </p>
        {/if}
      {/if}
    </fieldset>

    <button type="button" class="btn-sm deselect" onclick={() => onSelect({ kind: 'none' })}>
      Deselect
    </button>
  {/if}
</section>

<style>
  .inspector {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    min-width: 0;
    max-width: 100%;
    overflow-x: hidden;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }
  .identity {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.15rem 0.5rem;
    margin: 0;
    font-size: 0.85em;
    min-width: 0;
  }
  .identity dt {
    opacity: 0.7;
    white-space: nowrap;
  }
  .identity dd {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .section-box {
    border: 1px solid #444;
    border-radius: 4px;
    padding: 0.5rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }
  .section-box:disabled {
    opacity: 0.75;
  }
  legend {
    padding: 0 4px;
    margin-left: 2px;
  }
  .collapse-btn {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    font-size: 0.8em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 2px 4px;
    border-radius: 3px;
  }
  .collapse-btn:hover {
    background: rgba(255, 255, 255, 0.08);
  }
  .chevron {
    font-size: 0.75em;
    user-select: none;
  }
  .vectors {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    min-width: 0;
  }
  .vector-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
  }
  /*
    The three axis inputs share whatever the label leaves, so a long label eats
    their digits. `rotation (radians)` was 6.2rem wide, which squeezed the z
    input to about two characters and rendered `3.14` as `3.1` — a rotation value
    silently displayed wrong, which is worse than a clipped label because the
    developer reads the truncated number as the real one and saves it back.
    8.5rem fits the longest label in full and leaves each axis room for a signed
    decimal.
  */
  .vector-label {
    width: 8.5rem;
    flex-shrink: 0;
    font-size: 0.8em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.85;
  }
  .vector-axes {
    display: flex;
    flex: 1;
    gap: 0.3rem;
    min-width: 0;
  }
  .axis-field {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 4.5rem;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid #444;
    border-radius: 3px;
    padding: 1px 4px;
  }
  .axis-field:focus-within {
    border-color: #646cff;
  }
  .axis-tag {
    font-size: 0.7em;
    font-weight: 600;
    opacity: 0.6;
    margin-right: 2px;
    user-select: none;
    text-transform: uppercase;
  }
  .axis-field input {
    width: 100%;
    min-width: 0;
    border: none;
    background: transparent;
    color: inherit;
    font-size: 0.85em;
    padding: 1px 0;
  }
  .axis-field input:focus {
    outline: none;
  }
  .fields-list {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    min-width: 0;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }
  .field label {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.85em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .field-title-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .field input[type="text"],
  .field input[type="number"],
  .field select {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }
  .required {
    color: #b4553a;
  }
  .field-error {
    margin: 0;
    color: #e05252;
    font-size: 0.8em;
    overflow-wrap: break-word;
  }
  .global-error-container {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .global-error {
    margin: 0;
    color: #b4553a;
    font-size: 0.85em;
    border: 1px solid currentColor;
    padding: 0.35rem;
    border-radius: 3px;
  }
  .details-toggle {
    background: transparent;
    border: 1px solid #555;
    color: inherit;
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 0.75rem;
    cursor: pointer;
    align-self: flex-start;
  }
  .error-details {
    margin: 0;
    font-family: monospace;
    font-size: 0.75rem;
    white-space: pre-wrap;
    background: rgba(0, 0, 0, 0.25);
    padding: 0.35rem;
    border-radius: 3px;
  }
  .field-title {
    font-weight: 500;
    font-size: 0.85em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .unsupported-note {
    margin: 0;
    opacity: 0.8;
    font-size: 0.8em;
  }
  .badge {
    font-size: 0.7em;
    border: 1px solid currentColor;
    border-radius: 3px;
    padding: 0 0.25em;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .badge.locked {
    color: #b08b2a;
  }
  .badge.missing {
    color: #b4553a;
  }
  .locked-note {
    margin: 0;
    font-size: 0.85em;
    color: #b08b2a;
  }
  .empty {
    margin: 0;
    opacity: 0.7;
    font-size: 0.85em;
  }
  .btn-sm {
    font-size: 0.8em;
    padding: 3px 8px;
    align-self: flex-start;
  }
  .deselect {
    margin-top: 0.25rem;
  }
</style>

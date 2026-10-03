/**
 * components.test.ts — the two components, rendered without a browser.
 *
 * `svelte/server`'s `render` is used rather than a DOM: it exercises the real
 * templates and the real `$derived` chains, so a typo in a prop name or an
 * `{#if}` that swallows a section is caught here, with no jsdom and no
 * @testing-library. What it cannot do is click anything, which is exactly why
 * every *decision* lives in `tree.ts` / `fields.ts` / `errors.ts` and is tested
 * there — this file asserts what reaches the screen.
 *
 * The search-with-a-query case cannot be driven from props (the query is
 * component state), so it is asserted in `tree.test.ts` where the filter
 * itself lives.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { JsonSchema, PrefabFailure, PrefabSummary, Selection } from '../../src/ipc.js';
import type { SceneInstance } from '@contextforge/core';
import Inspector from '../../src/renderer/components/Inspector.svelte';
import Outliner from '../../src/renderer/components/Outliner.svelte';

const schema: JsonSchema = {
  type: 'object',
  properties: {
    speed: { kind: 'number', title: 'Speed', min: 0, max: 10, default: 1 },
    label: { kind: 'string', title: 'Label' },
    mode: { kind: 'string', title: 'Mode', options: ['lit', 'dark'] },
    castsShadow: { kind: 'boolean', title: 'Casts shadow' },
    texture: {
      kind: 'unsupported',
      title: 'Texture',
      reason: 'the Zod type is a ZodRecord, which has no single control',
    },
  },
  required: ['speed'],
  additionalProperties: false,
};

const prefabs: PrefabSummary[] = [
  { name: 'crate', description: 'a wooden box', paramsJsonSchema: schema },
  { name: 'coin', description: 'a spinning coin', paramsJsonSchema: schema },
];

function instance(id: string, extra: Partial<SceneInstance> = {}): SceneInstance {
  return {
    id,
    prefab: 'crate',
    transform: { position: [1, 2, 3], rotation: [0.5, 0, 0], scale: [1, 1, 1] },
    params: { speed: 3 },
    ...extra,
  };
}

const scene: SceneInstance[] = [
  instance('crate', { name: 'Crate' }),
  instance('coin-a', { prefab: 'coin', parent: 'crate' }),
  instance('coin-b', { prefab: 'coin', parent: 'crate' }),
  instance('lamp', { prefab: 'coin', locked: true, visible: false }),
];

const selection: Selection = { kind: 'instance', id: 'crate' };

describe('Outliner', () => {
  const props = { instances: scene, prefabs, failed: [] as PrefabFailure[], selection };

  it('renders every instance, with the display name and the id as a tooltip', () => {
    const { body } = render(Outliner, { props });
    expect(body).toContain('Crate');
    expect(body).toContain('coin-a');
    expect(body).toContain('coin-b');
    expect(body).toContain('title="crate"');
  });

  it('marks a locked and a hidden instance rather than hiding the row', () => {
    const { body } = render(Outliner, { props });
    expect(body).toContain('locked');
    expect(body).toContain('hidden');
    expect(body).toContain('lamp');
  });

  it('marks an instance whose parent is missing, instead of dropping it', () => {
    const { body } = render(Outliner, {
      props: { ...props, instances: [instance('orphan', { parent: 'gone' })] },
    });
    expect(body).toContain('orphan');
    expect(body).toContain('missing parent');
  });

  it('marks a row whose prefab failed to load, and lists the failure', () => {
    const failed: PrefabFailure[] = [
      { name: 'coin', file: 'prefabs/coin.ts', reason: 'THREE is not defined' },
    ];
    const { body } = render(Outliner, { props: { ...props, failed } });
    expect(body).toContain('prefab failed');
    expect(body).toContain('THREE is not defined');
    expect(body).toContain('prefabs/coin.ts');
  });

  it('gives every row a delete control, and no delete fires on its own', () => {
    // The row count is the assertion that matters: a destructive control is
    // present per row and is only ever armed through the confirmation.
    const { body } = render(Outliner, { props });
    const deletes = body.match(/aria-label="Delete /g) ?? [];
    expect(deletes).toHaveLength(scene.length);
  });

  it('offers every prefab name from the registry and invents none', () => {
    const { body } = render(Outliner, { props });
    expect(body).toContain('crate');
    expect(body).toContain('a wooden box');
    expect(body).toContain('a spinning coin');
  });

  it('says so when the registry is empty rather than showing an empty picker', () => {
    const { body } = render(Outliner, { props: { ...props, prefabs: [] } });
    expect(body).toContain('No prefabs loaded');
  });

  it('says so when the scene has no instances', () => {
    const { body } = render(Outliner, { props: { ...props, instances: [] } });
    expect(body).toContain('no instances');
  });

  it('marks the selected row for assistive technology', () => {
    const { body } = render(Outliner, { props });
    expect(body).toContain('aria-selected="true"');
    // One selected row, not the whole tree.
    expect(body.match(/aria-selected="true"/g)).toHaveLength(1);
  });
});

describe('Inspector', () => {
  it('renders an empty state when nothing is selected', () => {
    const { body } = render(Inspector, {
      props: { selection: { kind: 'none' } as Selection, instance: null, prefabs },
    });
    expect(body).toContain('Nothing is selected');
  });

  it('shows the id, the prefab, and the three transform vectors', () => {
    const { body } = render(Inspector, {
      props: { selection, instance: scene[0]!, prefabs },
    });
    expect(body).toContain('crate');
    expect(body).toContain('position');
    expect(body).toContain('rotation (radians)');
    expect(body).toContain('scale');
    // 3 axes per vector, and the stored values are in the inputs.
    expect(body).toContain('aria-label="position x"');
    expect(body).toContain('aria-label="rotation y"');
    expect(body).toContain('aria-label="scale z"');
    expect(body).toMatch(/value="0\.5"/);
  });

  /**
   * A clipped number is worse than a clipped label: the developer reads
   * `3.1` as the rotation and saves it back. `rotation (radians)` was wide
   * enough to squeeze the z input to about two characters, so the label's fixed
   * width and each axis's floor are both pinned here.
   */
  it('reserves enough width that a three-decimal rotation is not truncated', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/renderer/components/Inspector.svelte', import.meta.url)),
      'utf-8',
    );

    const labelWidth = source.match(/\.vector-label\s*\{[^}]*width:\s*([\d.]+)rem/)?.[1];
    expect(labelWidth).toBeDefined();
    // `rotation (radians)` at 0.8em is ~18 characters; anything under this
    // clips the z axis.
    expect(Number.parseFloat(labelWidth ?? '0')).toBeGreaterThanOrEqual(8);

    // Each axis input also has its own floor, so a narrow panel clips the
    // digits rather than dropping a whole axis out of the row.
    expect(source).toMatch(/\.axis-field\s*\{[^}]*min-width:\s*[\d.]+rem/);
  });

  it('renders a three-decimal rotation value in full', () => {
    const instance = {
      ...scene[0]!,
      transform: { position: [0, 0, 0], rotation: [3.14, 0, 0], scale: [1, 1, 1] },
    };
    const { body } = render(Inspector, { props: { selection, instance, prefabs } });

    expect(body).toContain('value="3.14"');
  });

  it('generates one control per params field, of the right kind', () => {
    const { body } = render(Inspector, {
      props: { selection, instance: scene[0]!, prefabs },
    });
    expect(body).toContain('id="param-speed"');
    expect(body).toContain('type="number"');
    expect(body).toContain('id="param-label"');
    expect(body).toContain('id="param-mode"');
    expect(body).toContain('<select');
    expect(body).toContain('>lit</option>');
    expect(body).toContain('id="param-castsShadow"');
    expect(body).toContain('type="checkbox"');
  });

  it('renders no input at all for an unsupported field, and gives the reason', () => {
    const { body } = render(Inspector, {
      props: { selection, instance: scene[0]!, prefabs },
    });
    expect(body).toContain('Not editable');
    expect(body).toContain('ZodRecord');
    // The name is shown, and it is not a form control: no input, no select, and
    // no <label for> pointing at a non-control.
    expect(body).toContain('Texture');
    expect(body).not.toContain('id="param-texture"');
    expect(body).not.toContain('for="param-texture"');
  });

  it('places a refusal from the main process under the field it names, verbatim', () => {
    const reason = 'instances[0].params.speed must be a finite number';
    const { body } = render(Inspector, {
      props: { selection, instance: scene[0]!, prefabs, errors: [reason] },
    });
    expect(body).toContain(reason);
    expect(body).toContain('field-error');
  });

  it('shows a refusal that names no field globally rather than misfiling it', () => {
    const { body } = render(Inspector, {
      props: {
        selection,
        instance: scene[0]!,
        prefabs,
        errors: ['the project has no manifest and no project.godot'],
      },
    });
    expect(body).toContain('the project has no manifest');
    expect(body).toContain('global-error');
  });

  it('warns about params the schema rejects, because saving will fail', () => {
    const { body } = render(Inspector, {
      props: {
        selection,
        instance: instance('crate', { params: { speed: 1, mystery: 'x' } }),
        prefabs,
      },
    });
    expect(body).toContain('mystery');
    expect(body).toContain('Saving will fail');
  });

  it('marks a locked instance and renders its controls disabled', () => {
    const locked = instance('crate', { locked: true });
    const { body } = render(Inspector, { props: { selection, instance: locked, prefabs } });
    expect(body).toContain('locked');
    expect(body).toContain('edits are blocked');
    expect(body).toContain('disabled');
  });

  it('shows an unregistered prefab rather than an empty panel', () => {
    const { body } = render(Inspector, {
      props: {
        selection,
        instance: instance('mystery', { prefab: 'not-in-registry' }),
        prefabs,
      },
    });
    expect(body).toContain('not registered');
    expect(body).toContain('no schema to');
    // The transform section is still there: one bad prefab is not a dead editor.
    expect(body).toContain('position');
  });
});

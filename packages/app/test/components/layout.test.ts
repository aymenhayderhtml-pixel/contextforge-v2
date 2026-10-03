/**
 * layout.test.ts — tests for Layout specialist requirements (Step 3b):
 * 1. Resizable panes & wider default outliner
 * 2. Text truncation & tooltips (no horizontal scrollbars)
 * 3. Transform layout (compact x, y, z inputs on one row)
 * 4. Collapsible inspector sections (Transform, Params)
 * 5. Single-row merged header bar
 * 6. Save status indicator (dot/unsaved indicator on unsaved changes)
 * 7. Error display using AppError model on Outliner, Inspector, and Problems container
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { JsonSchema, PrefabFailure, PrefabSummary, Selection } from '../../src/ipc.js';
import type { SceneInstance } from '@contextforge/core';
import { createAppError } from '../../src/errors.js';
import Inspector from '../../src/renderer/components/Inspector.svelte';
import Outliner from '../../src/renderer/components/Outliner.svelte';
import SceneScreen from '../../src/renderer/screens/SceneScreen.svelte';
import { FakeClock, FakeInvoker, FakeListener, demoScene, snapshotOf, succeed } from '../shell/fakes.js';
import { CHANNELS } from '../../src/ipc.js';
import { createEditorStore, type EditorStore } from '../../src/renderer/store.js';

const schema: JsonSchema = {
  type: 'object',
  properties: {
    speed: { kind: 'number', title: 'Speed', min: 0, max: 10, default: 1 },
    label: { kind: 'string', title: 'Label' },
  },
  required: ['speed'],
  additionalProperties: false,
};

const prefabs: PrefabSummary[] = [
  { name: 'crate', description: 'a wooden box with a very long description that might overflow', paramsJsonSchema: schema },
  { name: 'coin', description: 'a spinning gold coin', paramsJsonSchema: schema },
];

function makeInstance(id: string, extra: Partial<SceneInstance> = {}): SceneInstance {
  return {
    id,
    prefab: 'crate',
    transform: { position: [1, 2, 3], rotation: [0.5, 0, 0], scale: [1, 1, 1] },
    params: { speed: 3 },
    ...extra,
  };
}

const scene: SceneInstance[] = [
  makeInstance('crate-long-name-that-could-overflow-the-sidebar-boundary', { name: 'Crate Long Name Example' }),
  makeInstance('coin-a', { prefab: 'coin', parent: 'crate-long-name-that-could-overflow-the-sidebar-boundary' }),
];

const selection: Selection = { kind: 'instance', id: 'crate-long-name-that-could-overflow-the-sidebar-boundary' };

async function createTestStore(withSnapshot = true): Promise<EditorStore> {
  const invoker = new FakeInvoker({
    [CHANNELS.openProject]: (req: any) =>
      Promise.resolve(
        succeed(
          snapshotOf(demoScene(), {
            project: { root: req.root, name: 'demo-game', scenePath: 'scene.json', engine: 'three' },
          }),
        ),
      ),
    [CHANNELS.closeProject]: () => Promise.resolve(succeed(undefined)),
    [CHANNELS.save]: () => Promise.resolve(succeed(snapshotOf(demoScene()))),
  });
  const listener = new FakeListener();
  const clock = new FakeClock();
  const store = createEditorStore({
    invoker,
    listener: listener.on,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  if (withSnapshot) {
    await store.openProject('/workspace/demo-game');
  }

  return store;
}

describe('Layout: Text Truncation & Outliner', () => {
  it('truncates long instance names and sets title tooltips on labels and prefabs', () => {
    const { body } = render(Outliner, {
      props: {
        instances: scene,
        prefabs,
        failed: [] as PrefabFailure[],
        selection,
      },
    });

    expect(body).toMatch(/class="[^"]*\blabel\b[^"]*"/);
    expect(body).toContain('title="Crate Long Name Example"');
    expect(body).toMatch(/class="[^"]*\bprefab\b[^"]*"/);
    expect(body).toContain('title="crate"');
  });

  it('displays AppError indicators on outliner items with error tooltip', () => {
    const error = createAppError({
      scope: 'instance',
      instanceId: 'crate-long-name-that-could-overflow-the-sidebar-boundary',
      short: 'Mesh failed to load',
    });

    const { body } = render(Outliner, {
      props: {
        instances: scene,
        prefabs,
        failed: [] as PrefabFailure[],
        selection,
        errors: [error],
      },
    });

    expect(body).toContain('error-badge');
    expect(body).toContain('title="Mesh failed to load"');
    expect(body).toContain('has-error');
  });
});

describe('Layout: Inspector', () => {
  it('renders transform axes (x, y, z) on compact single rows', () => {
    const { body } = render(Inspector, {
      props: {
        selection,
        instance: scene[0]!,
        prefabs,
      },
    });

    expect(body).toMatch(/class="[^"]*\bvector-row\b[^"]*"/);
    expect(body).toMatch(/class="[^"]*\bvector-axes\b[^"]*"/);
    expect(body).toContain('aria-label="position x"');
    expect(body).toContain('aria-label="position y"');
    expect(body).toContain('aria-label="position z"');
    expect(body).toContain('aria-label="rotation x"');
    expect(body).toContain('aria-label="scale z"');
  });

  it('renders collapsible sections for transform and params, open by default', () => {
    const { body } = render(Inspector, {
      props: {
        selection,
        instance: scene[0]!,
        prefabs,
      },
    });

    expect(body).toContain('collapse-btn');
    expect(body).toContain('aria-expanded="true"');
    expect(body).toContain('transform');
    expect(body).toContain('params');
    // Params are visible without scrolling because transform is compact
    expect(body).toContain('id="param-speed"');
  });

  it('sets title tooltip on inspector heading and identity for text truncation', () => {
    const { body } = render(Inspector, {
      props: {
        selection,
        instance: scene[0]!,
        prefabs,
      },
    });

    expect(body).toContain('title="Crate Long Name Example"');
    expect(body).toContain('title="crate-long-name-that-could-overflow-the-sidebar-boundary"');
  });

  it('renders field errors from AppError directly under the matching input', () => {
    const fieldError = createAppError({
      scope: 'field',
      instanceId: scene[0]!.id,
      fieldPath: 'params.speed',
      short: 'Speed must be at least 0',
    });

    const { body } = render(Inspector, {
      props: {
        selection,
        instance: scene[0]!,
        prefabs,
        errors: [fieldError],
      },
    });

    expect(body).toContain('field-error');
    expect(body).toContain('Speed must be at least 0');
  });

  it('renders instance errors from AppError in inspector', () => {
    const instErr = createAppError({
      scope: 'instance',
      instanceId: scene[0]!.id,
      short: 'Instance failed to initialize prefab',
    });

    const { body } = render(Inspector, {
      props: {
        selection,
        instance: scene[0]!,
        prefabs,
        errors: [instErr],
      },
    });

    expect(body).toContain('global-error');
    expect(body).toContain('Instance failed to initialize prefab');
  });
});

describe('Layout: SceneScreen', () => {
  it('renders resizable panes with wider default outliner (300px) and resizers', async () => {
    const store = await createTestStore(true);
    const { body } = render(SceneScreen, { props: { store } });

    expect(body).toContain('--outliner-width: 300px');
    expect(body).toContain('--inspector-width: 380px');
    expect(body).toMatch(/class="[^"]*\bresizer left\b[^"]*"/);
    expect(body).toMatch(/class="[^"]*\bresizer right\b[^"]*"/);
    expect(body).toContain('role="separator"');
  });

  /**
   * The inspector pane has to fit one transform row end to end.
   *
   * A row is a fixed 8.5rem label plus three axis inputs that each need ~4.5rem
   * to show a signed decimal — roughly 355px before pane padding. `.pane.inspector`
   * is `overflow-x: hidden`, so at the old 320px default the z input was pushed
   * past the right edge and clipped away entirely: a rotation whose third axis
   * could not be read or edited. The rendered width is asserted rather than the
   * arithmetic, because it is the rendered width that was wrong.
   */
  it('gives the inspector pane enough width for all three axis inputs', async () => {
    const store = await createTestStore(true);
    const { body } = render(SceneScreen, { props: { store } });

    const width = Number.parseInt(/--inspector-width:\s*(\d+)px/.exec(body)?.[1] ?? '0', 10);
    expect(width).toBeGreaterThanOrEqual(380);

    const source = readFileSync(
      fileURLToPath(new URL('../../src/renderer/components/Inspector.svelte', import.meta.url)),
      'utf-8',
    );
    // 8.5rem label + 3 x 4.5rem inputs + gaps, at the 14px base font.
    const labelRem = Number.parseFloat(/\.vector-label\s*\{[^}]*width:\s*([\d.]+)rem/.exec(source)?.[1] ?? '0');
    const axisRem = Number.parseFloat(/\.axis-field\s*\{[^}]*min-width:\s*([\d.]+)rem/.exec(source)?.[1] ?? '0');
    const needed = Math.ceil((labelRem + 3 * axisRem + 0.9) * 14) + 20;
    expect(width).toBeGreaterThanOrEqual(needed);
  });

  it('renders merged single-row header with scene name, project, and actions', async () => {
    const store = await createTestStore(true);
    const { body } = render(SceneScreen, { props: { store } });

    expect(body).toMatch(/class="[^"]*\bbar\b[^"]*"/);
    expect(body).toContain('role="toolbar"');
    expect(body).toContain('demo-game');
    expect(body).toContain('Save scene');
    expect(body).toContain('Undo (Ctrl+Z)');
  });

  it('renders problems container ready for ERRORS subagent', async () => {
    const store = await createTestStore(true);
    const { body } = render(SceneScreen, { props: { store } });

    expect(body).toContain('problems-container');
    expect(body).toContain('Problems');
  });
});

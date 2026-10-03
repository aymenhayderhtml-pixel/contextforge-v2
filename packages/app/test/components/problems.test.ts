/**
 * packages/app/test/components/problems.test.ts
 *
 * Tests for ProblemsPanel.svelte and Inspector error scoping (ContextForge v2 Step 3b).
 */

import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { createAppError } from '../../src/errors.js';
import type { JsonSchema, PrefabFailure, PrefabSummary, SceneSnapshot, Selection } from '../../src/ipc.js';
import type { SceneInstance } from '@contextforge/core';
import ProblemsPanel, {
  collectSkippedInstanceProblems as collectSkipped,
} from '../../src/renderer/components/ProblemsPanel.svelte';
import Inspector from '../../src/renderer/components/Inspector.svelte';

/**
 * How many rows the panel rendered.
 *
 * The panel used to own a `Problems (N)` header, which sat underneath the
 * Scene screen's collapsible `Problems (N)` bar and showed a different N —
 * `PROBLEMS (2)` over `PROBLEMS (6)`. There is now one header, on the bar, and
 * this component renders only rows (D44), so the count these tests care about is
 * the number of `problem-item` elements.
 *
 * Asserting row count rather than header text is the stronger check anyway: the
 * header was a *label* of the count, while the rows are the count itself.
 */
function rowCount(body: string): number {
  return body.match(/class="problem-item/g)?.length ?? 0;
}

describe('ProblemsPanel component', () => {
  it('renders empty state when there are no problems', () => {
    const { body } = render(ProblemsPanel, { props: { problems: [] } });
    expect(rowCount(body)).toBe(0);
    expect(body).toContain('No problems detected');
  });

  it('renders count badge and short summary for project problems', () => {
    const problems = [
      createAppError({
        scope: 'project',
        short: 'hazardCrate failed to load: Corrupted GLTF buffer',
        details: 'File: models/hazardCrate.glb\nStack trace: ...',
      }),
      createAppError({
        scope: 'project',
        short: 'Scene contains duplicate id "crate"',
      }),
    ];

    const { body } = render(ProblemsPanel, { props: { problems } });
    expect(rowCount(body)).toBe(2);
    expect(body).toContain('hazardCrate failed to load: Corrupted GLTF buffer');
    expect(body).toContain('Scene contains duplicate id &quot;crate&quot;');
    // Shows Details toggle button for problem with details
    expect(body).toContain('Details');
    expect(body).toContain('details-toggle');
  });

  it('automatically gathers problems from snapshot and failed prefabs', () => {
    const failed: PrefabFailure[] = [
      { name: 'hazardCrate', file: 'models/hazardCrate.glb', reason: 'Corrupted GLTF buffer' },
    ];
    const snapshot: Partial<SceneSnapshot> = {
      problems: ['Scene syntax error at line 12'],
      prefabs: {
        prefabs: [],
        failed,
      },
      scene: {
        name: 'test',
        instances: [
          { id: 'unreg_1', prefab: 'ghost_prefab', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        ],
      },
    };

    const { body } = render(ProblemsPanel, {
      props: { snapshot: snapshot as SceneSnapshot, failed },
    });

    expect(rowCount(body)).toBe(3);
    expect(body).toContain('hazardCrate failed to load: Corrupted GLTF buffer');
    expect(body).toContain('Scene syntax error at line 12');
    expect(body).toContain('ghost_prefab');
  });
});

describe('ProblemsPanel — one header, one count', () => {
  /**
   * A minimal *registered* `trackSegment`. Registering it matters: an instance
   * referencing an unregistered prefab produces its own "Missing prefab" row, so
   * an empty registry would add a third row to every count below and hide the
   * duplication these tests are about.
   */
  const registeredTrackSegment: PrefabSummary = {
    name: 'trackSegment',
    description: 'Asphalt race track segment.',
    paramsJsonSchema: {
      type: 'object',
      properties: {
        width: { kind: 'number', title: 'Width', min: 0 },
        length: { kind: 'number', title: 'Length', min: 0 },
        color: { kind: 'string', title: 'Color' },
      },
      required: [],
      additionalProperties: false,
    },
  };
  /**
   * The `PROBLEMS (2)` over `PROBLEMS (6)` defect, reduced to its cause.
   *
   * `collectProjectProblems` derives errors from `snapshot.problems`. When the
   * Scene screen also passed that same array as the `problems` prop — which it
   * did — step 3 and step 4 derived each string twice. Deduplication could not
   * save it: `createAppError` mints `err:<scope>:…:<random>` when given no id,
   * so the two copies of one string had different ids and both survived.
   *
   * Four rows rendered where two facts existed, and the collapsed bar counted
   * the raw strings (2) while the expanded panel counted the doubled rows (6).
   *
   * These tests pin the fix at both layers: the derivation is not repeated, and
   * the panel renders one header's worth of rows.
   */

  function snapshotWithTwoProblems(): SceneSnapshot {
    return {
      problems: [
        'scene.json: instances[0].params.width: value out of range',
        'Prefab registry could not be loaded',
      ],
      prefabs: { prefabs: [registeredTrackSegment], failed: [] },
      scene: {
        name: 'GrandPrix_Circuit',
        instances: [
          {
            id: 'track',
            prefab: 'trackSegment',
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            // Valid params: a bad value would add a genuine third row and the
            // point of these tests is the duplicate, not the param validator.
            params: { width: 16, length: 50, color: '#1f2228' },
          },
        ],
      },
    } as unknown as SceneSnapshot;
  }

  it('renders no header of its own — the Scene screen bar owns the count', () => {
    const snapshot = snapshotWithTwoProblems();
    const { body } = render(ProblemsPanel, { props: { snapshot } });

    // The defect was two headers with two numbers. The panel's is gone.
    expect(body).not.toMatch(/Problems \(\d+\)/);
    expect(body).not.toContain('count-badge');
    // The rows are still here; only the rival header went.
    expect(rowCount(body)).toBeGreaterThan(0);
  });

  it('derives each snapshot problem once, not twice', () => {
    // Exactly the Scene screen's call shape: the same array handed over as both
    // `snapshot` and `problems`. Each string must yield one row.
    const snapshot = snapshotWithTwoProblems();

    const { body } = render(ProblemsPanel, {
      props: { snapshot, problems: snapshot.problems },
    });

    // Two faults in, two rows out. Before the fix this was four.
    expect(rowCount(body)).toBe(2);
  });

  it('still derives the snapshot problems when no problems prop is given', () => {
    // The negative direction. Suppressing the duplicate derivation must not
    // suppress the original one — a panel that silently drops real problems is
    // a worse defect than one that repeats them.
    const snapshot = snapshotWithTwoProblems();

    const { body } = render(ProblemsPanel, { props: { snapshot } });

    expect(rowCount(body)).toBe(2);
    expect(body).toContain('Prefab registry could not be loaded');
  });

  it('a string repeated in both props still yields one row', () => {
    // The same fault arriving twice by two routes is one fault. This is the
    // exact shape the Scene screen produced.
    const snapshot = snapshotWithTwoProblems();

    const { body } = render(ProblemsPanel, {
      props: {
        snapshot,
        problems: [
          ...snapshot.problems,
          // The screen's own copy of the same strings.
          ...snapshot.problems,
        ],
      },
    });

    expect(rowCount(body)).toBe(2);
  });
});

describe('ProblemsPanel — a skipped instance is listed, not silently absent', () => {
  /**
   * `trackSegment`'s real `paramsSchema` as the app sees it: `zodToJsonSchema`
   * turns `z.number().positive()` into `min: 0`. The shipped
   * `kart-dash-3d-v2/scene.json` carries `instances[0].width: -10`, so this is
   * the exact case the game skips and warns about — asserted here on the other
   * side of the same boundary.
   */
  const trackSegment: PrefabSummary = {
    name: 'trackSegment',
    description: 'Asphalt race track segment with red/white curbs.',
    paramsJsonSchema: {
      type: 'object',
      properties: {
        width: { kind: 'number', title: 'Width', min: 0, default: 16 },
        length: { kind: 'number', title: 'Length', min: 0, default: 40 },
        color: { kind: 'string', title: 'Color', default: '#24262b' },
      },
      required: [],
      additionalProperties: false,
    },
  };

  /** The real scene's first instance, bad width and all. */
  function sceneWithTrackParams(width: number): SceneInstance {
    return {
      id: 'track',
      prefab: 'trackSegment',
      name: 'Starting Straight',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      params: { width, length: 50, color: '#1f2228' },
    };
  }

  function snapshotOf(instances: SceneInstance[], problems: string[] = []): SceneSnapshot {
    return {
      problems,
      prefabs: { prefabs: [trackSegment], failed: [] },
      scene: { name: 'GrandPrix_Circuit', instances },
    } as unknown as SceneSnapshot;
  }

  it('lists the bad-param instance with its id and what is wrong', () => {
    const snapshot = snapshotOf([sceneWithTrackParams(-10)]);

    const { body } = render(ProblemsPanel, { props: { snapshot } });

    // It is listed, not hidden and not collapsed away: the panel is where the
    // developer looks after noticing the track is missing from the viewport.
    expect(rowCount(body)).toBe(1);
    expect(body).not.toContain('No problems detected');

    // **Which instance** — the id, as a selectable link, so it can be jumped to.
    expect(body).toContain('Go to instance track');
    // **What is wrong** — the reason, not a bare "invalid".
    expect(body).toContain('Width must be at least 0');

    // Scoped to the instance, not left as an anonymous project-level row.
    expect(body).toContain('data-scope="field"');
    // A Details toggle exists, so the offending value is one click away — the
    // short line says what is wrong but not what the value currently is.
    expect(body).toContain('details-toggle');
  });

  it('the row it renders carries the offending value in its details', () => {
    // The panel's own pass is a pure computation over the snapshot, so it is
    // asserted here directly rather than through the DOM: the collapsed details
    // body is not in the server-rendered HTML, and asserting against markup
    // that only exists after a click would test the click, not the row.
    const snapshot = snapshotOf([sceneWithTrackParams(-10)]);

    const { body } = render(ProblemsPanel, { props: { snapshot } });

    // The row exists in the DOM…
    expect(body).toContain('err:param:track:width');
    // …and the error it was built from names the value the developer must fix.
    const [row] = collectSkipped(snapshot, [trackSegment]);
    expect(row).toBeDefined();
    expect(row!.short).toBe('Width must be at least 0');
    expect(row!.instanceId).toBe('track');
    expect(row!.details).toContain('Current value: -10');
  });

  it('lists nothing for the same scene once the value is valid', () => {
    // The negative, in the app's direction: the panel must be as quiet about a
    // good scene as the game's warning is. A panel that flags every instance is
    // as useless as one that flags none.
    const { body } = render(ProblemsPanel, {
      props: { snapshot: snapshotOf([sceneWithTrackParams(20)]) },
    });

    expect(rowCount(body)).toBe(0);
    expect(body).toContain('No problems detected');
    expect(body).not.toContain('must be at least 0');
  });

  it('flags only the offending instance, not its valid neighbours', () => {
    const goodKart: SceneInstance = {
      id: 'player_kart',
      prefab: 'kart',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      params: { character: 'dash' },
    };
    // `kart` IS registered here, with a schema its params satisfy, so the
    // neighbour contributes nothing and every row on screen is the track's.
    const kart: PrefabSummary = {
      name: 'kart',
      description: 'A kart.',
      paramsJsonSchema: {
        type: 'object',
        properties: { character: { kind: 'string', title: 'Character', options: ['dash'] } },
        required: [],
        additionalProperties: false,
      },
    };
    const snapshot = snapshotOf([sceneWithTrackParams(-10), goodKart]);
    snapshot.prefabs.prefabs = [trackSegment, kart];

    const { body } = render(ProblemsPanel, { props: { snapshot } });

    expect(rowCount(body)).toBe(1);
    expect(body).toContain('Width must be at least 0');
    expect(body).toContain('Go to instance track');
    // The valid neighbour produced no row, and the single row belongs to the
    // offending instance only.
    expect(body).not.toContain('Go to instance player_kart');
  });

  it('reports the value fault once even when snapshot.problems describes the same instance', () => {
    // `collectProjectProblems` turns a `snapshot.problems` string into a
    // *field* error, and so does this panel's own pass over the schemas. If the
    // two produced different ids for the same fault the panel would show two
    // rows for one mistake — and a count that cannot be trusted is worse than
    // no count, because the developer stops reading it (SPEC R9).
    //
    // **This test used to expect `Go to instance 0`, and it was the test that
    // was wrong.** The string names `instances[0]`, and the index was being used
    // as the id verbatim. That produced a link that selected nothing, and the
    // label shifted whenever an instance was added above. Step 4 made
    // `toAppError` resolve `instances[n]` against the scene, so `instances[0]`
    // is now `track` — the stable identifier, and one a "Go to" link can
    // actually navigate to. Both rows naming `track` is now the correct outcome,
    // and the two rows still stay two rows because one is the schema pass and
    // the other is the snapshot string, which only clears on a re-read.
    const snapshot = snapshotOf([sceneWithTrackParams(-10)], [
      'scene.json: instances[0].params.width: value out of range',
    ]);

    const { body } = render(ProblemsPanel, { props: { snapshot } });

    // The panel's own row, with the id.
    expect(body).toContain('Width must be at least 0');
    expect(body).toContain('Go to instance track');
    // The main-process string is passed through as its own row rather than
    // folded into the panel's — so a developer who fixes the value in the
    // inspector still sees the string until the scene is re-read.
    expect(rowCount(body)).toBe(2);
    expect(body).toContain('value out of range');
    // And it is the *id* that came out the other end, not the index. This is
    // the assertion that would have caught the bug: the panel's own row already
    // said `track`, so if the string's row still said `0` the two rows would
    // disagree and the second link would go nowhere.
    expect(body).toContain('Go to instance track');
    expect(
      body,
      'the snapshot string was still labelled by index, which selects nothing',
    ).not.toContain('Go to instance 0');
  });
});

describe('Inspector error scoping & param validation', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      width: { kind: 'number', title: 'Width', min: 0, max: 100 },
      height: { kind: 'number', title: 'Height', min: 0 },
    },
    required: [],
    additionalProperties: false,
  };

  const prefabs: PrefabSummary[] = [
    { name: 'crate', description: 'box', paramsJsonSchema: schema },
  ];

  const instance1: SceneInstance = {
    id: 'crate_1',
    prefab: 'crate',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    params: { width: -10 },
  };

  const selection: Selection = { kind: 'instance', id: 'crate_1' };

  it('shows error directly under Width field when Width = -10', () => {
    const { body } = render(Inspector, {
      props: {
        selection,
        instance: instance1,
        prefabs,
      },
    });

    expect(body).toContain('id="param-width"');
    expect(body).toContain('must be at least 0');
    // Ensure error appears as a field-error
    expect(body).toContain('field-error');
  });

  it('scopes errors to the selected instanceId and excludes other instances', () => {
    const errThisInstance = createAppError({
      scope: 'instance',
      instanceId: 'crate_1',
      short: 'crate_1 failed to initialize collider',
      details: 'File: collider.ts:50',
    });
    const errOtherInstance = createAppError({
      scope: 'instance',
      instanceId: 'crate_2',
      short: 'crate_2 failed to load mesh',
    });
    const projectError = createAppError({
      scope: 'project',
      short: 'project-wide problem: unreferenced assets',
    });

    const { body } = render(Inspector, {
      props: {
        selection,
        instance: instance1,
        prefabs,
        errors: [errThisInstance, errOtherInstance, projectError],
      },
    });

    // Should contain error belonging to crate_1
    expect(body).toContain('crate_1 failed to initialize collider');
    expect(body).toContain('Details');

    // Should NOT contain error belonging to crate_2
    expect(body).not.toContain('crate_2 failed to load mesh');

    // Should NOT contain project-level error in inspector
    expect(body).not.toContain('project-wide problem: unreferenced assets');
  });
});

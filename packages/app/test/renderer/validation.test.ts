import { describe, expect, it } from 'vitest';

import { buildFormFields } from '../../src/renderer/components/fields.js';
import {
  collectSkippedInstanceProblems,
  validateField,
  validateInstanceParams,
  validateParamValue,
} from '../../src/renderer/validation.js';
import type { SceneSnapshot } from '../../src/ipc.js';

/**
 * The one validator, used by both the Problems panel and SceneScreen.
 *
 * These tests exist because `exclusiveMin` was the fourth attempt at a
 * `width: 0` bug (D26): the app accepted a value the game's own Zod schema
 * refused, so the game skipped the instance and the Problems panel reported
 * nothing at all. Every case below is one place that gap can reopen — the
 * loader's Zod conversion, the shared validator, and the two consumers that
 * must agree with each other.
 */

/**
 * A number field exactly as `zodToJsonSchema` emits it for `.positive()`.
 *
 * `min: 0` with `exclusiveMin: true`: the bound value is 0 and 0 is not
 * allowed. This is the pair that must never be collapsed back into one.
 */
const POSITIVE = { kind: 'number', title: 'Width', min: 0, exclusiveMin: true } as const;

/** The same bound, inclusive — `.min(0)`. */
const NON_NEGATIVE = { kind: 'number', title: 'Width', min: 0 } as const;

describe('exclusiveMin — the width: 0 rule (validateParamValue)', () => {
  it('rejects 0 when the bound is exclusive, in the game\'s own wording', () => {
    // The message matters as much as the rejection. "at least 0" for a value the
    // game refuses is a developer typing 0 and watching the instance vanish.
    expect(validateParamValue(POSITIVE, 0)).toBe('Width must be greater than 0');
    expect(validateParamValue(POSITIVE, '0')).toBe('Width must be greater than 0');
  });

  it('accepts 0 when the bound is inclusive — the two must not be confused', () => {
    // If `.min(0)` ever started reporting "greater than 0", a field that really
    // does allow zero would reject it. The distinguishing assertion.
    expect(validateParamValue(NON_NEGATIVE, 0)).toBeNull();
    expect(validateParamValue(NON_NEGATIVE, '0')).toBeNull();
  });

  it('reports a plain bound as "at least", never as "greater than"', () => {
    expect(validateParamValue(NON_NEGATIVE, -1)).toBe('Width must be at least 0');
  });

  it('still rejects a value below an exclusive bound, with the exclusive wording', () => {
    expect(validateParamValue(POSITIVE, -10)).toBe('Width must be greater than 0');
  });

  it('accepts a value just above an exclusive bound', () => {
    expect(validateParamValue(POSITIVE, 1)).toBeNull();
  });
});

describe('exclusiveMin in the live input field (validateField)', () => {
  // A different function with a different message style — no field title, since
  // the row it renders in already carries one. The rule has to survive that
  // difference too, or the inspector would accept what the panel rejects.
  const positiveForm = { kind: 'number', title: 'Width', min: 0, exclusiveMin: true } as const;
  const inclusiveForm = { kind: 'number', title: 'Width', min: 0 } as const;

  it('rejects 0 for an exclusive bound and accepts it for an inclusive one', () => {
    expect(validateField(positiveForm, '0')).toBe('must be greater than 0');
    expect(validateField(inclusiveForm, '0')).toBeNull();
  });

  it('survives the trip through toFormField, which is what the inspector builds from', () => {
    // This is the step that actually had the bug. `FormField` had no
    // `exclusiveMin` slot, so the fact was dropped while the schema was being
    // turned into form rows — and the rule that reads it downstream could not
    // have known. Tested through the builder rather than by asserting the type,
    // because the type alone would not catch the value being dropped on the way.
    const schema = {
      type: 'object',
      properties: { width: { kind: 'number', title: 'Width', min: 0, exclusiveMin: true } },
      required: ['width'],
    } as never;

    const [row] = buildFormFields(schema, { width: 40 });

    expect(row?.exclusiveMin).toBe(true);
    // And the rule is actually enforced on what the inspector built, with no
    // hand-made object in between.
    expect(validateField(row!, '0')).toBe('must be greater than 0');
    expect(validateField(row!, '40')).toBeNull();
  });

  it('leaves an inclusive bound flagged as inclusive', () => {
    const schema = {
      type: 'object',
      properties: { width: { kind: 'number', title: 'Width', min: 0 } },
      required: ['width'],
    } as never;

    const [row] = buildFormFields(schema, { width: 0 });
    expect(row?.exclusiveMin).toBe(false);
    expect(validateField(row!, '0')).toBeNull();
  });
});

describe('validateInstanceParams', () => {
  const schema = {
    type: 'object',
    properties: { width: POSITIVE },
    required: ['width'],
  } as never;

  it('does not flag a valid instance at all', () => {
    // The negative direction. A validator that always fires is as broken as one
    // that never does: the developer learns to ignore the Problems count.
    expect(validateInstanceParams({ width: 1 }, schema, 'track')).toEqual([]);
  });

  it('flags width 0, naming the instance and the field', () => {
    const errors = validateInstanceParams({ width: 0 }, schema, 'track');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.short).toBe('Width must be greater than 0');
    // The id, never the index: an index shifts whenever a row is inserted above.
    expect(errors[0]?.instanceId).toBe('track');
    expect(errors[0]?.fieldPath).toBe('width');
  });
});

describe('collectSkippedInstanceProblems — one list, both consumers', () => {
  /** A scene whose `track` instance has the exclusive bound set to 0. */
  const snapshotWith = (width: number): SceneSnapshot =>
    ({
      file: 'scene.json',
      schemaVersion: 1,
      scene: {
        version: 1,
        instances: [
          { id: 'track', prefab: 'track', parent: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], params: { width } },
        ],
      },
      prefabs: {
        prefabs: [
          { name: 'track', paramsJsonSchema: { type: 'object', properties: { width: POSITIVE }, required: ['width'] } },
        ],
      },
      problems: [],
    }) as never;

  it('reports the instance by its id, never by its index', () => {
    // A "Go to instance 0" link that selects the wrong kart is worse than no
    // link, and the index renumbers itself the moment a row is inserted above.
    const problems = collectSkippedInstanceProblems(snapshotWith(0));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.instanceId).toBe('track');
  });

  it('reports nothing for a valid instance', () => {
    expect(collectSkippedInstanceProblems(snapshotWith(40))).toEqual([]);
  });

  it('carries the reason, so the panel never shows a bare "skipped"', () => {
    const problems = collectSkippedInstanceProblems(snapshotWith(0));
    expect(problems[0]?.short).toContain('greater than 0');
  });

  it('does not re-report an id the caller already has', () => {
    // The panel merges its own schema pass with the snapshot's strings. Without
    // this, one bad width shows as two rows and the count stops being readable.
    const problems = collectSkippedInstanceProblems(snapshotWith(0), undefined, []);
    const second = collectSkippedInstanceProblems(snapshotWith(0), undefined, problems.map((p) => p.id));
    expect(second).toEqual([]);
  });

  it('returns nothing for a null snapshot rather than throwing', () => {
    expect(collectSkippedInstanceProblems(null)).toEqual([]);
  });
});
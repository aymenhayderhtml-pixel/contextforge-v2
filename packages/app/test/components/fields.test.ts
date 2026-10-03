/**
 * fields.test.ts — deriving the inspector's params form, tested headlessly.
 *
 * The assertions that matter are the refusals: an unsupported field must
 * produce a row with no value and the registry's own reason, and a kind the
 * renderer cannot honour must not be coerced into a text input.
 */

import { describe, expect, it } from 'vitest';
import type { FieldSchema, JsonSchema } from '../../src/ipc.js';
import type { JsonValue, SceneInstance } from '@contextforge/core';
import {
  EMPTY_JSON_SCHEMA,
  VECTOR_AXES,
  buildFormFields,
  editability,
  fieldTitle,
  fieldValue,
  findUnknownParams,
  formatFieldInput,
  parseFieldInput,
  readVector,
  toFormField,
  transformPatch,
  validateField,
  vectorPatch,
} from '../../src/renderer/components/fields.js';

const schema: JsonSchema = {
  type: 'object',
  properties: {
    speed: { kind: 'number', title: 'Speed', min: 0, max: 10, default: 1 },
    label: { kind: 'string', title: 'Label', default: 'crate' },
    mode: { kind: 'string', title: 'Mode', options: ['lit', 'dark', 'off'] },
    castsShadow: { kind: 'boolean', title: 'Casts shadow', default: false },
    texture: {
      kind: 'unsupported',
      title: 'Texture',
      reason: 'the Zod type is a ZodRecord, which has no single control',
    },
  },
  required: ['speed'],
  additionalProperties: false,
};

const params: Record<string, JsonValue> = { speed: 3, mode: 'dark' };

function field(name: string): ReturnType<typeof toFormField> {
  const found = schema.properties[name];
  if (found === undefined) throw new Error(`no field ${name}`);
  return toFormField(name, found, schema, params);
}

describe('buildFormFields', () => {
  const fields = buildFormFields(schema, params);
  const byName = new Map(fields.map((entry) => [entry.name, entry]));

  it('emits one row per property, in schema order', () => {
    expect(fields.map((entry) => entry.name)).toEqual([
      'speed',
      'label',
      'mode',
      'castsShadow',
      'texture',
    ]);
  });

  it('maps a number field, carrying its bounds and default', () => {
    const speed = byName.get('speed');
    expect(speed?.kind).toBe('number');
    expect(speed?.min).toBe(0);
    expect(speed?.max).toBe(10);
    expect(speed?.required).toBe(true);
    expect(speed?.hasDefault).toBe(true);
    expect(speed?.defaultValue).toBe(1);
    expect(speed?.value).toBe(3);
  });

  it('turns a string field with options into a select', () => {
    const mode = byName.get('mode');
    expect(mode?.kind).toBe('select');
    expect(mode?.options).toEqual(['lit', 'dark', 'off']);
    expect(mode?.value).toBe('dark');
  });

  it('keeps a plain string as a string', () => {
    expect(byName.get('label')?.kind).toBe('string');
  });

  it('maps a boolean field', () => {
    const shadow = byName.get('castsShadow');
    expect(shadow?.kind).toBe('boolean');
    // Not on the instance, so the prefab default shows — `params: {}` means
    // "use all defaults", not "use zeros".
    expect(shadow?.value).toBe(false);
  });

  it('produces a non-editable row for an unsupported kind, with the reason and no value', () => {
    const texture = byName.get('texture');
    expect(texture?.kind).toBe('unsupported');
    expect(texture?.reason).toContain('ZodRecord');
    expect(texture?.value).toBeNull();
    expect(texture?.min).toBeNull();
    expect(texture?.options).toEqual([]);
    expect(texture?.hasDefault).toBe(false);
  });

  it('returns no rows for a null schema rather than inventing one', () => {
    expect(buildFormFields(null, params)).toEqual([]);
    expect(buildFormFields(EMPTY_JSON_SCHEMA, params)).toEqual([]);
  });
});

describe('fieldTitle and fieldValue', () => {
  it('falls back to the field name when the title is blank', () => {
    expect(fieldTitle('speed', { kind: 'number', title: '  ' })).toBe('speed');
    expect(fieldTitle('speed', { kind: 'number', title: 'Speed' })).toBe('Speed');
  });

  it('prefers the instance’s own value over the default', () => {
    expect(fieldValue('speed', { kind: 'number', title: 's', default: 1 }, { speed: 9 })).toBe(9);
    expect(fieldValue('speed', { kind: 'number', title: 's', default: 1 }, {})).toBe(1);
    expect(fieldValue('speed', { kind: 'number', title: 's' }, {})).toBeNull();
  });

  it('never reports a value for an unsupported field', () => {
    const unsupported: FieldSchema = { kind: 'unsupported', title: 't', reason: 'no' };
    expect(fieldValue('x', unsupported, { x: 'anything' })).toBeNull();
  });
});

describe('findUnknownParams', () => {
  it('lists params the schema does not declare when unknown keys are rejected', () => {
    expect(findUnknownParams(schema, { speed: 1, mystery: 'x', another: 2 })).toEqual([
      'another',
      'mystery',
    ]);
  });

  it('lists nothing when the schema allows unknown keys', () => {
    expect(findUnknownParams({ ...schema, additionalProperties: true }, { mystery: 'x' })).toEqual(
      [],
    );
  });

  it('lists nothing without a schema', () => {
    expect(findUnknownParams(null, { mystery: 'x' })).toEqual([]);
  });
});

describe('parseFieldInput', () => {
  it('parses a number, refusing blanks and non-numbers', () => {
    expect(parseFieldInput('number', ' 2.5 ')).toBe(2.5);
    expect(parseFieldInput('number', '')).toBeNull();
    expect(parseFieldInput('number', 'two')).toBeNull();
    expect(parseFieldInput('number', 'NaN')).toBeNull();
    expect(parseFieldInput('number', 'Infinity')).toBeNull();
  });

  it('passes strings and selects through unchanged', () => {
    expect(parseFieldInput('string', ' crate ')).toBe(' crate ');
    expect(parseFieldInput('select', 'lit')).toBe('lit');
  });

  it('reads a checkbox as a boolean', () => {
    expect(parseFieldInput('boolean', 'true')).toBe(true);
    expect(parseFieldInput('boolean', 'false')).toBe(false);
  });
});

describe('formatFieldInput', () => {
  it('round-trips scalars', () => {
    expect(formatFieldInput(3)).toBe('3');
    expect(formatFieldInput(true)).toBe('true');
    expect(formatFieldInput('lit')).toBe('lit');
  });

  it('renders an absent value as empty rather than as a zero', () => {
    expect(formatFieldInput(null)).toBe('');
  });

  it('shows a compound value as JSON so the developer sees what is stored', () => {
    expect(formatFieldInput([1, 2, 3])).toBe('[1,2,3]');
    expect(formatFieldInput({ a: 1 })).toBe('{"a":1}');
  });
});

describe('validateField', () => {
  it('accepts a value inside the declared bounds', () => {
    expect(validateField(field('speed'), '5')).toBeNull();
  });

  it('rejects a value outside the bounds, naming the bound', () => {
    expect(validateField(field('speed'), '11')).toBe('must be at most 10');
    expect(validateField(field('speed'), '-1')).toBe('must be at least 0');
  });

  it('rejects a non-finite number', () => {
    expect(validateField(field('speed'), 'nope')).toBe('must be a finite number');
  });

  it('requires a blank only when the field is required', () => {
    expect(validateField(field('speed'), '')).toBe('this field is required');
    expect(validateField(field('label'), '')).toBeNull();
  });

  it('rejects a select value outside its options', () => {
    expect(validateField(field('mode'), 'lit')).toBeNull();
    expect(validateField(field('mode'), 'blazing')).toContain('lit, dark, off');
  });

  it('never validates an unsupported field into a value', () => {
    expect(validateField(field('texture'), 'anything')).toBeNull();
  });
});

describe('editability', () => {
  function instance(extra: Partial<SceneInstance> = {}): SceneInstance {
    return {
      id: 'crate',
      prefab: 'crate',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      params: {},
      ...extra,
    };
  }

  it('is editable when nothing is selected to block it', () => {
    expect(editability(instance())).toEqual({ editable: true, reason: '' });
  });

  it('refuses when nothing is selected', () => {
    expect(editability(null)).toEqual({ editable: false, reason: 'nothing is selected' });
  });

  it('refuses a locked instance and says what locked means', () => {
    const result = editability(instance({ locked: true }));
    expect(result.editable).toBe(false);
    expect(result.reason).toContain('locked');
  });

  it('treats locked: false as editable', () => {
    expect(editability(instance({ locked: false })).editable).toBe(true);
  });
});

describe('transform vectors', () => {
  const transform = {
    position: [1, 2, 3] as [number, number, number],
    rotation: [0.5, 0, 0] as [number, number, number],
    scale: [2, 2, 2] as [number, number, number],
  };

  it('exposes the three axes in order', () => {
    expect([...VECTOR_AXES]).toEqual(['x', 'y', 'z']);
  });

  it('reads each vector as a 3-tuple', () => {
    expect(readVector(transform, 'position')).toEqual([1, 2, 3]);
    expect(readVector(transform, 'scale')).toEqual([2, 2, 2]);
  });

  it('builds a patch for one axis and refuses an unparseable one', () => {
    expect(transformPatch('position', 'y', '4')).toEqual({
      key: 'position',
      axis: 'y',
      value: 4,
    });
    expect(transformPatch('position', 'y', '-')).toBeNull();
    expect(transformPatch('position', 'y', '')).toBeNull();
  });

  it('builds a full vector patch from three drafts', () => {
    expect(vectorPatch('position', ['1', '2', '3'])?.patch).toEqual({ position: [1, 2, 3] });
  });

  it('emits nothing while any component is still being typed', () => {
    // "-", "1e", "" are all mid-keystroke states; a half-typed number must not
    // become an edit, or a transform of NaN is written on every backspace.
    expect(vectorPatch('position', ['-', '1', '2'])).toBeNull();
    expect(vectorPatch('position', ['1e', '1', '2'])).toBeNull();
    expect(vectorPatch('position', ['', '', ''])).toBeNull();
  });
});

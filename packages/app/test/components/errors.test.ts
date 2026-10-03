/**
 * errors.test.ts — placing a refusal under the control that caused it.
 *
 * `Result.reason` is a complete sentence from the main process and the scene
 * schema names a JSON path (R9), so the work here is finding the field, not
 * writing a new message. The cases that must not regress: a reason that names
 * no field is honestly reported as global instead of being pinned to an
 * arbitrary input, and a caller that knows the field wins over any guess.
 */

import { describe, expect, it } from 'vitest';
import type { JsonSchema } from '../../src/ipc.js';
import type { JsonValue } from '@contextforge/core';
import { buildFormFields, type FormField } from '../../src/renderer/components/fields.js';
import {
  findParamPath,
  findTransformPath,
  groupErrors,
  placeError,
  reasonForField,
} from '../../src/renderer/components/errors.js';

const schema: JsonSchema = {
  type: 'object',
  properties: {
    speed: { kind: 'number', title: 'Speed' },
    maxSpeed: { kind: 'number', title: 'Max speed' },
    position: { kind: 'string', title: 'Position tag' },
    texture: { kind: 'unsupported', title: 'Texture', reason: 'ZodRecord' },
  },
  required: [],
  additionalProperties: false,
};

const fields: FormField[] = buildFormFields(schema, {} as Record<string, JsonValue>);

describe('findParamPath', () => {
  it('reads a dotted JSON path', () => {
    expect(findParamPath('instances[2].params.speed must be a finite number')).toBe('speed');
  });

  it('reads a bracketed JSON path', () => {
    expect(findParamPath('objects[0].params["maxSpeed"] is required')).toBe('maxSpeed');
  });

  it('returns null when no path is present', () => {
    expect(findParamPath('the scene failed to load')).toBeNull();
  });
});

describe('findTransformPath', () => {
  it('names the vector the scene schema complained about', () => {
    expect(
      findTransformPath('instances[3].transform.position must have exactly 3 components'),
    ).toBe('position');
    expect(findTransformPath('instances[3].transform.scale[1] must have exactly 3 components')).toBe(
      'scale',
    );
  });

  it('returns null for a refusal with no transform in it', () => {
    expect(findTransformPath('instance id "crate" is already used in this scene')).toBeNull();
  });
});

describe('placeError', () => {
  it('trusts the field the caller says it just edited', () => {
    const placed = placeError('something went wrong', fields, 'speed');
    expect(placed).toEqual({ scope: { kind: 'field', field: 'speed' }, reason: 'something went wrong' });
  });

  it('falls back to the JSON path in the reason', () => {
    const placed = placeError('instances[2].params.speed must be a finite number', fields);
    expect(placed.scope).toEqual({ kind: 'field', field: 'speed' });
  });

  it('does not match a field whose name is a suffix of another', () => {
    // A naive `reason.includes(name)` would file this under `speed`.
    const placed = placeError('maxSpeed exceeds the world limit', fields);
    expect(placed).toEqual({
      scope: { kind: 'field', field: 'maxSpeed' },
      reason: 'maxSpeed exceeds the world limit',
    });
  });

  it('falls back to a bare mention of a declared field name', () => {
    const placed = placeError('speed must be a finite number', fields);
    expect(placed.scope).toEqual({ kind: 'field', field: 'speed' });
  });

  it('routes a transform refusal to the vector section', () => {
    const placed = placeError('instances[0].transform.rotation must have exactly 3 components', fields);
    expect(placed.scope).toEqual({ kind: 'field', field: 'rotation' });
  });

  it('reports a refusal that names no control as global rather than guessing', () => {
    const reason = 'the project has no manifest and no project.godot';
    expect(placeError(reason, fields)).toEqual({ scope: { kind: 'global' }, reason });
  });

  it('ignores a caller-supplied field the form does not show', () => {
    const placed = placeError('nope', fields, 'not-a-field');
    expect(placed.scope).toEqual({ kind: 'global' });
  });

  it('never rewrites the reason', () => {
    const reason = 'instances[2].params.speed must be a finite number';
    expect(placeError(reason, fields).reason).toBe(reason);
  });
});

describe('groupErrors', () => {
  it('keys each refusal by its field and keeps the last for that field', () => {
    const { byField, global } = groupErrors([
      { scope: { kind: 'field', field: 'speed' }, reason: 'stale' },
      { scope: { kind: 'field', field: 'maxSpeed' }, reason: 'too fast' },
      { scope: { kind: 'field', field: 'speed' }, reason: 'current' },
    ]);
    expect(byField.get('speed')).toBe('current');
    expect(byField.get('maxSpeed')).toBe('too fast');
    expect(global).toBe('');
  });

  it('collects global refusals instead of dropping them', () => {
    const { global } = groupErrors([
      { scope: { kind: 'global' }, reason: 'scene invalid' },
      { scope: { kind: 'global' }, reason: 'camera missing' },
    ]);
    expect(global).toBe('scene invalid camera missing');
  });

  it('handles no errors at all', () => {
    const { byField, global } = groupErrors([]);
    expect(byField.size).toBe(0);
    expect(global).toBe('');
  });
});

describe('reasonForField', () => {
  it('prefers a refusal from the main process over local text', () => {
    const byField = new Map([['speed', 'params.speed must be a finite number']]);
    expect(reasonForField(byField, 'speed', 'must be at most 10')).toBe(
      'params.speed must be a finite number',
    );
  });

  it('falls back to the local message when the main process said nothing', () => {
    expect(reasonForField(new Map(), 'speed', 'must be at most 10')).toBe('must be at most 10');
  });

  it('returns null when there is nothing to say', () => {
    expect(reasonForField(new Map(), 'speed', null)).toBeNull();
  });
});

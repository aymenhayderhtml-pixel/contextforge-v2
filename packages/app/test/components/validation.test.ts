/**
 * packages/app/test/components/validation.test.ts
 *
 * Tests for parameter validation (ContextForge v2 Step 3b).
 */

import { describe, expect, it } from 'vitest';
import type { FieldSchema, JsonSchema } from '../../src/ipc.js';
import {
  validateField,
  validateInstanceParams,
  validateParamValue,
} from '../../src/renderer/validation.js';

describe('validateParamValue', () => {
  const numberField: FieldSchema = {
    kind: 'number',
    title: 'Width',
    min: 0,
    max: 100,
  };

  it('rejects values below min (e.g. Width = -10)', () => {
    expect(validateParamValue(numberField, -10)).toBe('Width must be at least 0');
    expect(validateParamValue(numberField, '-10')).toBe('Width must be at least 0');
  });

  it('rejects values above max', () => {
    expect(validateParamValue(numberField, 150)).toBe('Width must be at most 100');
  });

  it('rejects non-finite numbers', () => {
    expect(validateParamValue(numberField, 'not-a-number')).toBe('Width must be a finite number');
    expect(validateParamValue(numberField, NaN)).toBe('Width must be a finite number');
  });

  it('accepts valid numbers within range', () => {
    expect(validateParamValue(numberField, 50)).toBeNull();
    expect(validateParamValue(numberField, '50')).toBeNull();
    expect(validateParamValue(numberField, 0)).toBeNull();
    expect(validateParamValue(numberField, 100)).toBeNull();
  });

  it('enforces required fields', () => {
    expect(validateParamValue(numberField, null, true)).toBe('Width is required');
    expect(validateParamValue(numberField, '', true)).toBe('Width is required');
    expect(validateParamValue(numberField, undefined, true)).toBe('Width is required');
    // Optional field can be empty
    expect(validateParamValue(numberField, undefined, false)).toBeNull();
  });

  it('validates select/options fields', () => {
    const selectField: FieldSchema = {
      kind: 'string',
      title: 'Mode',
      options: ['easy', 'hard'],
    };
    expect(validateParamValue(selectField, 'easy')).toBeNull();
    expect(validateParamValue(selectField, 'impossible')).toBe('Mode must be one of: easy, hard');
  });
});

describe('validateInstanceParams', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      width: { kind: 'number', title: 'Width', min: 0, max: 100 },
      height: { kind: 'number', title: 'Height', min: 0 },
      name: { kind: 'string', title: 'Name' },
    },
    required: ['width'],
    additionalProperties: false,
  };

  it('emits field-scoped AppError for Width = -10', () => {
    const errors = validateInstanceParams({ width: -10 }, schema, 'crate_1');
    expect(errors).toHaveLength(1);
    const err = errors[0]!;
    expect(err.scope).toBe('field');
    expect(err.instanceId).toBe('crate_1');
    expect(err.fieldPath).toBe('width');
    expect(err.short).toBe('Width must be at least 0');
  });

  it('emits field-scoped AppError for missing required param', () => {
    const errors = validateInstanceParams({}, schema, 'crate_1');
    expect(errors).toHaveLength(1);
    const err = errors[0]!;
    expect(err.scope).toBe('field');
    expect(err.instanceId).toBe('crate_1');
    expect(err.fieldPath).toBe('width');
    expect(err.short).toBe('Width is required');
  });

  it('emits AppError for unknown params when additionalProperties is false', () => {
    const errors = validateInstanceParams({ width: 10, rogueProp: 'value' }, schema, 'crate_1');
    expect(errors).toHaveLength(1);
    const err = errors[0]!;
    expect(err.scope).toBe('field');
    expect(err.fieldPath).toBe('rogueProp');
    expect(err.short).toContain('Unknown parameter "rogueProp"');
  });
});

describe('validateField', () => {
  it('validates live input strings', () => {
    const field = {
      name: 'width',
      title: 'Width',
      required: true,
      kind: 'number' as const,
      reason: '',
      value: 10,
      min: 0,
      max: 100,
      options: [],
      hasDefault: false,
      defaultValue: null,
    };
    expect(validateField(field, '-5')).toBe('must be at least 0');
    expect(validateField(field, '150')).toBe('must be at most 100');
    expect(validateField(field, 'abc')).toBe('must be a finite number');
    expect(validateField(field, '50')).toBeNull();
  });
});

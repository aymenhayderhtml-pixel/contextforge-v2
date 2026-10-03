/**
 * packages/app/test/components/instanceErrorScoping.test.ts
 *
 * Verifies that selecting each of the 5 instances in kart-dash-3d-v2
 * shows ONLY its own errors in the Inspector.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SceneFile } from '@contextforge/core';
import type { PrefabSummary, PrefabFailure } from '../../src/ipc.js';
import { validateInstanceParams } from '../../src/renderer/validation.js';
import { scopeErrorsToInstance } from '../../src/renderer/errorFormatting.js';
import { createAppError, type AppError } from '../../src/errors.js';

describe('Instance Error Scoping for 5 instances in kart-dash-3d-v2', () => {
  const projectRoot = process.env['CF_PROJECT'] ??
    resolve(import.meta.dirname, '..', '..', '..', '..', '..', 'kart-dash-3d-v2');
  const scenePath = join(projectRoot, 'scene.json');
  const scene: SceneFile = JSON.parse(readFileSync(scenePath, 'utf-8'));

  // Prefab definitions / schemas for the project
  const prefabs: PrefabSummary[] = [
    {
      name: 'kart',
      description: 'Go-kart with character driver',
      paramsJsonSchema: {
        type: 'object',
        properties: {
          character: { kind: 'string', title: 'Character', default: 'dash', options: ['dash', 'luna', 'rex'] },
          headgear: { kind: 'string', title: 'Headgear', default: 'helmet', options: ['helmet', 'cap', 'helmet-full'] },
        },
        required: ['character'],
        additionalProperties: true,
      },
    },
    {
      name: 'trackSegment',
      description: 'Modular track segment',
      paramsJsonSchema: {
        type: 'object',
        properties: {
          width: { kind: 'number', title: 'Width', min: 0, default: 12 },
          length: { kind: 'number', title: 'Length', min: 1, default: 50 },
          color: { kind: 'string', title: 'Color', default: '#1f2228' },
        },
        required: ['width', 'length'],
        additionalProperties: true,
      },
    },
  ];

  const failedPrefabs: PrefabFailure[] = [
    {
      name: 'hazardCrate',
      file: 'prefabs/hazardCrate.ts',
      reason: 'Corrupted GLTF buffer: failed to parse header',
    },
  ];

  // Build the complete AppError list across the scene (identical to SceneScreen)
  const allAppErrors: AppError[] = [];
  const prefabMap = new Map(prefabs.map((p) => [p.name, p]));
  const failedMap = new Map(failedPrefabs.map((f) => [f.name, f]));

  for (const inst of scene.instances) {
    const failed = failedMap.get(inst.prefab);
    if (failed) {
      allAppErrors.push(
        createAppError({
          id: `err-prefab-${inst.id}:${failed.name}`,
          scope: 'instance',
          instanceId: inst.id,
          short: `${failed.name} failed to load: ${failed.reason}`,
          details: failed.file ? `File: ${failed.file}` : undefined,
        }),
      );
    }

    const summary = prefabMap.get(inst.prefab);
    if (summary) {
      const paramErrors = validateInstanceParams(inst.params, summary.paramsJsonSchema, inst.id);
      allAppErrors.push(...paramErrors);
    }
  }

  it('contains exactly 5 instances in kart-dash-3d-v2', () => {
    expect(scene.instances).toHaveLength(5);
    const ids = scene.instances.map((i) => i.id);
    expect(ids).toEqual(['track', 'hazard_crate', 'player_kart', 'rival_luna', 'rival_rex']);
  });

  it('instance 1 (track): shows ONLY its own param error and no other instance errors', () => {
    const trackErrors = scopeErrorsToInstance(allAppErrors, 'track');
    expect(trackErrors).toHaveLength(1);
    expect(trackErrors[0]!.scope).toBe('field');
    expect(trackErrors[0]!.instanceId).toBe('track');
    expect(trackErrors[0]!.fieldPath).toBe('width');
    expect(trackErrors[0]!.short).toContain('Width must be at least 0');
  });

  it('instance 2 (hazard_crate): shows ONLY its own prefab failure and no other instance errors', () => {
    const crateErrors = scopeErrorsToInstance(allAppErrors, 'hazard_crate');
    expect(crateErrors).toHaveLength(1);
    expect(crateErrors[0]!.scope).toBe('instance');
    expect(crateErrors[0]!.instanceId).toBe('hazard_crate');
    expect(crateErrors[0]!.short).toBe('hazardCrate failed to load: Corrupted GLTF buffer: failed to parse header');
    expect(crateErrors[0]!.details).toBe('File: prefabs/hazardCrate.ts');
  });

  it('instance 3 (player_kart): has 0 errors', () => {
    const kartErrors = scopeErrorsToInstance(allAppErrors, 'player_kart');
    expect(kartErrors).toHaveLength(0);
  });

  it('instance 4 (rival_luna): has 0 errors', () => {
    const lunaErrors = scopeErrorsToInstance(allAppErrors, 'rival_luna');
    expect(lunaErrors).toHaveLength(0);
  });

  it('instance 5 (rival_rex): has 0 errors', () => {
    const rexErrors = scopeErrorsToInstance(allAppErrors, 'rival_rex');
    expect(rexErrors).toHaveLength(0);
  });

  it('no instance receives errors belonging to another instance', () => {
    for (const inst of scene.instances) {
      const scoped = scopeErrorsToInstance(allAppErrors, inst.id);
      for (const err of scoped) {
        if (err.instanceId) {
          expect(err.instanceId).toBe(inst.id);
        }
      }
    }
  });
});

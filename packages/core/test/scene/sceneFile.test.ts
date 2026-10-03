/**
 * scene/sceneFile.test.ts — the `scene.json` contract (SPEC §4.2, R6).
 *
 * The invalid cases are the point of the suite. Each asserts that the failure
 * names the JSON path, because a scene is written by an AI and the developer's
 * only recourse is to know *where* the problem is (SPEC R9).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadScene,
  saveScene,
  validateScene,
  parseScene,
  serializeScene,
  emptyScene,
  type SceneError,
} from '../../src/scene/sceneFile.js';
import { SCENE_SCHEMA_VERSION, type SceneFile } from '../../src/scene/scene.schema.js';

/** A minimal scene that must validate. */
function validScene(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    name: 'Level1',
    engine: 'three',
    seed: 12345,
    instances: [
      {
        id: 'crate',
        prefab: 'cube',
        transform: {
          position: [1, 2, 3],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        params: { size: 2 },
      },
    ],
    lights: [{ id: 'sun', kind: 'directional', color: '#ffffff', intensity: 1 }],
    camera: {
      kind: 'perspective',
      position: [0, 5, 10],
      rotation: [0, 0, 0],
      fov: 60,
    },
    ...overrides,
  };
}

/** Assert an input is rejected, and that the message names `expectedPath`. */
function expectRejected(data: unknown, expectedPath: string): SceneError[] {
  const result = validateScene(data);
  if (result.valid) {
    throw new Error(
      `Expected the scene to be rejected, but it validated. Errors: ${JSON.stringify(result.errors)}`,
    );
  }
  const paths = result.errors.map((e) => e.path);
  expect(paths).toContain(expectedPath);
  return result.errors;
}

describe('validateScene: a valid scene', () => {
  it('accepts it and returns the data', () => {
    const result = validateScene(validScene());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.data?.name).toBe('Level1');
  });

  it('defaults params to an empty object', () => {
    const data = validScene({
      instances: [
        {
          id: 'crate',
          prefab: 'cube',
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
      ],
    });
    const result = validateScene(data);
    expect(result.valid).toBe(true);
    expect(result.data?.instances[0]?.params).toEqual({});
  });

  it('defaults lights to an empty array', () => {
    const data = validScene();
    delete (data as Record<string, unknown>)['lights'];
    const result = validateScene(data);
    expect(result.valid).toBe(true);
    expect(result.data?.lights).toEqual([]);
  });
});

describe('validateScene: the failures the spec names', () => {
  it('rejects a duplicate instance id, naming the JSON path', () => {
    const instance = {
      id: 'crate',
      prefab: 'cube',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    };
    const errors = expectRejected(
      validScene({ instances: [instance, { ...instance }] }),
      'instances[1].id',
    );
    expect(errors[0]?.message).toContain('duplicate instance id "crate"');
  });

  it('rejects a dangling parent, naming the JSON path', () => {
    const errors = expectRejected(
      validScene({
        instances: [
          {
            id: 'coin',
            prefab: 'cube',
            parent: 'nowhere',
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
        ],
      }),
      'instances[0].parent',
    );
    expect(errors[0]?.message).toContain('does not exist');
  });

  it('rejects self-parenting', () => {
    const errors = expectRejected(
      validScene({
        instances: [
          {
            id: 'coin',
            prefab: 'cube',
            parent: 'coin',
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
        ],
      }),
      'instances[0].parent',
    );
    expect(errors[0]?.message).toContain('parents itself');
  });

  it('rejects a two-component position rather than padding it', () => {
    const errors = expectRejected(
      validScene({
        instances: [
          {
            id: 'crate',
            prefab: 'cube',
            transform: { position: [1, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
        ],
      }),
      'instances[0].transform.position',
    );
    expect(errors[0]?.message).toContain('exactly 3 components');
  });

  it('rejects an unknown key, naming the JSON path', () => {
    // `postion` is the typo an AI makes, and exactly the one Zod's default
    // key-stripping would hide.
    const errors = expectRejected(
      validScene({
        instances: [
          {
            id: 'crate',
            prefab: 'cube',
            postion: [1, 2, 3],
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
        ],
      }),
      'instances[0]',
    );
    expect(JSON.stringify(errors)).toContain('postion');
  });

  it('rejects a wrong schema_version with a message that says why', () => {
    const errors = expectRejected(validScene({ version: 2 }), 'version');
    expect(errors[0]?.message).toContain('refused');
  });

  it('rejects a non-integer seed', () => {
    expectRejected(validScene({ seed: 1.5 }), 'seed');
  });

  it('rejects a bad hex colour', () => {
    expectRejected(
      validScene({ lights: [{ id: 'sun', kind: 'directional', color: 'white', intensity: 1 }] }),
      'lights[0].color',
    );
  });

  it('rejects an unknown engine', () => {
    expectRejected(validScene({ engine: 'unreal' }), 'engine');
  });

  it('reports every problem at once, not just the first', () => {
    const result = validateScene(
      validScene({
        version: 9,
        engine: 'unreal',
        lights: [{ id: 'x', kind: 'directional', color: 'nope', intensity: 1 }],
      }),
    );
    expect(result.valid).toBe(false);
    // A developer who fixed one typo should not have to re-run three times.
    expect(result.errors.map((e) => e.path).sort()).toEqual([
      'engine',
      'lights[0].color',
      'version',
    ]);
  });
});

describe('validateScene: parent cycles', () => {
  const makeInstance = (id: string, parent?: string) => ({
    id,
    prefab: 'cube',
    ...(parent !== undefined ? { parent } : {}),
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });

  it('rejects a two-instance cycle', () => {
    const errors = expectRejected(
      validScene({ instances: [makeInstance('a', 'b'), makeInstance('b', 'a')] }),
      'instances[0].parent',
    );
    expect(errors[0]?.message).toContain('cycle');
  });

  it('rejects a three-instance cycle', () => {
    expectRejected(
      validScene({
        instances: [makeInstance('a', 'c'), makeInstance('b', 'a'), makeInstance('c', 'b')],
      }),
      'instances[0].parent',
    );
  });

  it('accepts a deep but acyclic chain', () => {
    const result = validateScene(
      validScene({
        instances: [
          makeInstance('a'),
          makeInstance('b', 'a'),
          makeInstance('c', 'b'),
          makeInstance('d', 'c'),
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });
});

describe('parseScene', () => {
  it('returns the data when valid', () => {
    expect(parseScene(validScene()).name).toBe('Level1');
  });

  it('throws listing every error when invalid', () => {
    let message = '';
    try {
      parseScene(validScene({ version: 3 }), 'scene.json');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('scene.json is not a valid scene');
    expect(message).toContain('version');
  });
});

describe('loadScene / saveScene', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cf-scene-'));
    file = join(dir, 'scenes', 'Level1.scene.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when the file does not exist', () => {
    // "No scene yet" is a normal state for a fresh project, not an error.
    expect(loadScene(file)).toBeNull();
  });

  it('round-trips a scene unchanged', () => {
    const original = parseScene(validScene());
    saveScene(file, original);
    expect(loadScene(file)).toEqual(original);
  });

  it('round-trips byte-identically on a second save', () => {
    // Determinism (R8): saving an unmodified scene must not rewrite it, or
    // every save shows up as a diff between two AIs.
    const original = parseScene(validScene());
    saveScene(file, original);
    const first = readFileSync(file, 'utf-8');
    saveScene(file, loadScene(file) as SceneFile);
    expect(readFileSync(file, 'utf-8')).toBe(first);
  });

  it('creates the parent directory', () => {
    saveScene(file, parseScene(validScene()));
    expect(existsSync(file)).toBe(true);
  });

  it('refuses to write an invalid scene', () => {
    // saveScene re-validates, so a hand-built scene with a duplicate id never
    // reaches disk. The file must not exist afterwards.
    const broken = parseScene(validScene());
    const doubled = { ...broken, instances: [...broken.instances, ...broken.instances] };
    expect(() => saveScene(file, doubled as SceneFile)).toThrow(/duplicate instance id/);
    expect(existsSync(file)).toBe(false);
  });

  it('throws naming the file when the JSON is malformed', () => {
    mkdirSync(join(dir, 'scenes'), { recursive: true });
    writeFileSync(file, '{ not json', 'utf-8');
    expect(() => loadScene(file)).toThrow(/not valid JSON/);
  });

  it('throws naming the file when the scene is invalid', () => {
    mkdirSync(join(dir, 'scenes'), { recursive: true });
    writeFileSync(file, JSON.stringify(validScene({ version: 42 })), 'utf-8');
    expect(() => loadScene(file)).toThrow(/Level1\.scene\.json/);
    expect(() => loadScene(file)).toThrow(/version/);
  });

  it('writes optional keys in a stable order', () => {
    const text = serializeScene(
      parseScene(
        validScene({
          instances: [
            {
              id: 'crate',
              prefab: 'cube',
              name: 'Crate',
              parent: 'ground',
              transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              params: {},
              model: 'models/crate.glb',
              visible: true,
              locked: false,
            },
            {
              id: 'ground',
              prefab: 'cube',
              transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              params: {},
            },
          ],
        }),
      ),
    );
    expect(text).toMatch(/"name": "Crate"/);
    expect(text).toMatch(/"model": "models\/crate\.glb"/);
    expect(text.endsWith('\n')).toBe(true);
    // Key order is the contract, not insertion order: parent precedes transform.
    expect(text.indexOf('"parent"')).toBeLessThan(text.indexOf('"transform"'));
  });
});

describe('emptyScene', () => {
  it('produces a scene that validates', () => {
    const result = validateScene(emptyScene('Fresh'));
    expect(result.valid).toBe(true);
    expect(result.data?.instances).toEqual([]);
    expect(result.data?.schema_version).toBeUndefined();
    expect(result.data?.version).toBe(SCENE_SCHEMA_VERSION);
  });
});

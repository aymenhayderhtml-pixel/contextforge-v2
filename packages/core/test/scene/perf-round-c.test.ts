/**
 * packages/core/test/scene/perf-round-c.test.ts
 *
 * SCENE-8: `checkRelations` was super-linear on a deep parent chain (D53).
 *
 * Every instance walked its own parent chain to the root from scratch, so a
 * single deep chain — the shape a generated scene or an exported hierarchy
 * produces — cost n²/2 hops. Measured on main: 8,001,999 hops for a 4,000-deep
 * chain, and 7,124 ms of `validateScene` at 8,000 deep. `saveScene` pays this
 * before a byte is written.
 *
 * Fixed by memoising "this id's chain is acyclic", consulted at every step of the
 * walk, and populating the memo with the nodes walked on a successful return.
 */

import { describe, expect, it } from 'vitest';
import { validateScene } from '../../src/scene/sceneFile.js';
import type { SceneFile } from '../../src/scene/scene.schema.js';

const v = () => [0, 0, 0] as [number, number, number];
const tf = () => ({
  position: v(),
  rotation: v(),
  scale: [1, 1, 1] as [number, number, number],
});

interface InstSpec {
  id: string;
  parent?: string;
}

function scene(instances: InstSpec[], lights: unknown[] = []): SceneFile {
  return {
    version: 1,
    name: 'p',
    engine: 'godot',
    seed: 1,
    camera: { kind: 'perspective', position: v(), rotation: v(), fov: 60 },
    instances: instances.map((i) => ({
      id: i.id,
      prefab: 'box',
      parent: i.parent,
      transform: tf(),
      params: {},
    })),
    lights,
  } as unknown as SceneFile;
}

function ms(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

/** A single chain of `n` instances, `i(n-1)` the deepest. */
function deepChain(n: number): SceneFile {
  return scene(
    Array.from({ length: n }, (_, i) => ({
      id: `i${i}`,
      parent: i === 0 ? undefined : `i${i - 1}`,
    })),
  );
}

describe('SCENE-8 — checkRelations is linear on a deep parent chain', () => {
  it('a 4,000-deep chain validates with no errors', () => {
    // Correctness first: the memo must not turn a valid scene into an invalid one.
    expect(validateScene(deepChain(4000)).valid).toBe(true);
  });

  it('an 8,000-deep chain validates in well under 2s', () => {
    // Unfixed: 7,124 ms.
    expect(ms(() => validateScene(deepChain(8000)))).toBeLessThan(2000);
  });

  it('doubling the depth does not quadruple the time', () => {
    // Linear is ~2x. Unfixed this was ~3.6x at every doubling measured.
    const small = ms(() => validateScene(deepChain(4000)));
    const large = ms(() => validateScene(deepChain(8000)));
    expect(large / small).toBeLessThan(3);
  });
});

describe('SCENE-8 parity — the memo reports exactly what the naive walk did', () => {
  /**
   * The pre-fix relation rules, written out longhand.
   *
   * A memo that cached a `true` verdict it should not, or seeded `seen` with the
   * starting id, would silently change which instances get an error. This is the
   * check that catches it: every case below is compared against this walk, not
   * against a hand-written expectation.
   */
  function reference(instances: InstSpec[]): string[] {
    const out: string[] = [];
    const indexById = new Map<string, number>();
    instances.forEach((instance, index) => {
      if (indexById.has(instance.id)) {
        out.push(`instances[${index}].id|duplicate ${instance.id}`);
        return;
      }
      indexById.set(instance.id, index);
    });

    instances.forEach((instance, index) => {
      if (instance.parent === undefined) return;
      if (instance.parent === instance.id) {
        out.push(`instances[${index}].parent|self ${instance.id}`);
        return;
      }
      if (!indexById.has(instance.parent)) {
        out.push(`instances[${index}].parent|missing ${instance.parent}`);
        return;
      }
      const seen = new Set<string>([instance.id]);
      let current: string | undefined = instance.parent;
      while (current !== undefined) {
        if (seen.has(current)) {
          out.push(`instances[${index}].parent|cycle ${instance.id} -> ${current}`);
          return;
        }
        seen.add(current);
        const parentIndex = indexById.get(current);
        current = parentIndex === undefined ? undefined : instances[parentIndex]?.parent;
      }
    });
    return out;
  }

  /** Reduce a real error message to the same shape `reference` emits. */
  function actual(errors: { path: string; message: string }[]): string[] {
    return errors.map((e) => {
      const path = e.path;
      if (/parents itself/.test(e.message)) {
        return `${path}|self ${/instance "([^"]+)"/.exec(e.message)?.[1] ?? '?'}`;
      }
      if (/duplicate instance id/.test(e.message)) {
        return `${path}|duplicate ${/duplicate instance id "([^"]+)"/.exec(e.message)?.[1] ?? '?'}`;
      }
      if (/does not exist — no instance has that id/.test(e.message)) {
        return `${path}|missing ${/parent "([^"]+)" does not exist/.exec(e.message)?.[1] ?? '?'}`;
      }
      const cyc = /parent chain from "([^"]+)" is a cycle through "([^"]+)"/.exec(e.message);
      if (cyc) return `${path}|cycle ${cyc[1]} -> ${cyc[2]}`;
      return `${path}|${e.message}`;
    });
  }

  const cases: [string, InstSpec[]][] = [
    ['clean chain', [{ id: 'a' }, { id: 'b', parent: 'a' }, { id: 'c', parent: 'b' }]],
    ['self parent', [{ id: 'a' }, { id: 'b', parent: 'b' }]],
    ['missing parent', [{ id: 'a' }, { id: 'b', parent: 'nope' }]],
    ['two-node cycle', [{ id: 'a', parent: 'b' }, { id: 'b', parent: 'a' }]],
    ['three-node cycle', [{ id: 'a', parent: 'c' }, { id: 'b', parent: 'a' }, { id: 'c', parent: 'b' }]],
    ['cycle plus clean tail', [{ id: 'a', parent: 'b' }, { id: 'b', parent: 'a' }, { id: 'c', parent: 'd' }, { id: 'd' }]],
    ['cycle below a clean chain', [{ id: 'r' }, { id: 'x', parent: 'r' }, { id: 'a', parent: 'b' }, { id: 'b', parent: 'a' }]],
    ['cycle reachable from a root', [{ id: 'root' }, { id: 'm', parent: 'root' }, { id: 'p', parent: 'q' }, { id: 'q', parent: 'p' }]],
    ['two roots', [{ id: 'r1' }, { id: 'r2' }, { id: 'c', parent: 'r1' }]],
    ['duplicate id', [{ id: 'a' }, { id: 'a' }, { id: 'b', parent: 'a' }]],
    ['self parent plus a cycle', [{ id: 'a', parent: 'a' }, { id: 'b', parent: 'c' }, { id: 'c', parent: 'b' }]],
    ['wide fanout', [{ id: 'hub' }, ...Array.from({ length: 20 }, (_, i) => ({ id: `w${i}`, parent: 'hub' }))]],
    ['chain running into a cycle', [{ id: 'a', parent: 'b' }, { id: 'b', parent: 'c' }, { id: 'c', parent: 'd' }, { id: 'd', parent: 'c' }]],
  ];

  for (const [name, instances] of cases) {
    it(`reports the same errors as the naive walk: ${name}`, () => {
      const result = validateScene(scene(instances));
      expect(actual(result.errors)).toEqual(reference(instances));
    });
  }

  it('a cycle still names the instance the chain started from', () => {
    // The memoised version re-walks a cycle to produce this sentence, so the
    // message a developer reads must be the specific one the naive walk gave:
    // the chain closes back on the instance it started from. a -> c -> b -> a.
    const result = validateScene(
      scene([{ id: 'a', parent: 'c' }, { id: 'b', parent: 'a' }, { id: 'c', parent: 'b' }]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toContain('parent chain from "a" is a cycle through "a"');
  });
});
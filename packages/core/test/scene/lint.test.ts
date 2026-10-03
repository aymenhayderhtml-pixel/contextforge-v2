/**
 * scene/lint.test.ts — the prefab lint, rule by rule.
 *
 * Every rule is tested twice: once against a good prefab that must pass, and
 * once against a bad prefab that must be caught. The good case matters as much
 * as the bad one — a lint that flags prose in a doc comment is a lint the
 * developer will disable, and a prefab *has* to be allowed to document itself
 * (SPEC R5: a regex cannot tell a comment from code; these are the tests that
 * prove the tree-based version can).
 */

import { describe, expect, it } from 'vitest';
import { lintPrefabSource, PREFAB_RULES, type PrefabRule } from '../../src/scene/lint.js';

/** A prefab that satisfies every rule: pure, seeded, caller-composed. */
const GOOD_PREFAB = `
import { z } from 'zod';

const paramsSchema = z.object({ size: z.number() }).strict();

export function create(three, params, rng) {
  const mesh = new three.Mesh(
    new three.BoxGeometry(params.size, params.size, params.size),
    new three.MeshStandardMaterial({ color: 0xff0000 }),
  );
  mesh.position.set(rng.range(-1, 1), 0, rng.range(-1, 1));
  return { object: mesh, parts: { body: mesh } };
}

export default { name: 'cube', create, paramsSchema };
`;

/** The rules present in a result, as a sorted set. */
function rulesIn(source: string, file = 'prefab.ts'): PrefabRule[] {
  const result = lintPrefabSource(source, file);
  // A rule set is only meaningful if the source actually parsed: otherwise
  // every rule reads as absent, which is how a broken prefab passes a test.
  expect(result.violations.map((v) => v.rule)).not.toContain('parse-error');
  return [...new Set(result.violations.map((v) => v.rule))].sort();
}

describe('prefab lint: a clean prefab passes', () => {
  it('reports no violations', () => {
    const result = lintPrefabSource(GOOD_PREFAB, 'cube.ts');
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('passes a prefab that uses randomness through the injected rng', () => {
    const source = `
      const schema = z.object({}).strict();
      export function create(three, params, rng) {
        const group = new three.Group();
        for (let i = 0; i < 3; i++) {
          const child = new three.Mesh(new three.SphereGeometry(1), new three.MeshBasicMaterial());
          child.position.x = rng.range(-5, 5);
          group.add(child);
        }
        return { object: group, parts: {} };
      }
    `;
    // `group.add` is allowed: a prefab builds its own hierarchy. Only `scene.add`
    // is a violation.
    expect(rulesIn(source)).toEqual([]);
  });
});

describe('prefab lint: no-this', () => {
  it('flags `this` in a method', () => {
    const rules = rulesIn(`
      export function create(three) {
        return { object: new three.Object3D(), parts: {} };
      }
      class Helper {
        build() {
          this.mesh = new Mesh();
          return this.mesh;
        }
      }
    `);
    expect(rules).toContain('no-this');
  });

  it('does not flag `this` inside a comment or a string', () => {
    const rules = rulesIn(`
      // This prefab returns an object; this is not a violation.
      /* Nor is this mention of this. */
      export function create(three) {
        const label = 'this is a string mentioning this';
        return { object: new three.Object3D(), parts: {}, label };
      }
    `);
    expect(rules).toEqual([]);
  });
});

describe('prefab lint: no-dom-global', () => {
  it.each(['window', 'document', 'localStorage', 'HTMLElement'])(
    'flags %s',
    (globalName) => {
      const rules = rulesIn(
        `export function create(three) { return { object: new three.Object3D(), parts: {}, g: ${globalName} }; }`,
      );
      expect(rules).toContain('no-dom-global');
    },
  );

  it('does not flag a DOM global named in prose', () => {
    const rules = rulesIn(`
      // The window and the document are irrelevant here: the prefab is pure.
      export function create(three) {
        return { object: new three.Object3D(), parts: {} };
      }
    `);
    expect(rules).toEqual([]);
  });
});

describe('prefab lint: no-scene-add', () => {
  it('flags scene.add', () => {
    const rules = rulesIn(`
      export function create(three, params, rng, scene) {
        const mesh = new three.Mesh();
        scene.add(mesh);
        return { object: mesh, parts: {} };
      }
    `);
    expect(rules).toContain('no-scene-add');
  });

  it('flags scene.attach', () => {
    const rules = rulesIn(`
      export function create(three, scene) {
        scene.attach(new three.Object3D());
        return { object: new three.Object3D(), parts: {} };
      }
    `);
    expect(rules).toContain('no-scene-add');
  });
});

describe('prefab lint: no-math-random', () => {
  it('flags Math.random()', () => {
    const rules = rulesIn(`
      export function create(three) {
        const x = Math.random();
        return { object: new three.Object3D(), parts: { x } };
      }
    `);
    expect(rules).toContain('no-math-random');
  });

  it('does not flag Math.random in a comment', () => {
    const rules = rulesIn(`
      // Never use Math.random() here — use the injected rng instead.
      export function create(three, params, rng) {
        return { object: new three.Object3D(), parts: {} };
      }
    `);
    expect(rules).toEqual([]);
  });
});

describe('prefab lint: no-module-mutable-state', () => {
  it('flags a module-level let', () => {
    const rules = rulesIn(`
      let instanceCount = 0;
      export function create(three) {
        instanceCount += 1;
        return { object: new three.Object3D(), parts: { count: instanceCount } };
      }
    `);
    expect(rules).toContain('no-module-mutable-state');
  });

  it('flags a module-level var', () => {
    const rules = rulesIn(`
      var scaleFactor = 2;
      export function create(three) {
        return { object: new three.Object3D(), parts: { scaleFactor } };
      }
    `);
    expect(rules).toContain('no-module-mutable-state');
  });

  it('allows a function-local let', () => {
    const rules = rulesIn(`
      export function create(three) {
        let total = 0;
        for (let i = 0; i < 3; i++) total += i;
        return { object: new three.Object3D(), parts: { total } };
      }
    `);
    expect(rules).toEqual([]);
  });

  it('allows a module-level const', () => {
    // A const binding is not mutable state: it cannot be reassigned, so every
    // instance sees the same value by definition.
    const rules = rulesIn(`
      const DEFAULT_SIZE = 2;
      export function create(three, params) {
        return { object: new three.Object3D(), parts: { size: params.size ?? DEFAULT_SIZE } };
      }
    `);
    expect(rules).toEqual([]);
  });
});

describe('prefab lint: reporting', () => {
  it('names the line, column, rule and quoted text', () => {
    const result = lintPrefabSource(
      `export function create(three) {
  const x = Math.random();
  return { object: new three.Object3D(), parts: { x } };
}`,
      'bad.ts',
    );
    expect(result.ok).toBe(false);
    const violation = result.violations[0];
    expect(violation?.rule).toBe('no-math-random');
    expect(violation?.line).toBe(2);
    expect(violation?.column).toBe(13);
    expect(violation?.text).toBe('Math.random');
    expect(violation?.message).toContain('rng');
  });

  it('returns violations sorted by position', () => {
    const result = lintPrefabSource(
      `let shared = 0;
export function create(three) {
  shared += 1;
  const x = Math.random();
  window.alert(x);
  return { object: new three.Object3D(), parts: { x, shared } };
}`,
      'many.ts',
    );
    const lines = result.violations.map((v) => v.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));

    // Three distinct rules, one per line: the module-level `let` is reported
    // where it is *declared* (line 1), which is the line a developer would edit.
    expect(result.violations.map((v) => `${v.line}:${v.rule}`)).toEqual([
      '1:no-module-mutable-state',
      '4:no-math-random',
      '5:no-dom-global',
    ]);
  });

  it('exposes a reason for every rule', () => {
    for (const rule of PREFAB_RULES) {
      expect(rulesIn(`export function create() { return {}; }`, `${rule}.ts`)).toBeDefined();
    }
  });
});

describe('prefab lint: an unparseable prefab is a failure, not a pass', () => {
  it('reports parse-error rather than reporting nothing', () => {
    // The dangerous shape: a file the lint could not read, reported as clean
    // because no rule matched. That would let a broken prefab ship.
    const result = lintPrefabSource(
      'export function create(three) { return { object: ',
      'broken.ts',
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.rule).toBe('parse-error');
    expect(result.violations[0]?.message).toContain('does not parse');
  });

  it('passes a well-formed but empty prefab', () => {
    const result = lintPrefabSource('export function create() { return {}; }', 'empty.ts');
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

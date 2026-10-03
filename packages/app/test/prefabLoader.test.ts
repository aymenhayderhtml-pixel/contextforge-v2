/**
 * test/prefabLoader.test.ts — the main-process prefab loader.
 *
 * Fixtures are real projects from core's `generateProject`, not hand-written
 * directories: the loader's job is to cope with the template an AI is handed, and
 * a fixture friendlier than the template would test nothing.
 *
 * No Electron is booted here. Everything under test is main-process *logic* —
 * bundling, importing, converting, isolating — and the only Electron-specific
 * part of the loader is which process runs it, which is `main.ts`'s wiring.
 *
 * The failure-isolation tests are the ones that matter. A prefab that throws is
 * the normal state of a project being edited by an AI, and the difference between
 * "one row in the outliner" and "the app will not open" is the whole subject of
 * this file.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { generateProject } from '@contextforge/core';

import {
  bundleEntry,
  createPrefabLoader,
  describeError,
  isPrefabDefinition,
  loadPrefabRegistry,
  prefabSourceFiles,
  summarizePrefab,
  UnsupportedParamsSchemaError,
  WATCH_DEBOUNCE_MS,
  zodToJsonSchema,
} from '../src/electron/prefabLoader.js';
import type { FieldSchema, PrefabSummary } from '../src/ipc.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cf-prefab-loader-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A generated project — the thing the loader is pointed at in real use. */
function makeProject(name = 'star-crawler'): string {
  generateProject(root, {
    name,
    idea: 'a small game where the player collects drifting rocks in a low-gravity cavern',
    seed: 42,
  });
  return root;
}

/**
 * Add a prefab module and register it in the barrel.
 *
 * Rewrites `prefabs/index.ts` the way an AI would, so the fixture is the real
 * shape and not a hand-composed one. The import and the list are appended
 * separately so a bundle that throws on import is genuinely unreachable from the
 * barrel — which is what the fallback path exists for, and a fixture whose
 * barrel still worked would never exercise it.
 */
function addPrefab(fileName: string, source: string, register = true): void {
  writeFileSync(join(root, 'prefabs', fileName), source, 'utf-8');
  if (!register) return;

  const indexPath = join(root, 'prefabs', 'index.ts');
  const exportName = fileName.replace(/\.ts$/, '');
  const imports = [...readFileSync(indexPath, 'utf-8').matchAll(/^import \{ (\w+) \} from '\.\/[\w-]+\.js';$/gm)];
  const importLine = `import { ${exportName} } from './${exportName}.js';`;

  writeFileSync(
    indexPath,
    readFileSync(indexPath, 'utf-8')
      .replace(/^export const registry/m, `${importLine}\n\nexport const registry`)
      .replace(
        /prefabs: \[([^\]]*)\]/,
        (_match, existing: string) => `prefabs: [${existing.trim()}, ${exportName}]`,
      ),
    'utf-8',
  );

  // The rewrite must actually have registered the prefab, or a test asserting on
  // the barrel is silently asserting on a fixture that never had it.
  expect(imports.length).toBeGreaterThan(0);
  expect(readFileSync(indexPath, 'utf-8')).toContain(importLine);
}

/** The source of a prefab that builds a box, with defaults on every param. */
function boxPrefab(name: string, description = `Prefab ${name}.`): string {
  return [
    "import { z } from 'zod';",
    'export const paramsSchema = z.object({});',
    `export const ${name} = {`,
    `  name: '${name}',`,
    `  description: '${description}',`,
    '  paramsSchema,',
    "  create: (three) => ({ object: new three.BoxGeometry(1, 1, 1), parts: {} }),",
    '};',
  ].join('\n');
}

/** Prefabs keyed by name, for terse assertions. */
function byName(prefabs: PrefabSummary[]): Map<string, PrefabSummary> {
  return new Map(prefabs.map((p) => [p.name, p]));
}

/** One field of a summary, asserting its presence in a single place. */
function field(summary: PrefabSummary, key: string): FieldSchema {
  const found: FieldSchema | undefined = summary.paramsJsonSchema.properties[key];
  if (found === undefined) {
    throw new Error(
      `no field "${key}" in ${Object.keys(summary.paramsJsonSchema.properties).join(', ')}`,
    );
  }
  return found;
}

/** The `three` stand-in for the pure `summarizePrefab` tests. */
const STUB_THREE = { BoxGeometry: class {}, Mesh: class {}, MeshStandardMaterial: class {} };

/** Poll until `check` is true, or fail naming `what` after `timeoutMs`. */
async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}

// ── Zod → JSON Schema ────────────────────────────────────────────────────────

describe('zodToJsonSchema', () => {
  it('maps the generated cube prefab exactly as the inspector needs it', () => {
    const schema = zodToJsonSchema(
      z
        .object({
          size: z.number().positive(),
          colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
          jitter: z.number().min(0).max(1).default(0),
        })
        .strict(),
    );

    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(['colour', 'size']);
    // `size` is `.positive()`, so the bound is **exclusive**. Step 4 added
    // `exclusiveMin` to `FieldSchema` precisely because reporting it as a bare
    // `min: 0` made the app accept `width: 0` while the game's own Zod schema
    // rejected it — the two halves of the same rule disagreeing, which is the
    // kind of divergence that looks like a rendering bug and is not.
    expect(schema.properties['size']).toEqual({
      kind: 'number',
      title: 'Size',
      min: 0,
      exclusiveMin: true,
    });
    expect(schema.properties['colour']).toEqual({
      kind: 'string',
      title: 'Colour',
      pattern: '^#[0-9a-fA-F]{6}$',
    });
    // A default makes the key optional on input and is carried through so the
    // form can pre-fill it.
    expect(schema.properties['jitter']).toEqual({
      kind: 'number',
      title: 'Jitter',
      min: 0,
      max: 1,
      default: 0,
    });
  });

  it('carries inclusive and exclusive number bounds', () => {
    const schema = zodToJsonSchema(z.object({ bounded: z.number().min(1).max(10), plain: z.number() }));
    expect(schema.properties['bounded']).toEqual({ kind: 'number', title: 'Bounded', min: 1, max: 10 });
    expect(schema.properties['plain']).toEqual({ kind: 'number', title: 'Plain' });
  });

  it('uses .describe() as the title, and humanises the key otherwise', () => {
    const schema = zodToJsonSchema(
      z.object({
        maxHealth: z.number(),
        snakecase_name: z.string(),
        documented: z.string().describe('Shown as help text'),
      }),
    );
    expect(schema.properties['maxHealth']).toEqual({ kind: 'number', title: 'Max Health' });
    expect(schema.properties['snakecase_name']).toEqual({ kind: 'string', title: 'Snakecase name' });
    expect(schema.properties['documented']).toEqual({ kind: 'string', title: 'Shown as help text' });
  });

  it('maps an enum to a string with options', () => {
    const schema = zodToJsonSchema(z.object({ shape: z.enum(['box', 'sphere']) }));
    expect(schema.properties['shape']).toEqual({ kind: 'string', title: 'Shape', options: ['box', 'sphere'] });
  });

  it('maps a boolean, with and without a default', () => {
    const schema = zodToJsonSchema(z.object({ solid: z.boolean(), soft: z.boolean().default(false) }));
    expect(schema.properties['solid']).toEqual({ kind: 'boolean', title: 'Solid' });
    expect(schema.properties['soft']).toEqual({ kind: 'boolean', title: 'Soft', default: false });
    expect(schema.required).toEqual(['solid']);
  });

  it('refuses each shape the inspector cannot render, per field, with a showable reason', () => {
    const schema = zodToJsonSchema(
      z.object({
        nested: z.object({ x: z.number() }),
        list: z.array(z.number()),
        either: z.union([z.string(), z.number()]),
        mapping: z.record(z.string()),
        tuple: z.tuple([z.number(), z.string()]),
      }),
    );

    for (const key of ['nested', 'list', 'either', 'mapping', 'tuple']) {
      const found = schema.properties[key];
      expect(found?.kind, `${key} should be unsupported`).toBe('unsupported');
      if (found?.kind !== 'unsupported') continue;
      // The reason must name the field and say why, because it is shown verbatim.
      expect(found.reason).toContain(key);
      expect(found.reason).toMatch(/inspector has no field for/);
    }

    // Per field, not per prefab: the rest of the schema is still usable.
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toHaveLength(5);
  });

  it('treats a wrapper that does not change the field kind as the field itself', () => {
    const schema = zodToJsonSchema(
      z.object({ maybe: z.number().optional(), orNull: z.string().nullable(), caught: z.string().catch('') }),
    );
    expect(schema.properties['maybe']).toEqual({ kind: 'number', title: 'Maybe' });
    expect(schema.properties['orNull']).toEqual({ kind: 'string', title: 'Or Null' });
    expect(schema.properties['caught']).toEqual({ kind: 'string', title: 'Caught' });
    // Only a key that may be *absent* drops out of `required`. A nullable key
    // must still be supplied — it may be null, which is not the same thing.
    expect(schema.required).toEqual(['orNull']);
  });

  it('sets additionalProperties false for .strict() and true for passthrough', () => {
    expect(zodToJsonSchema(z.object({ a: z.string() }).strict()).additionalProperties).toBe(false);
    expect(zodToJsonSchema(z.object({ a: z.string() }).passthrough()).additionalProperties).toBe(true);
    // Zod's default strips unknown keys, which is not the same as accepting
    // them, so the form is told not to offer any.
    expect(zodToJsonSchema(z.object({ a: z.string() })).additionalProperties).toBe(true);
  });

  it('refuses a paramsSchema that is not an object', () => {
    expect(() => zodToJsonSchema(z.string())).toThrow(UnsupportedParamsSchemaError);
    expect(() => zodToJsonSchema(z.union([z.object({}), z.string()]))).toThrow(/not an object/);
  });

  it('refuses something that is not a Zod schema at all', () => {
    expect(() => zodToJsonSchema({} as unknown as z.ZodTypeAny)).toThrow(/not a Zod type/);
  });

  it('refuses a literal, which has no field kind either', () => {
    const schema = zodToJsonSchema(z.object({ mode: z.literal('only') }));
    expect(schema.properties['mode']?.kind).toBe('unsupported');
  });
});

// ── Isolation ────────────────────────────────────────────────────────────────

describe('summarizePrefab', () => {
  const good = {
    name: 'thing',
    description: 'A thing.',
    paramsSchema: z.object({ size: z.number().default(1) }),
    create: () => ({ object: {}, parts: {} }),
  };

  it('summarises a working prefab', () => {
    const result = summarizePrefab(good, '/p/thing.ts', STUB_THREE as never);
    expect('paramsJsonSchema' in result).toBe(true);
    expect(result.name).toBe('thing');
    expect(result.description).toBe('A thing.');
  });

  it('turns a create() that throws into a failure naming the message and the file', () => {
    const result = summarizePrefab(
      {
        name: 'boom',
        paramsSchema: z.object({}),
        create: () => {
          throw new Error('BoxGeometry is not a function');
        },
      },
      '/p/boom.ts',
      STUB_THREE as never,
    );
    expect('paramsJsonSchema' in result).toBe(false);
    if ('paramsJsonSchema' in result) return;
    expect(result.reason).toContain('BoxGeometry is not a function');
    expect(result.file).toBe('/p/boom.ts');
  });

  it('reports a create() that returns nothing usable', () => {
    const result = summarizePrefab(
      { name: 'nope', paramsSchema: z.object({}), create: () => null as never },
      '/p/nope.ts',
      STUB_THREE as never,
    );
    expect('paramsJsonSchema' in result).toBe(false);
    if ('paramsJsonSchema' in result) return;
    expect(result.reason).toMatch(/did not return an object with an `object` key/);
  });

  it('does not probe a prefab whose params are required', () => {
    // A prefab that needs a colour must not be failed by a probe that supplied
    // none. It is loaded; the viewer supplies params from scene.json.
    let called = false;
    const result = summarizePrefab(
      {
        name: 'needs-params',
        paramsSchema: z.object({ colour: z.string() }),
        create: () => {
          called = true;
          throw new Error('should not be called');
        },
      },
      '/p/needs.ts',
      STUB_THREE as never,
    );
    expect(called).toBe(false);
    expect('paramsJsonSchema' in result).toBe(true);
  });

  it('probes with the schema defaults applied, so the defaults are exercised', () => {
    let seen: unknown;
    summarizePrefab(
      {
        name: 'defaulted',
        paramsSchema: z.object({ size: z.number().default(3) }),
        create: (_three, params) => {
          seen = params;
          return { object: {}, parts: {} };
        },
      },
      '/p/d.ts',
      STUB_THREE as never,
    );
    expect(seen).toEqual({ size: 3 });
  });

  it('reports a paramsSchema the inspector cannot describe', () => {
    const result = summarizePrefab(
      { name: 'weird', paramsSchema: z.string() as never, create: () => ({ object: {}, parts: {} }) },
      '/p/weird.ts',
      STUB_THREE as never,
    );
    expect('paramsJsonSchema' in result).toBe(false);
    if ('paramsJsonSchema' in result) return;
    expect(result.reason).toMatch(/not an object/);
  });

  it('reports a prefab with no name, one with no create, and one with a bad description', () => {
    const unnamed = summarizePrefab({ name: '' } as never, '/p/x.ts', STUB_THREE as never);
    expect(unnamed.name).toBe('(unnamed)');

    const noCreate = summarizePrefab(
      { name: 'nocreate', paramsSchema: z.object({}) } as never,
      '/p/x.ts',
      STUB_THREE as never,
    );
    expect('paramsJsonSchema' in noCreate).toBe(false);
    if (!('paramsJsonSchema' in noCreate)) expect(noCreate.reason).toMatch(/no `create/);

    // An absent description becomes an empty string, not `undefined` — the
    // inspector renders a one-line summary and must not have to null-check.
    const noDescription = summarizePrefab(
      { name: 'nodesc', paramsSchema: z.object({}), create: () => ({ object: {}, parts: {} }) },
      '/p/x.ts',
      STUB_THREE as never,
    );
    expect(noDescription.description).toBe('');
  });
});

describe('isPrefabDefinition', () => {
  it('needs a name and a create, and nothing else', () => {
    expect(isPrefabDefinition({ name: 'a', create: () => {} })).toBe(true);
    expect(isPrefabDefinition({ name: 'a' })).toBe(false);
    expect(isPrefabDefinition({ create: () => {} })).toBe(false);
    expect(isPrefabDefinition(null)).toBe(false);
    expect(isPrefabDefinition('cube')).toBe(false);
  });
});

describe('describeError', () => {
  it('keeps the message and a few frames of the stack', () => {
    const text = describeError(new Error('kaboom'));
    expect(text).toContain('kaboom');
    expect(text.length).toBeGreaterThan('kaboom'.length);
  });

  it('handles a thrown non-Error', () => {
    expect(describeError('just a string')).toBe('just a string');
    expect(describeError({ nope: true })).toBe('[object Object]');
  });
});

// ── Loading a real project ───────────────────────────────────────────────────

describe('loadPrefabRegistry', () => {
  it('loads the generated project, with the description the template declares', async () => {
    const result = await loadPrefabRegistry(makeProject());
    expect(result.failed).toEqual([]);
    expect(result.prefabs.map((p) => p.name)).toEqual(['cube']);
    const cube = byName(result.prefabs).get('cube');
    expect(cube?.description).toBe('A box. The default building block.');
    expect(cube?.paramsJsonSchema.additionalProperties).toBe(false);
  });

  it('reports a missing prefabs directory instead of throwing', async () => {
    const result = await loadPrefabRegistry(root);
    expect(result.prefabs).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toMatch(/no prefabs directory/);
    expect(result.failed[0]?.file).toMatch(/prefabs$/);
  });

  it('reports a prefabs directory with no index.ts', async () => {
    makeProject();
    rmSync(join(root, 'prefabs', 'index.ts'));
    const result = await loadPrefabRegistry(root);
    expect(result.prefabs).toEqual([]);
    expect(result.failed[0]?.reason).toMatch(/no registry at/);
  });

  it('reports a registry module that exports no registry, and still finds the prefabs', async () => {
    // The barrel is gone but the files are not, so the per-file recovery finds
    // the cube. An error screen with no way back would be the wrong answer.
    makeProject();
    writeFileSync(join(root, 'prefabs', 'index.ts'), 'export const nothing = 1;\n', 'utf-8');
    const result = await loadPrefabRegistry(root);
    expect(result.prefabs.map((p) => p.name)).toEqual(['cube']);
    expect(result.failed[0]?.reason).toMatch(/exports no `registry` object/);
  });

  it('reports a registry entry that is not a prefab definition', async () => {
    makeProject();
    const indexPath = join(root, 'prefabs', 'index.ts');
    writeFileSync(
      indexPath,
      readFileSync(indexPath, 'utf-8').replace('prefabs: [cube],', 'prefabs: [cube, { name: "not-real" }],'),
      'utf-8',
    );
    const result = await loadPrefabRegistry(root);
    expect(byName(result.prefabs).has('cube')).toBe(true);
    const bad = result.failed.find((f) => f.name === 'not-real');
    expect(bad?.reason).toMatch(/not a prefab definition/);
  });

  it('reports a duplicate name as a failure rather than silently picking one', async () => {
    makeProject();
    addPrefab(
      'twin.ts',
      [
        "import { z } from 'zod';",
        'export const paramsSchema = z.object({});',
        'export const twin = {',
        "  name: 'cube',",
        "  description: 'The impostor.',",
        '  paramsSchema,',
        '  create: () => ({ object: {}, parts: {} }),',
        '};',
      ].join('\n'),
    );
    const result = await loadPrefabRegistry(root);
    const cubes = result.prefabs.filter((p) => p.name === 'cube');
    expect(cubes).toHaveLength(1);
    expect(cubes[0]?.description).not.toBe('The impostor.');
    expect(result.failed.some((f) => f.reason.includes('duplicate prefab name'))).toBe(true);
  });

  it('loads each prefab of a multi-prefab project', async () => {
    const project = makeProject();
    for (const name of ['rock', 'crate', 'lamp']) addPrefab(`${name}.ts`, boxPrefab(name));
    const result = await loadPrefabRegistry(project);
    expect(result.failed).toEqual([]);
    expect(result.prefabs.map((p) => p.name).sort()).toEqual(['crate', 'cube', 'lamp', 'rock']);
  });
});

// ── Isolation: a prefab that throws ──────────────────────────────────────────

describe('a prefab that throws', () => {
  it('is reported without taking the barrel down with it', async () => {
    const project = makeProject();
    addPrefab(
      'broken.ts',
      [
        "import { z } from 'zod';",
        'export const paramsSchema = z.object({});',
        "throw new Error('this prefab file explodes at module scope');",
      ].join('\n'),
    );
    const result = await loadPrefabRegistry(project);

    // The cube survived, because the fallback loaded the files one at a time.
    expect(byName(result.prefabs).has('cube')).toBe(true);
    const broken = result.failed.find((f) => f.file.endsWith('broken.ts'));
    expect(broken?.reason).toContain('explodes at module scope');
    expect(broken?.name).toBe('broken');
  });

  it('is reported when only its create() throws, and the barrel still loads', async () => {
    const project = makeProject();
    addPrefab(
      'sphere.ts',
      [
        "import { z } from 'zod';",
        'export const paramsSchema = z.object({ r: z.number().default(1) });',
        'export const sphere = {',
        "  name: 'sphere',",
        "  description: 'A ball.',",
        '  paramsSchema,',
        // A constructor that does not exist: the shape a half-finished prefab
        // written by an AI actually has. It throws only when the loader
        // smoke-tests the prefab, which is the isolation path under test.
        "  create: (three) => ({ object: new three.NoSuchGeometry(1), parts: {} }),",
        '};',
      ].join('\n'),
    );
    const result = await loadPrefabRegistry(project);

    // No fallback needed: the module evaluated, one `create` was bad.
    expect(byName(result.prefabs).has('cube')).toBe(true);
    const sphere = result.failed.find((f) => f.name === 'sphere');
    expect(sphere?.reason).toMatch(/not a constructor/);
    expect(sphere?.file).toMatch(/index\.ts$/);
  });

  it('leaves eleven working prefabs out of twelve when one file explodes', async () => {
    const project = makeProject();
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
      addPrefab(`${name}.ts`, boxPrefab(name));
    }
    // Registered, so the throw is reached *through the barrel* — the normal
    // case, where one bad file takes the whole registry with it. The per-file
    // recovery is what keeps this to one loss instead of eleven.
    addPrefab('bad.ts', "throw new Error('nope');\n");

    const result = await loadPrefabRegistry(project);
    expect(result.prefabs).toHaveLength(11);
    expect(result.prefabs.map((p) => p.name).sort()).toEqual(
      ['a', 'b', 'c', 'cube', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].sort(),
    );
    // Both the barrel's failure and the recovered per-file one are reported.
    expect(result.failed.some((f) => f.file.endsWith('index.ts'))).toBe(true);
    expect(result.failed.some((f) => f.file.endsWith('bad.ts'))).toBe(true);
  });

  it('reports a file with a syntax error without losing the good prefabs', async () => {
    const project = makeProject();
    addPrefab('syntax.ts', 'export const = ;;;(\n');
    const result = await loadPrefabRegistry(project);
    expect(byName(result.prefabs).has('cube')).toBe(true);
    expect(result.failed.some((f) => f.file.endsWith('syntax.ts'))).toBe(true);
  });

  it('reports a prefabDir that does not exist, when one is passed explicitly', async () => {
    makeProject();
    const result = await loadPrefabRegistry(root, { prefabDir: join(root, 'nowhere') });
    expect(result.prefabs).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toMatch(/no prefabs directory/);
  });
});

// ── Bundling ─────────────────────────────────────────────────────────────────

describe('bundleEntry', () => {
  it('keeps three external and rewrites third-party specifiers to absolute URLs', async () => {
    const project = makeProject();
    writeFileSync(
      join(project, 'prefabs', 'usesthree.ts'),
      [
        "import { BoxGeometry } from 'three';",
        "import { z } from 'zod';",
        'export const paramsSchema = z.object({});',
        'export const usesthree = {',
        "  name: 'usesthree',",
        "  description: 'Imports three directly.',",
        '  paramsSchema,',
        '  create: () => ({ object: new BoxGeometry(1, 1, 1), parts: {} }),',
        '};',
      ].join('\n'),
      'utf-8',
    );

    const bundle = await bundleEntry(join(project, 'prefabs', 'usesthree.ts'), project);
    try {
      const code = readFileSync(bundle.handle.file, 'utf-8');
      const specifiers = [...code.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1] ?? '');

      // `three` stays bare on purpose: a temp path to it would be a *second*
      // Three.js, whose classes are not identical to the app's.
      expect(specifiers).toContain('three');
      // `zod` is rewritten, because a bare specifier in a temp directory with no
      // `node_modules` above it fails at import time.
      const zod = specifiers.find((s) => s.includes('zod'));
      expect(zod).toBeDefined();
      expect(zod).toMatch(/^file:\/\/.*zod/);

      // Nothing Three.js-sized was inlined: 200KB is a very loose ceiling that
      // a megabyte of Three.js cannot hide under.
      expect(code.length).toBeLessThan(200_000);
      expect(existsSync(bundle.handle.file)).toBe(true);
    } finally {
      bundle.handle.dispose();
    }
  });

  it('leaves no bare third-party specifier in the index bundle', async () => {
    const project = makeProject();
    const bundle = await bundleEntry(join(project, 'prefabs', 'index.ts'), project);
    try {
      const code = readFileSync(bundle.handle.file, 'utf-8');
      const specifiers = [...code.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1] ?? '');
      for (const specifier of specifiers) {
        expect(
          specifier === 'three' || specifier.startsWith('file://') || specifier.startsWith('node:'),
          `"${specifier}" was left bare in a temp-directory bundle`,
        ).toBe(true);
      }
    } finally {
      bundle.handle.dispose();
    }
  });

  it('writes a bundle Node can import, and removes its temp directory on dispose', async () => {
    const project = makeProject();
    const bundle = await bundleEntry(join(project, 'prefabs', 'cube.ts'), project);
    const dir = bundle.handle.file.slice(0, bundle.handle.file.lastIndexOf('/'));
    expect(existsSync(bundle.handle.file)).toBe(true);
    expect(existsSync(dir)).toBe(true);

    bundle.handle.dispose();
    expect(existsSync(dir)).toBe(false);
    // Idempotent: the caller's `finally` must not throw.
    expect(() => bundle.handle.dispose()).not.toThrow();
  });

  it('gives two bundles two different temp directories', async () => {
    const project = makeProject();
    const first = await bundleEntry(join(project, 'prefabs', 'cube.ts'), project);
    const second = await bundleEntry(join(project, 'prefabs', 'cube.ts'), project);
    try {
      expect(first.handle.file).not.toBe(second.handle.file);
    } finally {
      first.handle.dispose();
      second.handle.dispose();
    }
  });

  it('rejects on a syntax error rather than writing a broken bundle', async () => {
    const project = makeProject();
    writeFileSync(join(project, 'prefabs', 'syntax.ts'), 'export const = ;;;(\n', 'utf-8');
    await expect(bundleEntry(join(project, 'prefabs', 'syntax.ts'), project)).rejects.toThrow();
  });
});

describe('prefabSourceFiles', () => {
  it('lists every .ts except the index, sorted, and nothing for a missing directory', () => {
    makeProject();
    writeFileSync(join(root, 'prefabs', 'zeta.ts'), '', 'utf-8');
    writeFileSync(join(root, 'prefabs', 'alpha.ts'), '', 'utf-8');
    writeFileSync(join(root, 'prefabs', 'types.d.ts'), '', 'utf-8');

    const files = prefabSourceFiles(join(root, 'prefabs')).map((f) => f.split('/').pop());
    expect(files).toEqual(['alpha.ts', 'cube.ts', 'zeta.ts']);
    expect(prefabSourceFiles(join(root, 'absent'))).toEqual([]);
  });

  it('ignores subdirectories, which are not prefab files', () => {
    makeProject();
    // A directory that happens to be named `*.ts` is not a prefab file.
    mkdirSync(join(root, 'prefabs', 'nested.ts'), { recursive: true });
    const files = prefabSourceFiles(join(root, 'prefabs')).map((f) => f.split('/').pop());
    expect(files).toEqual(['cube.ts']);
  });
});

// ── Watching ─────────────────────────────────────────────────────────────────

describe('createPrefabLoader', () => {
  it('has no registry before the first load, and dispose is idempotent', () => {
    makeProject();
    const loader = createPrefabLoader(root, { debounceMs: 10 });
    expect(loader.current()).toBeNull();
    expect(loader.projectRoot).toBe(root);
    loader.dispose();
    expect(() => loader.dispose()).not.toThrow();
  });

  it('reloads on demand and keeps the result for current()', async () => {
    const project = makeProject();
    const loader = createPrefabLoader(project, { debounceMs: 10 });
    try {
      const result = await loader.reload();
      expect(result.prefabs.map((p) => p.name)).toEqual(['cube']);
      expect(loader.current()?.prefabs).toHaveLength(1);
    } finally {
      loader.dispose();
    }
  });

  it('rebuilds and notifies when a prefab file changes', async () => {
    const project = makeProject();
    const notified: string[][] = [];
    const loader = createPrefabLoader(project, {
      debounceMs: 20,
      onChanged: (registry) => notified.push(registry.prefabs.map((p) => p.name).sort()),
    });
    try {
      addPrefab('newone.ts', boxPrefab('newone', 'Added mid-session.'));

      await waitFor(() => notified.length > 0, 15_000, 'the watcher to fire');
      expect(notified[0]).toEqual(['cube', 'newone']);
      expect(loader.current()?.prefabs.map((p) => p.name).sort()).toEqual(['cube', 'newone']);
    } finally {
      loader.dispose();
    }
  });

  it('picks up a prefabs directory that did not exist yet', async () => {
    // The fresh-project case: nothing to watch, so the project root is watched
    // instead and creating `prefabs/` must start working with no restart.
    const notified: number[] = [];
    const loader = createPrefabLoader(root, {
      debounceMs: 20,
      onChanged: (registry) => notified.push(registry.prefabs.length),
    });
    try {
      makeProject();
      await waitFor(() => notified.length > 0, 15_000, 'the watcher to notice prefabs/');
      expect(notified[0]).toBe(1);
    } finally {
      loader.dispose();
    }
  });

  it('stops notifying after dispose', async () => {
    const project = makeProject();
    let calls = 0;
    const loader = createPrefabLoader(project, { debounceMs: 20, onChanged: () => calls++ });
    loader.dispose();
    addPrefab('late.ts', boxPrefab('late'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls).toBe(0);
  });
});

describe('WATCH_DEBOUNCE_MS', () => {
  it('is the 150ms the task calls for', () => {
    expect(WATCH_DEBOUNCE_MS).toBe(150);
  });
});

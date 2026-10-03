/**
 * context/brief.test.ts — the brief generator.
 *
 * Six properties are asserted here, and each one exists because breaking it makes
 * the brief worse than having none:
 *
 *  - **nothing is hand-written** — every signature in the brief is a string the
 *    extractors produced, so renaming a function and regenerating changes the
 *    brief, and a brief naming a symbol that does not exist cannot pass;
 *  - **it is deterministic** (SPEC R8) — the same project twice is byte-identical,
 *    with no timestamp leaking in when `now` is not injected;
 *  - **the two modes differ for exactly one reason** — one-shot carries the task,
 *    interactive carries the `NEED:` instruction, and neither carries the other;
 *  - **it writes only inside the project** — `.contextforge/brief.md`, created on
 *    demand, and refused for a target that escapes the root;
 *  - **refuse rather than guess** (SPEC R9/R6) — an invalid request, a missing
 *    scene and a broken scene each produce a specific message, never a fabricated
 *    scene description;
 *  - **it is callable without the GUI** (SPEC R10) — `buildBriefMarkdown` returns
 *    the markdown and writes nothing, which is what a CLI entry point calls.
 *
 * Headless throughout: temp folders, no Electron, no DOM (SPEC R2/R3).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

import {
  BRIEF_MODES,
  BRIEF_PATH,
  briefModeFrom,
  buildBriefMarkdown,
  generateBrief,
  readBrief,
  validateBriefRequest,
  writeBrief,
  type BriefMode,
} from '../../src/context/brief.js';
import { extractJsProject } from '../../src/extract/js.js';
import { buildManifest } from '../../src/graph/manifest.js';
import { strictPatchContract } from '../../src/context/compiler.js';
import { PREFAB_RULES, PREFAB_RULE_REASONS } from '../../src/scene/lint.js';

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'cf-brief-'));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

/** Write a file into the fixture project, creating directories. */
function write(relativePath: string, contents: string): void {
  const absolute = join(project, relativePath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, contents, 'utf-8');
}

const TRACK_JS = `import { buildMesh } from './mesh.js';

const TRACK_LENGTH = 100;

export function loadTrack(name) {
  const segments = buildMesh(name);
  return { name, segments, length: TRACK_LENGTH };
}
`;

const MESH_JS = `export function buildMesh(name) {
  return { name, geometry: 'box' };
}
`;

const PREFAB_TS = `import { z } from 'zod';
import type { PrefabDefinition, PrefabParams, Rng, ThreeModule } from '@contextforge/core';

export const paramsSchema = z.object({ size: z.number().positive() }).strict();

export function create(
  _three: ThreeModule,
  _params: PrefabParams,
  _rng: Rng,
): { object: unknown; parts: Record<string, unknown> } {
  return { object: null, parts: {} };
}

export const crate: PrefabDefinition = {
  name: 'crate',
  description: 'A wooden crate.',
  paramsSchema,
  create,
};
`;

/** A minimal valid scene, written through the same JSON the editor would write. */
const SCENE_JSON = {
  version: 1,
  name: 'Level1',
  engine: 'three',
  seed: 4242,
  instances: [
    {
      id: 'floor',
      prefab: 'crate',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      params: { size: 1 },
    },
    {
      id: 'marker',
      prefab: 'crate',
      transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      params: { size: 2 },
    },
  ],
  lights: [{ id: 'sun', kind: 'directional', color: '#ffffff', intensity: 1 }],
  camera: { kind: 'perspective', position: [0, 5, 10], rotation: [-0.3, 0, 0], fov: 60, near: 0.1, far: 1000 },
};

/** A Three.js-shaped fixture project, the same shape the demo project has. */
function scaffold(): void {
  write('index.html', '<html><body><script type="module" src="./src/main.js"></script></body></html>\n');
  write('src/main.js', "import { loadTrack } from './track.js';\n\nexport function main() {\n  return loadTrack('one');\n}\n");
  write('src/track.js', TRACK_JS);
  write('src/mesh.js', MESH_JS);
  write('prefabs/crate.ts', PREFAB_TS);
  write('prefabs/index.ts', "import type { PrefabRegistry } from '@contextforge/core';\nimport { crate } from './crate.js';\n\nexport const registry: PrefabRegistry = { prefabs: [crate] };\n");
  write('scene.json', `${JSON.stringify(SCENE_JSON, null, 2)}\n`);
  write(
    'package.json',
    `${JSON.stringify({ name: 'fixture', private: true, type: 'module', dependencies: { three: '0.180.0' }, devDependencies: { vite: '^5' } }, null, 2)}\n`,
  );
}

// ── The IPC contract, pinned ─────────────────────────────────────────────────

/**
 * `ipc.ts` is not importable from core (SPEC R4), so the brief's own types are
 * checked against a structural copy of the contract here. A change to either
 * side without the other fails this file instead of drifting silently — the same
 * convention `integration/step3.e2e.test.ts` uses.
 */
interface BriefResultContract {
  path: string;
  markdown: string;
  mode: 'oneShot' | 'interactive';
  stats: { nodes: number; edges: number; prefabs: number; instances: number };
}

type ResultContract<T> = { ok: true; value: T } | { ok: false; reason: string };

describe('the brief contract matches the one ipc.ts declares', () => {
  it('satisfies the pinned BriefResult shape', () => {
    scaffold();
    const result = generateBrief({ projectRoot: project, mode: 'oneShot' });

    const contract: BriefResultContract = {
      path: result.path,
      markdown: result.markdown,
      mode: result.mode,
      stats: result.stats,
    };

    expect(contract.path).toBe('.contextforge/brief.md');
    expect(typeof contract.markdown).toBe('string');
    expect(contract.mode).toBe('oneShot');
    expect(Object.keys(contract.stats).sort()).toEqual(['edges', 'instances', 'nodes', 'prefabs']);
    for (const value of Object.values(contract.stats)) expect(Number.isInteger(value)).toBe(true);
  });

  it('declares exactly the two modes the contract names, in order', () => {
    expect(BRIEF_MODES).toEqual(['oneShot', 'interactive']);
  });
});

// ── R6: validate the request at the boundary ─────────────────────────────────

describe('validating the brief request', () => {
  it('accepts both modes and an optional task', () => {
    expect(validateBriefRequest({ mode: 'oneShot', task: 'fix the crate' })).toEqual({
      ok: true,
      value: { mode: 'oneShot', task: 'fix the crate' },
    });
    expect(validateBriefRequest({ mode: 'interactive' })).toEqual({
      ok: true,
      value: { mode: 'interactive' },
    });
  });

  it('refuses an unknown mode, naming the field and what was expected', () => {
    const bad = validateBriefRequest({ mode: 'oneshot' });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('unreachable');

    const result: ResultContract<unknown> = bad;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('mode');
    expect(result.reason).toContain('"oneShot"');
    expect(result.reason).toContain('"interactive"');
  });

  it('refuses an unknown key rather than dropping it', () => {
    const bad = validateBriefRequest({ mode: 'oneShot', timestamp: 12345 });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('unreachable');
    expect(bad.reason).toContain('no brief was written');
  });

  it('refuses a task that is not a string, and one that is absurdly long', () => {
    expect(validateBriefRequest({ mode: 'oneShot', task: 42 }).ok).toBe(false);
    expect(validateBriefRequest({ mode: 'oneShot', task: 'x'.repeat(5000) }).ok).toBe(false);
  });

  it('refuses a null request rather than defaulting it to one-shot', () => {
    const bad = validateBriefRequest(null);
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('unreachable');
    expect(bad.reason.length).toBeGreaterThan(0);
  });
});

// ── Nothing is hand-written ──────────────────────────────────────────────────

describe('the brief contains only what the graph says', () => {
  beforeEach(scaffold);

  it('carries real signatures, byte-identical to the extracted contract', () => {
    const { markdown } = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot' });
    const graph = extractJsProject(project);

    const exportsOf = (id: string): string[] =>
      graph.nodes.find((n) => n.id === id)?.contract.exports ?? [];

    const track = exportsOf('src/track.js');
    expect(track.length).toBeGreaterThan(0);
    for (const signature of track) {
      expect(markdown).toContain(signature);
    }
    expect(markdown).toContain('function loadTrack(name)');
    expect(markdown).toContain('function buildMesh(name)');

    // A name that does not exist anywhere in the project must not appear as a
    // signature. This is the assertion that would fail if anyone hand-typed the
    // signature section.
    expect(markdown).not.toContain('function loadLevel(');
  });

  it('counts nodes and edges exactly as the extractor does', () => {
    const { markdown, stats } = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot' });
    const manifest = buildManifest(project, extractJsProject(project), '');

    expect(stats.nodes).toBe(manifest.nodes.length);
    expect(stats.edges).toBe(manifest.edges.length);
    expect(markdown).toContain(`- Nodes: ${manifest.nodes.length}`);
    expect(markdown).toContain(`- Edges: ${manifest.edges.length}`);
  });

  it('reads declared dependencies from package.json, not from import text', () => {
    const { markdown } = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot' });
    expect(markdown).toContain('- Declared npm dependencies: three');
    expect(markdown).toContain('- Declared npm devDependencies: vite');

    // `zod` is imported by the prefab and is not in package.json. Listing it as
    // a declared dependency would be the brief guessing.
    expect(markdown).not.toContain('Declared npm dependencies: three, zod');
  });

  it('states the prefab lint rules with the linter\'s own reasons', () => {
    const { markdown } = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot' });
    for (const rule of PREFAB_RULES) {
      expect(markdown).toContain(`\`${rule}\``);
      expect(markdown).toContain(PREFAB_RULE_REASONS[rule]);
    }
  });

  it('embeds the patch contract verbatim', () => {
    const { markdown } = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot' });
    // The exact contract string, so the two cannot drift: the brief and the
    // prompt the compiler builds must teach the same format.
    expect(markdown).toContain(strictPatchContract());
    expect(markdown).toContain('### EDIT: relative/path.ext');
    expect(markdown).toContain('### FILE: relative/path.ext');
  });

  it('reports the scene as read from disk, with its own numbers', () => {
    const { markdown, stats } = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot' });
    expect(stats.instances).toBe(2);
    expect(markdown).toContain('`GrandPrix_Circuit`'.replace('GrandPrix_Circuit', 'Level1'));
    expect(markdown).toContain('seed `4242`');
    expect(markdown).toContain('crate (2)');
  });

  it('counts prefab modules from the graph and excludes the registry index', () => {
    const { stats } = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot' });
    expect(stats.prefabs).toBe(1);
  });

  it('lists the build order layer by layer, entrypoint last', () => {
    const { markdown } = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot' });

    // Only the graph section's layers are inspected: the folder map mentions the
    // same paths earlier in the document, and matching the first occurrence would
    // assert the ordering of a table, not of the dependency graph.
    const layers = markdown.slice(markdown.indexOf('## Graph summary'), markdown.indexOf('## Public signatures'));
    expect(layers).toContain('**Layer 0**');

    const position = (id: string): number => layers.indexOf(`\`${id}\``);
    // index.html loads src/main.js, which loads track.js, which loads mesh.js —
    // so each sits strictly above the one it depends on.
    expect(position('src/mesh.js')).toBeGreaterThan(-1);
    expect(position('src/track.js')).toBeGreaterThan(position('src/mesh.js'));
    expect(position('src/main.js')).toBeGreaterThan(position('src/track.js'));
    expect(position('index.html')).toBeGreaterThan(position('src/main.js'));
  });

  it('maps every folder the graph holds, and nothing it does not', () => {
    const { markdown } = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot' });
    expect(markdown).toContain('`src/`');
    expect(markdown).toContain('`prefabs/`');
    expect(markdown).toContain('`(project root)/`');
    expect(markdown).not.toContain('`node_modules/`');
  });
});

// ── R8: determinism ──────────────────────────────────────────────────────────

describe('determinism', () => {
  beforeEach(scaffold);

  it('produces byte-identical markdown for the same project and options', () => {
    const first = buildBriefMarkdown({
      projectRoot: project,
      mode: 'oneShot',
      task: 'make the crate explode',
    });
    const second = buildBriefMarkdown({
      projectRoot: project,
      mode: 'oneShot',
      task: 'make the crate explode',
    });
    expect(second.markdown).toBe(first.markdown);
    expect(second.stats).toEqual(first.stats);
  });

  it('omits the timestamp entirely when none is injected', () => {
    const { markdown } = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot' });
    expect(markdown).not.toContain('Generated:');
    // A year-shaped run of digits would be the leak R8 is about.
    expect(markdown).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('prints the timestamp only when one was injected, and then the same one', () => {
    const stamp = '2020-05-05T05:05:05.000Z';
    const a = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot', generatedAt: stamp });
    const b = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot', generatedAt: stamp });

    expect(a.markdown).toContain(`- Generated: ${stamp}`);
    expect(b.markdown).toBe(a.markdown);
  });

  it('writes the same bytes to disk on a second run', () => {
    generateBrief({ projectRoot: project, mode: 'oneShot', task: 'same' });
    const first = readFileSync(join(project, '.contextforge', 'brief.md'), 'utf-8');
    generateBrief({ projectRoot: project, mode: 'oneShot', task: 'same' });
    expect(readFileSync(join(project, '.contextforge', 'brief.md'), 'utf-8')).toBe(first);
  });
});

// ── The two modes ────────────────────────────────────────────────────────────

describe('the two modes', () => {
  beforeEach(scaffold);

  it('one-shot carries the task verbatim and no NEED instruction', () => {
    const { markdown } = buildBriefMarkdown({
      projectRoot: project,
      mode: 'oneShot',
      task: 'Replace the crate model with a barrel',
    });
    expect(markdown).toContain("## The developer's task");
    expect(markdown).toContain('Replace the crate model with a barrel');
    expect(markdown).not.toContain('NEED:');
    expect(markdown).not.toContain('Ask back for anything missing');
  });

  it('interactive carries the NEED instruction and no task', () => {
    const { markdown } = buildBriefMarkdown({
      projectRoot: project,
      mode: 'interactive',
      task: 'this text must not appear as a task',
    });
    expect(markdown).toContain('Ask back for anything missing');
    expect(markdown).toContain('NEED: <path relative to the project root> — <what you need from it>');
    expect(markdown).not.toContain("## The developer's task");
    expect(markdown).not.toContain('this text must not appear as a task');
  });

  it('differs between the modes only in that section and the mode line', () => {
    const one = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot', task: 'the task' });
    const two = buildBriefMarkdown({ projectRoot: project, mode: 'interactive', task: 'the task' });

    const strip = (md: string): string[] =>
      md
        .split('\n')
        .filter((line) => !line.startsWith('<!-- contextforge:brief mode='))
        .filter((line) => !line.startsWith('- Mode:'));

    const a = strip(one.markdown);
    const b = strip(two.markdown);

    // Everything after the task section is identical: the stack, the folder map,
    // the graph, the signatures, the rules and the patch contract do not depend
    // on the mode. If one of them did, "the mode" would be doing two jobs.
    const signatureStart = a.findIndex((line) => line === '## The stack');
    const signatureStartB = b.findIndex((line) => line === '## The stack');
    expect(signatureStart).toBeGreaterThan(-1);
    expect(a.slice(signatureStart)).toEqual(b.slice(signatureStartB));
  });

  it('does not rank files against a task in interactive mode', () => {
    const { markdown } = buildBriefMarkdown({
      projectRoot: project,
      mode: 'interactive',
      task: 'hazard crate',
    });
    expect(markdown).not.toContain('Ranked against your task');
  });

  it('ranks files against the task in one-shot mode, using core\'s ranker', () => {
    const { markdown } = buildBriefMarkdown({
      projectRoot: project,
      mode: 'oneShot',
      task: 'Fix buildMesh in the track',
    });
    expect(markdown).toContain('Ranked against your task');
    expect(markdown).toContain('`src/mesh.js`');
  });

  it('says so when a one-shot brief was asked for with no task', () => {
    const { markdown } = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot' });
    expect(markdown).toContain('No task was given with this brief');
  });

  it('survives a task containing a markdown fence', () => {
    const { markdown } = buildBriefMarkdown({
      projectRoot: project,
      mode: 'oneShot',
      task: 'fix this:\n```js\nconst x = 1;\n```',
    });
    // The fence is broken so the task cannot end the surrounding block early.
    expect(markdown).toContain('``\u200b`');
  });
});

// ── The mode marker ──────────────────────────────────────────────────────────

describe('the mode marker', () => {
  beforeEach(scaffold);

  it('round-trips the mode through the file for both modes', () => {
    for (const mode of BRIEF_MODES) {
      generateBrief({ projectRoot: project, mode });
      const read = readBrief(project);
      expect(read?.mode).toBe(mode);
      expect(read?.path).toBe(BRIEF_PATH);
    }
  });

  it('keeps the marker on line one and out of the rendered body', () => {
    const { markdown } = buildBriefMarkdown({ projectRoot: project, mode: 'interactive' });
    expect(markdown.split('\n')[0]).toBe('<!-- contextforge:brief mode=interactive -->');
    expect(briefModeFrom(markdown)).toBe('interactive');
  });

  it('falls back to one-shot for a file with no marker, rather than inventing a mode', () => {
    expect(briefModeFrom('# just some notes\n')).toBe('oneShot');
    expect(briefModeFrom('<!-- contextforge:brief mode=nonsense -->')).toBe('oneShot');
  });
});

// ── Writing ──────────────────────────────────────────────────────────────────

describe('writing the brief', () => {
  beforeEach(scaffold);

  it('creates .contextforge/ and writes brief.md inside it', () => {
    expect(existsSync(join(project, '.contextforge'))).toBe(false);

    const result = generateBrief({ projectRoot: project, mode: 'oneShot' });
    expect(result.path).toBe(BRIEF_PATH);
    expect(existsSync(join(project, '.contextforge', 'brief.md'))).toBe(true);
    expect(readFileSync(join(project, '.contextforge', 'brief.md'), 'utf-8')).toBe(result.markdown);
  });

  it('works when the directory already exists', () => {
    mkdirSync(join(project, '.contextforge'), { recursive: true });
    expect(() => generateBrief({ projectRoot: project, mode: 'oneShot' })).not.toThrow();
    expect(readBrief(project)?.markdown.length).toBeGreaterThan(0);
  });

  it('writes nothing outside the project', () => {
    generateBrief({ projectRoot: project, mode: 'oneShot' });

    const created = readdirSync(project).sort();
    expect(created).toContain('.contextforge');

    // Nothing was written beside the fixture, and the brief is the only file
    // under .contextforge — no stray state file, no lock, no index.
    expect(readdirSync(join(project, '.contextforge')).sort()).toEqual(['brief.md']);
  });

  it('keeps the target inside the root however the root was written', () => {
    // The containment check is what stops a mistyped root from turning a brief
    // generator into a writer for somewhere else on disk. Every target is built
    // from `BRIEF_PATH`, which is a constant, so the only way to escape is a
    // root that resolves *outside itself* — and `resolve()` collapses that
    // before the check runs. So what is proved here is the two properties the
    // check rests on: the target is always inside the resolved root, and a root
    // given with a trailing separator or a `..` segment still writes inside
    // itself rather than beside it.
    const root = resolve(tmpdir());
    const target = resolve(root, ...BRIEF_PATH.split('/'));
    expect(target.startsWith(root.endsWith(sep) ? root : root + sep)).toBe(true);

    const nested = mkdtempSync(join(root, 'cf-brief-alt-'));
    try {
      for (const equivalent of [nested, `${nested}${sep}`, join(nested, '..', 'cf-brief-alt-')]) {
        expect(writeBrief(equivalent, 'hello')).toBe(BRIEF_PATH);
        expect(readFileSync(join(nested, '.contextforge', 'brief.md'), 'utf-8')).toBe('hello');
      }
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('returns null from readBrief when nothing has been generated', () => {
    expect(readBrief(project)).toBeNull();
  });

  it('returns the file it wrote, not a regenerated one', () => {
    const written = generateBrief({ projectRoot: project, mode: 'oneShot', task: 'as written' });
    // A later edit to the project must not change what readBrief reports.
    write('src/mesh.js', `${MESH_JS}\nexport function addedLater() { return 1; }\n`);
    const read = readBrief(project);
    expect(read?.markdown).toBe(written.markdown);
    expect(read?.markdown).not.toContain('addedLater');
  });
});

// ── Refuse rather than guess ─────────────────────────────────────────────────

describe('refusing instead of guessing', () => {
  it('says so when there is no scene file, and reports zero instances', () => {
    write('src/track.js', TRACK_JS);
    const { markdown, stats } = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot' });

    expect(stats.instances).toBe(0);
    expect(markdown).toContain('There is no scene file at `scene.json`');
    expect(markdown).toContain('Treat the scene as');
    // The rest of the brief is still real.
    expect(markdown).toContain('function loadTrack(name)');
  });

  it('reports a broken scene with the reason, and describes no scene contents', () => {
    scaffold();
    write('scene.json', '{"version": 1, "instances": [\n');

    const { markdown, stats } = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot' });
    expect(stats.instances).toBe(0);
    expect(markdown).toContain('could not be read');
    expect(markdown).toContain('not valid JSON');
    // Crucially: it does not describe a scene it could not read.
    expect(markdown).not.toContain('This project\'s scene, as read from disk.');
    // And it still says what is true about the code.
    expect(markdown).toContain('function loadTrack(name)');
  });

  it('reports a scene that is valid JSON but invalid per the schema', () => {
    scaffold();
    const broken = { ...SCENE_JSON, instances: [{ ...SCENE_JSON.instances[0], transform: { position: [1, 2] } }] };
    write('scene.json', `${JSON.stringify(broken, null, 2)}\n`);

    const { markdown } = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot' });
    expect(markdown).toContain('could not be read');
    expect(markdown).toContain('position');
    expect(markdown).not.toContain('This project\'s scene, as read from disk.');
  });

  it('survives a package.json an AI truncated', () => {
    scaffold();
    write('package.json', '{"dependencies": {"three"');

    const { markdown } = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot' });
    expect(markdown).toContain('- Declared npm dependencies: (none)');
    expect(markdown).toContain('## The stack');
  });

  it('produces a brief for an empty folder rather than failing', () => {
    const { markdown, stats } = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot' });
    expect(stats.nodes).toBe(0);
    expect(stats.edges).toBe(0);
    expect(markdown).toContain('the graph is empty');
    expect(markdown).toContain('no file in the graph exports anything readable');
  });

  it('reports a dependency cycle instead of hiding it', () => {
    write('a.js', "import { b } from './b.js';\nexport function a() { return b(); }\n");
    write('b.js', "import { a } from './a.js';\nexport function b() { return a(); }\n");

    const { markdown } = buildBriefMarkdown({ projectRoot: project, mode: 'oneShot' });
    expect(markdown).toContain('Dependency cycle');
    expect(markdown).toContain('`a.js`');
    expect(markdown).toContain('`b.js`');
  });
});

// ── R10: callable without the GUI ────────────────────────────────────────────

describe('the callable surface', () => {
  beforeEach(scaffold);

  it('buildBriefMarkdown writes nothing at all', () => {
    const before = readdirSync(project).sort();
    buildBriefMarkdown({ projectRoot: project, mode: 'oneShot', task: 'preview only' });
    expect(readdirSync(project).sort()).toEqual(before);
    expect(existsSync(join(project, '.contextforge'))).toBe(false);
  });

  it('every exported function is reachable without an app or a renderer', async () => {
    const module = await import('../../src/context/brief.js');
    for (const name of [
      'buildBriefMarkdown',
      'briefModeFrom',
      'generateBrief',
      'readBrief',
      'validateBriefRequest',
      'writeBrief',
    ]) {
      expect(typeof module[name as keyof typeof module]).toBe('function');
    }
  });

  it('accepts an alternate scene path without re-implementing the search', () => {
    write('scenes/level1.scene.json', `${JSON.stringify({ ...SCENE_JSON, name: 'Dune' }, null, 2)}\n`);
    const { markdown, stats } = buildBriefMarkdown({
      projectRoot: project,
      mode: 'oneShot',
      scenePath: 'scenes/level1.scene.json',
    });
    expect(stats.instances).toBe(2);
    expect(markdown).toContain('`Dune`');
  });
});
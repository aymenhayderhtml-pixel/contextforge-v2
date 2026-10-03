/**
 * scene/template.ts — generate a new Three.js project from a filled-in brief.
 *
 * A template's job is to make the two rules true before any AI has written a
 * line, so that the AI's *first* edit already obeys them:
 *
 *  1. **Every object is a prefab.** There is no code path for placing something
 *     that is not a registered prefab, because there is no code path for
 *     placing something at all — placement only exists in `scene.json`.
 *  2. **All placement is in `scene.json`.** `loadScene.ts` reads the file and
 *     nothing else. An AI that wants to move a crate edits the JSON; there is
 *     no `main.ts` with hard-coded positions to find and forget.
 *
 * The generated `AI_RULES.md` states both, because an AI that does not read the
 * rules will not obey them, and a rule that only exists in a generator's
 * documentation is not a rule.
 *
 * The generator **refuses to run until the game idea is filled in**. A template
 * named "MyGame" with a placeholder idea produces a project that compiles, runs,
 * and teaches an AI nothing about what it is for — and the developer finds out
 * after an AI has built the wrong game in it. This is the same reasoning as
 * SPEC R9: refuse rather than produce a plausible-looking wrong thing.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SCENE_SCHEMA_VERSION, type SceneFile } from './scene.schema.js';
import { serializeScene } from './sceneFile.js';

/** What the developer must supply before a project can be generated. */
export interface GameBrief {
  /** Project folder name, e.g. "star-crawler". */
  name: string;
  /**
   * What the game is, in the developer's own words.
   *
   * Required and required to be *specific*. A vague idea produces a vague
   * project, and a vague project is one an AI will fill in with its own
   * assumptions — the exact context loss this app exists to prevent.
   */
  idea: string;
  /** Optional, defaults to a fixed seed so the first run is reproducible. */
  seed?: number;
}

/** The refusal raised when a brief is incomplete. */
export class IncompleteBriefError extends Error {
  /** Which fields are missing or unusable. */
  readonly missing: string[];

  constructor(missing: string[]) {
    super(
      `Cannot generate a project — the game brief is incomplete:\n` +
        missing.map((m) => `  - ${m}`).join('\n') +
        `\n\nA template generated from a half-filled brief teaches an AI nothing about\n` +
        `what the game is, and the developer only finds out after the AI has built\n` +
        `the wrong game in it. Fill these in and run again.`,
    );
    this.name = 'IncompleteBriefError';
    this.missing = missing;
  }
}

/** Shortest idea that counts as specific. Below this, assume it is a placeholder. */
const MIN_IDEA_LENGTH = 20;

/** Words that mean the idea was left as a placeholder rather than written. */
const PLACEHOLDER_IDEAS = new Set([
  'todo',
  'tbd',
  'fixme',
  'xxx',
  'placeholder',
  'lorem ipsum',
  'my game',
  'a game',
  'game idea',
  'describe your game here',
  'your game idea here',
]);

/**
 * Check a brief, returning the reasons it cannot be used.
 *
 * Exported so the UI (Step 4) can show the same list the CLI would, instead of
 * reimplementing the rules and drifting from them.
 */
export function checkBrief(brief: Partial<GameBrief>): string[] {
  const problems: string[] = [];

  const name = (brief.name ?? '').trim();
  if (name === '') {
    problems.push('`name` is required — the project folder name, e.g. "star-crawler"');
  } else if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    problems.push(
      `\`name\` must be a plain folder name (letters, digits, dot, dash, underscore) — got "${name}"`,
    );
  }

  const idea = (brief.idea ?? '').trim();
  if (idea === '') {
    problems.push(
      '`idea` is required — one or two sentences on what the game is and what the player does',
    );
  } else if (PLACEHOLDER_IDEAS.has(idea.toLowerCase())) {
    // Checked before length: "TODO" is rejected for *what it is*, and the
    // length message ("4 characters, need 20") would be a less useful answer
    // than "that is a placeholder".
    problems.push(`\`idea\` is a placeholder ("${idea}") — write what the game actually is`);
  } else if (idea.length < MIN_IDEA_LENGTH) {
    problems.push(
      `\`idea\` is too short to be useful (${idea.length} characters, need ${MIN_IDEA_LENGTH}) — ` +
        'describe what the player actually does, not just the genre',
    );
  }

  return problems;
}

/** The files a generated project contains, as project-relative paths. */
export interface GeneratedProject {
  /** Where it was written. */
  root: string;
  /** Every file written, in a stable order. */
  files: string[];
}

/**
 * Write a new project.
 *
 * Throws `IncompleteBriefError` rather than generating a template around a
 * missing idea.
 *
 * ## It refuses to write into a folder that already has any of its files
 *
 * The comment on this function used to claim that "existing files are never
 * overwritten", and **there was no check that made that true** —
 * `writeFileSync` ran unconditionally, so generating a second time over a folder
 * the developer had edited silently replaced `prefabs/cube.ts`, `scene.json` and
 * `AI_RULES.md` with the template. Phase 5e found this by running it, not by
 * reading it: the comment described the intended behaviour, the code did the
 * opposite, and nothing between the two said so.
 *
 * Silent data loss is the worst failure this function has, so the refusal is
 * total rather than per-file. A generator that skipped the files it found and
 * wrote the rest would leave the developer with a *half* template — some files
 * theirs, some the template's — which is harder to reason about than a clean
 * refusal and much harder to undo.
 *
 * Unrelated files in the folder are fine and untouched: only the six this
 * generator would write are checked, so pointing it at a folder that also holds
 * `src/` or a `node_modules/` is still refused only if one of *its* six is
 * present.
 */
export function generateProject(root: string, brief: Partial<GameBrief>): GeneratedProject {
  const problems = checkBrief(brief);
  if (problems.length > 0) throw new IncompleteBriefError(problems);

  const name = (brief.name as string).trim();
  const idea = (brief.idea as string).trim();
  const seed = brief.seed ?? 1337;

  const scene: SceneFile = {
    version: SCENE_SCHEMA_VERSION,
    name: 'Level1',
    engine: 'three',
    seed,
    instances: [
      {
        id: 'floor',
        prefab: 'cube',
        name: 'Floor',
        transform: {
          position: [0, -0.5, 0],
          rotation: [0, 0, 0],
          scale: [20, 1, 20],
        },
        params: { size: 1, colour: '#4a4a55' },
      },
      {
        id: 'marker',
        prefab: 'cube',
        name: 'Marker',
        transform: {
          position: [0, 0.5, 0],
          rotation: [0, 45, 0],
          scale: [1, 1, 1],
        },
        params: { size: 1, colour: '#4fc3f7' },
      },
    ],
    lights: [
      { id: 'ambient', kind: 'ambient', color: '#ffffff', intensity: 0.4 },
      {
        id: 'sun',
        kind: 'directional',
        color: '#ffffff',
        intensity: 1.2,
        position: [5, 10, 7],
        castShadow: true,
      },
    ],
    camera: {
      kind: 'perspective',
      position: [0, 6, 12],
      rotation: [-0.3, 0, 0],
      fov: 60,
      near: 0.1,
      far: 1000,
    },
  };

  const files: Array<[string, string]> = [
    ['scene.json', serializeScene(scene)],
    ['prefabs/cube.ts', cubePrefabSource()],
    ['prefabs/index.ts', prefabIndexSource()],
    ['loadScene.ts', loadSceneSource()],
    ['AI_RULES.md', aiRulesSource(name, idea)],
    ['README.md', readmeSource(name, idea)],
  ];

  const written: string[] = [];

  /**
   * The refusal, checked **before the first write**.
   *
   * Order matters as much as the check. Writing one file and then discovering a
   * second one exists would leave the developer with a partly-written template —
   * and the one file already replaced is the one they cannot get back.
   */
  const existing = files
    .map(([relativePath]) => relativePath)
    .filter((relativePath) => existsSync(join(root, relativePath)));
  if (existing.length > 0) {
    throw new Error(
      `Cannot generate a project in ${root} — it already contains ${existing.length} of the ` +
        `${files.length} file(s) this generator writes:\n` +
        existing.map((p) => `  - ${p}`).join('\n') +
        `\n\nGenerating again would overwrite them. Nothing has been written. If this is a\n` +
        `new project, pick an empty folder; if you meant to keep what is there, this\n` +
        `folder is already a project and you can just open it.`,
    );
  }

  for (const [relativePath, contents] of files) {
    const absolute = join(root, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, 'utf-8');
    written.push(relativePath);
  }

  return { root, files: written };
}

/** The one prefab a fresh project starts with. */
function cubePrefabSource(): string {
  return `/**
 * cube — the only prefab a new project starts with.
 *
 * Written to model the rules rather than to be clever. Every one of them is
 * load-bearing and each is checked by \`npm run lint:prefabs\`:
 *
 *  - \`three\` is a **parameter**. This file never imports Three.js, so it can
 *    be exercised headlessly with a stub.
 *  - \`rng\` is a **parameter**, and is seeded. A prefab that called
 *    \`Math.random()\` would make the scene non-reproducible, so the same
 *    \`scene.json\` would place objects differently on every load.
 *  - no \`this\`, no module-level \`let\`: two cubes in one scene would otherwise
 *    share state.
 *  - no \`scene.add()\`: this function returns the object and the caller puts it
 *    in the scene, so the same prefab can be placed any number of times.
 */

import { z } from 'zod';
import type { PrefabDefinition, PrefabParams, Rng, ThreeModule } from '@contextforge/core';

/** What this prefab accepts, validated at the boundary. */
export const paramsSchema = z
  .object({
    size: z.number().positive(),
    colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    /** 0 = no jitter, 1 = a full unit in every direction. */
    jitter: z.number().min(0).max(1).default(0),
  })
  .strict();

export function create(
  three: ThreeModule,
  params: PrefabParams,
  rng: Rng,
): { object: unknown; parts: Record<string, unknown> } {
  // Narrow the untyped params to what this prefab actually accepts. The scene
  // file is data; this is where it becomes something Three.js understands.
  const { size, colour, jitter } = paramsSchema.parse(params);

  const geometry = new three.BoxGeometry(size, size, size);
  const material = new three.MeshStandardMaterial({ color: colour });
  const mesh = new three.Mesh(geometry, material);

  // Seeded, so the same scene always produces the same jitter. A prefab with
  // randomness takes the rng; it never reaches for a global.
  if (jitter > 0) {
    mesh.position.x = rng.range(-jitter, jitter);
    mesh.position.y = rng.range(-jitter, jitter);
    mesh.position.z = rng.range(-jitter, jitter);
  }

  return { object: mesh, parts: { body: mesh } };
}

export const cube: PrefabDefinition = {
  name: 'cube',
  description: 'A box. The default building block.',
  paramsSchema,
  create,
};
`;
}

/** The registry a generated project exports. */
function prefabIndexSource(): string {
  return `/**
 * prefabs/index.ts — every prefab this project has.
 *
 * A scene may only reference a name listed here. That single rule is what makes
 * "all objects must be prefabs" true rather than aspirational: there is no way
 * to place something the registry does not know about, because \`scene.json\`
 * holds a name and the name is looked up here.
 *
 * To add a prefab: create \`prefabs/<name>.ts\` exporting a PrefabDefinition,
 * then add it to the list below.
 */

import type { PrefabRegistry } from '@contextforge/core';
import { cube } from './cube.js';

export const registry: PrefabRegistry = {
  prefabs: [cube],
};

export default registry;
`;
}

/** The loader. Note how little it does — that is the point. */
function loadSceneSource(): string {
  return `/**
 * loadScene.ts — turn \`scene.json\` into Three.js objects.
 *
 * This is the only place placement happens, and it contains no placements: it
 * reads positions, rotations and scales from the file. There is no hard-coded
 * position in this file to find, override, or forget about — which is the point.
 *
 * Edit \`scene.json\` to move anything. Do not add a position here.
 *
 * ## It runs on its own, in a browser
 *
 * \`scene.json\` is **fetched**, not read from disk: \`core.loadScene\` is a
 * Node function and a browser has no filesystem. The document is handed to
 * \`validateScene\`, which is core's own Zod check — the same one \`loadScene\`
 * calls once it has read the bytes.
 *
 * What matters is that the validation is still **core's own**. \`validateScene\`
 * and \`validateScenePrefabs\` are imported from \`@contextforge/core\`, so the
 * schema that accepts or refuses this project's scene is the same schema the
 * editor validates with. A second schema written here would be a second
 * definition of "a valid scene", and the two would drift (SPEC R6).
 *
 * ## Why core is imported from deep paths
 *
 * Core is a headless Node package (SPEC R3) whose index also exports the
 * tree-sitter parsers, so a browser cannot resolve \`@contextforge/core\` as a
 * whole. The imports below name the scene modules directly, which pull in Zod
 * and nothing else — no DOM, and no \`node:fs\`. The only Node builtin that
 * survives is \`sceneFile.ts\`'s own \`node:fs\`/\`node:path\` import, used only
 * by \`loadScene\`/\`saveScene\`, which this file never calls.
 *
 * If your bundler complains about \`node:fs\`, alias it to a module whose
 * exports throw — **not** to one that returns \`undefined\`. A stub that
 * pretends the filesystem works makes \`loadScene()\` report "no scene" for a
 * perfectly valid project, which is a wrong answer that looks like a right one.
 */

import * as THREE from 'three';
import { validateScene } from '@contextforge/core/dist/scene/sceneFile.js';
import { rngFor } from '@contextforge/core/dist/scene/rng.js';
// Two modules, not one. \`validateScenePrefabs\` is defined in the prefab
// registry, not in \`sceneFile.js\` — importing it from there resolves to
// \`undefined\` under ESM and fails at the first call with a bare "is not a
// function", naming neither the missing symbol nor where it really lives.
import { validateScenePrefabs } from '@contextforge/core/dist/scene/prefabs/index.js';
import { registry } from './prefabs/index.js';
import type { PrefabInstance, SceneFile } from '@contextforge/core';

/** The scene file's path, relative to the project root. */
export const SCENE_PATH = 'scene.json';

/** A built scene: the root to add to the renderer, and a lookup by instance id. */
export interface BuiltScene {
  root: THREE.Group;
  byId: Map<string, PrefabInstance>;
  scene: SceneFile;
  /** Ids that did not build, named. Never silent (SPEC R9). */
  failed: string[];
}

/** Options for \`buildScene\`. It exists so the loader can be driven headlessly. */
export interface BuildSceneOptions {
  /**
   * The fetcher. Defaults to the browser's \`fetch\`.
   *
   * Injected rather than reached for so a test can serve a scene without a
   * server — and so nothing in this file quietly assumes a network.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch, validate and instantiate the scene.
 *
 * @param scenePath Fetched relative to this module. Defaults to the project's
 *   own \`scene.json\`.
 * @param options \`fetchImpl\`, for a headless caller.
 */
export async function buildScene(
  scenePath: string = SCENE_PATH,
  options: BuildSceneOptions = {},
): Promise<BuiltScene> {
  const url = new URL(scenePath, import.meta.url).href;
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      \`Could not fetch \${url}: \${reason}. Without scene.json nothing in this project is placed.\`,
    );
  }
  if (!response.ok) {
    throw new Error(
      \`No scene at \${url} (HTTP \${response.status}). \` +
        'scene.json is the only source of placement in this project; a missing file is not a ' +
        'state it can start in.',
    );
  }

  // Validated before a single object is created, so a malformed scene.json gives
  // an error naming each JSON path rather than a half-built scene that is
  // missing half its objects (SPEC R6).
  const result = validateScene(await response.json());
  if (!result.valid || result.data === undefined) {
    throw new Error(
      \`Scene at \${url} is not a valid scene:\\n\` +
        result.errors.map((e) => \`  - \${e.path}: \${e.message}\`).join('\\n'),
    );
  }
  const scene = result.data;

  // Params are a different case: a bad param belongs to ONE instance, and that
  // instance's prefab will refuse it anyway. So the errors are reported with
  // their JSON paths and scoped to the instances they name, and every other
  // instance still builds — one typo must not empty the scene (SPEC R9).
  const paramErrors = validateScenePrefabs(scene, registry);
  const invalidIds = new Map<string, string[]>();
  for (const error of paramErrors) {
    const match = /^instances\\[(\\d+)\\]/.exec(error.path);
    const instance = match === null ? undefined : scene.instances[Number(match[1])];
    if (instance === undefined) {
      console.error(
        \`Scene at \${url}: \${error.path}: \${error.message} — this path does not name an \` +
          'instance, so no instance was skipped for it',
      );
      continue;
    }
    const reasons = invalidIds.get(instance.id) ?? [];
    reasons.push(\`\${error.path}: \${error.message}\`);
    invalidIds.set(instance.id, reasons);
    console.error(\`Scene at \${url}: \${error.path}: \${error.message}\`);
  }

  const root = new THREE.Group();
  root.name = scene.name;
  const byId = new Map<string, PrefabInstance>();
  const failed: string[] = [];

  for (const instance of scene.instances) {
    const reasons = invalidIds.get(instance.id);
    if (reasons !== undefined) {
      failed.push(instance.id);
      // Announced separately from the validation error: that one says the param
      // is wrong, this says the object is therefore ABSENT from the running
      // game. Without it the scene is short an object and nothing says which.
      console.warn(
        \`Scene at \${url}: skipped instance "\${instance.id}" (\${instance.prefab}) — \` +
          \`\${reasons.join('; ')}. That object is absent from the scene; every other instance \` +
          'still built.',
      );
      continue;
    }

    const prefab = registry.prefabs.find((p) => p.name === instance.prefab);
    if (prefab === undefined) {
      // Reported by validateScenePrefabs already. Reaching here means the
      // registry changed between validation and build, which would otherwise
      // produce a silently missing object (SPEC R9).
      throw new Error(
        \`Scene at \${url}: instance "\${instance.id}" names prefab "\${instance.prefab}", which is \` +
          'no longer in the registry — the registry changed between validation and build, so the ' +
          'scene on screen would silently differ from the file.',
      );
    }

    let built: PrefabInstance;
    try {
      // Seeded from the scene seed and the instance id, so every instance gets
      // its own reproducible stream (SPEC R7).
      built = prefab.create(THREE, instance.params, rngFor(scene.seed, instance.id));
    } catch (error) {
      // One broken prefab must not take the scene down with it, or a single bad
      // crate leaves the developer with nothing and an error naming nothing
      // useful (SPEC R9).
      failed.push(instance.id);
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        \`Scene at \${url}: instance "\${instance.id}" (\${instance.prefab}) failed to build: \` +
          \`\${reason}. The rest of the scene was built without it.\`,
      );
      continue;
    }

    if (built === null || typeof built !== 'object' || built.object === null || built.object === undefined) {
      throw new Error(
        \`Scene at \${url}: prefab "\${prefab.name}" returned no object for instance \` +
          \`"\${instance.id}". A prefab that returns nothing leaves a hole in the scene that \` +
          'surfaces much later as an object that is simply not there.',
      );
    }

    built.object.position.set(...instance.transform.position);
    built.object.rotation.set(...instance.transform.rotation);
    built.object.scale.set(...instance.transform.scale);
    // \`name ?? id\` is the contract: the display name is decoration, the id is the
    // only identifier guaranteed to be present and unique.
    if (instance.name !== undefined) built.object.name = instance.name;
    else built.object.name = instance.id;
    if (instance.visible !== undefined) built.object.visible = instance.visible;

    root.add(built.object);
    byId.set(instance.id, built);
  }

  // Parents are applied after every object exists, so the order instances
  // appear in scene.json does not matter (SPEC R8).
  for (const instance of scene.instances) {
    if (instance.parent === undefined) continue;
    const child = byId.get(instance.id)?.object;
    const parent = byId.get(instance.parent)?.object;
    if (child && parent) parent.add(child);
  }

  return { root, byId, scene, failed };
}
`;
}

/** The rules an AI must obey. This is the file the whole template exists for. */
function aiRulesSource(name: string, idea: string): string {
  return `# AI rules for ${name}

**Read this before writing any code.** These are not style preferences. Each one
exists because breaking it produces a project that looks fine and behaves wrong.

## The game

${idea}

## The two rules

### 1. Every object in the scene must be a prefab

A prefab is a pure function in \`prefabs/\`:

\`\`\`ts
create(three, params, rng) -> { object, parts }
\`\`\`

Rules a prefab must obey, all enforced by \`npm run lint:prefabs\`:

- \`three\` is a **parameter**. Never \`import * as THREE\` inside a prefab.
- \`rng\` is a **parameter**, and it is seeded. **\`Math.random()\` is a lint
  error** — unseeded randomness means the same \`scene.json\` renders differently
  on every load, and two AIs will disagree about where things are.
- No \`this\`. Pass state in, return state out.
- No module-level \`let\` or \`var\`. Two instances of the same prefab would
  share it.
- No \`scene.add()\`. Return the object; the caller places it.

If you need a new kind of object, add a prefab to \`prefabs/\` and register it in
\`prefabs/index.ts\`. Do not add a new kind of object anywhere else.

### 2. All scene placement goes in \`scene.json\`

**Positions, rotations, scales, and which prefab is where — all of it lives in
\`scene.json\`.** Not in a script. Not in a constant. Not "just this once, inline".

To move an object, edit \`scene.json\`. That is the only correct way.

\`loadScene.ts\` reads the file and creates objects. It contains no placements,
and you must not add any. If you find yourself wanting to write a position in
TypeScript, you want a \`params\` entry on a prefab instead.

## Scene file rules

- \`version\` is exactly \`${SCENE_SCHEMA_VERSION}\`.
- Every instance \`id\` is unique.
- \`parent\` must name another instance; parent chains must not be cycles.
- \`transform.position/rotation/scale\` are always exactly 3 numbers.
- Unknown keys are **rejected**. A typo like \`postion\` fails loudly rather
  than being ignored — that is deliberate.

## Before you finish

- Every change is validated: an invalid \`scene.json\` is refused with the JSON
  path of the problem, not silently half-applied.
- Edits are surgical. Change the lines that need changing; do not rewrite a whole
  file to change one line.
- If the supplied context is not enough to make a correct change, say
  \`CONTEXT INSUFFICIENT: <what you need>\` and stop. Do not guess at an API you
  have not been shown.
`;
}

/** The generated README. */
function readmeSource(name: string, idea: string): string {
  return `# ${name}

${idea}

## Layout

| Path | What it is |
| --- | --- |
| \`scene.json\` | The scene. All placement lives here. |
| \`prefabs/\` | Pure functions that build objects. |
| \`prefabs/index.ts\` | The registry. A scene may only name a prefab listed here. |
| \`loadScene.ts\` | Reads \`scene.json\` and builds the object graph. Contains no placements. |
| \`AI_RULES.md\` | The rules any AI must follow. Read it first. |

## Two rules

1. **Every object is a prefab.** A scene can only reference a registered name.
2. **All placement is in \`scene.json\`.** To move something, edit the JSON.

Both are why this project stays editable: an AI given \`scene.json\` and a prefab
list has everything it needs, and cannot quietly break a position it was never
shown.
`;
}

/**
 * scene/scaffoldPrompt.ts — the prompt that asks an AI to build the project.
 *
 * ## Why this is in core and not in the Project screen
 *
 * Two reasons, and the second is the one that matters.
 *
 * 1. `generateProject` already writes `AI_RULES.md` from a brief. This is the
 *    same artifact with more structure, and the two must not drift — an AI
 *    told to build the project and an AI told to edit it should be given the
 *    same rules, or the AI unlearns them as soon as the developer pastes
 *    something else.
 * 2. `checkBrief` is exported from `template.ts` specifically so a UI can gate
 *    on it rather than reimplement the rules. A gate that reimplemented them
 *    would let the screen enable a copy button that the generator then refuses,
 *    which is worse than having no gate: the developer pastes a prompt, the AI
 *    builds nothing, and nothing anywhere said why.
 *
 * ## Nothing here reads a clock or a random number
 *
 * Two runs with the same brief produce byte-identical text, so the prompt can
 * be diffed and the tests can compare it as a string (SPEC: determinism).
 */

import { checkBrief, type GameBrief } from './template.js';
import { PREFAB_RULE_REASONS, PREFAB_RULES } from './lint.js';
import { SCENE_SCHEMA_VERSION } from './scene.schema.js';

/**
 * The prompt, built from a brief.
 *
 * Pure: it takes the brief and returns text. It writes nothing, so a screen can
 * show a preview before the developer has committed to anything — the same
 * split `buildBriefMarkdown` / `generateBrief` makes for the project brief.
 *
 * The idea is embedded verbatim and marked as the developer's own words, so the
 * AI does not "helpfully" restate the game it was asked to build.
 */
export function buildScaffoldPrompt(brief: Partial<GameBrief>): string {
  const name = (brief.name ?? '').trim() || 'my-game';
  const idea = (brief.idea ?? '').trim() || '(not written yet)';

  return `# Build the game: ${name}

## The game

${idea}

That description is the developer's own words and it is the whole specification.
Build the game that is described there. If something is genuinely unspecified,
make a choice, write it down in a comment at the point of decision, and keep
going — do not stop to ask, and do not substitute a different game you find more
interesting.

## The shape of the project

\`\`\`
${name}/
├── index.html          the page, with <canvas id="game-canvas">
├── package.json        "type": "module", three pinned exactly (no ^ or ~)
├── vite.config.js      dev server on 127.0.0.1:5173, strictPort
├── scene.json          every object, placed. schema_version ${SCENE_SCHEMA_VERSION}
├── src/
│   ├── main.js         boot: build the scene, start the loop
│   ├── scene-manager.js  load scene.json, own the scene graph
│   └── ...             game code
└── prefabs/
    ├── index.ts        the registry
    └── <name>.ts      one prefab per reusable object
\`\`\`

## scene.json is the single source of placement

Every object in the game is an instance in \`scene.json\`, not something created
with \`new\` in code. That is what lets ContextForge show the scene, move an
object, and write the change back without touching game logic. If an object
exists but is not in \`scene.json\`, it cannot be edited.

Two prefabs to start from, and they exist to be extended:

- \`trackSegment\` — a stretch of road, parameterised by width, length and colour.
- \`kart\` — a vehicle, parameterised by character.

Add a prefab for anything that appears more than once.

## Prefabs are pure functions

\`\`\`ts
export function create(THREE, params, rng): { object, parts }
\`\`\`

- \`THREE\` is **passed in**. Never import it.
- \`rng\` is seeded. Never use \`Math.random()\` — two runs must produce the same
  scene, or a saved \`scene.json\` does not reproduce.
- Return \`parts\` as a named map so a specific sub-object can be selected.
- Never call \`scene.add\`. The caller composes what you return.

\`npm run lint:prefabs\` enforces these, and they are the same rules the brief
tells an editing AI:

${PREFAB_RULES.map((rule) => `- \`${rule}\` — ${PREFAB_RULE_REASONS[rule]}`).join('\n')}

## Rules

- \`three\` is pinned **exactly** in package.json. \`^\` or \`~\` is a build error.
- One \`node_modules\`; never add a second copy of \`three\`.
- If you cannot see a file you need, say so in one line and name the path. Do
  not guess at its contents, and do not import something you have not read.

## Start here

Write \`scene.json\` and the two prefabs first, then the code that loads them.
Run it and look at it before adding anything else.
`;
}

/**
 * Why the scaffold prompt cannot be shown yet, or `[]` when it can.
 *
 * This is `checkBrief` — the same function, the same rules, called from one
 * place. The Project screen uses the return value to disable its copy button, so
 * the button and the generator can never disagree about whether a brief is
 * usable.
 */
export function scaffoldPromptProblems(brief: Partial<GameBrief>): string[] {
  return checkBrief(brief);
}
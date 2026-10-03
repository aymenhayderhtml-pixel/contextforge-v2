/**
 * scripts/check-three-pinned.mjs — the game and the viewer must run the *same*
 * Three.js, exactly (Step 3d).
 *
 * ## Why this is a gate and not a comment
 *
 * Step 3d's headline defect was a version gap: the game declared `three@^0.160.0`
 * and the viewer used `0.180.0`. Nothing complained. The parity test still passed,
 * because it bundled the game's modules against the *host's* Three.js and so was
 * comparing 0.180 against 0.180 — it could not see the gap it existed to catch.
 *
 * A caret range is the mechanism that produces this gap, so it is what is banned
 * here. `^0.180.0` means "any 0.18x", and `0.180.0` means "exactly this". The
 * distinction is invisible in a diff review and decisive at runtime: an AI that
 * runs `npm install` in the game a month from now can end up on a different
 * Three.js than the viewer, and the symptom is a rendering difference nobody can
 * point at.
 *
 * ## What it checks
 *
 *  1. The viewer's `three` (and `@types/three`) are pinned with no range operator.
 *  2. The game's declared `three` is pinned with no range operator.
 *  3. The two **declared** versions are byte-identical.
 *  4. The two **installed** versions are byte-identical.
 *
 * The installed check is separate from the declared one on purpose: a lockfile
 * that disagrees with its own manifest is a different failure from two manifests
 * that disagree with each other, and the message says which.
 *
 * ## Exit codes
 *
 *  - `0` clean.
 *  - `1` a violation (a range, or a mismatch). Printed with the exact fix.
 *  - `2` operational error — a manifest or an install is missing, so "clean"
 *    would be a claim about something that was never read. A gate that reports
 *    success because it checked nothing is worse than no gate (D24).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The viewer's manifest, and the game project it must agree with. */
const VIEWER_MANIFEST = join(REPO, 'packages/app/package.json');
const VIEWER_INSTALL = join(REPO, 'node_modules/three/package.json');

const GAME_ROOT = process.env.CF_GAME_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'kart-dash-3d-v2');
const GAME_MANIFEST = join(GAME_ROOT, 'package.json');
const GAME_INSTALL = join(GAME_ROOT, 'node_modules/three/package.json');

/** `^`, `~`, `>`, `<`, `=`, `x`, `*` — anything that is not one exact version. */
const RANGE = /[\^~><=x*]|\s-\s/;

/** Read a manifest's `version`/`name`, or explain why it could not be read. */
function readVersion(path, field) {
  if (!existsSync(path)) {
    throw new Error(
      `Cannot read ${path}. Run the install first, or point CF_GAME_ROOT at the game ` +
        'project. Reporting "pinned and identical" about a file that does not exist ' +
        'would be a claim about nothing.',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  const value = field === 'name' ? parsed.name : parsed.version;
  if (typeof value !== 'string') {
    throw new Error(`${path} has no "${field}" string. Refusing to guess at a version.`);
  }
  return value;
}

const problems = [];

// 1. The viewer's own pins must be exact.
for (const dep of ['three', '@types/three']) {
  const manifest = JSON.parse(readFileSync(VIEWER_MANIFEST, 'utf-8'));
  const declared = manifest.dependencies?.[dep] ?? manifest.devDependencies?.[dep];
  if (declared === undefined) {
    problems.push(`packages/app/package.json does not declare "${dep}" at all.`);
  } else if (RANGE.test(declared)) {
    problems.push(
      `packages/app/package.json pins "${dep}" as "${declared}" — a range. ` +
        'Pin it exactly ("0.180.0"): a range is what let the viewer and the game drift ' +
        'apart in the first place, and the drift is invisible in a diff.',
    );
  }
}

// 2–4. Declared and installed versions must agree across the two projects.
let viewerDeclared;
let gameDeclared;
let viewerInstalled;
let gameInstalled;

try {
  viewerDeclared = readVersion(VIEWER_MANIFEST, 'name');
  const viewerManifest = JSON.parse(readFileSync(VIEWER_MANIFEST, 'utf-8'));
  viewerDeclared = viewerManifest.dependencies.three;
  if (RANGE.test(viewerDeclared)) {
    problems.push(`packages/app declares three as "${viewerDeclared}" — a range, not a pin.`);
  }

  const gameManifest = JSON.parse(readFileSync(GAME_MANIFEST, 'utf-8'));
  gameDeclared = gameManifest.dependencies?.three;
  if (gameDeclared === undefined) {
    problems.push(`${GAME_MANIFEST} does not declare "three" in dependencies.`);
  } else if (RANGE.test(gameDeclared)) {
    problems.push(
      `${GAME_MANIFEST} pins three as "${gameDeclared}" — a range. ` +
        'Pin it to exactly the version the viewer uses.',
    );
  }

  if (viewerDeclared !== undefined && gameDeclared !== undefined && viewerDeclared !== gameDeclared) {
    problems.push(
      `The viewer declares three@${viewerDeclared} but the game declares three@${gameDeclared}. ` +
        'They must be byte-identical: the viewer and the game build the same objects, and two ' +
        'Three.js versions means the thing on screen is not the thing under test.',
    );
  }

  viewerInstalled = readVersion(VIEWER_INSTALL, 'version');
  gameInstalled = readVersion(GAME_INSTALL, 'version');

  if (viewerInstalled !== gameInstalled) {
    problems.push(
      `The viewer has three@${viewerInstalled} installed but the game has three@${gameInstalled}. ` +
        'Reinstall whichever side is behind. This is the gap that Step 3d was created to close.',
    );
  }
} catch (error) {
  // Exit 2, below: an operational failure is not "a violation", it is "no answer".
  process.stderr.write(`check:three-pinned — ${error instanceof Error ? error.message : error}\n`);
  process.exit(2);
}

if (problems.length > 0) {
  process.stderr.write(`check:three-pinned — ${problems.length} problem(s):\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.stderr.write(
    '\nFix: pin three to the same exact version in both manifests, then reinstall the game ' +
      'with NODE_ENV=development npm install --include=dev (this shell sets NODE_ENV=production, ' +
      'which silently skips devDependencies).\n',
  );
  process.exit(1);
}

process.stdout.write(
  `check:three-pinned — viewer three@${viewerDeclared} and game three@${gameDeclared}, ` +
    `both installed as ${viewerInstalled}. Exactly pinned, exactly identical.\n`,
);

/**
 * context/brief.ts — build `brief.md`, the project's own context sheet (SPEC §5 Step 5).
 *
 * ## What a brief is for
 *
 * The handoff prompt (`compiler.ts`) answers "what does this AI need *for this
 * error*". The brief answers the question underneath it: "what is this project,
 * and what must never be violated in it". An AI that has read a brief knows which
 * engine it is in, where the objects live, which signatures are real, and that
 * `scene.json` is the only place placement happens — before it has seen a single
 * error.
 *
 * ## Everything here comes from the real graph
 *
 * That is the whole design constraint, and it is what stops the brief from
 * becoming fiction. The stack comes from the extractors' own node ids and
 * engines; the folder map is a projection of the graph; the counts are
 * `manifest.nodes.length` and `manifest.edges.length`; the signatures are
 * `node.contract.exports`, which the JS and GDScript parsers read out of
 * **syntax trees** (SPEC R5) rather than by matching text; the build order is
 * `layerNodes`; the patch format is `strictPatchContract()` verbatim; the
 * prefab rules are `PREFAB_RULES` with `PREFAB_RULE_REASONS`, which is the same
 * table the linter enforces from.
 *
 * There is no second analysis anywhere in this file. If the parsers get better,
 * the brief changes; if the brief were hand-written it would drift from the code
 * it describes on the first commit that moved a function.
 *
 * ## Determinism (SPEC R8)
 *
 * Nothing here reads the clock. `buildManifest` takes its `generatedAt` as an
 * argument for exactly this reason, so it is threaded through from the caller's
 * `now` and the brief prints a `Generated:` line **only when one was supplied**.
 * Two runs over the same project produce byte-identical output, which is what
 * makes the brief safe to commit and diff — a brief that changed on every click
 * would train a developer to ignore it.
 *
 * The mode is written into an HTML comment on the first line so `readBrief` can
 * recover it from the file's own bytes instead of guessing at it or keeping a
 * side-channel state file that could disagree with what is on disk.
 *
 * ## Why it writes under `.contextforge/`
 *
 * The brief is derived data about the project, so it belongs in the project but
 * out of the way of the game's own source: a folder nothing imports, with a
 * leading dot so no bundler or `scanFiles` sweep picks it up. `writeBrief`
 * resolves the final path and refuses anything that would land outside the open
 * project — a brief generator that could write to `/tmp` on a mistyped root is
 * not worth having (SPEC R9).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { z } from 'zod';

import { readTextFileOrNull } from '../extract/files.js';
import { extractGodotProject, parseAutoloads } from '../extract/godot.js';
import { extractJsProject } from '../extract/js.js';
import { buildManifest } from '../graph/manifest.js';
import type { Manifest } from '../graph/types.js';
import { danglingEdges, layerNodes } from '../graph/reverse.js';
import { PREFAB_RULES, PREFAB_RULE_REASONS } from '../scene/lint.js';
import { SCENE_SCHEMA_VERSION, type SceneFile } from '../scene/scene.schema.js';
import { loadScene } from '../scene/sceneFile.js';
import { strictPatchContract } from './compiler.js';
import { rankRelevantFiles } from './rank.js';

// ── The contract ─────────────────────────────────────────────────────────────

/** Where the brief lives, project-relative. Also its only legal write target. */
export const BRIEF_DIR = '.contextforge';

/** The brief's path inside a project, always with forward slashes. */
export const BRIEF_PATH = `${BRIEF_DIR}/brief.md`;

/**
 * Which brief the developer asked for.
 *
 * Duplicated from `ipc.ts` rather than imported from it, and the duplication is
 * deliberate: core may not import app (SPEC R4), so the types have to be pinned
 * on both sides. `.satisfies`-style agreement is enforced by
 * `assertBriefModeMatchesIpc` in the test, so a change on either side fails
 * something instead of drifting.
 */
export type BriefMode = 'oneShot' | 'interactive';

/** Both modes, in the order the UI offers them. */
export const BRIEF_MODES: readonly BriefMode[] = ['oneShot', 'interactive'];

/**
 * Validate a brief request at the boundary (SPEC R6).
 *
 * A brief request is attacker-shaped in the same way a scene file is: it arrives
 * over IPC from a renderer and carries a mode plus free text. Validating it here
 * means a bad mode is a refusal naming the field, not a switch statement that
 * silently falls through to the one-shot path — which would give the developer a
 * one-shot brief while believing they asked for an interactive one.
 *
 * `.strict()` for the same reason the manifest schema is: an unknown key means
 * the caller was built against a different version, and dropping it would hide
 * that.
 */
export const briefRequestSchema = z
  .object({
    mode: z.enum(['oneShot', 'interactive'], {
      errorMap: () => ({
        message: `mode must be one of ${BRIEF_MODES.map((m) => `"${m}"`).join(' or ')}`,
      }),
    }),
    /** The developer's task. Optional in interactive mode, meaningful in one-shot. */
    task: z.string().max(4000, 'task must be at most 4000 characters — it is pasted into the brief verbatim').optional(),
  })
  .strict();

/** What a validated request carries. */
export type BriefRequest = z.infer<typeof briefRequestSchema>;

/** One refusal, as `ipc.ts` defines it. Pinned structurally; core may not import app. */
export type BriefValidation =
  | { ok: true; value: BriefRequest }
  | { ok: false; reason: string };

/**
 * Validate a brief request without throwing.
 *
 * Returns the same union shape as every other boundary in this codebase: a
 * success carrying the value, or a failure carrying a sentence that can be shown
 * verbatim (SPEC R9). The Zod issues are joined with their field path, because
 * "Invalid input" does not tell a developer which of the two fields to fix.
 */
export function validateBriefRequest(input: unknown): BriefValidation {
  const parsed = briefRequestSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };

  const detail = parsed.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(request)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');

  return {
    ok: false,
    reason:
      `The brief request was refused, so no brief was written: ${detail}. ` +
      'Send { mode: "oneShot" | "interactive", task?: string } and nothing else.',
  };
}

// ── The result ───────────────────────────────────────────────────────────────

/** What went into the brief, as the Context screen shows it. */
export interface BriefStats {
  /** Graph nodes core extracted from the project. */
  nodes: number;
  /** Graph edges between them. */
  edges: number;
  /**
   * Prefab modules found — files under a `prefabs/` directory, excluding the
   * registry's own index.
   *
   * Counted from the graph rather than by importing the registry: loading a
   * project's registry needs a bundler and a live Three.js instance, and a brief
   * generator that cannot run headlessly is a brief generator that only works in
   * one place (SPEC R3, R10).
   */
  prefabs: number;
  /** Instances in `scene.json`, or 0 when there is no readable scene. */
  instances: number;
}

/** A generated brief, and where it landed. */
export interface GeneratedBrief {
  /** Project-relative path. Always `.contextforge/brief.md`. */
  path: string;
  /** The markdown, so the screen can show it without a second round trip. */
  markdown: string;
  mode: BriefMode;
  stats: BriefStats;
}

/** How to build a brief. */
export interface BriefOptions {
  /** Project root. Every path in the brief is relative to it. */
  projectRoot: string;
  /** Which brief to produce. */
  mode: BriefMode;
  /** The developer's task, used in `oneShot` mode and to rank files in both. */
  task?: string | undefined;
  /**
   * An ISO timestamp, injected rather than read (SPEC R8).
   *
   * Omitted from the output entirely when absent, so a caller with no clock
   * still gets a byte-identical brief across runs.
   */
  generatedAt?: string | undefined;
  /**
   * The scene file, project-relative. Defaults to `scene.json`; the main process
   * may pass the path it found (`scenes/level1.scene.json`) instead of
   * duplicating that search here.
   */
  scenePath?: string | undefined;
}

/**
 * The first line of the file.
 *
 * An HTML comment rather than visible text because it must not appear in a
 * rendered brief, and a mode line a reader can see would be one more thing to
 * keep in sync. It is also the *only* place the mode is stored, so `readBrief`
 * and the file can never disagree.
 */
const MODE_MARKER_PREFIX = '<!-- contextforge:brief mode=';

/** Longest folder-map row per folder. Keeps the brief readable, not exhaustive. */
const FOLDER_SAMPLE = 6;

/** Longest ranked list in the brief; the rest are in the graph. */
const MAX_RANKED = 8;

/** How many build-order layers are listed before collapsing to a count. */
const MAX_LAYERS_LISTED = 12;

// ── Building the markdown ────────────────────────────────────────────────────

/**
 * Build the brief's markdown without writing anything.
 *
 * Pure with respect to output: same project and same options in, byte-identical
 * string out. Split from `generateBrief` so a test, a CLI or a preview can read
 * what *would* be written without creating a directory (R10 — a capability that
 * exists only behind a button is unfinished).
 */
export function buildBriefMarkdown(options: BriefOptions): {
  markdown: string;
  stats: BriefStats;
} {
  const { projectRoot, mode, task, generatedAt, scenePath } = options;
  const root = resolve(projectRoot);

  const manifest = manifestFor(root, generatedAt);
  const scene = readSceneOrReport(root, scenePath ?? 'scene.json');

  const stats: BriefStats = {
    nodes: manifest.nodes.length,
    edges: manifest.edges.length,
    prefabs: prefabModules(manifest).length,
    instances: scene.file?.instances.length ?? 0,
  };

  const sections: string[] = [
    `${MODE_MARKER_PREFIX}${mode} -->`,
    heading(1, `Project brief: ${projectName(root)}`),
    overviewSection(root, mode, generatedAt, stats, scene),
    taskOrInstructionSection(mode, task),
    stackSection(root, manifest, scene),
    folderMapSection(manifest),
    graphSection(manifest),
    // Only one-shot ranks against the task. An interactive brief carries no
    // task by construction — the point of that mode is that the question is not
    // asked yet — so ranking against one would order the brief by a task it does
    // not contain, which is a confident answer to a question nobody posed.
    signaturesSection(root, manifest, mode === 'oneShot' ? (task ?? '') : ''),
    sceneRulesSection(scene),
    `${heading(2, 'The patch format you must reply in')}\n\n` +
      'Reply with blocks in exactly this form. The FIND block is matched\n' +
      'character-for-character against the file on disk, so re-indenting or\n' +
      '"tidying" the code you were given makes the patch fail.\n\n' +
      '```\n' +
      strictPatchContract() +
      '\n```',
  ];

  const footer = scene.report === null ? '' : `> ${scene.report}\n`;
  const markdown = `${sections.join('\n\n')}\n${footer === '' ? '' : `\n${footer}`}`;

  return { markdown, stats };
}

/**
 * Build the brief and write it to `.contextforge/brief.md`.
 *
 * The write is the only side effect, it is a whole file rather than a patch into
 * someone's project, and it happens under a dot-directory nothing imports.
 */
export function generateBrief(options: BriefOptions): GeneratedBrief {
  const root = resolve(options.projectRoot);
  const { markdown, stats } = buildBriefMarkdown(options);
  writeBrief(root, markdown);
  return { path: BRIEF_PATH, markdown, mode: options.mode, stats };
}

/**
 * Write the brief, refusing any target outside the project.
 *
 * The containment check is not paranoia: `projectRoot` is whatever path the
 * developer opened, and `BRIEF_PATH` is joined onto it without a second thought
 * by a caller. If that join ever escapes — a root of `''`, a `..` in the root
 * itself — the alternative is writing a brief into a directory the developer
 * never opened. So the resolved path is compared to the resolved root and the
 * mismatch is a refusal naming both (SPEC R9).
 */
export function writeBrief(projectRoot: string, markdown: string): string {
  const root = resolve(projectRoot);
  const target = resolve(root, ...BRIEF_PATH.split('/'));
  const inside = target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);

  if (!inside) {
    throw new Error(
      `Refusing to write the brief: "${target}" is outside the project folder "${root}". ` +
        'A brief belongs to the project it describes and nowhere else.',
    );
  }

  // `mkdirSync(dirname, { recursive: true })` is the same call `generateProject`
  // and `saveScene` use: the directory is created on demand and creating an
  // existing one is a no-op, so a second run is not a special case.
  mkdirSync(join(root, BRIEF_DIR), { recursive: true });
  writeFileSync(target, markdown, 'utf-8');
  return BRIEF_PATH;
}

/**
 * Read the brief back, or `null` when there is none.
 *
 * `null` is an answer and not a failure: a project that has never had a brief
 * generated is the normal state of a project an AI has not been handed yet, and
 * the Context screen shows an empty state rather than a red error for it.
 *
 * The mode comes from the file's own marker line. Recovering it any other way —
 * a timestamped filename, a side-car state file — would let the two disagree,
 * and a screen that shows the wrong mode sends a one-shot brief into the
 * interactive path with no symptom to notice.
 */
export function readBrief(projectRoot: string): {
  path: string;
  markdown: string;
  mode: BriefMode;
  /** `null` for a brief not written by `buildBriefMarkdown`. See `briefStatsFrom`. */
  stats: BriefStats | null;
} | null {
  const root = resolve(projectRoot);
  const target = join(root, ...BRIEF_PATH.split('/'));
  if (!existsSync(target)) return null;

  const markdown = readFileSync(target, 'utf-8');
  return {
    path: BRIEF_PATH,
    markdown,
    mode: briefModeFrom(markdown),
    stats: briefStatsFrom(markdown),
  };
}

/**
 * Recover the mode a brief was written in.
 *
 * A bounded pattern over a marker this module writes verbatim. This is a lexical
 * concern on a line of prose — the R5-permitted case — and it is deliberately
 * narrow: an unrecognised or absent marker yields `oneShot`, because that is the
 * mode a brief with no task behaves like, and guessing `interactive` would tell
 * the screen to show an instruction the file does not contain.
 */
export function briefModeFrom(markdown: string): BriefMode {
  const marker = /^<!-- contextforge:brief mode=(oneShot|interactive) -->$/m.exec(markdown);
  return marker?.[1] === 'interactive' ? 'interactive' : 'oneShot';
}

/**
 * Recover the counts from a saved brief, or `null` for a brief that has none.
 *
 * **Why this exists.** `readBrief` returned `{path, markdown, mode}` and the
 * Context screen rendered `brief.stats.nodes` from it — so reopening a project
 * showed a brief panel whose four count rows read `undefined`. Nothing caught it:
 * `BriefResult.stats` was typed as required, the handler's return type was a
 * narrower inline object rather than `BriefResult`, and no test read the panel's
 * counts. `svelte-check` reported it as a missing property, which is the only
 * reason it was ever seen (D50).
 *
 * **Not re-extracting the project.** The obvious alternative — run the extractor
 * again to recompute the numbers — is a full project scan on what the screen
 * treats as a cheap read, and it would report the counts *now* rather than the
 * counts the brief was written with, which is a different and wrong number: the
 * file on disk is the record of what was handed to the AI.
 *
 * So the counts are read back out of the markdown, which writes them verbatim in
 * `overviewSection`. This is the same lexical-over-own-marker approach as
 * `briefModeFrom` above, and carries the same caveat: a brief hand-edited away
 * from the generated shape yields `null`, and the screen says the counts are
 * unavailable rather than showing zeros that were never counted.
 */
export function briefStatsFrom(markdown: string): BriefStats | null {
  const number = (line: RegExp): number | undefined => {
    const found = line.exec(markdown);
    return found?.[1] === undefined ? undefined : Number(found[1]);
  };

  const nodes = number(/^- Graph: (\d+) node\(s\), \d+ edge\(s\)$/m);
  const edges = number(/^- Graph: \d+ node\(s\), (\d+) edge\(s\)$/m);
  const prefabs = number(/^- Prefab modules: (\d+)$/m);
  const instances = number(/^- Scene instances: (\d+)$/m);

  // All four or none. A brief missing one line is a brief whose shape this module
  // did not write, and half the counts would be a worse answer than none.
  if (nodes === undefined || edges === undefined || prefabs === undefined || instances === undefined) {
    return null;
  }
  return { nodes, edges, prefabs, instances };
}

// ── Sections ─────────────────────────────────────────────────────────────────

/** One `## heading`, with the trailing blank line the callers expect. */
function heading(level: number, text: string): string {
  return `${'#'.repeat(level)} ${text}`;
}

/** How the scene file came out, including what was wrong with it. */
interface SceneRead {
  /** The validated scene, or `null` when there is none to read. */
  file: SceneFile | null;
  /** One sentence naming what happened, or `null` when nothing did. */
  report: string | null;
}

/**
 * Read the project's scene, reporting rather than throwing.
 *
 * `loadScene` throws on a scene that exists and is invalid — correct for a tool
 * that is *about* the scene, wrong for a brief, which is a larger document that
 * still has a graph, a folder map and a stack to describe. So the throw becomes a
 * line in the brief telling the AI the scene is currently unreadable, which is
 * exactly the thing it must not guess about (SPEC R9).
 */
function readSceneOrReport(root: string, scenePath: string): SceneRead {
  try {
    const scene = loadScene(join(root, ...scenePath.split('/')));
    if (scene === null) {
      return {
        file: null,
        report:
          `There is no scene file at \`${scenePath}\`. Nothing in this brief describes ` +
          'scene contents, and there are none to describe.',
      };
    }
    return { file: scene, report: null };
  } catch (error) {
    return {
      file: null,
      report:
        `The scene file \`${scenePath}\` could not be read, so its contents are NOT in this brief: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'Do not assume what is in it; read it yourself or ask for it.',
    };
  }
}

/** Header: what this is, which mode, how big the project is. */
function overviewSection(
  root: string,
  mode: BriefMode,
  generatedAt: string | undefined,
  stats: BriefStats,
  scene: SceneRead,
): string {
  const lines = [
    'This is the context sheet for a project you are about to edit. It was',
    'generated from the project\'s own dependency graph — every count, path and',
    'signature below was read out of the code, not written by hand. Where this',
    'brief omits something, it means it could not be read, and it says so.',
    '',
    `- Project folder: \`${projectName(root)}\``,
    `- Engine: ${engineLabel(root, scene.file)}`,
    `- Mode: ${mode === 'oneShot' ? 'one-shot (ask now, get one answer)' : 'interactive (ask back with NEED: for anything missing)'}`,
    `- Graph: ${stats.nodes} node(s), ${stats.edges} edge(s)`,
    `- Prefab modules: ${stats.prefabs}`,
    `- Scene instances: ${stats.instances}`,
  ];

  if (generatedAt !== undefined && generatedAt !== '') {
    lines.push(`- Generated: ${generatedAt}`);
  }

  return lines.join('\n');
}

/**
 * The section that differs between the two modes.
 *
 * `oneShot` states the task and nothing else: the developer's question is the
 * question, and a brief that also invited negotiation would leave the AI unsure
 * whether it is expected to answer or to ask.
 *
 * `interactive` states no task at all — there is no question yet — and instead
 * gives the AI the one thing it must do when the brief is not enough: name the
 * file it needs with a `NEED:` line and stop. The marker is exactly the one the
 * Context screen's detector looks for, so the round trip works without anyone
 * agreeing on a format.
 */
function taskOrInstructionSection(mode: BriefMode, task: string | undefined): string {
  if (mode === 'oneShot') {
    const trimmed = (task ?? '').trim();
    if (trimmed === '') {
      return (
        `${heading(2, 'The developer\'s task')}\n\n` +
        'No task was given with this brief, so this sheet is the entire context. ' +
        'If you cannot proceed from it, ask rather than guess.'
      );
    }
    return (
      `${heading(2, 'The developer\'s task')}\n\n` +
      'This is what you are being asked to do. Answer **this**, and nothing wider.\n\n' +
      '```\n' +
      trimmed.replace(/```/g, '``\u200b`') +
      '\n```'
    );
  }

  return (
    `${heading(2, 'Ask back for anything missing')}\n\n` +
    'No task was given yet. This brief is the context, and it may not be enough.\n\n' +
    'Before you write a single line of code, check that you can see every file the\n' +
    'task will touch. If anything is missing, **do not guess at it** — a wrong guess\n' +
    'about an API is applied to a real project and breaks the game.\n\n' +
    'Reply with one line per missing file, and nothing else:\n\n' +
    '```\n' +
    'NEED: <path relative to the project root> — <what you need from it>\n' +
    '```\n\n' +
    'Paths are project-relative and must match the folder map above exactly (for\n' +
    'example `src/track.js`, not `track.js`). One question per file; ask for\n' +
    'symbols and behaviour, not for whole directories.\n\n' +
    'The app will attach what you name and ask again. That is the whole loop: ask,\n' +
    'attach, re-ask.'
  );
}

/**
 * Languages, engine and declared libraries.
 *
 * Languages are counted from the node ids the extractor produced, so the number
 * under "TypeScript" is the number of TypeScript files core actually parsed — not
 * a glob. Libraries come from `package.json`, which is where a project declares
 * what it uses; a bare-specifier import that is not in `package.json` is not a
 * dependency this project claims to have, and listing it as one would be the
 * brief guessing (SPEC R9).
 */
function stackSection(root: string, manifest: Manifest, scene: SceneRead): string {
  const counts = new Map<string, number>();
  for (const node of manifest.nodes) {
    const dot = node.id.lastIndexOf('.');
    const extension = dot === -1 ? '(no extension)' : node.id.slice(dot + 1).toLowerCase();
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }
  const byCount = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );

  const lines = [heading(2, 'The stack')];
  lines.push('');
  lines.push(`- Engine: ${engineLabel(root, scene.file)}`);
  lines.push('- Node types: ' + summarize(manifest.nodes.map((n) => n.type)));
  lines.push('- Edge kinds: ' + summarize(manifest.edges.map((e) => e.kind)));
  lines.push('- Languages by file count: ' + countBy(byCount.map(([ext, n]) => `${ext} (${n})`)));

  const godot = existsSync(join(root, 'project.godot'));
  if (godot) {
    const autoloads = [...parseAutoloads(root).keys()].sort();
    lines.push(
      '- Autoloads (globals injected by `project.godot`): ' +
        (autoloads.length > 0 ? autoloads.join(', ') : '(none declared)'),
    );
  }

  const libraries = readDeclaredDependencies(root);
  lines.push('- Declared npm dependencies: ' + (libraries.dependencies.length > 0 ? libraries.dependencies.join(', ') : '(none)'));
  lines.push('- Declared npm devDependencies: ' + (libraries.devDependencies.length > 0 ? libraries.devDependencies.join(', ') : '(none)'));

  return lines.join('\n');
}

/**
 * One directory per top-level folder, with its file count and a sample.
 *
 * The map is derived from graph node ids, so it covers the files core read as
 * source or as an asset reference and **not** the ones it deliberately skips
 * (`node_modules`, `dist`, build output, minified bundles). That is the point:
 * this is a map of the code you may be asked to change.
 */
function folderMapSection(manifest: Manifest): string {
  const folders = new Map<string, string[]>();

  for (const node of manifest.nodes) {
    const slash = node.id.lastIndexOf('/');
    const folder = slash === -1 ? '(project root)' : node.id.slice(0, slash);
    const list = folders.get(folder) ?? [];
    list.push(node.id);
    folders.set(folder, list);
  }

  const ordered = [...folders.entries()].sort(
    (a, b) => a[0].localeCompare(b[0]),
  );

  const lines = [
    heading(2, 'Folder map'),
    '',
    'Everything below is a file core parsed or followed a reference into. Ignored',
    'by the extractor, so absent here and not worth touching: `node_modules`, `dist`,',
    '`build`, `.godot`, `vendor`, and minified vendor bundles.',
    '',
  ];

  for (const [folder, files] of ordered) {
    const sorted = [...files].sort((a, b) => a.localeCompare(b));
    const sample = sorted.slice(0, FOLDER_SAMPLE).map((f) => `\`${f}\``).join(', ');
    const more = sorted.length > FOLDER_SAMPLE ? `, +${sorted.length - FOLDER_SAMPLE} more` : '';
    lines.push(`- \`${folder}/\` — ${sorted.length} file(s): ${sample}${more}`);
  }

  if (ordered.length === 0) {
    lines.push('- (the graph is empty: core found no parsable source in this project)');
  }

  return lines.join('\n');
}

/**
 * Node and edge totals, the dependency layers, and anything structurally wrong.
 *
 * `layerNodes` is the build order: layer 0 depends on nothing, layer N depends
 * only on layers below it. An AI that edits a file in layer 4 has to assume its
 * callers in layer 3 are affected, and seeing the order is what tells it so.
 *
 * Cycles and dangling edges are printed rather than tolerated. A cycle is a hard
 * error in every runtime, and an AI handed a cyclic graph will cheerfully create
 * another one; a dangling edge means the graph is describing something the
 * project no longer has (SPEC R9).
 */
function graphSection(manifest: Manifest): string {
  const { layers, cyclic } = layerNodes(manifest);
  const dangling = danglingEdges(manifest);

  const lines = [heading(2, 'Graph summary')];
  lines.push('');
  lines.push(`- Nodes: ${manifest.nodes.length}`);
  lines.push(`- Edges: ${manifest.edges.length}`);
  lines.push(`- Layers (build order): ${layers.length}`);
  lines.push('');
  lines.push('Read this as: a file in layer N may use anything in layers 0..N-1, and nothing above it.');

  const listed = layers.slice(0, MAX_LAYERS_LISTED);
  listed.forEach((layer, index) => {
    lines.push('');
    lines.push(`**Layer ${index}** — ${layer.length} file(s): ${layer.map((id) => `\`${id}\``).join(', ')}`);
  });
  if (layers.length > MAX_LAYERS_LISTED) {
    lines.push('');
    lines.push(`(${layers.length - MAX_LAYERS_LISTED} further layer(s) omitted; see the graph for the rest.)`);
  }

  if (cyclic.length > 0) {
    lines.push('');
    lines.push(
      `**Dependency cycle** — ${cyclic.length} file(s) cannot be ordered: ${cyclic.map((id) => `\`${id}\``).join(', ')}. ` +
        'These depend on each other. Do not add to it; break it and say so.',
    );
  }

  if (dangling.length > 0) {
    lines.push('');
    lines.push(
      `**Dangling references** — ${dangling.length} edge(s) point at something that is not in the graph: ` +
        dangling
          .slice(0, FOLDER_SAMPLE)
          .map((e) => `\`${e.from}\` → \`${e.to}\` (${e.kind})`)
          .join(', ') +
        '. The reference is real; its target is missing or was not parseable.',
    );
  }

  return lines.join('\n');
}

/**
 * The real public signatures, from the extracted contracts.
 *
 * These strings are `node.contract.exports` and `node.contract.signals` exactly as
 * the parser produced them — `formatJsExport` for JS/TS, `formatGdExport` /
 * `formatGdFunction` / `formatGdSignal` for GDScript. Nothing is retyped by hand,
 * because a hand-typed signature is exactly the fabrication this brief must not
 * contain (SPEC R5, R9).
 *
 * A node with no exports is listed with what it does expose instead — its
 * `requires`, or a note that it exports nothing — so an AI reading the list can
 * tell "this file has no public interface" from "this file is not here".
 */
function signaturesSection(root: string, manifest: Manifest, task: string): string {
  const exists = (file: string): boolean => existsSync(join(root, file));

  // Ranking is core's, not this file's: the same scores `compileContext` uses to
  // decide what to attach. In one-shot mode the task says which files matter; in
  // interactive mode there is no task yet and the ranking is simply empty, which
  // the section says rather than pretending otherwise.
  const ranked = rankRelevantFiles({ logs: '', issue: task, manifest, exists });
  const priority = new Set(ranked.map((r) => r.file));

  const withExports = manifest.nodes
    .filter((n) => n.contract.exports.length > 0 || n.contract.signals.length > 0)
    .sort((a, b) => {
      const pa = priority.has(a.id) ? 0 : 1;
      const pb = priority.has(b.id) ? 0 : 1;
      return pa - pb || a.id.localeCompare(b.id);
    });

  const lines = [heading(2, 'Public signatures')];
  lines.push('');
  lines.push('Read out of each file\'s syntax tree by core\'s parsers. These are the');
  lines.push('real interfaces — if a name is not here, it does not exist, and calling');
  lines.push('it anyway is the failure this brief exists to prevent.');
  lines.push('');

  if (task.trim() !== '' && ranked.length > 0) {
    lines.push('Ranked against your task (core\'s own ranking, best first):');
    lines.push('');
    for (const entry of ranked.slice(0, MAX_RANKED)) {
      lines.push(`- \`${entry.file}\` — ${entry.reason}`);
    }
    lines.push('');
  }

  if (withExports.length === 0) {
    lines.push('(no file in the graph exports anything readable)');
    return lines.join('\n');
  }

  for (const node of withExports) {
    lines.push(`### \`${node.id}\` (${node.type})`);
    lines.push('');
    for (const signature of node.contract.exports) lines.push(`- \`${signature}\``);
    for (const signal of node.contract.signals) lines.push(`- signal \`${signal}\``);
    if (node.contract.requires.length > 0) {
      lines.push(`- requires (assumed to exist at runtime): ${node.contract.requires.join(', ')}`);
    }
    lines.push('');
  }

  const silent = manifest.nodes.filter((n) => n.contract.exports.length === 0 && n.contract.signals.length === 0);
  if (silent.length > 0) {
    lines.push(
      `${silent.length} further node(s) export nothing readable (assets and entrypoints, mostly): ` +
        silent.slice(0, FOLDER_SAMPLE).map((n) => `\`${n.id}\``).join(', ') +
        (silent.length > FOLDER_SAMPLE ? ', …' : ''),
    );
  }

  return lines.join('\n');
}

/**
 * The rules an AI must obey about prefabs and `scene.json` (SPEC R6/R7).
 *
 * The rule *reasons* are `PREFAB_RULE_REASONS`, the same table `npm run
 * lint:prefabs` prints — so the brief and the linter cannot disagree about why
 * `Math.random()` in a prefab is an error. The scene facts are read from the
 * project: the schema version it declares, the prefabs it places, how many times.
 */
function sceneRulesSection(scene: SceneRead): string {
  const lines = [heading(2, 'Rules for `scene.json` and prefabs')];
  lines.push('');
  lines.push('These are not style preferences. Breaking one produces a project that');
  lines.push('looks fine and behaves wrong.');
  lines.push('');

  lines.push('**1. Every object in the scene must be a prefab.**');
  lines.push('');
  lines.push('A prefab is a pure function:');
  lines.push('');
  lines.push('```ts');
  lines.push('create(three, params, rng) -> { object, parts }');
  lines.push('```');
  lines.push('');
  lines.push('`three` and `rng` are *parameters*. Never `import * as THREE` inside a prefab, and');
  lines.push('never call `Math.random()` — randomness goes through the seeded `rng`, which is');
  lines.push('what makes a scene reproducible and diffable. Each rule below is enforced by');
  lines.push('`npm run lint:prefabs`, so a violation will be reported against your file:');
  lines.push('');
  for (const rule of PREFAB_RULES) {
    lines.push(`- \`${rule}\` — ${PREFAB_RULE_REASONS[rule]}.`);
  }
  lines.push('');
  lines.push('If you need a new kind of object, add a prefab to `prefabs/` and register it in');
  lines.push('`prefabs/index.ts`. Do not add a new kind of object anywhere else.');
  lines.push('');

  lines.push('**2. All placement lives in `scene.json`.**');
  lines.push('');
  lines.push('Positions, rotations, scales and which prefab goes where are all in the');
  lines.push('`scene.json` file. To move an object, edit the JSON — that is the only correct');
  lines.push('way. If you find yourself wanting to write a position in TypeScript, you want a');
  lines.push('`params` entry on a prefab instead.');
  lines.push('');

  lines.push('**3. The scene file is validated with Zod on every read and every write.**');
  lines.push('');
  lines.push(`- \`version\` must be exactly \`${SCENE_SCHEMA_VERSION}\`.`);
  lines.push('- Every instance `id` is unique, and unique across lights too.');
  lines.push('- `parent` must name another instance; parent chains must not be cycles.');
  lines.push('- `transform.position`, `.rotation` and `.scale` are always exactly 3 numbers.');
  lines.push('- Unknown keys are **rejected**. A typo like `postion` fails loudly rather than');
  lines.push('  being ignored — that is deliberate, and a refusal names the JSON path.');
  lines.push('');

  if (scene.file === null) {
    lines.push(
      'The scene contents are not in this brief (see the note at the end). Treat the scene as',
      'unknown rather than empty: an AI that assumes "no scene" will happily write one that',
      'overwrites what is there.',
    );
    return lines.join('\n');
  }

  const byPrefab = new Map<string, number>();
  for (const instance of scene.file.instances) {
    byPrefab.set(instance.prefab, (byPrefab.get(instance.prefab) ?? 0) + 1);
  }
  const parented = scene.file.instances.filter((i) => i.parent !== undefined).length;

  lines.push('**This project\'s scene, as read from disk.**');
  lines.push('');
  lines.push(`- Name: \`${scene.file.name}\`, version \`${scene.file.version}\`, engine \`${scene.file.engine}\`, seed \`${scene.file.seed}\``);
  lines.push(`- Instances: ${scene.file.instances.length} (${parented} parented)`);
  lines.push(`- Lights: ${scene.file.lights.length}; camera: ${scene.file.camera.kind}`);
  lines.push('- Prefabs placed: ' + (byPrefab.size > 0 ? countBy([...byPrefab.entries()].sort().map(([name, n]) => `${name} (${n})`)) : '(none)'));
  lines.push('');
  lines.push('An instance may only name a prefab in that list, and its `params` must satisfy');
  lines.push('that prefab\'s own schema — a `params` key the prefab does not declare is');
  lines.push('rejected rather than ignored.');

  return lines.join('\n');
}

// ── Facts read off the project ───────────────────────────────────────────────

/** The engine, as the brief should say it. */
function engineLabel(root: string, scene: SceneFile | null): string {
  if (existsSync(join(root, 'project.godot'))) return 'Godot 4.x (GDScript)';
  const declared = scene?.engine;
  if (declared === 'three') return 'Three.js (WebGL) with HTML5 and Vite';
  if (scene === null) return 'HTML5 and Three.js (no scene file, so the engine is inferred)';
  return String(declared);
}

/**
 * Extract the project's graph and wrap it in a manifest.
 *
 * `generatedAt` is passed straight through and may be `undefined`-driven away:
 * `buildManifest` requires the field, so an absent timestamp is replaced with the
 * empty string and then omitted from the output. Nothing here reads the clock.
 */
function manifestFor(root: string, generatedAt: string | undefined): Manifest {
  const graph = existsSync(join(root, 'project.godot'))
    ? extractGodotProject(root)
    : extractJsProject(root);
  return buildManifest(root, graph, generatedAt ?? '');
}

/**
 * The prefab modules, as file paths.
 *
 * Files under a `prefabs/` directory, excluding the registry's own index — which
 * exports a registry object, not a prefab, and counting it would inflate the
 * number by one every project.
 */
function prefabModules(manifest: Manifest): string[] {
  const briefDir = `/${BRIEF_DIR}/`;
  return manifest.nodes
    .map((n) => n.id)
    .filter((id) => !id.includes(briefDir))
    .filter((id) => /(^|\/)prefabs\/[^/]+\.(ts|js|mjs|cjs|jsx|tsx)$/.test(id))
    // The registry index exports a `PrefabRegistry`, not a `PrefabDefinition`.
    // Counting it would inflate every project's prefab count by exactly one, and
    // a number that is wrong by a constant is a number nobody can trust.
    .filter((id) => !/(^|\/)prefabs\/index\.(ts|js|mjs|cjs)$/.test(id))
    .sort((a, b) => a.localeCompare(b));
}

/** `a (1), b (2)` — a list with counts, for a line that needs them. */
function countBy(items: readonly string[]): string {
  return items.length > 0 ? items.join(', ') : '(none)';
}

/**
 * `a (2), b (1)` — values collapsed to one entry each, with their totals.
 *
 * Distinct from `countBy`, which does not collapse: "Node types: module, module,
 * module" is not a summary, it is the node list printed with extra commas. The
 * count belongs next to the value, and the values are sorted by how common they
 * are so the dominant one is read first.
 */
function summarize(values: readonly string[]): string {
  if (values.length === 0) return '(none)';

  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, n]) => `${value} (${n})`)
    .join(', ');
}

/** Dependencies a project declares. Read, never inferred from import text. */
function readDeclaredDependencies(root: string): {
  dependencies: string[];
  devDependencies: string[];
} {
  const raw = readTextFileOrNull(join(root, 'package.json'));
  if (raw === null) return { dependencies: [], devDependencies: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A package.json an AI truncated is a real state a brief should survive.
    // Reporting nothing declared is honest; reporting nothing *at all* would be
    // a silent omission.
    return { dependencies: [], devDependencies: [] };
  }

  if (typeof parsed !== 'object' || parsed === null) return { dependencies: [], devDependencies: [] };
  const record = parsed as Record<string, unknown>;

  const names = (value: unknown): string[] => {
    if (typeof value !== 'object' || value === null) return [];
    return Object.keys(value as Record<string, unknown>).sort((a, b) => a.localeCompare(b));
  };

  return {
    dependencies: names(record['dependencies']),
    devDependencies: names(record['devDependencies']),
  };
}

/** The project's folder name, which is how the brief and the title bar name it. */
function projectName(root: string): string {
  const name = basename(root);
  return name === '' ? root : name;
}
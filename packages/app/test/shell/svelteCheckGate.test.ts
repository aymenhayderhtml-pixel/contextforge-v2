/**
 * packages/app/test/shell/svelteCheckGate.test.ts
 *
 * `svelte-check` is in `verify` and must stay there.
 *
 * ## Why this test exists
 *
 * `npm run verify` runs six stages now, and `check:svelte` is the one that reads
 * `.svelte` files. `tsc --build` does not, so every defect listed below was
 * invisible to the type checker, invisible to the unit tests, and invisible to
 * `svelte-check` itself before it was installed. Some were real runtime bugs, not
 * type noise:
 *
 * - The viewport sent `transform:` where core's `SceneEdit` names the field
 *   `patch:`, so `edit.patch` was `undefined` and **dragging a gizmo moved
 *   nothing**, with no error.
 * - `readBrief` returned no `stats` while the brief panel read `brief.stats.nodes`,
 *   so reopening a project showed four count rows reading `undefined`.
 * - `brief` was read inside an async clipboard handler after an `{#if}` guard that
 *   does not narrow there.
 * - `store.notices` was typed `Notice[]` while holding `LiveNotice[]`, so six
 *   `notice.id` reads were reading a property the type did not have.
 *
 * This test does not re-check those — `svelte-check` does. It asserts that the gate
 * **is wired in and is configured to fail on errors**, because a check that is
 * installed but not in `verify` catches nothing, and that failure is silent.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/**
 * A JSONC config with its comments stripped, **one character at a time**.
 *
 * `packages/app/tsconfig.svelte.json` is JSONC — the reasoning for `skipLibCheck`
 * is a comment, and that reasoning is the reason the setting exists, so it is not
 * removed to make a test parse.
 *
 * A regex strip is **not** good enough here, and it took two attempts to see why.
 * The config's `include` globs contain a double star followed by a slash, which
 * together are a comment terminator to any block-comment pattern. Stripping
 * therefore deleted the star from every glob and left `src/renderer*.svelte`,
 * which parses fine — so the test failed with "expected false" and no hint that a
 * comment stripper had eaten the very value it was asserting on.
 *
 * So this walks the text and only treats those two characters as a terminator
 * while it is inside a comment. That distinction is the whole problem, and a regex
 * cannot express it: the two cases are not distinguishable by the characters alone.
 */
function readJsonc(path: string): {
  compilerOptions?: Record<string, unknown>;
  include?: string[];
  references?: { path: string }[];
  exclude?: string[];
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  const raw = read(path);
  let out = '';
  let inComment = false;
  let inString = false;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i] as string;
    const next = raw[i + 1];

    if (inComment) {
      if (c === '*' && next === '/') {
        inComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\' && next !== undefined) {
        out += next;
        i += 1;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '*') {
      inComment = true;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i += 1;
      continue;
    }
    out += c;
  }
  const stripped = out;
  return JSON.parse(stripped);
}

describe('the svelte-check gate', () => {
  it('is a real devDependency, not an npx call at verify time', () => {
    const pkg = JSON.parse(read('package.json')) as {
      devDependencies?: Record<string, string>;
    };
    // A `npx svelte-check` inside the script would download a different version on
    // every machine that runs verify, so the gate would not be the gate.
    expect(pkg.devDependencies?.['svelte-check']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('runs in npm run verify', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['verify']).toContain('check:svelte');
  });

  it('runs after typecheck and before the tests', () => {
    // Order matters: `svelte-check` reads core through `dist`, so it must follow
    // the build or it type-checks against stale declarations. That is not
    // hypothetical — it reported four phantom errors mid-task until a
    // `tsc --build --force` corrected the `.d.ts`.
    const { scripts } = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const verify = scripts['verify'] ?? '';
    expect(verify.indexOf('typecheck')).toBeLessThan(verify.indexOf('check:svelte'));
    expect(verify.indexOf('check:svelte')).toBeLessThan(verify.indexOf('test'));
  });

  it('fails on errors and tolerates warnings', () => {
    // Two warnings are known and documented in AI.md (the panel resizers). Failing
    // on warnings would mean silencing them, and silencing them would hide the next
    // real one.
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['check:svelte']).toContain('--threshold error');
  });

  it('reads the renderer through a config that excludes node_modules', () => {
    // Without `skipLibCheck`, four third-party `.d.ts` defects fail the build —
    // three in `@types/three` (GPUTexture is not in this TS lib) and two in
    // Svelte's own esrap resolution. None can be fixed from this repo, and a gate
    // that cannot go green gets ignored.
    const config = readJsonc('packages/app/tsconfig.svelte.json');
    expect(config.compilerOptions?.['skipLibCheck']).toBe(true);
    expect(config.include?.some((p) => p.includes('**/*.svelte'))).toBe(true);
  });

  it('is not in the tsc project graph, which cannot compile .svelte', () => {
    const app = readJsonc('packages/app/tsconfig.json');
    expect(app.references.map((r) => r.path)).not.toContain('./tsconfig.svelte.json');
    // The renderer stays excluded from `tsc`; `svelte-check` is the separate
    // reader for it. Both statements are load-bearing and the second is why the
    // first is safe.
    expect(app.exclude).toContain('src/renderer');
  });

  it('has a Svelte config, which svelte-check needs and Vite does not', () => {
    // Without it, svelte-check reports "No Svelte configuration found in vite
    // config" once per component — twelve copies of one missing-file error.
    expect(read('packages/app/svelte.config.js')).toContain('vitePreprocess');
  });
});

describe('what the gate found, and where each fix lives', () => {
  it('the gizmo edit names the field core reads', () => {
    // The regression that was a live bug: core's `SceneEdit` names it `patch`, and
    // `applySceneEdit` reads `edit.patch`.
    const viewport = read('packages/app/src/renderer/viewport/Viewport.svelte');
    expect(viewport).toMatch(/op: 'setTransform',[\s\S]{0,120}patch:/);
    expect(viewport).not.toMatch(/op: 'setTransform',[\s\S]{0,120}\btransform:/);
  });

  it('the brief channel and the brief panel agree on one type', () => {
    // Both used to spell their own shape out, and they disagreed: the channel said
    // no `stats`, the panel read `brief.stats`. Asserted on the response field
    // specifically, because `generateBrief` was always right and only `readBrief`
    // drifted.
    const ipc = read('packages/app/src/ipc.ts');
    const channel = /\[CHANNELS\.readBrief\]:([\s\S]*?)\n  \};/.exec(ipc);
    expect(channel, 'the readBrief channel should be declared').toBeTruthy();
    expect(channel?.[1]).toContain('Result<BriefResult | null>');
  });

  it('core recovers the counts it writes into the markdown', () => {
    // `readBrief` has no manifest and cannot re-extract the project cheaply, and
    // the counts that matter are the ones the brief was *written* with.
    const brief = read('packages/core/src/context/brief.ts');
    expect(brief).toContain('export function briefStatsFrom');
    expect(brief).toMatch(/stats: briefStatsFrom\(markdown\)/);
  });

  it('the store types its notices with the ids the screen reads', () => {
    const store = read('packages/app/src/renderer/store.ts');
    expect(store).toContain('readonly notices: readonly LiveNotice[]');
  });

  it('the sidebar owns the ScreenId union it hands to App.svelte', () => {
    // One owner. Two definitions of a screen list is a list that can disagree.
    expect(read('packages/app/src/renderer/Sidebar.svelte')).toContain(
      "export type ScreenId = 'project' | 'context' | 'graph' | 'scene' | 'patch'",
    );
    expect(read('packages/app/src/renderer/App.svelte')).not.toMatch(
      /type ScreenId = 'project'/,
    );
  });
});
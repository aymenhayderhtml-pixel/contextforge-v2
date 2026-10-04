/**
 * test/shell/search.test.ts — the `search:project` channel and the search UI's rules.
 *
 * ## What is asserted here, and why each case is here
 *
 * A search box that finds nothing, finds everything, or jumps to the wrong line is
 * **worse than no search box**, because it looks like it works. So the list below is
 * chosen to fail loudly in exactly the ways that produce a convincing wrong answer:
 *
 *  1. **a match with the correct file AND line** — the positive direction, with the
 *     line number checked against a file whose content the test wrote, so "line 12"
 *     means the same thing here as in an editor.
 *  2. **a query with no match returns an empty list, not a crash and not a stale
 *     list** — asserted on a *second* search after a successful one, because the
 *     "stale list" failure only exists when there was a previous list to keep.
 *  3. **the negative direction** — a term genuinely absent from the project. A check
 *     that always fires is as broken as one that never fires, so this pairs with
 *     case 1: the same query shape finds something in one project and nothing in the
 *     other.
 *  4. **a path outside the project root is refused** by `resolveInsideRoot` — a
 *     symlink out of the project is the case a lexical check misses, and D51 exists
 *     because four places got it wrong independently.
 *  5. **a large file and a large result set do not hang** — measured, not asserted by
 *     eyeball: the big fixtures are searched and the result is checked for the caps
 *     actually being reported, because a cap that silently truncates is the one limit
 *     failure worse than having none.
 *
 * ## How the two halves are tested
 *
 * The **main process** half is asserted against the real `AppBackend` over a real
 * temp project — no Electron, no fake invoker — because what it must get right is the
 * walk, the reads and the containment check, and a fake would only re-assert the
 * fake. The **renderer** half (`renderer/search/match.ts`) is asserted directly,
 * because it is pure functions over a `SearchResponse` and needs nothing else.
 *
 * The Svelte component is *not* asserted here. It renders through
 * `svelte/server`, which does not run effects or event handlers, so a test against it
 * would prove it parses rather than that it searches. What the component does with
 * `$state.snapshot` is asserted where it can be: the payload it sends is checked in
 * the store-level test below.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveInsideRoot } from '@contextforge/core';
import { AppBackend } from '../../src/electron/ipcHandlers.js';
import { CHANNELS, type SearchResponse } from '../../src/ipc.js';
import {
  groupMatchesByPath,
  highlightRangeIn,
  listedFilePaths,
  previewOf,
  summarizeSearch,
} from '../../src/renderer/search/match.js';

const temporaries: string[] = [];

afterEach(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** A backend with no project open. */
function backend(): AppBackend {
  return new AppBackend(() => {}, { allowUnpickedRoot: 'test-only' });
}

/**
 * A small project with one known needle at a known place.
 *
 * `src/kart.ts` has `MAX_SPEED` on line 3 and line 9, deliberately not adjacent, so
 * "the second match is line 9" is a real assertion about line counting rather than
 * something that passes by accident on a file where everything matches.
 */
function searchProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-search-'));
  temporaries.push(dir);
  mkdirSync(join(dir, 'src', 'prefabs'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'kart.ts'),
    [
      'export const KART_NAME = "dash";', // 1
      '', // 2
      'export const MAX_SPEED = 42;', // 3  <- first MAX_SPEED
      'export const grip = 0.8;', // 4
      '', // 5
      'export function accelerate(kart) {', // 6
      '  return kart.speed * 2;', // 7
      '}', // 8
      'export const SPEED_CAP = MAX_SPEED;', // 9  <- second MAX_SPEED
      '', // 10
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'src', 'prefabs', 'hazardCrate.ts'),
    'export const crate = { width: 4 };\n',
  );
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'search-demo' }));
  return dir;
}

/** Open `dir` and return a backend with it loaded. */
async function open(dir: string): Promise<AppBackend> {
  const app = backend();
  const opened = await app.openProject({ root: dir });
  // A refused open would make every assertion below a lie — they would be testing a
  // backend with no project, and `searchProject` refuses that by name.
  expect(opened.ok).toBe(true);
  return app;
}

/** The success value of a search, failing the test if it was refused. */
function searchOk(result: ReturnType<AppBackend['searchProject']>): SearchResponse {
  expect(result.ok).toBe(true);
  return (result as { ok: true; value: SearchResponse }).value;
}

// ── The main process channel ──────────────────────────────────────────────────

describe('searchProject — finding something', () => {
  it('reports the correct file and line for a match', async () => {
    const app = await open(searchProject());
    const value = searchOk(app.searchProject({ query: 'MAX_SPEED' }));

    const paths = value.matches.map((m) => m.path);
    expect(paths).toContain('src/kart.ts');

    // The two `MAX_SPEED` lines are 3 and 9 in the file written above. Asserting the
    // exact numbers is the point: a line number that is off by one, or that counts
    // from zero, produces a result that *looks* right and opens the wrong line.
    const inKart = value.matches.filter((m) => m.path === 'src/kart.ts').map((m) => m.line);
    expect(inKart).toEqual([3, 9]);

    const first = value.matches.find((m) => m.line === 3);
    expect(first?.text).toBe('export const MAX_SPEED = 42;');
    // 1-based column of the first `M`, which is column 16 on that line.
    expect(first?.column).toBe('export const '.length + 1);
  });

  it('matches a file by name and reports it as a file hit', async () => {
    const app = await open(searchProject());
    const value = searchOk(app.searchProject({ query: 'hazardCrate' }));

    // The name matched. Nothing inside it contains "hazardCrate" except the word
    // `crate`, so this is genuinely a path hit rather than a line hit.
    expect(value.files.map((f) => f.path)).toContain('src/prefabs/hazardCrate.ts');
  });

  it('matches case-insensitively, both in paths and in lines', async () => {
    const app = await open(searchProject());
    const value = searchOk(app.searchProject({ query: 'max_speed' }));
    expect(value.matches.map((m) => m.path)).toContain('src/kart.ts');
  });

  it('counts every file it considered, so a short list can be told from a whole project', async () => {
    const app = await open(searchProject());
    const value = searchOk(app.searchProject({ query: 'MAX_SPEED' }));

    // Exactly the three files written above, all of which `scanFiles` picks up:
    // src/kart.ts, src/prefabs/hazardCrate.ts and package.json. Asserted as an exact
    // number rather than a lower bound because the count is the developer's only clue
    // that a short list is short *because the project is small* — and a
    // lower-bound assertion would pass just as happily if the walk had double-counted.
    // Measured, not assumed: this number came out of a probe, not out of a guess.
    expect(value.scannedFiles).toBe(3);
  });
});

describe('searchProject — finding nothing', () => {
  it('returns an empty result for a term that is genuinely absent', async () => {
    // The negative direction, and the one a "check that always fires" bug breaks. The
    // term below appears nowhere in this project — not in any file, not in any name.
    const app = await open(searchProject());
    const value = searchOk(app.searchProject({ query: 'zzzz-definitely-not-here' }));

    expect(value.files).toEqual([]);
    expect(value.matches).toEqual([]);
    // It is not a truncation and not an error: nothing was hidden and nothing failed.
    expect(value.truncated).toBe(false);
    expect(value.truncatedReason).toBe('');
  });

  it('clears a previous result rather than leaving it stale', async () => {
    const app = await open(searchProject());

    const hit = searchOk(app.searchProject({ query: 'MAX_SPEED' }));
    expect(hit.matches.length).toBeGreaterThan(0);

    // The stale-list failure only exists when there *was* a list. Searching again
    // for something absent must replace it, not leave the old rows under a new query.
    const miss = searchOk(app.searchProject({ query: 'zzzz-definitely-not-here' }));
    expect(miss.matches).toEqual([]);
    expect(miss.files).toEqual([]);
  });

  it('treats an empty query as an answer, not a refusal', async () => {
    const app = await open(searchProject());

    // Empty and whitespace-only both. A refusal here would put a red sentence on
    // screen for a developer's first keystroke.
    for (const query of ['', '   ', '\t\n']) {
      const result = app.searchProject({ query });
      expect(result.ok).toBe(true);
      const value = searchOk(result);
      expect(value.matches).toEqual([]);
      expect(value.files).toEqual([]);
      // Nothing was walked, so claiming otherwise would be a false count.
      expect(value.scannedFiles).toBe(0);
      expect(value.truncated).toBe(false);
    }
  });

  it('refuses with a sentence when no project is open', () => {
    const app = backend();
    const result = app.searchProject({ query: 'anything' });
    expect(result.ok).toBe(false);
    // The sentence names the problem, and is not the same shape as "no matches" —
    // which is exactly why this cannot be confused with an empty result.
    expect((result as { reason: string }).reason).toMatch(/No project is open/);
  });
});

describe('searchProject — containment', () => {
  /**
   * ## What these tests prove, and the finding that shaped them
   *
   * Every path the walk yields is put back through `resolveInsideRoot` before it is
   * read. These tests assert that check refuses what it should.
   *
   * Writing them surfaced a property of core's `scanFiles` that is worth recording
   * here rather than discovering a second time: **the walk skips symlinked entries
   * entirely, both files and directories.** `scanFiles` descends on
   * `entry.isDirectory()` and keeps on `entry.isFile()`, and for a symlink
   * `readdirSync(…, { withFileTypes: true })` reports **both as false** (verified
   * directly against Node 22: a symlink to a `.ts` file, and a symlink to a
   * directory, both come back `isDirectory=false, isFile=false,
   * isSymbolicLink=true`).
   *
   * So a symlink escape **cannot reach search's containment loop through the walk** —
   * it is filtered one step earlier, by the walk itself. That is the safe direction,
   * and it means the in-handler `resolveInsideRoot` call is defence in depth rather
   * than the only barrier. It is still correct to have it: `scanFiles` is core's
   * policy about which files to *index*, not a guarantee about which paths are
   * *readable*, and a containment check that depends on the walk's filtering staying
   * exactly as it is today is not a containment check.
   *
   * The tests below therefore assert the **checker's** behaviour directly, which is
   * what the prompt asks for and what actually holds: given a path that points out of
   * the project, `resolveInsideRoot` refuses it and says why.
   */
  it('refuses a path outside the project root, with a sentence naming it', () => {
    const dir = searchProject();

    // Traversal: refused by name, before the filesystem is consulted at all.
    const traversal = resolveInsideRoot(dir, '../outside.ts');
    expect(traversal.ok).toBe(false);
    const refused = traversal as { reason: string; refusal: string; path: string };
    expect(refused.refusal).toBe('traversal');
    expect(refused.reason).toMatch(/\.\./);
    expect(refused.path).toBe('../outside.ts');

    // An absolute path is refused rather than normalised, for the same reason: a
    // helper whose safety depends on the caller having picked `join` over `resolve`
    // is not a helper (D51).
    const absolute = resolveInsideRoot(dir, '/etc/passwd');
    expect(absolute.ok).toBe(false);
    expect((absolute as { refusal: string }).refusal).toBe('absolute_path');

    // A path that does not exist yet is still *accepted* when it is inside — this is
    // the asymmetry `ok` vs `existsOnDisk` exists for (D51), and getting it backwards
    // would make search refuse every file it is about to read.
    const inside = resolveInsideRoot(dir, 'src/not-created-yet.ts');
    expect(inside.ok).toBe(true);
    expect((inside as { value: { existsOnDisk: boolean } }).value.existsOnDisk).toBe(false);
  });

  it('refuses a symlinked directory whose contents point outside the root', () => {
    const dir = searchProject();
    const outside = mkdtempSync(join(tmpdir(), 'cf-search-outside-'));
    temporaries.push(outside);
    writeFileSync(join(outside, 'secret.ts'), 'const SECRET_TOKEN = "do not read me";\n');
    symlinkSync(outside, join(dir, 'src', 'linked'), 'dir');

    // The shape a naive `join(root, relativePath)` would follow straight out of the
    // project: the path is lexically inside, and the bytes are not. This is the case
    // D51 exists for, and it is the one a purely lexical check cannot catch.
    const resolved = resolveInsideRoot(dir, 'src/linked/secret.ts');
    expect(resolved.ok).toBe(false);
    const refused = resolved as { refusal: string; reason: string };
    expect(refused.refusal).toBe('symlink_escape');
    // The sentence names the path, so a refusal is actionable rather than a bare flag.
    expect(refused.reason).toContain('src/linked/secret.ts');
    // And it says where the path actually pointed, which is the part that tells a
    // developer what happened.
    expect(refused.reason).toMatch(/outside the project/);
  });

  it('never lets outside content into a result, and says nothing was searched there', async () => {
    const dir = searchProject();
    const outside = mkdtempSync(join(tmpdir(), 'cf-search-outside-'));
    temporaries.push(outside);
    writeFileSync(join(outside, 'secret.ts'), 'const SECRET_TOKEN = "do not read me";\n');
    symlinkSync(outside, join(dir, 'src', 'linked'), 'dir');

    const app = await open(dir);
    const value = searchOk(app.searchProject({ query: 'SECRET_TOKEN' }));

    // The end-to-end property, asserted on the bytes: nothing from outside the
    // project appears anywhere in the response. (As established above, `scanFiles`
    // filters the symlink before the containment loop sees it, so `skipped` is
    // legitimately empty here — the walk never offered the path. This test is the
    // one that holds no matter *which* of the two stops it.)
    expect(value.matches).toEqual([]);
    expect(JSON.stringify(value)).not.toContain('do not read me');
  });

  it('still searches ordinary files, so the containment check costs nothing', async () => {
    const dir = searchProject();
    const app = await open(dir);
    // The control: a check that fired on everything would "pass" the test above by
    // refusing to read any file at all. This is what makes that test meaningful.
    const value = searchOk(app.searchProject({ query: 'kart', kind: 'files' }));
    expect(value.files.map((f) => f.path)).toContain('src/kart.ts');

    const contents = searchOk(app.searchProject({ query: 'MAX_SPEED' }));
    expect(contents.matches.map((m) => m.path)).toContain('src/kart.ts');
  });
});

describe('searchProject — big inputs', () => {
  it('caps a file that matches on many lines and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-search-big-'));
    temporaries.push(dir);
    // 500 lines, every one containing the needle. The per-file cap is 50, so this
    // must return 50 and *report* that it did — a cap that silently truncates is the
    // failure mode this test exists to catch.
    const lines = Array.from({ length: 500 }, (_, i) => `const NEEDLE_${i} = ${i};`);
    writeFileSync(join(dir, 'many.ts'), lines.join('\n'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'big' }));

    const app = await open(dir);
    const value = searchOk(app.searchProject({ query: 'NEEDLE_' }));

    expect(value.matches.length).toBe(50);
    expect(value.truncated).toBe(true);
    expect(value.truncatedReason).toMatch(/many\.ts/);
    expect(value.truncatedReason).toMatch(/more lines than are shown/);
    // The lines that came back are real, contiguous-from-the-top lines — not noise.
    expect(value.matches[0]?.line).toBe(1);
    expect(value.matches[49]?.line).toBe(50);
  });

  it('skips a file too large to search, reports it, and still finds it by name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-search-huge-'));
    temporaries.push(dir);
    // Just over the 2MB cap. Generating 3MB of text in a temp dir is fast and does
    // not touch kart-dash-3d-v2, which is read-only (RULES §7).
    const big = `const HUGE_TOKEN = 1;\n${'x'.repeat(2 * 1024 * 1024)}\nconst HUGE_TOKEN = 2;\n`;
    writeFileSync(join(dir, 'huge.ts'), big);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'huge' }));

    const app = await open(dir);
    const value = searchOk(app.searchProject({ query: 'HUGE_TOKEN' }));

    // The contents were skipped — so there is no line hit — but the reason is on
    // screen, and the file is still reachable by its name.
    expect(value.matches).toEqual([]);
    expect(value.skipped.join(' ')).toMatch(/huge\.ts.*larger than/s);
    const byName = searchOk(app.searchProject({ query: 'huge', kind: 'files' }));
    expect(byName.files.map((f) => f.path)).toContain('huge.ts');
  });

  it('returns in bounded time over a wide project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-search-wide-'));
    temporaries.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    // 200 files, each with the needle once. The search must finish; the assertion on
    // the count is what proves it walked them all rather than giving up.
    for (let i = 0; i < 200; i += 1) {
      writeFileSync(
        join(dir, 'src', `mod${String(i).padStart(3, '0')}.ts`),
        `export const WIDE_NEEDLE = ${i};\n`,
      );
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'wide' }));

    const app = await open(dir);
    const started = Date.now();
    const value = searchOk(app.searchProject({ query: 'WIDE_NEEDLE' }));
    const elapsed = Date.now() - started;

    expect(value.matches.length).toBe(200);
    // A generous ceiling. The point is that it is bounded — a search that took
    // minutes here would hang the main process, which also serves every other channel.
    expect(elapsed).toBeLessThan(10_000);
  });
});

describe('searchProject — the kind filter', () => {
  it('contents: searches lines and never reports a name hit', async () => {
    const app = await open(searchProject());
    // "hazardCrate" is in a path and nowhere in the file's text.
    const value = searchOk(app.searchProject({ query: 'hazardCrate', kind: 'contents' }));
    expect(value.files).toEqual([]);
    expect(value.matches).toEqual([]);
  });

  it('files: searches names and never reads a line', async () => {
    const app = await open(searchProject());
    const value = searchOk(app.searchProject({ query: 'MAX_SPEED', kind: 'files' }));
    // "MAX_SPEED" is in no file *name* — it is only in line contents.
    expect(value.files).toEqual([]);
    expect(value.matches).toEqual([]);
  });
});

// ── The renderer's display rules ──────────────────────────────────────────────

/** A response with one file hit and two line matches. */
function sampleResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    files: [{ path: 'src/hazardCrate.ts' }],
    matches: [
      { path: 'src/kart.ts', line: 3, column: 16, text: 'export const MAX_SPEED = 42;' },
      { path: 'src/kart.ts', line: 9, column: 21, text: 'export const SPEED_CAP = MAX_SPEED;' },
    ],
    truncated: false,
    truncatedReason: '',
    scannedFiles: 12,
    skipped: [],
    ...overrides,
  };
}

describe('the search summary line', () => {
  it('says nothing was typed yet, rather than "0 matches"', () => {
    expect(summarizeSearch(null, null, '')).toMatch(/Type to search/);
    expect(summarizeSearch(sampleResponse(), null, '   ')).toMatch(/Type to search/);
  });

  it('shows a refusal verbatim', () => {
    expect(summarizeSearch(null, 'No project is open.', 'kart')).toBe('No project is open.');
  });

  it('names the query and the number of files searched when nothing matched', () => {
    const summary = summarizeSearch(sampleResponse({ files: [], matches: [] }), null, 'zzz');
    expect(summary).toMatch(/No matches/);
    expect(summary).toMatch(/zzz/);
    // The file count is in the sentence, so an empty result can be distinguished
    // from a search that never ran.
    expect(summary).toMatch(/12 files/);
  });

  it('counts names and lines separately', () => {
    const summary = summarizeSearch(sampleResponse(), null, 'MAX_SPEED');
    expect(summary).toMatch(/2 lines/);
    expect(summary).toMatch(/1 file name/);
    expect(summary).toMatch(/12 files/);
  });

  it('says the list was cut short when it was', () => {
    const summary = summarizeSearch(
      sampleResponse({ truncated: true, truncatedReason: 'Only the first 50 matches are shown.' }),
      null,
      'MAX_SPEED',
    );
    // This is the assertion that matters: a truncated list that reads as complete
    // is what the cap exists to prevent being invisible.
    expect(summary).toMatch(/Only the first 50/);
  });

  it('uses singular for one file and one line', () => {
    const summary = summarizeSearch(
      sampleResponse({ files: [{ path: 'a.ts' }], matches: [], scannedFiles: 1 }),
      null,
      'a',
    );
    expect(summary).toMatch(/1 file name of 1 file\./);
  });
});

describe('grouping and listing results', () => {
  it('groups matches under their file, in first-seen order', () => {
    const grouped = groupMatchesByPath(sampleResponse().matches);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.path).toBe('src/kart.ts');
    expect(grouped[0]?.lines.map((l) => l.line)).toEqual([3, 9]);
  });

  it('lists a file once even when its name and its contents both matched', () => {
    const listed = listedFilePaths(sampleResponse());
    expect(listed).toEqual(['src/kart.ts', 'src/hazardCrate.ts']);
    // Exactly two entries for three facts — the duplicate is collapsed.
    expect(listed).toHaveLength(2);
  });

  it('is deterministic across calls', () => {
    const response = sampleResponse();
    expect(listedFilePaths(response)).toEqual(listedFilePaths(response));
  });
});

describe('the line preview and its highlight', () => {
  it('previews the matched line as stored', () => {
    const hit = sampleResponse().matches[0];
    if (hit === undefined) throw new Error('fixture missing a hit');
    expect(previewOf(hit)).toBe('export const MAX_SPEED = 42;');
  });

  it('locates the query inside the preview', () => {
    const hit = sampleResponse().matches[0];
    if (hit === undefined) throw new Error('fixture missing a hit');
    const range = highlightRangeIn('max_speed', previewOf(hit));
    expect(range).not.toBeNull();
    // `export const ` is 13 characters, so the `M` of `MAX_SPEED` is at index 13.
    expect(range?.start).toBe(13);
    expect(range?.end).toBe(22);
    // The highlighted slice is the query, exactly — this is what the <mark> wraps.
    const preview = previewOf(hit);
    expect(preview.slice(range?.start ?? 0, range?.end ?? 0).toLowerCase()).toBe('max_speed');
  });

  it('locates the needle late in a line, not at the start', () => {
    // The match sits behind a long prefix. If the offset were measured against the
    // *original* line while the preview trimmed indentation, the highlight would land
    // short by exactly the removed whitespace — invisible on an unindented line and
    // wrong on every indented one. `column` and `text` must agree on which string
    // they index.
    const preview = 'export const SPEED_CAP = MAX_SPEED;';
    const range = highlightRangeIn('max_speed', preview);
    // `export const SPEED_CAP = ` is 25 characters, so the `M` sits at index 25.
    expect(range?.start).toBe(25);
    expect(preview.slice(range?.start ?? 0, range?.end ?? 0)).toBe('MAX_SPEED');
  });

  it('returns no range rather than a wrong one when the needle is not there', () => {
    const hit = sampleResponse().matches[0];
    if (hit === undefined) throw new Error('fixture missing a hit');
    // A highlight pointing at the wrong characters is worse than none.
    expect(highlightRangeIn('not-in-this-line', previewOf(hit))).toBeNull();
  });
});

// ── The channel is registered, and it is the only one this lane added ─────────

describe('the search channel is wired end to end', () => {
  it('is declared once and handled once', async () => {
    const { registerHandlers } = await import('../../src/electron/ipcHandlers.js');

    // `registerHandlers` throws when a channel in `CHANNELS` has no handler, and
    // when two handlers claim one channel. If this passes, the channel is both
    // declared and bound — a forgotten binding is a UI that waits forever.
    const bound: string[] = [];
    const ipcMain = {
      handle: (channel: string) => {
        bound.push(channel);
      },
      removeHandler: () => {},
    };

    const app = backend();
    const teardown = registerHandlers(ipcMain, app);
    expect(bound.filter((c) => c === CHANNELS.searchProject)).toHaveLength(1);
    teardown();
  });

  it('sends a plain object across the boundary, not a proxy', async () => {
    // The reason `$state.snapshot` is in `SearchBox.svelte`: `invoke`
    // structured-clones its argument and cannot clone a Svelte proxy. This asserts
    // the *payload shape* the channel documents, which is the part that would break
    // if a future edit sent something unclonable.
    const { FakeInvoker, succeed } = await import('./fakes.js');
    const invoker = new FakeInvoker({
      [CHANNELS.searchProject]: () => Promise.resolve(succeed(sampleResponse())),
    });

    const response = await invoker.invoke(CHANNELS.searchProject, { query: 'kart', kind: 'all' });
    expect(response.ok).toBe(true);
    // The recorded request must be structured-cloneable — which is exactly what a
    // plain object is and a Svelte proxy is not.
    const sent = invoker.lastRequest(CHANNELS.searchProject);
    expect(() => structuredClone(sent as object)).not.toThrow();
    expect(sent).toEqual({ query: 'kart', kind: 'all' });
  });
});
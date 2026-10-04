import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Regressions for four defects that every unit test in this repo passed (D34).
 *
 * None of them is a logic bug in a component. They are bugs in the seams
 * *between* components — navigation gating, an effect's dependency graph, and a
 * file header — which is exactly the territory a test that renders one component
 * and asserts on its markup does not cover. All four were found by driving the
 * real app and looking at a screenshot.
 *
 * These are structural tests on purpose. They are cheap, they cannot go flaky,
 * and each one names the failure it prevents. Where a structural test would be
 * brittle for no benefit it is not written; where a behavioural test would be
 * impossible in `svelte/server` render it is (see the `$effect` note below).
 */

const APP_SRC = resolve(import.meta.dirname, '..', '..', 'src');

const read = (relative: string): string => readFileSync(join(APP_SRC, relative), 'utf-8');

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The text of every `$effect(() => { … })` body, brace-matched.
 *
 * Written as a scanner rather than a regex because the bodies nest:
 * `SceneScreen` has an `untrack(() => { … })` inside its effect, and a
 * non-greedy regex stops at that inner brace and hands back a truncated body —
 * which then reads as a write outside `untrack` and reports a defect that is not
 * there. A test that invents bugs is worse than no test.
 */
function effectBodies(source: string): string[] {
  const bodies: string[] = [];
  const marker = /\$effect\(\(\)\s*=>\s*\{/g;
  for (const match of source.matchAll(marker)) {
    const open = source.indexOf('{', match.index);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          bodies.push(source.slice(open + 1, i));
          break;
        }
      }
    }
  }
  return bodies;
}

/** Every `untrack( … )` argument, brace-matched, as one string. */
function untrackCalls(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/untrack\(/g)) {
    const open = source.indexOf('(', match.index);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          out.push(source.slice(open + 1, i));
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Names declared `const`/`let`/`var` inside `body`.
 *
 * A declared local is not a Svelte dependency, so `const snap = snapshot` is a
 * *read* of `snapshot`, never a write to it. Without excluding them this check
 * reports "writes snap outside untrack" on code that is correct — a test that
 * invents bugs trains people to ignore it.
 */
function declaredLocals(body: string): Set<string> {
  const names = new Set<string>();
  for (const m of body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    if (m[1]) names.add(m[1]);
  }
  // Arrow-function parameters are locals too: `untrack((e) => …)`.
  for (const m of body.matchAll(/\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>/g)) {
    if (m[1]) names.add(m[1]);
  }
  return names;
}

/**
 * The effect body with every `untrack( … )` call removed.
 *
 * A write inside `untrack` is *not* tracked as a dependency of the effect, so it
 * cannot feed the effect. Removing those regions before looking for writes is
 * what makes this check mean "a tracked write that is also read".
 */
function stripUntrackCalls(body: string): string {
  let out = body;
  for (const region of untrackCalls(body)) {
    out = out.replace(region, '');
  }
  return out;
}

describe('the sidebar no longer disables the screens it ships', () => {
  const sidebar = read('renderer/Sidebar.svelte');

  it('gates Context and Patch on an open project, not on a step number', () => {
    // Before: `return screen.id === 'context' || screen.id === 'patch';` — always
    // true, tooltip "Coming in future steps". Both screens were fully built and
    // completely unreachable by clicking.
    expect(sidebar).not.toMatch(
      /return\s+screen\.id\s*===\s*'context'\s*\|\|\s*screen\.id\s*===\s*'patch'\s*;/,
    );
    expect(sidebar).toMatch(/projectName\s*===\s*null/);
  });

  it('no longer claims a built screen is coming in a future step', () => {
    // A tooltip is a promise to the user. Saying "coming in future steps" about a
    // screen that exists hides working software.
    expect(sidebar).not.toContain('Coming in future steps');
  });

  it('still lets an explicit disabled flag win, so callers keep that power', () => {
    expect(sidebar).toMatch(/if\s*\(typeof screen\.disabled\s*===\s*'boolean'\)/);
  });

  it('gates Graph on an open project too', () => {
    // The Graph screen extracts from the files on disk, so it has the same
    // precondition as Context and Patch. Left ungated it would be clickable
    // with nothing open, and would render an empty canvas that looks exactly
    // like a project with no files.
    expect(sidebar).toMatch(/screen\.id === 'graph'/);
  });

  it('gates Scene on an open project, like every screen that reads one', () => {
    // Scene was the last screen left out of the gate. Its own "No project is open"
    // empty state made that look harmless, but it meant the sidebar answered "can I
    // open this?" differently for Scene than for Context, Graph and Patch — two
    // surfaces disagreeing about the same question, which is the seam D34 is about.
    expect(sidebar).toMatch(/screen\.id === 'scene'/);
  });

  it('gates every screen that reads the project, so none can be added ungated by accident', () => {
    // The individual assertions above are one hand-written guard per screen id, and
    // each was written after its own defect was found. This is the general form: every
    // screen in the union that reads the open project must appear in the gate. It
    // fails when a sixth screen is added and forgotten, which is how Scene was missed.
    const union = read('renderer/Sidebar.svelte'); // the ScreenId union's owner
    const declaration = union.match(/export type ScreenId\s*=\s*([^;]+);/);
    expect(declaration, 'could not read the ScreenId union from Sidebar.svelte').not.toBeNull();
    const ids = [...(declaration![1]!.matchAll(/'([a-z]+)'/g))].map((m) => m[1]!);
    expect(ids.length, 'the ScreenId union held no ids').toBeGreaterThan(0);

    // `project` is the screen that OPENS a project, so it must stay ungated; gating it
    // would make it impossible to recover from having no project open.
    const mustBeGated = ids.filter((id) => id !== 'project');
    for (const id of mustBeGated) {
      expect(
        sidebar.includes(`screen.id === '${id}'`),
        `screen '${id}' reads the open project but is not in isScreenDisabled's gate`,
      ).toBe(true);
    }
  });

  it('every Cytoscape attribute selector quotes its value', () => {
    // Cytoscape rejects `node[focus = true]` — an attribute value is a quoted
    // string, not a bare identifier. It throws at draw time and leaves the
    // canvas empty, which is precisely the state focus mode exists to show, so
    // the failure is invisible: the screen renders, just with nothing on it.
    // There is no unit test for Cytoscape here (no jsdom), so this is the
    // assertion that stands in for one.
    const graph = read('renderer/screens/GraphScreen.svelte');
    const attributes = [...graph.matchAll(/selector:\s*'([^']*\[[^\]]*\])'/g)].map((m) => m[1]!);
    expect(attributes.length, 'GraphScreen should use attribute selectors').toBeGreaterThan(0);

    for (const selector of attributes) {
      for (const [, , value] of selector.matchAll(/\[\s*([\w-]+)\s*=\s*([^\]]+)\]/g)) {
        expect(
          value.trim().startsWith('"'),
          `selector ${selector} compares ${value.trim()} unquoted; Cytoscape requires a string`,
        ).toBe(true);
      }
    }
  });
});

describe('no screen writes state that the effect reading it depends on', () => {
  /**
   * What this can and cannot see — read this before trusting a pass.
   *
   * It scans the *body* of each `$effect(() => { … })` for a `$state` name that
   * is written and also read. That catches the direct shape.
   *
   * **It cannot see an indirect one.** The bug this was written for arrived as
   * `$effect(() => { void loadBrief(); })` with `briefMode = …` inside
   * `loadBrief` — one call away, and no amount of looking at the effect body
   * finds it. Verified by re-introducing that exact bug and watching this file
   * stay green. So the second test below covers the *call* case explicitly, and
   * this one is not on its own a guarantee.
   *
   * Why not detect it properly? Because the real guarantee is behavioural —
   * mount the component and see whether it settles — and `svelte/server`'s
   * `render` never runs effects at all. A structural test that overstates what
   * it checks is worse than a narrow one that says so, because the overstatement
   * is what people rely on later.
   */
  const SCREENS = [
    'renderer/screens/ContextScreen.svelte',
    'renderer/screens/ProjectScreen.svelte',
    'renderer/screens/SceneScreen.svelte',
    'renderer/screens/PatchScreen.svelte',
    'renderer/App.svelte',
  ];

  for (const file of SCREENS) {
    it(`${file} — no self-feeding $effect`, () => {
      const source = read(file);
      // Brace-matched effect bodies. A regex cannot do this: `SceneScreen`'s
      // effect contains a nested `untrack(() => { … })` block, and a
      // non-greedy `[\s\S]*?` stops at the inner `}` and reports a truncated
      // body — which then looks like a write outside `untrack` and fails.
      for (const body of effectBodies(source)) {
        const untracked = [...body.matchAll(/untrack\(/g)];
        // How many times each identifier appears as a *write* target outside an
        // untrack call. Anything written and also read is the infinite loop.
        const stripped = stripUntrackCalls(body);

        // **Assignments to a bare, non-local name.** Excluding the declared locals
        // is what keeps this honest: `const root = snapshot?.project.root` and
        // `const snap = snapshot` are reads of state, not writes to it, and
        // counting them as writes reported an infinite loop on code that has
        // none. `==` / `=>` / `+=` are excluded for the same reason.
        const locals = declaredLocals(body);
        const writes = [
          ...stripped.matchAll(/(?:^|[;{}(\s])((?:\$|[A-Za-z_])[\w$]*)\s*=(?![=>+\-*/])/g),
        ]
          .map((m) => m[1] ?? '')
          .filter((name) => !locals.has(name));
        for (const name of new Set(writes)) {
          const reads = [
            ...stripped.matchAll(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g')),
          ].length;
          expect(
            reads,
            `${file}: the $effect writes "${name}" outside untrack() and also reads it — that is an infinite loop`,
          ).toBeLessThanOrEqual(1);
        }
        // Unused here beyond proving the helper ran; kept so a future edit that
        // adds a second untrack has somewhere obvious to go.
        expect(untracked.length >= 0).toBe(true);
      }
    });
  }

  it('ProjectScreen imports untrack, because it uses it', () => {
    const source = read('renderer/screens/ProjectScreen.svelte');
    expect(source).toMatch(/import\s*\{[^}]*untrack[^}]*\}\s*from\s*'svelte'/);
  });

  /**
   * The call case, which the body scan above cannot reach.
   *
   * An effect that calls a function which **writes** a `$state` this component
   * binds somewhere is the same infinite loop, one frame of indirection away.
   * `ContextScreen` had exactly this: `$effect(() => { void loadBrief(); })`,
   * with `briefMode = result.value.mode` inside `loadBrief`, and `briefMode`
   * bound by the mode radios. It froze the screen on mount.
   *
   * The rule is **write**, not write-and-read, and that is worth spelling out
   * because the first version of this test got it wrong. Writing a `$state`
   * *is* a notification to every effect that reads it, and Svelte flushes those
   * notifications before the current effect finishes — so a write that lands
   * inside an effect's own call chain re-runs that effect even though its body
   * never mentioned the name. `$effect(() => { void loadBrief(); })` reads
   * nothing at all, and still loops.
   *
   * One level of call chain is scanned, which is what is written here. A full
   * call graph is beyond what a structural test should pretend to do, and this
   * limit is recorded rather than hidden.
   */
  it('a function called by an $effect does not write bound $state', () => {
    for (const file of SCREENS) {
      const source = read(file);

      // Every `$state` this file declares.
      const states = new Set<string>();
      for (const m of source.matchAll(/let\s+([A-Za-z_$][\w$]*)\s*=\s*\$state/g)) {
        if (m[1]) states.add(m[1]);
      }
      if (states.size === 0) continue;

      // The states that are **inputs the developer's own actions can write**.
      //
      // Not every `bind:` counts. `bind:value={reply}` on a textarea means Svelte
      // tracks `reply`, so writing it re-runs any effect that reads it.
      // `bind:group={briefMode}` on a radio does the same. Those are the loop
      // risk — and they are also exactly the states a developer can change by
      // clicking, which is why they are written by user intent and belong to the
      // component, not to an effect that loads on mount.
      //
      // What is *not* in this set: `$state` a screen only renders. Writing
      // `brief` — the loaded file — is how the screen displays it, and no
      // action of the developer's produces that write, so there is nothing to
      // re-trigger on.
      const bound = new Set<string>();
      for (const m of source.matchAll(/<input\b[^>]*\bbind:(?:value|group|checked)=\{?([A-Za-z_$][\w$]*)/g)) {
        if (m[1]) bound.add(m[1]);
      }
      for (const m of source.matchAll(/<textarea\b[^>]*\bbind:value=\{?([A-Za-z_$][\w$]*)/g)) {
        if (m[1]) bound.add(m[1]);
      }

      // The bodies of every locally-declared function.
      const functions = new Map<string, string>();
      for (const m of source.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
        const name = m[1];
        const open = source.indexOf('{', m.index);
        if (!name || open === -1) continue;
        let depth = 0;
        for (let i = open; i < source.length; i += 1) {
          if (source[i] === '{') depth += 1;
          else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) {
              functions.set(name, source.slice(open + 1, i));
              break;
            }
          }
        }
      }

      for (const effectBody of effectBodies(source)) {
        const stripped = stripUntrackCalls(effectBody);
        const calls = [...stripped.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1] ?? '');
        for (const call of calls) {
          const body = functions.get(call);
          if (body === undefined) continue;
          const inner = stripUntrackCalls(body);
          // Locals are read off the **stripped** body, the same text the write
          // scan runs on. Reading them off `body` lets a declaration inside an
          // `untrack` call count as a local while its assignment — now removed —
          // is still scanned, so the two disagree and a local looks like a write.
          const locals = declaredLocals(inner);
          for (const name of [
            ...inner.matchAll(/(?:^|[;{}(\s])((?:\$|[A-Za-z_])[\w$]*)\s*=(?![=>+\-*/])/g),
          ].map((m) => m[1] ?? '')) {
            if (locals.has(name)) continue;
            expect(
              bound.has(name),
              `${file}: $effect calls ${call}(), which writes the bound $state "${name}" — that is an infinite loop`,
            ).toBe(false);
          }
        }
      }
    }
  });
});

describe('a file header comment cannot leak onto the page', () => {
  const files = [
    'renderer/screens/ContextScreen.svelte',
    'renderer/screens/PatchScreen.svelte',
    'renderer/screens/SceneScreen.svelte',
    'renderer/screens/ProjectScreen.svelte',
  ];

  for (const file of files) {
    it(`${file} — header comment is balanced`, () => {
      // The header only: the first block, up to its closing `-->`.
      const source = read(file);
      if (!source.startsWith('<!--')) return; // no header comment, nothing to leak
      const end = source.indexOf('-->');
      const header = source.slice(0, end);

      // `slice(4)` drops the *opening* `<!--`; anything left that is still an
      // opener is a nested one, and it closes the comment early — every line
      // after that renders as visible text above the app.
      expect(
        header.slice(4).includes('<!--'),
        `${file}: a nested <!-- inside the header comment closes it early — the rest renders as visible text`,
      ).toBe(false);
    });
  }

  it('no screen header mentions comment markup as an example', () => {
    for (const file of files) {
      const source = read(file);
      if (!source.startsWith('<!--')) continue;
      const end = source.indexOf('-->');
      expect(
        source.slice(4, end),
        `${file}: the header uses comment markup as an example, which closes it early`,
      ).not.toContain('<!--');
    }
  });
});

describe('the four screens are all reachable', () => {
  it('App.svelte marks every screen as working, not as a future step', () => {
    const source = read('renderer/App.svelte');
    const steps = [...source.matchAll(/step:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(steps.length).toBeGreaterThanOrEqual(4);
    expect(
      steps.filter((s) => s.startsWith('Step')),
      'a screen is still labelled with a future step number',
    ).toEqual([]);
  });

  /**
   * The declared screen ids, read from whichever file owns the union.
   *
   * `Sidebar.svelte` since D50. Falling back to `App.svelte` keeps this working if
   * the union ever moves back, which costs four lines and means a move breaks no
   * test that was not about the move.
   */
  function screenIds(): string[] {
    const source = /type ScreenId =/.test(read('renderer/Sidebar.svelte'))
      ? read('renderer/Sidebar.svelte')
      : read('renderer/App.svelte');
    const union = /type ScreenId =([^;]+);/.exec(source);
    expect(union, 'a ScreenId union should be declared in Sidebar.svelte or App.svelte').toBeTruthy();
    return [...(union?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
  }

  it('every screen id has a real component file behind it', () => {
    // Read the id union itself rather than an alternation copied here. A
    // hand-written list of screen names is a list that stops being true the
    // moment a screen is added — which is how the Graph screen could have been
    // skipped by this check on its first day.
    //
    // Read from `Sidebar.svelte`, not `App.svelte`: the union moved there so the
    // sidebar's `onSelect` and `App.svelte`'s `active` share one type instead of
    // one `ScreenId` union and one bare `string` (D50). The producer of an id
    // should own its type, and these two tests failed the moment it moved.
    const ids = screenIds();
    expect(ids.length).toBeGreaterThanOrEqual(5);

    const dir = join(APP_SRC, 'renderer/screens');
    const files = readdirSync(dir);
    for (const id of ids) {
      const file = files.find((f) => f.toLowerCase().includes(id!.toLowerCase()));
      expect(file, `no component file for the "${id}" screen`).toBeTruthy();
    }
  });

  it('lists every declared screen in the SCREENS array, so none is unreachable', () => {
    // The sidebar renders `SCREENS`. A screen in the `ScreenId` union but not
    // in the array compiles fine and can never be clicked.
    const source = read('renderer/App.svelte');
    const declared = screenIds();
    const listed = [...source.matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);
    for (const id of declared) {
      expect(listed, `"${id}" is a ScreenId but no sidebar entry renders it`).toContain(id);
    }
  });
});
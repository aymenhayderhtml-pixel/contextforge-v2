/**
 * test/shell/patchScreenRender.test.ts — the Patch screen's markup.
 *
 * `svelte/server`'s `render` is a real render of the real component, so what is
 * asserted here is what a developer sees on a first visit. No Electron, no DOM
 * events: the buttons are checked for *what they say and whether they are
 * disabled*, not clicked, because driving a Svelte 5 click headlessly needs a
 * browser environment this project deliberately does not have.
 *
 * ## What this file is for
 *
 * The behaviour tests in `patchScreen.test.ts` prove the handlers. This one
 * proves the parts of the contract that live in markup and could be broken
 * without any handler changing:
 *
 *  - **one main action per screen** — Apply is the only emphasised button;
 *  - **a refusal is rendered**, not swallowed, and it has somewhere to live;
 *  - **"apply anyway" is not in the initial markup**, so it cannot be the
 *    default (SPEC R9);
 *  - the renderer **cannot reach the filesystem** — no `require`, no `fs`, no
 *    path-joining in this component. It emits intent and the main process
 *    writes.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import PatchScreen from '../../src/renderer/screens/PatchScreen.svelte';
import { createEditorStore, type EditorStore, type StoreDeps } from '../../src/renderer/store.js';
import { CHANNELS } from '../../src/ipc.js';
import { FakeClock, FakeInvoker, FakeListener, succeed } from './fakes.js';

const SCREEN_TS = readFileSync(
  fileURLToPath(new URL('../../src/renderer/screens/PatchScreen.svelte', import.meta.url)),
  'utf-8',
);

/** A store whose three patch channels answer with `answer`. */
function storeWith(answer: (request: unknown) => Promise<unknown>): {
  store: EditorStore;
  invoker: FakeInvoker;
} {
  const invoker = new FakeInvoker({
    [CHANNELS.previewPatch]: answer,
    [CHANNELS.applyPatch]: answer,
    [CHANNELS.patchHistory]: answer,
  });
  const listener = new FakeListener();
  const clock = new FakeClock();
  const deps: StoreDeps = {
    invoker,
    listener: listener.on,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  };
  return { store: createEditorStore(deps), invoker };
}

/** A refusal with no answer to render, so the screen is in its resting state. */
function noAnswer(): Promise<unknown> {
  return succeed({
    files: [],
    failedBlocks: [],
    alreadyApplied: 0,
    applicable: false,
    canApplyAnyway: false,
    blockedReason: '',
    blockCount: 0,
    entries: [],
    canUndo: false,
    canRedo: false,
  });
}

describe('PatchScreen — resting state', () => {
  it('offers one textarea for the reply and one main action', () => {
    const { store } = storeWith(noAnswer);
    const { body } = render(PatchScreen, { props: { store } });

    // The paste target, with a placeholder that teaches the format rather than
    // leaving the developer to guess what ContextForge reads.
    expect(body).toContain('<textarea');
    expect(body).toContain('### EDIT: src/player.js');

    // Exactly one `primary` button. Apply is the only action on this screen that
    // writes, so it is the only one that may look like the thing to press.
    const primary = body.match(/class="primary\s+svelte-[^"]*"/g) ?? [];
    expect(primary).toHaveLength(1);
    expect(body).toContain('Apply patch');
  });

  it('starts with Apply disabled, because nothing has been previewed yet', () => {
    const { store } = storeWith(noAnswer);
    const { body } = render(PatchScreen, { props: { store } });

    // A button that is enabled and then refuses is worse than one that is
    // disabled with a reason, so this is asserted from the first frame.
    expect(body).toMatch(/class="primary[^"]*"[^>]*disabled/);
  });

  it('never renders the "apply anyway" override before a preview asks for it', () => {
    const { store } = storeWith(noAnswer);
    const { body } = render(PatchScreen, { props: { store } });

    // The override is a second explicit click. If it appeared in the resting
    // markup it would be one click away from being the default (SPEC R9).
    expect(body).not.toContain('Apply anyway');
    expect(body).not.toContain('applyAnyway');
  });

  it('has no filesystem reach of any kind', () => {
    const { store } = storeWith(noAnswer);
    const { body } = render(PatchScreen, { props: { store } });

    // The renderer runs with `contextIsolation: true`, `nodeIntegration: false`
    // and `sandbox: true`, so any of these would simply be undefined at runtime
    // rather than a working write. Asserting their absence keeps that honest
    // instead of relying on the sandbox being enough.
    expect(body).not.toMatch(/require\(/);
    expect(body).not.toContain('node:fs');
    expect(body).not.toContain('readFile');
    expect(body).not.toContain('writeFile');
    expect(body).not.toContain('fetch(');
  });

  it('requests nothing on mount — the developer has pasted nothing yet', () => {
    const { store, invoker } = storeWith(noAnswer);
    render(PatchScreen, { props: { store } });

    // A screen that fires a request before it is asked to is doing work nobody
    // requested, and on this screen the work is a full parse of a scratch copy.
    expect(invoker.calls).toHaveLength(0);
  });
});

describe('PatchScreen — the source', () => {
  it('requests only channels that exist in the contract', () => {
    // A channel name typed into the component rather than imported from
    // `CHANNELS` would type-check against `IpcChannel` and still be wrong if the
    // constant were renamed, so the screen must go through the table.
    expect(SCREEN_TS).toContain("import {\n    CHANNELS,");
    expect(SCREEN_TS).toContain('CHANNELS.previewPatch');
    expect(SCREEN_TS).toContain('CHANNELS.applyPatch');
    expect(SCREEN_TS).toContain('CHANNELS.patchHistory');
  });

  it('renders the refusal beside the thing that caused it', () => {
    // Spelled out as source because the rendered form depends on whether a
    // preview has run, and the *placement* is the requirement: the refusal sits
    // in the same panel as the Apply button, not in a toast above the app.
    const refusalBlock = SCREEN_TS.indexOf('{#if refusal !== null}');
    const applyButton = SCREEN_TS.indexOf('Apply patch');
    const previewPanel = SCREEN_TS.indexOf('{#if preview !== null}');
    expect(refusalBlock).toBeGreaterThan(0);
    expect(applyButton).toBeGreaterThan(0);
    expect(previewPanel).toBeGreaterThan(0);
    // After Apply, so the developer reads the reason while looking at the button
    // that would have caused it…
    expect(refusalBlock).toBeGreaterThan(applyButton);
    // …and before the diff list, because a refusal about a block belongs with the
    // preview it is refusing.
    expect(refusalBlock).toBeLessThan(previewPanel);
  });

  it('renders a failed block’s reason without rewriting it', () => {
    // `{failure.reason}` and nothing else: any wrapper expression here would be
    // a paraphrase, which is the single failure this screen was built to remove.
    expect(SCREEN_TS).toContain('{failure.reason}');
    expect(SCREEN_TS).toContain('Edit block {failure.index} could not be applied');
  });
});

/**
 * The write reports name their files.
 *
 * "Previous changes were reverted" is a sentence that describes any undo at all,
 * including one that reverted something the developer did not expect. A count —
 * or nothing — leaves the same doubt; the names are what let a developer decide
 * whether the button did what they meant.
 */
describe('PatchScreen — write reports name the files', () => {
  it('builds every summary from one helper, so the shape cannot drift', () => {
    // Apply, undo and redo are rendered from `writeSummary`. If one of them were
    // spelled out inline it could quietly revert to a bare count while the other
    // two still named files.
    expect(SCREEN_TS).toContain('function writeSummary(');
    expect(SCREEN_TS).toContain("writeSummary('Wrote', applied.files)");
    expect(SCREEN_TS).toContain(
      "writeSummary(revertDirection === 'undo' ? 'Reverted' : 'Reapplied', reverted.files)",
    );
  });

  it('joins the file names into the sentence rather than showing only a count', () => {
    expect(SCREEN_TS).toContain('files.join(\', \')');
    // The old shape: a count with no names in the sentence.
    expect(SCREEN_TS).not.toContain('Previous changes were reverted.');
  });

  it('keeps the Applied heading distinct from the Undone heading', () => {
    // The e2e harness asserts on these words, and a screen that showed "Applied"
    // after an undo would claim the patch is live at the moment it was reverted.
    expect(SCREEN_TS).toContain('<h2>Applied</h2>');
    expect(SCREEN_TS).toContain("revertDirection === 'undo' ? 'Undone' : 'Redone'");
  });

  /**
   * The rendered sentence is proved in the e2e harness, not here.
   *
   * `reverted` is assigned inside `stepHistory`, which only a click on the Undo
   * button can reach, and `svelte/server` renders the resting state with no event
   * loop — so asserting the rendered text here would have meant asserting
   * something that is true only if the test drove the screen, which it cannot.
   * `patch-harness.mjs` clicks the real button and asserts the exact string
   * "Reverted 2 files: src/modes.js, src/settings.js" in the live DOM; the store
   * side is covered by `store.test.ts`. What is left to pin here is that the
   * panel renders the names and not only a count.
   */
  it('renders the reverted files as a list, so the names are selectable text', () => {
    expect(SCREEN_TS).toContain('{#each reverted.files as path (path)}');
    expect(SCREEN_TS).toContain('{#each applied.files as path (path)}');
  });

  /**
   * The mapping between the store's shape and the panel's.
   *
   * This is a real bug that shipped once: the store resolves to `{ paths, patchId }`
   * while the panel reads `.files`, and assigning the store's object straight
   * through made `reverted.files` undefined. `writeSummary` then threw on
   * `files.length`, the panel fell back to the "Applied" branch, and the Undo
   * message never rendered — found only by running the app, because SSR never
   * reaches `stepHistory`.
   *
   * The assertion is on the mapping expression rather than on a render, so it
   * fails the moment the two shapes are allowed to drift apart again.
   */
  it('maps the store’s `paths` onto the panel’s `files`, rather than assigning it', () => {
    expect(SCREEN_TS).toContain('reverted = { files: outcome.paths, patchId: outcome.patchId };');
    // The bare assignment is the bug. It is spelled here so a regression is
    // caught by the test rather than by a person clicking Undo.
    expect(SCREEN_TS).not.toMatch(/reverted\s*=\s*outcome\s*;/);
  });
});
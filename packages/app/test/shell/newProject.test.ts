/**
 * packages/app/test/shell/newProject.test.ts
 *
 * The New Project flow (Step 5d), and specifically the rule it exists for: **the
 * scaffold prompt cannot be copied until the game idea is filled in.**
 *
 * ## What is and is not provable here
 *
 * `svelte/server`'s `render()` runs no effects and no event handlers, and this
 * repo has no jsdom and no mounted-DOM harness. So a click cannot be simulated
 * and the clipboard cannot be stubbed. What *is* provable, and what this file
 * proves, is the rendered `disabled` attribute — which is the thing the rule
 * actually changes. The handler behind it is one line
 * (`if (!canCopy || promptText === null) return`) and is covered by
 * `canCopy` being driven entirely from core's own rule.
 *
 * The SSR scoping hash means `class="primary"` never matches exactly; every
 * assertion here follows `pickFolder.test.ts`'s regex style.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ProjectScreen, {
  NEW_PROJECT_STEPS,
} from '../../src/renderer/screens/ProjectScreen.svelte';
import { createEditorStore } from '../../src/renderer/store.js';
import { CHANNELS } from '../../src/ipc.js';
import { checkBrief, type GameBrief } from '@contextforge/core';
import { FakeClock, FakeInvoker, FakeListener, succeed } from './fakes.js';

/** This screen's source, for the structural guards below. */
const SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/renderer/screens/ProjectScreen.svelte', import.meta.url)),
  'utf8',
);

/**
 * A store whose scaffold channel answers the way core would, using core's own
 * `checkBrief` so the screen and the rule are the same function here too.
 */
function storeAnsweringLikeCore(): ReturnType<typeof createEditorStore> {
  const invoker = new FakeInvoker((channel, request) => {
    if (channel === CHANNELS.scaffoldProblems) {
      return succeed({ problems: checkBrief(request as Partial<GameBrief>) });
    }
    if (channel === CHANNELS.scaffoldPrompt) {
      return succeed({ prompt: '# Build the game\n\n(preview)' });
    }
    return succeed({});
  });
  return createEditorStore({
    invoker,
    clock: new FakeClock(),
    listener: new FakeListener(),
  });
}

function renderProject(store: ReturnType<typeof createEditorStore>): string {
  return render(ProjectScreen, { props: { store, onOpenScene: () => {} } }).body;
}

describe('New Project — the flow is five steps', () => {
  it('names exactly five steps', () => {
    expect(NEW_PROJECT_STEPS).toHaveLength(5);
    expect([...NEW_PROJECT_STEPS]).toEqual([
      'Name it',
      'Describe the game',
      'Take the prompt',
      'Paste the reply',
      'Install and run',
    ]);
  });

  it('offers a New project button', () => {
    // SSR always renders the header and step 1. The flow's *contents* cannot be
    // asserted from markup, because opening it needs a click and there is no
    // mounted-DOM harness — so the open state itself is asserted structurally
    // below, rather than pretending otherwise here.
    const body = renderProject(storeAnsweringLikeCore());
    expect(body).toMatch(/New project…/);
    expect(body).toMatch(/Open project/);
  });

  it('hides the flow behind a conditional and renders the steps from the list', () => {
    expect(SOURCE).toMatch(/\{#if newProjectOpen\}/);
    expect(SOURCE).toMatch(/\{#each NEW_PROJECT_STEPS as label, i \(label\)\}/);
  });
});

describe('New Project — the scaffold prompt is gated on a real idea', () => {
  /**
   * The gate itself, proven at the layer that decides it.
   *
   * `canCopy` is `name !== '' && idea !== '' && scaffoldProblems.length === 0`,
   * and `scaffoldProblems` is core's `checkBrief`. So asserting on `checkBrief`
   * asserts on the gate — with the caveat, stated here rather than hidden, that
   * no test here can click the button.
   */
  it('blocks an empty idea', () => {
    expect(checkBrief({ name: 'star-crawler', idea: '' }).length).toBeGreaterThan(0);
  });

  it('blocks a whitespace-only idea', () => {
    expect(checkBrief({ name: 'star-crawler', idea: '   \n  ' }).length).toBeGreaterThan(0);
  });

  it('blocks a placeholder idea', () => {
    expect(checkBrief({ name: 'x', idea: 'TODO' }).length).toBeGreaterThan(0);
  });

  it('allows a filled idea', () => {
    expect(
      checkBrief({
        name: 'star-crawler',
        idea: 'You drive a hover car around a collapsing space station.',
      }),
    ).toEqual([]);
  });

  it('the screen asks core for the gate rather than deciding locally', () => {
    // A source-level guard. If someone replaces the IPC call with a local
    // `idea.length > 0`, this fails — which is the drift the rule exists to
    // prevent, because the generator would then refuse a prompt the screen had
    // already enabled.
    expect(SOURCE).toContain('CHANNELS.scaffoldProblems');
    expect(SOURCE).toMatch(/const canCopy = \$derived\([\s\S]*?scaffoldProblems\.length === 0/);
  });

  it('the copy button is disabled whenever the gate is closed', () => {
    // Structural: the button's `disabled` must be bound to `canCopy`, so it can
    // never be enabled by anything else.
    expect(SOURCE).toMatch(/disabled=\{!canCopy \|\| promptText === null\}/);
  });

  it('step 3 cannot be reached without passing through the name and the idea', () => {
    // `goTo(3)` is not offered anywhere in the markup; only `goTo(1)`,
    // `goTo(2)` and the "Build the prompt" handler (which itself refuses when
    // `!canCopy`) appear.
    expect(SOURCE).not.toMatch(/goTo\(3\)/);
    expect(SOURCE).toMatch(/async function toPrompt\(\)[\s\S]*?if \(!canCopy\) return;/);
  });
});

describe('New Project — the scaffold channels', () => {
  it('refuses a prompt for an incomplete brief, naming what is missing', async () => {
    const { AppBackend } = await import('../../src/electron/ipcHandlers.js');
    const app = new AppBackend(() => {}, { allowUnpickedRoot: 'test-only' });

    const result = app.scaffoldPrompt({ name: 'star-crawler', idea: '' });
    expect(result.ok).toBe(false);
    // The refusal must name the problem, not just say no.
    expect((result as { reason: string }).reason).toMatch(/idea/);
  });

  it('returns a prompt for a complete brief, embedding the idea verbatim', async () => {
    const { AppBackend } = await import('../../src/electron/ipcHandlers.js');
    const app = new AppBackend(() => {}, { allowUnpickedRoot: 'test-only' });

    const idea = 'You drive a hover car around a collapsing space station.';
    const result = app.scaffoldPrompt({ name: 'star-crawler', idea });
    expect(result.ok).toBe(true);
    expect((result as { value: { prompt: string } }).value.prompt).toContain(idea);
  });

  it('problems answers rather than refusing for an incomplete brief', async () => {
    // "Incomplete" is the expected answer on this channel. Refusing would be a
    // second way of saying the same thing, and the screen would have to handle
    // both shapes.
    const { AppBackend } = await import('../../src/electron/ipcHandlers.js');
    const app = new AppBackend(() => {}, { allowUnpickedRoot: 'test-only' });

    const result = app.scaffoldProblems({ name: '', idea: '' });
    expect(result.ok).toBe(true);
    expect((result as { value: { problems: string[] } }).value.problems.length).toBeGreaterThan(0);
  });

  it('problems refuses a request it cannot understand', async () => {
    const { AppBackend } = await import('../../src/electron/ipcHandlers.js');
    const app = new AppBackend(() => {}, { allowUnpickedRoot: 'test-only' });

    const result = app.scaffoldProblems(null as never);
    expect(result.ok).toBe(false);
  });

  it('both channels are registered, or the app will not boot', async () => {
    // `registerHandlers` throws at startup when a channel in `CHANNELS` has no
    // handler, so this is a boot-time assertion, not a nicety.
    const { AppBackend, registerHandlers } = await import('../../src/electron/ipcHandlers.js');
    const registered: string[] = [];
    registerHandlers(
      {
        handle: (channel: string) => {
          registered.push(channel);
          return () => {};
        },
        removeHandler: () => {},
      } as never,
      new AppBackend(() => {}, { allowUnpickedRoot: 'test-only' }),
    );
    expect(registered).toContain(CHANNELS.scaffoldPrompt);
    expect(registered).toContain(CHANNELS.scaffoldProblems);
  });
});
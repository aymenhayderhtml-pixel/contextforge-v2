/**
 * test/shell/screens.test.ts — tests for ProjectScreen, Sidebar, ContextScreen, and PatchScreen.
 */

import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { EditorStore } from '../../src/renderer/store.js';
import Sidebar from '../../src/renderer/Sidebar.svelte';
import ProjectScreen from '../../src/renderer/screens/ProjectScreen.svelte';
import ContextScreen from '../../src/renderer/screens/ContextScreen.svelte';
import PatchScreen from '../../src/renderer/screens/PatchScreen.svelte';
import { FakeClock, FakeInvoker, FakeListener, demoScene, snapshotOf, succeed } from './fakes.js';
import { CHANNELS } from '../../src/ipc.js';
import { createEditorStore } from '../../src/renderer/store.js';

async function createTestStore(withSnapshot = false): Promise<EditorStore> {
  const invoker = new FakeInvoker({
    [CHANNELS.openProject]: (req: any) =>
      Promise.resolve(
        succeed(
          snapshotOf(demoScene(), {
            project: { root: req.root, name: 'demo-game', scenePath: 'scene.json', engine: 'three' },
          }),
        ),
      ),
    [CHANNELS.closeProject]: () => Promise.resolve(succeed(undefined)),
  });
  const listener = new FakeListener();
  const clock = new FakeClock();
  const store = createEditorStore({
    invoker,
    listener: listener.on,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  if (withSnapshot) {
    await store.openProject('/workspace/demo-game');
  }

  return store;
}

describe('Sidebar', () => {
  const screens = [
    { id: 'project', label: 'Project', step: 'Step 4' },
    { id: 'context', label: 'Context', step: 'Step 5' },
    { id: 'scene', label: 'Scene', step: 'working' },
    { id: 'patch', label: 'Patch', step: 'Step 5' },
  ];

  it('renders all screens and drops "not built — Step N" text', () => {
    const { body } = render(Sidebar, {
      props: {
        screens,
        active: 'project',
        onSelect: () => {},
        projectName: 'MyGame',
        scenePath: 'scenes/main.json',
        dirty: false,
      },
    });

    expect(body).toContain('Project');
    expect(body).toContain('Context');
    expect(body).toContain('Scene');
    expect(body).toContain('Patch');
    // Ensure "not built — Step N" text is completely gone
    expect(body).not.toContain('not built');
    expect(body).not.toContain('Step 4');
    expect(body).not.toContain('Step 5');
  });

  it('disables Context and Patch only while no project is open', () => {
    // **This test used to assert the opposite.** It required the tooltip
    // "Coming in future steps" and both buttons disabled — written when the
    // screens were placeholders. Both are built now (D34), so that assertion
    // was pinning a lie: a navigation entry promising a future step for a
    // screen that exists hides working software.
    //
    // What is actually load-bearing is the *reason* each screen is gated, not
    // that it is gated at all: Context needs files on disk to rank, and Patch
    // needs somewhere to land a diff. Both are gated on an open project.
    const closed = render(Sidebar, {
      props: {
        screens,
        active: 'project',
        onSelect: () => {},
        projectName: null,
        scenePath: null,
        dirty: false,
      },
    }).body;

    // No project: disabled, and the tooltip says *why* in terms of the state,
    // not in terms of a build schedule.
    expect(closed).toMatch(/<button[^>]*disabled=""[^>]*title="Open a project first[^"]*"[^>]*>[\s\S]*?Context<\/span>/);
    expect(closed).toMatch(/<button[^>]*disabled=""[^>]*title="Open a project first[^"]*"[^>]*>[\s\S]*?Patch<\/span>/);
    expect(closed).not.toContain('Coming in future steps');

    // A project open: both enabled. This is the direction that was never
    // tested, and it is the one that matters — it is the whole reason the
    // screens can be reached at all.
    const open = render(Sidebar, {
      props: {
        screens,
        active: 'project',
        onSelect: () => {},
        projectName: 'kart-dash-3d-v2',
        scenePath: 'scene.json',
        dirty: false,
      },
    }).body;

    expect(open).not.toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Context<\/span>/);
    expect(open).not.toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Patch<\/span>/);
  });

  it('renders project summary info correctly', () => {
    const { body } = render(Sidebar, {
      props: {
        screens,
        active: 'scene',
        onSelect: () => {},
        projectName: 'SuperGame',
        scenePath: 'levels/1.json',
        dirty: true,
      },
    });

    expect(body).toContain('SuperGame');
    expect(body).toContain('levels/1.json');
    expect(body).toContain('working…');
  });
});

describe('Context and Patch screens — built in Step 4', () => {
  // These two were assertions on the placeholder copy, and they went red the
  // moment the real screens landed. A test that asserts a screen is a stub is a
  // test that has to be deleted when the screen stops being a stub — and
  // deleting it is exactly when nobody re-reads what it was protecting. So each
  // now asserts the *shape* of the real screen: what a developer must be able to
  // do there, and that the placeholder is gone for good.

  it('renders the Context screen as a working compiler, not a placeholder', async () => {
    const store = await createTestStore();
    const { body } = render(ContextScreen, { props: { store } });

    // The two inputs the screen exists for: what is broken, and the error text.
    expect(body).toContain('Context');
    expect(body).toMatch(/what.{0,20}broken|broken/i);
    // Somewhere for the AI's reply — that is where CONTEXT INSUFFICIENT is
    // pasted, and without this box the ask-back loop has nowhere to land.
    expect(body).toMatch(/reply|response/i);

    // Deliberately NOT asserted on the resting frame: the prompt, its Copy
    // button, and the token estimate. All three render only once `compiled` is
    // non-null, and a screen that showed an empty prompt and a token count of
    // nothing before anything had been compiled would be lying. Asserting them
    // here would test that the screen lies.
    //
    // What this asserts is the honest resting state: it asks for input, and it
    // does not claim to have an answer. The populated frame is covered by
    // `context/handlers.test.ts`, which drives a real compile.
    expect(body).toMatch(/compile/i);

    expect(
      body,
      'the placeholder copy is still rendered somewhere on the Context screen',
    ).not.toContain('This screen is coming in a future step.');
  });

  it('renders the Patch screen as a working review-and-apply, not a placeholder', async () => {
    const store = await createTestStore();
    const { body } = render(PatchScreen, { props: { store } });

    expect(body).toContain('Patch');
    // A place to paste the reply.
    expect(body).toContain('<textarea');
    // Preview before Apply, and an undo history.
    expect(body).toMatch(/preview/i);
    expect(body).toMatch(/undo/i);

    expect(
      body,
      'the placeholder copy is still rendered somewhere on the Patch screen',
    ).not.toContain('This screen is coming in a future step.');
  });
});

describe('ProjectScreen', () => {
  it('renders a Browse… button and no file input', async () => {
    const store = await createTestStore();
    const { body } = render(ProjectScreen, {
      props: { store, onOpenScene: () => {} },
    });

    expect(body).toContain('Browse…');
    // There is deliberately no `<input type="file" webkitdirectory>` any more.
    // It read `File.path` to recover the chosen folder — a non-standard
    // Chromium extension Electron deprecated in v32 and removed under
    // `sandbox: true`, so the button silently did nothing. `pickFolder.test.ts`
    // owns the replacement's behaviour; this assertion only records that the
    // broken control is gone from the markup.
    expect(body).not.toContain('webkitdirectory');
    expect(body).not.toContain('type="file"');
  });

  it('renders recent projects list when recents are present', async () => {
    const store = await createTestStore();
    const recents = ['/home/dev/game-one', '/home/dev/game-two'];
    const { body } = render(ProjectScreen, {
      props: {
        store,
        onOpenScene: () => {},
        initialRecents: recents,
      },
    });

    expect(body).toContain('Recent projects');
    expect(body).toContain('/home/dev/game-one');
    expect(body).toContain('/home/dev/game-two');
    expect(body).toContain('recent-item');
  });

  it('shows current path in the input field when a project is open', async () => {
    const store = await createTestStore(true);
    const { body } = render(ProjectScreen, {
      props: { store, onOpenScene: () => {} },
    });

    expect(body).toContain('value="/workspace/demo-game"');
    expect(body).toContain('demo-game');
    expect(body).toContain('Close project');
  });

  it('shows empty input and placeholder when no project is open', async () => {
    const store = await createTestStore(false);
    const { body } = render(ProjectScreen, {
      props: { store, onOpenScene: () => {} },
    });

    expect(body).toContain('placeholder="/home/you/projects/my-game"');
    expect(body).toContain('No project is open');
  });
});

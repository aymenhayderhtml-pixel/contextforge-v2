/**
 * packages/app/test/components/toasts.test.ts
 *
 * Tests for Toast notifications in App.svelte:
 * - One line each with Dismiss button.
 * - Details toggle for paths and multi-line errors.
 * - Corner stacking.
 * - Collapsing into '+N more' when more than 3 notices exist.
 */

import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import App from '../../src/renderer/App.svelte';
import type { EditorStore, LiveNotice } from '../../src/renderer/store.js';

function createMockStore(notices: LiveNotice[] = []): EditorStore {
  return {
    snapshot: null,
    busy: false,
    selection: { kind: 'none' },
    gizmo: 'translate',
    space: 'world',
    snap: null,
    notices,
    notice: () => {},
    dismissNotice: () => {},
    clearNotices: () => {},
    select: () => {},
    selectInstance: () => {},
    setGizmo: () => {},
    setSpace: () => {},
    setSnap: () => {},
    openProject: async () => true,
    closeProject: async () => {},
    pickFolder: async () => null,
    saveScene: async () => true,
    reloadScene: async () => {},
    applyEdit: async () => true,
    undo: async () => true,
    redo: async () => true,
    connect: () => () => {},
    destroy: () => {},
    requestChannel: async () => ({ ok: true, value: {} } as any),
    refusalOf: () => null,
  };
}

describe('Toasts in App.svelte', () => {
  it('renders one line each with a Dismiss button', () => {
    const notices: LiveNotice[] = [
      { id: 1, at: 100, level: 'info', message: 'Saved scene.json.' },
    ];
    const store = createMockStore(notices);
    const { body } = render(App, { props: { store } });

    expect(body).toContain('Saved scene.json.');
    expect(body).toContain('Dismiss');
    expect(body).toContain('notice-info');
    expect(body).toContain('notice-text');
  });

  it('renders a Details toggle button for multi-line error notices', () => {
    const notices: LiveNotice[] = [
      {
        id: 1,
        at: 100,
        level: 'error',
        message: 'The scene file on disk is not valid.\ninstances[0].params.width: must be greater than 0',
      },
    ];
    const store = createMockStore(notices);
    const { body } = render(App, { props: { store } });

    expect(body).toContain('The scene file on disk is not valid.');
    expect(body).toContain('Details');
    expect(body).toContain('Dismiss');
  });

  it('collapses notices into "+N more" when there are more than 3', () => {
    const notices: LiveNotice[] = [
      { id: 1, at: 100, level: 'info', message: 'Notice 1' },
      { id: 2, at: 101, level: 'info', message: 'Notice 2' },
      { id: 3, at: 102, level: 'info', message: 'Notice 3' },
      { id: 4, at: 103, level: 'warning', message: 'Notice 4' },
      { id: 5, at: 104, level: 'error', message: 'Notice 5' },
    ];
    const store = createMockStore(notices);
    const { body } = render(App, { props: { store } });

    // Should render '+2 more'
    expect(body).toContain('+2 more');
    // Should render the 3 latest notices (Notice 3, Notice 4, Notice 5)
    expect(body).toContain('Notice 5');
    expect(body).toContain('Notice 4');
    expect(body).toContain('Notice 3');
    // Notice 1 and 2 are collapsed
    expect(body).not.toContain('Notice 1');
    expect(body).not.toContain('Notice 2');
  });

  it('renders all notices without collapse toggle when 3 or fewer exist', () => {
    const notices: LiveNotice[] = [
      { id: 1, at: 100, level: 'info', message: 'Notice 1' },
      { id: 2, at: 101, level: 'info', message: 'Notice 2' },
      { id: 3, at: 102, level: 'info', message: 'Notice 3' },
    ];
    const store = createMockStore(notices);
    const { body } = render(App, { props: { store } });

    expect(body).not.toContain('more');
    expect(body).toContain('Notice 1');
    expect(body).toContain('Notice 2');
    expect(body).toContain('Notice 3');
  });
});

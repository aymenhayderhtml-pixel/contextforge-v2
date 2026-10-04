<!--
  Viewport.svelte — the Svelte shell around the headless Viewport class.

  The split: `viewport.ts` owns the Three.js renderer, controls, and raycaster.
  This file owns the lifecycle (onMount/onDestroy), the store wiring, and the
  prop-to-method bridge. Nothing about WebGL belongs here; nothing about Svelte
  reactivity belongs in `viewport.ts`.

  Props:
  - `store` — the editor store; keyboard shortcuts and gizmo changes are echoed
    back through it so the toolbar stays in step with the canvas.
  - `scene` — the validated scene file. Passed to `vp.loadFromIndex` when it
    changes. The viewport re-renders; it does not diff.
  - `prefabIndex` — an indexed registry from `indexPrefabDefinitions`. Updated
    whenever the main process rebuilds prefabs.
  - `onEdit` — called with a `setTransform` edit when the gizmo drag ends.

  `problems` was accepted and then not used. It was listed here as "shown as a
  notice but not rendered", which was **not true** — nothing in this component
  read it. `svelte-check` reported the unused binding and the comment was the
  reason it survived as long as it did: the doc said the value was used, so the
  dead prop read as a documented decision. Removed rather than kept with a
  corrected comment, because a prop nothing reads is a claim the viewport is
  showing problems when it is not. `SceneScreen` still passes `snapshot.problems`
  nowhere; if the notice is wanted it should be built here and the prop restored
  with a test. See D50.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { SceneEdit, SceneFile } from '@contextforge/core';
  import type { EditorStore } from '../store.js';
  import type { PrefabIndex } from './sceneGraph.js';
  import { Viewport, type ViewportCallbacks } from './viewport.js';
  import { loadPrefabBundle } from './prefabBundle.js';

  interface Props {
    store: EditorStore;
    scene: SceneFile;
    prefabIndex: PrefabIndex;
    onEdit: (edit: SceneEdit) => void;
  }

  let { store, scene, prefabIndex, onEdit }: Props = $props();

  let container: HTMLDivElement;
  let vp: Viewport | null = null;

  function makeCallbacks(): ViewportCallbacks {
    return {
      onSelectionChange(selection) {
        store.select(selection);
      },
      onGizmoModeChange(mode) {
        store.setGizmo(mode);
      },
      onSpaceChange(space) {
        store.setSpace(space);
      },
      onTransformCommit(change) {
        /**
         * `patch:`, not `transform:`.
         *
         * Core's `SceneEdit` union names this field `patch` — `applySceneEdit`
         * reads `edit.patch` — and the viewport was sending `transform`, so
         * `edit.patch` was `undefined` and `setTransform` received no vectors.
         * Dragging a gizmo in the 3D viewport therefore committed an edit that
         * moved nothing, with no error: the guard in `setTransform` is about the
         * instance existing, not about the patch having content.
         *
         * Found by `svelte-check` (D50). It was invisible to `tsc` because it
         * does not read `.svelte`, and invisible to the unit tests because they
         * do not drag a gizmo.
         */
        onEdit({
          op: 'setTransform',
          instanceId: change.instanceId,
          patch: {
            position: change.transform.position,
            rotation: change.transform.rotation,
            scale: change.transform.scale,
          },
        });
      },
    };
  }

  let lastLoadedScene: SceneFile | null = null;
  let lastLoadedIndex: PrefabIndex | null = null;

  onMount(() => {
    vp = new Viewport({
      container,
      prefabs: [...prefabIndex.values()],
      callbacks: makeCallbacks(),
    });
    vp.loadFromIndex(scene, prefabIndex);
    lastLoadedScene = scene;
    lastLoadedIndex = prefabIndex;
  });

  onDestroy(() => {
    vp?.dispose();
    vp = null;
  });

  // Sync store gizmo mode → viewport (toolbar click, not a key press).
  $effect(() => {
    if (!vp) return;
    const mode = store.gizmo;
    if (vp.getGizmoMode() !== mode) {
      vp.setGizmoMode(mode);
    }
  });

  // Sync store space → viewport.
  $effect(() => {
    if (!vp) return;
    const space = store.space;
    if (vp.getSpace() !== space) {
      vp.setSpaceDirect(space);
    }
  });

  // Sync snap increment → viewport.
  $effect(() => {
    if (!vp) return;
    const snap = store.snap;
    if (vp.getSnap() !== snap) {
      vp.setSnap(snap);
    }
  });

  // Sync store selection → viewport (outliner click, or a refused edit reset).
  $effect(() => {
    if (!vp) return;
    const current = vp.getSelection();
    const desired = store.selection;
    if (
      current.kind !== desired.kind ||
      (desired.kind === 'instance' && (current.kind !== 'instance' || current.id !== desired.id))
    ) {
      vp.select(desired);
    }
  });

  let loadedBundleCode: string | null = null;

  // Load executable prefab bundle into registry when provided
  $effect(() => {
    const bundleCode = store.snapshot?.prefabs?.bundleCode;
    if (bundleCode && bundleCode !== loadedBundleCode) {
      loadedBundleCode = bundleCode;
      void loadPrefabBundle(bundleCode).then(() => {
        if (typeof window !== 'undefined') {
          (window as any).__prefabsLoaded = true;
        }
        if (vp && scene) {
          vp.loadFromIndex(scene, prefabIndex);
        }
      }).catch((err) => {
        console.error('[viewport] failed to load prefab bundle:', err);
      });
    } else if (!bundleCode && typeof window !== 'undefined') {
      (window as any).__prefabsLoaded = true;
    }
  });

  // Reload when the scene file changes.
  $effect(() => {
    if (!vp) return;
    if (scene !== lastLoadedScene || prefabIndex !== lastLoadedIndex) {
      vp.loadFromIndex(scene, prefabIndex);
      lastLoadedScene = scene;
      lastLoadedIndex = prefabIndex;
    }
  });
</script>

<!--
  The container div fills its parent. The Viewport appends a <canvas> to it on
  mount. tabindex="-1" lets the div receive keyboard events without appearing in
  the tab order — the toolbar controls are the keyboard-accessible path.
-->
<div
  class="viewport-shell"
  bind:this={container}
  tabindex="-1"
  role="application"
  aria-label="3D scene viewport"
></div>

<style>
  .viewport-shell {
    width: 100%;
    height: 100%;
    overflow: hidden;
    outline: none;
  }
</style>

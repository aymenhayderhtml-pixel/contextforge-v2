/**
 * viewport.ts — the modeling viewport.
 *
 * This is the DOM/WebGL half. Everything that can be reasoned about without a
 * GPU lives in `sceneGraph.ts`, `stage.ts`, `picking.ts` and `markers.ts`; what
 * is left here is the WebGLRenderer, the DOM event listeners, the gizmo, the
 * `.glb` loader and the draw loop.
 *
 * ## The rules this file exists to obey
 *
 *  - **It does not write to disk.** There is no `fs`, no `invoke`, no `save`.
 *    Every change is *emitted* to the owner through a callback, and the app
 *    shell decides whether that becomes an `applyEdit` over IPC. A viewport that
 *    persisted its own edits would have two writers to one file and the last
 *    undo step would belong to whichever wrote last.
 *
 *  - **It does not run a game.** The `requestAnimationFrame` loop below calls
 *    `renderer.render` and nothing else. It does not advance time, tick a
 *    physics step, or mutate scene data. Nothing is added to the scene after
 *    `load()` except in response to a click, a key, or a `.glb` arriving.
 *
 *  - **A failed prefab or model is visible, not fatal.** See `sceneGraph.ts`
 *    and `markers.ts`. A scene an AI has just written is the normal case.
 *
 * ## Keys
 *
 * W/E/R set the gizmo mode, Q toggles world/local, F frames the selection —
 * all resolved through `gizmoModeForKey` from `ipc.ts`. This file contains no
 * key literals of its own, so the shortcut table and the handler cannot drift.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { PrefabDefinition, SceneFile } from '@contextforge/core';
import type { GizmoMode, Selection } from '../../ipc.js';

import { indexPrefabDefinitions, type InstanceNode, type PrefabIndex, type SceneBuildFailure } from './sceneGraph.js';
import { assembleScene, type SceneProblem } from './assemble.js';
import { buildCamera, createGroundGrid } from './stage.js';
import { createErrorMarker } from './markers.js';
import { createAppError, type AppError } from '../../errors.js';
import { loadPrefabBundle } from './prefabBundle.js';
import {
  applyFraming,
  boundingSphereOf,
  framingForSelection,
  pickAt,
  pointerToNdc,
  snapValuesFor,
  toggleSpace,
  viewportActionForKey,
} from './picking.js';

/**
 * How the viewport talks to its owner.
 *
 * Every one of these is an *intent*, not a command. The viewport never writes;
 * it reports what a human did and the app shell turns that into an IPC request.
 */
export interface ViewportCallbacks {
  /** A click resolved to an instance, or to nothing (a deselect). */
  onSelectionChange?(selection: Selection): void;
  /** The gizmo mode changed, from W/E/R. */
  onGizmoModeChange?(mode: GizmoMode): void;
  /** Q was pressed. The viewport has already applied the new space. */
  onSpaceChange?(space: 'world' | 'local'): void;
  /** F was pressed. */
  onFocus?(selection: Selection): void;
  /**
   * The user finished dragging the gizmo. This is the only path by which a
   * transform reaches the owner, so a drag is one edit and one undo step rather
   * than a stream of intermediate positions.
   */
  onTransformCommit?(change: TransformCommit): void;
  /** Something failed: a prefab threw, a model would not load. Never throws. */
  onProblem?(problem: ViewportProblem): void;
  /** Emitted when an error occurs during prefab instantiation or model loading. */
  onError?(error: AppError): void;
  /** The scene finished (re)building, including any `.glb` that loaded. */
  onSceneBuilt?(summary: SceneBuildSummary): void;
}

/** A finished gizmo drag. */
export interface TransformCommit {
  readonly instanceId: string;
  readonly transform: {
    readonly position: [number, number, number];
    /** Euler radians, matching `scene.schema.ts`. */
    readonly rotation: [number, number, number];
    readonly scale: [number, number, number];
  };
}

/** A problem the viewport hit, surfaced to the owner as a sentence. */
export type ViewportProblem = SceneProblem;

/** What the viewport reports after a build. */
export interface SceneBuildSummary {
  readonly objectCount: number;
  readonly placeholderCount: number;
  readonly problems: readonly ViewportProblem[];
  readonly errors: readonly AppError[];
}

/** How the viewport should resolve a `.glb` path to a fetchable URL. */
export type ModelPathResolver = (path: string) => string;

export interface ViewportOptions {
  /** The canvas (or a container) the viewport draws into. */
  readonly container: HTMLElement;
  /**
   * The prefab registry. An array rather than a map, because the UI receives a
   * `PrefabRegistryResult`-shaped list and should not have to index it.
   */
  readonly prefabs: readonly PrefabDefinition[];
  readonly callbacks?: ViewportCallbacks;
  /**
   * Turns a project-relative `instance.model` into a URL the loader can fetch.
   *
   * Required if the scene references any model. In the Electron renderer this is
   * a `file://` or custom-protocol URL; the viewport does not know which,
   * because the renderer has no filesystem access (`ipc.ts`) and guessing would
   * couple it to the protocol.
   */
  readonly resolveModelPath?: ModelPathResolver;
  /** Turn snapping on with this grid increment, in scene units. */
  readonly snap?: number | null;
  /** Background colour. Dark, because the grid is drawn to be read against it. */
  readonly background?: number;
}

/** A viewport that owns no files and advances no simulation. */
export class Viewport {
  private readonly container: HTMLElement;
  private readonly callbacks: ViewportCallbacks;
  /** Kept so `load` can rebuild from the array without re-indexing per call. */
  private readonly prefabs: readonly PrefabDefinition[];
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  /**
   * The active camera. Not `readonly` because `load` swaps it for the scene
   * file's camera and re-points both controls at the new one.
   */
  private camera: THREE.Camera;
  private readonly orbit: OrbitControls;
  private readonly gizmo: TransformControls;
  private readonly raycaster: THREE.Raycaster;
  private readonly loader: GLTFLoader;
  private readonly resolveModelPath: ModelPathResolver | undefined;
  private readonly gridGroup: THREE.Group;

  /** The live scene root, rebuilt on every `load`. */
  private sceneRoot: THREE.Group | null = null;
  private byId: ReadonlyMap<string, InstanceNode> = new Map();

  private selection: Selection = { kind: 'none' };
  private gizmoMode: GizmoMode = 'translate';
  private space: 'world' | 'local' = 'world';
  private snap: number | null = null;

  /** Transform the gizmo was attached to when the drag started. */
  private dragOrigin: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 } | null = null;
  private dragging = false;

  private frameHandle: number | null = null;
  private disposed = false;
  private readonly onPointerDown: (event: PointerEvent) => void;
  private readonly onKeyDown: (event: KeyboardEvent) => void;
  private readonly onResize: () => void;
  private readonly onGizmoChange: () => void;
  private readonly errorListeners: Array<(error: AppError) => void> = [];

  /** Subscribe to structured AppError events emitted by the viewport. */
  onError(listener: (error: AppError) => void): () => void {
    this.errorListeners.push(listener);
    return () => {
      const idx = this.errorListeners.indexOf(listener);
      if (idx !== -1) this.errorListeners.splice(idx, 1);
    };
  }

  /** Emit an AppError to callbacks and registered listeners. */
  private emitError(error: AppError): void {
    this.callbacks.onError?.(error);
    for (const listener of this.errorListeners) {
      listener(error);
    }
    if (this.container && typeof this.container.dispatchEvent === 'function') {
      try {
        this.container.dispatchEvent(new CustomEvent('app-error', { detail: error }));
      } catch {
        // Non-browser or custom container test mock
      }
    }
  }

  /** Static helper to load prefabs from a bundled browser ES module */
  static async loadPrefabBundle(codeOrUrlOrModule: unknown): Promise<PrefabDefinition[]> {
    return loadPrefabBundle(codeOrUrlOrModule);
  }

  constructor(options: ViewportOptions) {
    this.container = options.container;
    this.callbacks = options.callbacks ?? {};
    this.prefabs = options.prefabs;
    this.resolveModelPath = options.resolveModelPath;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    // `preserveDrawingBuffer` is on because the done-when for Step 3 is a
    // screenshot test: `toDataURL` after the frame is presented returns blank
    // without it. It costs a little memory and is not worth a flaky test.
    this.renderer.setPixelRatio(globalThis.devicePixelRatio ?? 1);
    this.renderer.setSize(options.container.clientWidth || 800, options.container.clientHeight || 600);
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(options.background ?? 0x101014);
    this.gridGroup = createGroundGrid();
    this.scene.add(this.gridGroup);

    this.camera = buildCamera({
      kind: 'perspective',
      position: [8, 6, 10],
      rotation: [0, 0, 0],
    });

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.1;

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setMode(this.gizmoMode);
    this.gizmo.setSpace(this.space);
    this.scene.add(this.gizmo.getHelper());

    this.raycaster = new THREE.Raycaster();
    this.loader = new GLTFLoader();

    if (options.snap !== undefined && options.snap !== null) {
      this.setSnap(options.snap);
    }

    // --- wiring -----------------------------------------------------------
    // Orbit must not fight the gizmo: dragging an axis is not an orbit, and
    // letting both consume the same pointer makes the gizmo unusable.
    this.gizmo.addEventListener('dragging-changed', (event) => {
      this.dragging = event.value === true;
      this.orbit.enabled = !this.dragging;
    });

    this.onGizmoChange = () => {
      this.render();
    };
    this.gizmo.addEventListener('change', this.onGizmoChange);

    // The commit fires on *release*, so a drag is one edit rather than a
    // hundred (see `onTransformCommit`).
    this.gizmo.addEventListener('mouseDown', () => {
      const attached = this.gizmo.object;
      if (attached !== undefined && this.selection.kind === 'instance') {
        this.dragOrigin = {
          position: attached.position.clone(),
          quaternion: attached.quaternion.clone(),
          scale: attached.scale.clone(),
        };
      }
    });
    this.gizmo.addEventListener('mouseUp', () => {
      const attached = this.gizmo.object;
      if (attached !== undefined && this.dragOrigin !== null && this.selection.kind === 'instance') {
        this.callbacks.onTransformCommit?.({
          instanceId: this.selection.id,
          transform: {
            position: [attached.position.x, attached.position.y, attached.position.z],
            rotation: [attached.rotation.x, attached.rotation.y, attached.rotation.z],
            scale: [attached.scale.x, attached.scale.y, attached.scale.z],
          },
        });
      }
      this.dragOrigin = null;
      this.dragging = false;
    });

    this.onPointerDown = (event: PointerEvent) => {
      if (this.dragging) return;
      if (event.button !== 0) return;
      this.selectAt(pointerToNdc(event, this.container.getBoundingClientRect()));
    };
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);

    this.onKeyDown = (event: KeyboardEvent) => {
      this.handleKey(event);
    };
    this.container.tabIndex = 0;
    this.container.addEventListener('keydown', this.onKeyDown);

    this.onResize = () => {
      this.resize();
    };
    globalThis.addEventListener?.('resize', this.onResize);

    this.start();
  }

  // ── public API ───────────────────────────────────────────────────────────

  /**
   * Build a scene from validated data and show it.
   *
   * Synchronous for everything except `.glb` files: those load after the frame
   * is already on screen, and a failure becomes a marker rather than an
   * exception (SPEC R9 — a broken asset must be visible, not fatal).
   */
  load(scene: SceneFile): SceneBuildSummary {
    const { index, failures: registryFailures } = indexPrefabDefinitions(this.prefabs);
    return this.loadFromIndex(scene, index, registryFailures);
  }

  /**
   * `load` with an already-indexed registry.
   *
   * Exposed because the app shell will have indexed the registry once for the
   * outliner and the inspector, and re-indexing per scene load would report the
   * same duplicate-prefab problem twice.
   */
  loadFromIndex(
    scene: SceneFile,
    registry: PrefabIndex,
    registryFailures: readonly SceneBuildFailure[] = [],
  ): SceneBuildSummary {
    if (this.sceneRoot !== null) {
      this.scene.remove(this.sceneRoot);
      disposeSubtree(this.sceneRoot);
    }

    const assembled = assembleScene(scene, registry, { registryFailures });
    this.sceneRoot = assembled.root;
    this.byId = assembled.byId;
    this.scene.add(assembled.root);

    for (const problem of assembled.problems) {
      this.callbacks.onProblem?.(problem);
    }

    for (const error of assembled.errors) {
      this.emitError(error);
    }

    // The scene's own camera. The provisional one the constructor made is only
    // there so the first frame has something to draw through; `buildCamera` is
    // total over the schema, so any camera present is buildable.
    this.replaceCamera(scene.camera);

    // Size the grid to the content, now that the content exists.
    this.gridGroup.clear();
    this.gridGroup.add(createGroundGrid({ size: assembled.gridSize }));

    this.loadPendingModels(assembled.pendingModels);

    const summary: SceneBuildSummary = {
      objectCount: assembled.instances.length,
      placeholderCount: assembled.placeholderCount,
      problems: assembled.problems,
      errors: assembled.errors,
    };
    this.callbacks.onSceneBuilt?.(summary);

    this.render();
    return summary;
  }

  /**
   * Attach or clear the gizmo.
   *
   * Selection is owned here rather than by the Svelte store, because the store
   * cannot be the source of truth for an object the raycaster produced: the
   * owner learns about the selection through `onSelectionChange` and may
   * disagree, in which case this viewport's attachment is the one that matches
   * what is on screen.
   */
  select(selection: Selection): void {
    if (
      this.selection.kind === selection.kind &&
      (selection.kind === 'none' || (this.selection.kind === 'instance' && this.selection.id === selection.id))
    ) {
      return;
    }
    this.selection = selection;

    if (selection.kind === 'none') {
      this.gizmo.detach();
    } else {
      const node = this.byId.get(selection.id);
      if (node === undefined) {
        // The owner selected an id this scene does not contain (an AI deleted
        // it mid-edit). Detach rather than attach to nothing.
        this.gizmo.detach();
      } else {
        this.gizmo.attach(node.object);
        this.render();
      }
    }

    this.callbacks.onSelectionChange?.(selection);
  }

  /** Current selection. */
  getSelection(): Selection {
    return this.selection;
  }

  /** Current gizmo mode. */
  getGizmoMode(): GizmoMode {
    return this.gizmoMode;
  }

  /** Current gizmo space. */
  getSpace(): 'world' | 'local' {
    return this.space;
  }

  /** Current snap increment, or `null` when snapping is off. */
  getSnap(): number | null {
    return this.snap;
  }

  /**
   * Turn snapping on with a grid increment, or off with `null`.
   *
   * Off means `setTranslationSnap(null)`, not `setTranslationSnap(1)`: a snap of
   * 1 quantises to whole units, which reads as "snapping is stuck on" to anyone
   * who expected free movement (see `snapValuesFor`).
   */
  setSnap(increment: number | null): void {
    this.snap = increment;
    const values = snapValuesFor(increment);
    this.gizmo.setTranslationSnap(values.translation);
    this.gizmo.setRotationSnap(values.rotation);
    this.gizmo.setScaleSnap(values.scale);
  }

  /**
   * Set the gizmo mode directly.
   *
   * Called when the toolbar changes the mode without a keyboard event, so the
   * viewport and the store stay in step without a round-trip through `applyAction`.
   */
  setGizmoMode(mode: GizmoMode): void {
    if (this.gizmoMode === mode) return;
    this.gizmoMode = mode;
    this.gizmo.setMode(mode);
    this.render();
  }

  /**
   * Set the transform space directly.
   *
   * Same rationale as `setGizmoMode`: the toolbar sets this via the store, and
   * the viewport needs to reflect it without producing a second `onSpaceChange`.
   */
  setSpaceDirect(space: 'world' | 'local'): void {
    if (this.space === space) return;
    this.space = space;
    this.gizmo.setSpace(space);
    this.render();
  }


  /**
   * Apply one action, from a key or from a test.
   *
   * Public so the bindings can be driven headlessly and asserted without a
   * keyboard, which is what the W/E/R/Q/F test does.
   */
  applyAction(action: ReturnType<typeof viewportActionForKey>): boolean {
    if (action === null) return false;

    switch (action.kind) {
      case 'set-mode': {
        if (this.gizmoMode === action.mode) return true;
        this.gizmoMode = action.mode;
        this.gizmo.setMode(action.mode);
        this.callbacks.onGizmoModeChange?.(action.mode);
        return true;
      }
      case 'toggle-space': {
        this.space = toggleSpace(this.space);
        this.gizmo.setSpace(this.space);
        this.callbacks.onSpaceChange?.(this.space);
        return true;
      }
      case 'focus': {
        this.focus();
        this.callbacks.onFocus?.(this.selection);
        return true;
      }
      default: {
        const never: never = action;
        throw new Error(`Unhandled viewport action: ${JSON.stringify(never)}`);
      }
    }
  }

  /**
   * Handle a keyboard event. Returns true if the key was consumed.
   *
   * A consumed key is `preventDefault`ed so `w` does not also scroll the panel
   * it lives in, and an unbound key is left alone so the app shell still sees
   * it.
   */
  handleKey(event: KeyboardEvent): boolean {
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    const action = viewportActionForKey(event.key);
    if (action === null) return false;
    this.applyAction(action);
    event.preventDefault();
    return true;
  }

  /** Frame the selection, or the whole scene when nothing is selected. */
  focus(): void {
    const target =
      this.selection.kind === 'instance'
        ? (this.byId.get(this.selection.id)?.object ?? null)
        : this.sceneRoot;

    const sphere = target === null ? null : boundingSphereOf(target);
    const { fov, aspect } = cameraFramingNumbers(this.camera);
    applyFraming(this.camera, framingForSelection(sphere, fov, aspect));
    this.orbit.target.copy(
      sphere === null ? new THREE.Vector3() : sphere.center,
    );
    this.orbit.update();
    this.render();
  }

  /** Resize the drawing buffer to the container. */
  resize(): void {
    const width = this.container.clientWidth || 800;
    const height = this.container.clientHeight || 600;
    this.renderer.setSize(width, height, false);
    if (this.camera instanceof THREE.PerspectiveCamera) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    this.render();
  }

  /** Draw one frame. Does not advance anything. */
  render(): void {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * A PNG data URL of the current frame.
   *
   * Present because Step 3's done-when is a non-blank screenshot; there is no
   * GPU in CI, so the test that uses this is the one thing here that cannot
   * run headless today.
   */
  screenshot(): string {
    this.render();
    return this.renderer.domElement.toDataURL('image/png');
  }

  /** The Three.js scene, for a host that wants to add its own helpers. */
  getScene(): THREE.Scene {
    return this.scene;
  }

  /** The active camera. */
  getCamera(): THREE.Camera {
    return this.camera;
  }

  /** Stop the draw loop and release the WebGL context. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameHandle !== null) globalThis.cancelAnimationFrame?.(this.frameHandle);
    this.frameHandle = null;
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.container.removeEventListener('keydown', this.onKeyDown);
    globalThis.removeEventListener?.('resize', this.onResize);
    this.gizmo.removeEventListener('change', this.onGizmoChange);
    this.gizmo.detach();
    this.orbit.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Swap in the scene's camera.
   *
   * OrbitControls and TransformControls both hold a camera reference, so both
   * are re-pointed; a viewport whose gizmo orbits the old camera is a viewport
   * that appears to ignore the scene file.
   */
  private replaceCamera(sceneCamera: SceneFile['camera']): void {
    const camera = buildCamera(sceneCamera);
    camera.position.copy(this.camera.position);
    camera.quaternion.copy(this.camera.quaternion);

    this.scene.remove(this.camera);
    this.scene.add(camera);
    this.camera = camera;

    this.orbit.object = camera;
    this.gizmo.camera = camera;
  }

  /** Raycast at an NDC point and select whatever was hit. */
  private selectAt(ndc: THREE.Vector2): void {
    if (this.sceneRoot === null) {
      this.select({ kind: 'none' });
      return;
    }
    this.raycaster.camera = this.camera;
    const { selection } = pickAt(this.raycaster, [this.sceneRoot], ndc);
    this.select(selection);
  }

  /**
   * Load every `.glb` the scene referenced.
   *
   * Fire-and-forget by design: the frame is already on screen with a placeholder
   * where the model will go, and swapping it in when it arrives is a redraw, not
   * a rebuild. A failure is a marker plus a reported problem.
   */
  private loadPendingModels(
    pending: readonly { id: string; path: string; object: THREE.Object3D }[],
  ): void {
    const resolve = this.resolveModelPath;
    if (resolve === undefined) {
      for (const model of pending) {
        this.failModel(model.id, model.object, model.path, 'no model path resolver was configured');
      }
      return;
    }

    for (const model of pending) {
      const url = resolve(model.path);
      this.loader.load(
        url,
        (gltf) => {
          // A GLTF scene is not an Object3D root; `gltf.scene` is, and its own
          // transforms are relative to it.
          gltf.scene.userData['cfLoaded'] = true;
          model.object.add(gltf.scene);
          this.render();
        },
        undefined,
        (error: unknown) => {
          this.failModel(model.id, model.object, model.path, describeError(error));
        },
      );
    }
  }

  /** Put a visible error marker where a model should have been. */
  private failModel(id: string, target: THREE.Object3D, path: string, reason: string): void {
    const marker = createErrorMarker(`model "${path}" failed to load: ${reason}`);
    marker.userData['cfInstanceId'] = id;
    marker.userData['cfPlaceholder'] = true;
    target.add(marker);

    const message =
      `Model "${path}" for instance "${id}" failed to load: ${reason}. ` +
      'A marker is shown in its place.';
    this.callbacks.onProblem?.({ level: 'error', id, message });

    const appError = createAppError({
      scope: 'instance',
      instanceId: id,
      short: `Model "${path}" for instance "${id}" failed to load: ${reason}`,
      details: message,
    });
    marker.userData['appError'] = appError;
    this.emitError(appError);
  }

  /**
   * Start the draw loop.
   *
   * The frame callback is `render` and nothing else. OrbitControls' damping
   * needs the loop to keep calling `update()` while it settles, so damping is
   * read from the controls rather than from anything in the scene — no time is
   * advanced, and no scene data is mutated by the loop itself.
   */
  private start(): void {
    const tick = (): void => {
      if (this.disposed) return;
      this.orbit.update();
      this.renderer.render(this.scene, this.camera);
      this.frameHandle = globalThis.requestAnimationFrame(tick);
    };
    this.frameHandle = globalThis.requestAnimationFrame(tick);
  }
}

/**
 * Release every GPU resource under a subtree.
 *
 * A `load` that replaces the scene without disposing leaves the previous
 * scene's geometries and materials uploaded, and a developer reloading after
 * every AI edit would leak until the renderer falls over.
 */
function disposeSubtree(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const material = child.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    }
  });
}

/** Format an unknown loader error as a sentence. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * The fov and aspect `framingForSelection` needs, from either camera kind.
 *
 * An orthographic camera has neither, so its frustum is converted into the
 * notional perspective pair that would produce the same on-screen size. That
 * keeps the framing maths in one place rather than duplicated per camera type.
 */
function cameraFramingNumbers(camera: THREE.Camera): { fov: number; aspect: number } {
  if (camera instanceof THREE.PerspectiveCamera) {
    return { fov: camera.fov, aspect: camera.aspect };
  }
  if (camera instanceof THREE.OrthographicCamera) {
    const width = Math.max(camera.right - camera.left, 0.0001);
    const height = Math.max(camera.top - camera.bottom, 0.0001);
    return { fov: 50, aspect: width / height };
  }
  return { fov: 50, aspect: 1 };
}
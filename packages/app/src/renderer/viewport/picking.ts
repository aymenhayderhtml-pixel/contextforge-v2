/**
 * picking.ts — click-to-select, and the pure parts of the gizmo.
 *
 * Picking is a raycast against a scene, which needs no DOM and no GPU, so it
 * lives here and is tested headlessly by casting at a known NDC point against a
 * known scene. What it cannot know — the pixel coordinates of the click — is a
 * parameter.
 *
 * The key handling and the snap application are here too, for the same reason:
 * the bindings come from `ipc.ts` (`gizmoModeForKey`) and must be exercised
 * without a keyboard, and the snap rule ("off is null, not 1") is exactly the
 * kind of thing that regresses silently if it is only ever reached through a
 * real TransformControls instance.
 */

import * as THREE from 'three';
import { gizmoModeForKey, type GizmoMode, type Selection } from '../../ipc.js';

/** How a viewport key resolves once mapped through `gizmoModeForKey`. */
export type ViewportAction =
  | { readonly kind: 'set-mode'; readonly mode: GizmoMode }
  | { readonly kind: 'toggle-space' }
  | { readonly kind: 'focus' };

/**
 * Translate a raw key into a viewport action.
 *
 * Returns `null` for an unbound key. It never switches on key literals: the
 * mapping lives in `ipc.ts` and `gizmoModeForKey` is the only thing consulted,
 * so the shortcut table in the UI and the handler in the viewport cannot
 * disagree (W move, E rotate, R scale, Q toggle world/local, F focus).
 *
 * Modifier keys are ignored deliberately: Ctrl+W and Cmd+W are window
 * shortcuts, and swallowing them here would break the app shell.
 */
export function viewportActionForKey(key: string): ViewportAction | null {
  if (key.length !== 1) return null;
  const binding = gizmoModeForKey(key);
  switch (binding) {
    case 'translate':
      return { kind: 'set-mode', mode: 'translate' };
    case 'rotate':
      return { kind: 'set-mode', mode: 'rotate' };
    case 'scale':
      return { kind: 'set-mode', mode: 'scale' };
    case 'toggle-space':
      return { kind: 'toggle-space' };
    case 'focus':
      return { kind: 'focus' };
    default:
      return null;
  }
}

/** The world/local toggle, which is a pure flip. */
export function toggleSpace(space: 'world' | 'local'): 'world' | 'local' {
  return space === 'world' ? 'local' : 'world';
}

/**
 * The snap values to hand TransformControls for a given increment.
 *
 * `null` when snapping is off, never `1`. This distinction is the whole point:
 * `setTranslationSnap(1)` looks like "no snapping" but is not — it quantises to
 * every whole unit, so a developer who turned snapping off would find they
 * cannot place anything at 0.5 without the cursor drifting back.
 *
 * Rotation uses 15° and scale the same increment: they are separate knobs in
 * Three.js, and a single grid increment applied to rotation would make a 1-unit
 * grid produce 1-radian rotation snaps, which is unusable.
 */
export function snapValuesFor(increment: number | null): {
  translation: number | null;
  rotation: number | null;
  scale: number | null;
} {
  if (increment === null || !Number.isFinite(increment) || increment <= 0) {
    return { translation: null, rotation: null, scale: null };
  }
  return {
    translation: increment,
    rotation: (Math.PI / 180) * 15,
    scale: increment,
  };
}

/** The result of a pick: the instance under the pointer, or nothing. */
export interface PickResult {
  readonly selection: Selection;
  /** The object hit, for a hover highlight or an inspector. */
  readonly object: THREE.Object3D | null;
}

/**
 * Raycast a normalised device coordinate against the scene graph.
 *
 * `ndc` is in [-1, 1] on both axes, which is what a pointer event converts to;
 * taking NDC rather than pixels is what makes this testable — a headless test
 * casts at (0, 0) without a canvas.
 *
 * The raycaster is filtered to `pickTargets` so the grid and the gizmo helper
 * are never selected: clicking empty space on the grid is a deselect, not a
 * selection of the grid.
 *
 * The walk up from the hit object to the instance root is via
 * `userData.cfInstanceId`, set by the scene builder, so a click on a prefab's
 * deep child still reports the *instance* id the scene file knows.
 */
export function pickAt(
  raycaster: THREE.Raycaster,
  pickTargets: readonly THREE.Object3D[],
  ndc: THREE.Vector2,
): PickResult {
  raycaster.setFromCamera(ndc, raycaster.camera as THREE.Camera);
  const hits = raycaster.intersectObjects([...pickTargets], true);
  const first = hits[0];

  if (first === undefined) {
    return { selection: { kind: 'none' }, object: null };
  }

  let node: THREE.Object3D | null = first.object;
  while (node !== null) {
    const id = node.userData['cfInstanceId'];
    if (typeof id === 'string' && id.length > 0) {
      return { selection: { kind: 'instance', id }, object: node };
    }
    node = node.parent;
  }

  // Hit something that is not an instance — the grid, an axis line. Nothing is
  // selectable, but the object is still reported so a caller can say why.
  return { selection: { kind: 'none' }, object: first.object };
}

/** Convert a pointer position inside a canvas to NDC. */
export function pointerToNdc(
  event: { clientX: number; clientY: number },
  rect: { left: number; top: number; width: number; height: number },
): THREE.Vector2 {
  const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  return new THREE.Vector2(x, y);
}

/** The bounding sphere of an object, or null when it has no geometry. */
export function boundingSphereOf(object: THREE.Object3D): THREE.Sphere | null {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return null;
  return box.getBoundingSphere(new THREE.Sphere());
}

/** What a focus action needs to know about the world it is framing. */
export interface Framing {
  readonly target: THREE.Vector3;
  /** Distance from the target the camera should end up at. */
  readonly distance: number;
}

/**
 * Frame a selection, keeping the current viewing direction.
 *
 * Keeping the direction is deliberate: F is a zoom-to-object, not a reset. A
 * developer who orbits to look at the side of a model and presses F expects to
 * be closer to it, not to be yanked back to the default angle.
 *
 * With nothing selected the framing collapses to the origin at a fixed
 * distance, which is the "F on an empty scene" behaviour rather than a crash.
 *
 * `fovDegrees`/`aspect` are the perspective camera's; for an orthographic
 * camera the caller passes a notional pair, because the frustum is resized
 * instead (see {@link applyFraming}).
 */
export function framingForSelection(
  sphere: THREE.Sphere | null,
  fovDegrees = 50,
  aspect = 1,
  fillRatio = 1.4,
): Framing {
  if (sphere === null) {
    return { target: new THREE.Vector3(), distance: 12 };
  }

  const radius = Math.max(sphere.radius, 0.0001);

  // The distance at which a sphere of `radius` exactly fills the frame. Both
  // axes are checked because a narrow viewport is limited by width, not height,
  // and framing only against the fov would push the object off-screen sideways.
  const halfFov = (fovDegrees * Math.PI) / 360;
  const byHeight = radius / Math.tan(halfFov);
  const byWidth = byHeight / Math.max(aspect, 0.0001);
  const distance = Math.max(byHeight, byWidth) * fillRatio;

  return { target: sphere.center.clone(), distance };
}

/**
 * Apply a framing to a camera, preserving the current view direction.
 *
 * `camera` is mutated and pointed at `framing.target`. The direction from the
 * target to the camera is kept, so F zooms without re-orienting — see the note
 * on {@link framingForSelection}.
 */
export function applyFraming(camera: THREE.Camera, framing: Framing): void {
  if (camera instanceof THREE.OrthographicCamera) {
    // An orthographic camera has no distance to travel — zoom is the frustum
    // size, so framing is done by resizing the frustum around the selection.
    const half = Math.max(framing.distance * 0.2, 0.0001);
    camera.left = -half;
    camera.right = half;
    camera.top = half;
    camera.bottom = -half;
    camera.position.copy(framing.target).add(camera.up.clone().multiplyScalar(framing.distance));
    camera.lookAt(framing.target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    return;
  }

  const direction = camera.position.clone().sub(framing.target);
  if (direction.lengthSq() === 0) {
    direction.set(1, 1, 1);
  }
  direction.normalize();

  camera.position.copy(framing.target).add(direction.multiplyScalar(framing.distance));
  camera.lookAt(framing.target);
  camera.updateMatrixWorld();
}
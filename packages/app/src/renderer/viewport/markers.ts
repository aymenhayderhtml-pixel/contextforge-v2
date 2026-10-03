/**
 * markers.ts — visible stand-ins for things that failed to load.
 *
 * Two failures need to be *seen* rather than reported only in a list, because
 * the developer's eye goes to the viewport first:
 *
 *  - a prefab that threw, and
 *  - a `.glb` that failed to load.
 *
 * Both get an emissive box in a colour nobody uses for real geometry. The
 * message is baked into `name` and `userData.message` rather than rendered as a
 * texture label, because a canvas texture per marker would be a canvas
 * allocation per failure and a second thing to test; `name` is what the
 * outliner shows, and `userData` is what a tooltip would read.
 *
 * Kept separate from `sceneGraph.ts` so the marker factory can be asserted on
 * its own, and from `viewport.ts` so nothing here needs a DOM.
 */

import * as THREE from 'three';

/** The colour every failure marker uses. Loud on purpose. */
export const MARKER_COLOR = 0xff3b30;

/** The scale of a failure box, in scene units. */
const MARKER_SIZE = 0.6;

/**
 * A labelled box standing in for something that could not be built.
 *
 * `userData.cfPlaceholder` and `cfInstanceId` are the two keys the viewport and
 * the raycaster rely on; they are set by the caller that knows the instance id.
 */
export function createErrorMarker(message: string): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(MARKER_SIZE, MARKER_SIZE, MARKER_SIZE);
  const material = new THREE.MeshBasicMaterial({
    color: MARKER_COLOR,
    // Wireframe, so a marker is distinguishable from a real object even when
    // the scene happens to contain red geometry.
    wireframe: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `error:${message}`;
  mesh.userData['cfPlaceholder'] = true;
  mesh.userData['message'] = message;
  mesh.userData['error'] = true;
  return mesh;
}

/**
 * Replace a marker with real geometry once a `.glb` finally loads.
 *
 * Returns the object that was added, or `null` if the target is not a marker.
 * Loading is retried by the owner when a file changes on disk, and a second
 * success has to clear the first failure rather than stack markers.
 */
export function resolveMarker(marker: THREE.Object3D, loaded: THREE.Object3D): THREE.Object3D | null {
  if (marker.userData['cfPlaceholder'] !== true) return null;

  // Carry the identity across *before* detaching, so the replacement is still
  // selectable and the outliner still labels it the same way.
  loaded.userData['cfInstanceId'] = marker.userData['cfInstanceId'];
  loaded.userData['cfPlaceholder'] = false;
  loaded.userData['message'] = marker.userData['message'];
  loaded.name = marker.name;

  // The loaded model arrives at the origin; the marker's transform is what
  // placed the failure correctly, so it has to carry across or the object jumps.
  loaded.position.copy(marker.position);
  loaded.quaternion.copy(marker.quaternion);
  loaded.scale.copy(marker.scale);

  // Capture the parent before detaching. `marker.parent` is null once the
  // marker has been removed, so reading it afterwards yields null and the
  // replacement is silently dropped — the marker vanishes, nothing replaces it,
  // and the viewport looks like the object was deleted.
  const parent = marker.parent;
  if (parent !== null) parent.remove(marker);

  // Dispose regardless of whether it was attached. Loading is retried when a
  // file changes on disk, and a marker that leaks its geometry on every retry
  // is how a long editing session runs out of GPU memory.
  marker.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const material = child.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    }
  });

  // An orphan marker still resolves — the caller may be building a subtree that
  // is about to be attached, and the geometry must be freed either way.
  parent?.add(loaded);
  return loaded;
}

/** True when this object is a failure marker. */
export function isErrorMarker(object: THREE.Object3D): boolean {
  return object.userData['error'] === true;
}
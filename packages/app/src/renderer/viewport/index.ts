/**
 * renderer/viewport/index.ts — the viewport's public surface.
 *
 * Re-exported so the Svelte shell has one import path, and so the split
 * between the pure and the DOM halves is visible from the outside:
 *
 *  - **pure** (testable headlessly, no GPU): `sceneGraph`, `stage`, `picking`,
 *    `markers`.
 *  - **DOM/WebGL**: `Viewport`.
 */

export {
  buildSceneGraph,
  indexPrefabDefinitions,
  applyTransform,
  type InstanceNode,
  type PendingModel,
  type PrefabIndex,
  type SceneBuildFailure,
  type SceneBuildFailureKind,
  type SceneGraphBuild,
} from './sceneGraph.js';

export {
  buildCamera,
  buildLight,
  buildLights,
  createGroundGrid,
  defaultCameraFraming,
  gridSizeForRadius,
  type GroundGridOptions,
  type LightNode,
} from './stage.js';

export {
  applyFraming,
  boundingSphereOf,
  framingForSelection,
  pickAt,
  pointerToNdc,
  snapValuesFor,
  toggleSpace,
  viewportActionForKey,
  type Framing,
  type PickResult,
  type ViewportAction,
} from './picking.js';

export { createErrorMarker, isErrorMarker, resolveMarker, MARKER_COLOR } from './markers.js';

export { readVec3, setVec3 } from './vec3.js';

export {
  assembleScene,
  defaultLightRig,
  type AssembleOptions,
  type AssembledScene,
  type SceneProblem,
} from './assemble.js';

export {
  Viewport,
  type ModelPathResolver,
  type SceneBuildSummary,
  type TransformCommit,
  type ViewportCallbacks,
  type ViewportOptions,
  type ViewportProblem,
} from './viewport.js';

export {
  registerPrefab,
  registerPrefabs,
  getRegisteredPrefab,
  getAllRegisteredPrefabs,
  clearRegisteredPrefabs,
} from './registry.js';

export {
  loadPrefabBundle,
  isPrefabDefinition,
  extractPrefabDefinitions,
} from './prefabBundle.js';
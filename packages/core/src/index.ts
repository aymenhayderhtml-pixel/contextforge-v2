/**
 * @contextforge/core — the public surface.
 *
 * Everything the app shell (Step 4) and any CLI may import is re-exported here.
 * Two reasons the surface is curated rather than re-exporting whole modules:
 *
 *  - it keeps the app from reaching into `parse/` or `extract/` internals, so a
 *    refactor there does not ripple into the UI;
 *  - it makes the boundary obvious. If a capability is not listed here, it is not
 *    part of core's contract yet.
 *
 * Core has no UI and no DOM (SPEC R3) and never imports from app (SPEC R4);
 * `npm run check:boundaries` enforces both mechanically.
 */

// ── Graph model ──────────────────────────────────────────────────────────────
export type {
  DependencyGraph,
  EdgeKind,
  Engine,
  GraphEdge,
  GraphNode,
  Manifest,
  NodeContract,
  NodeLock,
  NodeType,
  SlotContract,
  ValidationResult,
} from './graph/types.js';
export { ENGINES, NODE_TYPES, EDGE_KINDS, assertValid, toNodeId } from './graph/types.js';

export {
  buildManifest,
  canonicalizeGraph,
  graphEdgeSchema,
  graphNodeSchema,
  manifestSchema,
  validateManifest,
  validateNode,
} from './graph/manifest.js';

export {
  danglingEdges,
  dependentsOf,
  findCycles,
  layerNodes,
  normalizeDeps,
  reachableFrom,
  sortGraph,
  withDependedOnBy,
} from './graph/reverse.js';

export {
  edgesWithin,
  findOrphans,
  focusNeighbourhood,
  summariseGraph,
} from './graph/analysis.js';
export type {
  FocusedNode,
  FocusDepth,
  GraphSummary,
  Orphan,
  OrphanReason,
} from './graph/analysis.js';

// Which labels the graph screen may draw, and what text. A pure rule so a test
// can assert it without a canvas; see labels.ts for why it lives here.
export { basename, decideGraphLabels, visibleLabels } from './graph/labels.js';
export type { GraphLabel, LabelInputs, LabelReason } from './graph/labels.js';

// ── Parsers ──────────────────────────────────────────────────────────────────
export {
  grammarForPath,
  parseSource,
  tryParse,
  withParsedTree,
  type GrammarName,
  type ParseOutcome,
  type ParsedTree,
} from './parse/grammars.js';

export {
  formatJsExport,
  jsContractExports,
  parseJsModule,
  type JsExport,
  type JsImport,
  type JsModuleContract,
} from './parse/js.js';

export {
  formatGdExport,
  formatGdFunction,
  formatGdSignal,
  findFunctionsMissingBody,
  parseGdScript,
  type GdExport,
  type GdFunction,
  type GdScriptContract,
  type GdSignal,
} from './parse/gdscript.js';

export {
  parseTscn,
  resToRelative,
  rootScriptId,
  TscnParseError,
  type TscnConnection,
  type TscnDocument,
  type TscnExtResource,
  type TscnNode,
} from './parse/tscn.js';

// ── Extraction ───────────────────────────────────────────────────────────────
export {
  IGNORED_DIRECTORIES,
  scanFiles,
  toPosixPath,
  type ScanOptions,
  type ScannedFile,
} from './extract/files.js';

export {
  ASSET_EXTENSIONS,
  buildSlotContractExports,
  findDeclaredSlot,
  isAssetFile,
  parseInCodeSlotHints,
  parseSlotContract,
  type SlotHints,
  type SlotResolution,
} from './extract/assets.js';

export {
  extractHtmlEntrypoints,
  readScriptSources,
  resolveScriptSrc,
  type HtmlEntrypoint,
} from './extract/html.js';

export {
  extractJsProject,
  extractSingleJsModule,
  normalizeAssetRef,
  resolveSpecifier,
  type MissingAsset,
  type UnparseableFile,
} from './extract/js.js';

export {
  extractGodotProject,
  extractSingleGodotFile,
  parseAutoloads,
  type Autoloads,
} from './extract/godot.js';

// ── Patch engine ─────────────────────────────────────────────────────────────
export { findTargetMatch, type MatchResult } from './patch/finder.js';

export {
  applyEditBlocks,
  normalizePatchPath,
  parseEditBlocks,
  type AppliedEdit,
  type EditApplyResult,
  type EditBlock,
  type FailedEdit,
} from './patch/editBlocks.js';

export {
  parseFileBlocks,
  readFileOrNull,
  writeFileBlocks,
  type FileBlock,
  type FileWriteOptions,
  type FileWriteResult,
} from './patch/fileBlocks.js';

export {
  validateAllSyntax,
  validateContentSyntax,
  type SyntaxCheckResult,
} from './patch/syntaxCheck.js';

export {
  DEFAULT_CONTEXT_LINES,
  formatUnifiedDiff,
  generateFlatDiff,
  generateUnifiedDiff,
  type DiffChunk,
  type DiffHunk,
} from './patch/diff.js';

// ── Scene contract ───────────────────────────────────────────────────────────
export {
  IDENTITY_TRANSFORM,
  SCENE_ENGINES,
  SCENE_SCHEMA_VERSION,
  jsonValueSchema,
  sceneCameraSchema,
  sceneFileSchema,
  sceneInstanceSchema,
  sceneLightSchema,
  transformSchema,
  type JsonValue,
  type SceneCamera,
  type SceneFile,
  type SceneInstance,
  type SceneLight,
  type Transform,
  type Vec3,
} from './scene/scene.schema.js';

export {
  emptyScene,
  loadScene,
  parseScene,
  saveScene,
  serializeScene,
  validateScene,
  type SceneError,
  type SceneValidationResult,
} from './scene/sceneFile.js';

export {
  applyEdit,
  applySceneEdit,
  addInstance,
  redoSceneEdit,
  removeInstance,
  sceneHistoryStatus,
  setParams,
  setTransform,
  swapModel,
  undoSceneEdit,
  type EditResult,
  type NewInstance,
  type SceneEdit,
  type SceneEditName,
  type TransformPatch,
  type Vec3Input,
} from './scene/edits.js';

export { mulberry32, rngFor, type Rng } from './scene/rng.js';

export {
  indexPrefabs,
  validateScenePrefabs,
  type PrefabDefinition,
  type PrefabInstance,
  type PrefabParams,
  type PrefabParts,
  type PrefabRegistry,
  type ThreeModule,
} from './scene/prefabs/index.js';

export {
  formatLintResult,
  lintPrefabSource,
  lintPrefabTree,
  LINT_RULES,
  PREFAB_RULES,
  PREFAB_RULE_REASONS,
  type LintResult,
  type LintRule,
  type LintViolation,
  type PrefabRule,
} from './scene/lint.js';

export {
  checkBrief,
  generateProject,
  IncompleteBriefError,
  type GameBrief,
  type GeneratedProject,
} from './scene/template.js';

export {
  buildScaffoldPrompt,
  scaffoldPromptProblems,
} from './scene/scaffoldPrompt.js';

export {
  validateModelSlot,
  makeSlotValidator,
  instanceSlotValidator,
  type SlotExpectations,
  type SlotRejection,
  type SlotRejectionKind,
  type SlotValidationOptions,
  type SlotValidator,
  type SlotVerdict,
} from './scene/slots.js';


// ── Context compiler ────────────────────────────────────────────────────────
export {
  AUTO_ATTACH_COUNT,
  extractFileReferences,
  rankRelevantFiles,
  tokenize,
  type RankInput,
  type RankedFile,
} from './context/rank.js';

export {
  findFunctions,
  sliceAroundLine,
  sliceFunctionAtLine,
  sliceFunctionByName,
  sliceWholeFile,
  type FunctionLocation,
  type Slice,
} from './context/slice.js';

export {
  compileContext,
  DEFAULT_MAX_CHARS,
  strictPatchContract,
  type CompiledContext,
  type CompileOptions,
  type ContextSection,
} from './context/compiler.js';

export {
  briefModeFrom,
  BRIEF_DIR,
  BRIEF_MODES,
  BRIEF_PATH,
  buildBriefMarkdown,
  generateBrief,
  readBrief,
  validateBriefRequest,
  writeBrief,
  type BriefMode,
  type BriefOptions,
  type BriefRequest,
  type BriefStats,
  type BriefValidation,
  type GeneratedBrief,
} from './context/brief.js';

// ── History ──────────────────────────────────────────────────────────────────
export {
  MAX_HISTORY_STEPS,
  captureAndWrite,
  clearHistory,
  getHistoryStatus,
  normalizeProjectPath,
  recordHistoryStep,
  redo,
  undo,
  type FileChange,
  type HistoryActionResult,
  type HistoryStatus,
  type HistoryStep,
} from './history/history.js';

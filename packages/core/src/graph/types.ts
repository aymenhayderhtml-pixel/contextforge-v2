/**
 * graph/types.ts — The dependency graph data model.
 *
 * This is the shared vocabulary between the parsers, the manifest, the scoped
 * prompt compiler, and the UI. Everything downstream reads these types, so they
 * carry the doc comments that v1 kept in a separate ARCHITECTURE.md.
 */

/** Which engine/framework a node belongs to. */
export const ENGINES = ['godot', 'js'] as const;
export type Engine = (typeof ENGINES)[number];

/**
 * The kind of source artifact a node represents.
 *
 * v1 called these "node types" and they are part of the public contract of the
 * manifest, so the string values are unchanged — an existing manifest produced
 * by v1 still validates against the v2 schema.
 */
export const NODE_TYPES = ['scene', 'script', 'module', 'asset'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** The type of dependency relationship between two nodes. */
export const EDGE_KINDS = [
  'ext_resource',
  'signal_connection',
  'import',
  'asset_ref',
  'requires',
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/**
 * Declared slot contract for an asset node.
 *
 * A slot is the promise a consumer makes about an asset: "this file will always
 * be a rigged GLB with these animation clips". Replacing the asset without
 * honouring the slot is what produces an invisible statued character, so the
 * contract is validated, not assumed.
 */
export interface SlotContract {
  /** Human-readable slot identifier, e.g. "character". */
  slot?: string | undefined;
  /** Expected file format, e.g. "glb", "png". */
  format?: string | undefined;
  /** Animation clips the slot requires. */
  expected_animations?: string[] | undefined;
  /** Image dimensions the slot requires, e.g. "512x512". */
  dimensions?: string | undefined;
  /** Whether the model must carry a skeletal rig/skin. */
  rigged?: boolean | undefined;
  /** Maximum allowed file size in kilobytes. */
  max_size_kb?: number | undefined;
}

/**
 * The public interface a node exposes.
 *
 * Every entry is a human-readable signature string rather than structured data,
 * because the primary consumer is an AI reading a scoped prompt: a signature is
 * what it needs, a type graph is noise it has to re-derive.
 */
export interface NodeContract {
  /** Exported vars (Godot @export) or JS named/default exports. */
  exports: string[];
  /** Godot signal declarations. Always empty for JS nodes. */
  signals: string[];
  /** Autoloads, singletons or globals this node assumes exist at runtime. */
  requires: string[];
  /**
   * Slot contract, for asset nodes.
   *
   * Declared as `| undefined` rather than optional-only because Zod's inferred
   * output includes an explicit `undefined` for absent keys, and
   * `exactOptionalPropertyTypes` (SPEC R1) otherwise makes the two unreconcilable.
   */
  slot?: SlotContract | undefined;
}

/** Runtime lock state, used for multi-agent safety. */
export interface NodeLock {
  status: 'free' | 'locked';
  holder: string;
  locked_at: string;
}

/** One node in the dependency graph. */
export interface GraphNode {
  /** Path relative to the project root, e.g. "scenes/Player.tscn". */
  id: string;
  engine: Engine;
  type: NodeType;
  contract: NodeContract;
  /** Node ids this node references directly, parsed from source. */
  depends_on: string[];
  /**
   * Node ids that reference this node. Computed from the full edge set by
   * `reverse.ts` — never parsed directly, because a parser cannot see its
   * callers.
   */
  depended_on_by: string[];
  lock?: NodeLock | undefined;
  slot?: SlotContract | undefined;
}

/** One dependency relationship between two nodes. */
export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

/** A complete dependency graph for one project. */
export interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** A validated manifest: a graph plus its provenance. */
export interface Manifest extends DependencyGraph {
  project_root: string;
  generated_at: string;
}

/** The result of validating untrusted data. Always specific about what failed. */
export interface ValidationResult<T> {
  valid: boolean;
  errors: string[];
  /**
   * Present only when `valid` is true.
   * Explicit `| undefined` so a failed result can be built without the field
   * under `exactOptionalPropertyTypes` (SPEC R1).
   */
  data?: T | undefined;
}

/** Narrow a validation result, throwing a combined error when invalid. */
export function assertValid<T>(
  result: ValidationResult<T>,
  subject = 'Data',
): T {
  if (!result.valid || result.data === undefined) {
    throw new Error(`${subject} validation failed:\n  - ${result.errors.join('\n  - ')}`);
  }
  return result.data;
}

/** Build a node id from an absolute path and a project root. Always POSIX-style. */
export function toNodeId(absolutePath: string, projectRoot: string): string {
  const rel = absolutePath.slice(
    projectRoot.endsWith('/') ? projectRoot.length : projectRoot.length + 1,
  );
  return rel.replaceAll('\\', '/');
}

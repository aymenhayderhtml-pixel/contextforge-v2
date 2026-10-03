/**
 * graph/manifest.ts — Manifest assembly and validation with Zod.
 *
 * v1 validated the manifest with Ajv against a JSON Schema file. v2 uses Zod
 * (SPEC R6) so the same schema technology serves both the manifest and
 * scene.json, and so a TypeScript caller gets the parsed type for free.
 *
 * Zod strips unknown keys by default; here that is deliberately tightened to
 * `.strict()` — a manifest with a typo'd key is a manifest built by a different
 * (buggy) version, and silently dropping the field would hide that.
 */

import { z } from 'zod';
import {
  EDGE_KINDS,
  ENGINES,
  NODE_TYPES,
  type DependencyGraph,
  type GraphEdge,
  type GraphNode,
  type Manifest,
  type ValidationResult,
} from './types.js';

const slotContractSchema = z
  .object({
    slot: z.string().optional(),
    format: z.string().optional(),
    expected_animations: z.array(z.string()).optional(),
    dimensions: z.string().optional(),
    rigged: z.boolean().optional(),
    max_size_kb: z.number().optional(),
  })
  .strict();

const contractSchema = z
  .object({
    exports: z.array(z.string()),
    signals: z.array(z.string()),
    requires: z.array(z.string()),
    slot: slotContractSchema.optional(),
  })
  .strict();

const lockSchema = z
  .object({
    status: z.enum(['free', 'locked']),
    holder: z.string(),
    locked_at: z.string(),
  })
  .strict();

export const graphNodeSchema = z
  .object({
    id: z.string().min(1, 'node id must not be empty'),
    engine: z.enum(ENGINES),
    type: z.enum(NODE_TYPES),
    contract: contractSchema,
    depends_on: z.array(z.string()),
    depended_on_by: z.array(z.string()),
    lock: lockSchema.optional(),
    slot: slotContractSchema.optional(),
  })
  .strict();

export const graphEdgeSchema = z
  .object({
    from: z.string().min(1, 'edge "from" must not be empty'),
    to: z.string().min(1, 'edge "to" must not be empty'),
    kind: z.enum(EDGE_KINDS),
  })
  .strict();

export const manifestSchema = z
  .object({
    project_root: z.string(),
    generated_at: z.string(),
    nodes: z.array(graphNodeSchema),
    edges: z.array(graphEdgeSchema),
  })
  .strict();

export type ParsedManifest = z.infer<typeof manifestSchema>;
export type ParsedGraphNode = z.infer<typeof graphNodeSchema>;

/**
 * Validate a manifest, returning specific errors rather than a bare false
 * (SPEC R9). Zod issues are formatted with their JSON path so a user can go
 * straight to the offending field.
 */
export function validateManifest(input: unknown): ValidationResult<Manifest> {
  const result = manifestSchema.safeParse(input);
  if (result.success) {
    return { valid: true, errors: [], data: result.data };
  }
  return { valid: false, errors: formatIssues(result.error) };
}

/**
 * Validate a single node. Used by the context compiler when it accepts a node
 * assembled from an AI response.
 */
export function validateNode(input: unknown): ValidationResult<GraphNode> {
  const result = graphNodeSchema.safeParse(input);
  if (result.success) {
    return { valid: true, errors: [], data: result.data };
  }
  return { valid: false, errors: formatIssues(result.error) };
}

/** Turn a ZodError into human-readable lines that name the failing path. */
function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

/**
 * Assemble a manifest from an extracted graph.
 *
 * `now` is injected rather than read from the clock so that callers can make
 * manifests byte-identical in tests (SPEC R8).
 */
export function buildManifest(
  projectRoot: string,
  graph: DependencyGraph,
  generatedAt: string,
): Manifest {
  return {
    project_root: projectRoot,
    generated_at: generatedAt,
    nodes: graph.nodes,
    edges: graph.edges,
  };
}

/**
 * Serialize a graph in the canonical form used for hashing and for handing to an
 * AI: nodes and edges sorted, no provenance fields. Two extractions of the same
 * project must produce identical strings.
 */
export function canonicalizeGraph(graph: DependencyGraph): string {
  const nodes = [...graph.nodes]
    .map((n) => ({
      id: n.id,
      engine: n.engine,
      type: n.type,
      exports: [...n.contract.exports].sort(),
      signals: [...n.contract.signals].sort(),
      requires: [...n.contract.requires].sort(),
      depends_on: [...n.depends_on].sort(),
      depended_on_by: [...n.depended_on_by].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const edges = [...graph.edges]
    .map((e) => ({ from: e.from, to: e.to, kind: e.kind }))
    .sort(
      (a, b) =>
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to) ||
        a.kind.localeCompare(b.kind),
    );

  return JSON.stringify({ nodes, edges }, null, 2);
}

/** Build an empty edge list from a node list. Used by tests and the scaffolder. */
export function edgesFromNodes(nodes: GraphNode[]): GraphEdge[] {
  return nodes.flatMap((n) =>
    n.depends_on.map((to) => ({ from: n.id, to, kind: 'import' as const })),
  );
}

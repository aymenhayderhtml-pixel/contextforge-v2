/**
 * tree.ts — the outliner's pure logic, with no Svelte and no DOM.
 *
 * Everything the Outliner decides — what is a root, who is a child, what the
 * search keeps, what a delete will do to a subtree — is computed here and unit
 * tested. The component is then a rendering of these values, which is why the
 * interesting behaviour can be tested in Node with no browser (SPEC R2).
 *
 * ## Two rules the shape below exists to enforce
 *
 *  1. **No instance is ever dropped.** A scene that fails validation on a
 *     dangling `parent` must still be drawable, so an instance whose parent is
 *     not in the list is surfaced as a root with `orphan: true` rather than
 *     disappearing (R9: say what is wrong, do not show an empty panel).
 *  2. **Sibling order is the file's order.** `scene.json` is written
 *     deterministically (R8), so preserving the order it arrived in is stable
 *     across reloads. Re-sorting by name would make a row jump every time an
 *     instance is renamed.
 */

import type { PrefabFailure, PrefabSummary } from '../../ipc.js';
import type { SceneInstance } from '@contextforge/core';

/** One node of the rendered hierarchy. */
export interface OutlinerNode {
  /** The instance this row edits. */
  readonly instance: SceneInstance;
  /** Display label: `name` when set, else the id. */
  readonly label: string;
  /** 0 for a root. */
  readonly depth: number;
  /**
   * True when `instance.parent` names an id that is not in the list.
   *
   * The row is still shown, at the root, with a marker — a hidden instance is
   * an instance a developer cannot select and cannot delete.
   */
  readonly orphan: boolean;
  /** True when the registry could not load this instance's prefab. */
  readonly failed: boolean;
  /** The failure, when `failed` is true, so the row can say why. */
  readonly failure: PrefabFailure | null;
  readonly children: readonly OutlinerNode[];
}

/** The instance's display name, defaulting to its id (SPEC §4.2). */
export function instanceLabel(instance: SceneInstance): string {
  const name = instance.name;
  return name !== undefined && name !== '' ? name : instance.id;
}

/**
 * Build the hierarchy.
 *
 * `failedByName` maps a prefab name to its load failure, so a row can be marked
 * as coming from a prefab that threw. It comes from `PrefabRegistryResult.failed`
 * and is matched by name rather than by file, because an instance records only
 * the prefab name (SPEC §4.2).
 */
export function buildTree(
  instances: readonly SceneInstance[],
  failedByName: ReadonlyMap<string, PrefabFailure> = new Map(),
): OutlinerNode[] {
  const known = new Set(instances.map((instance) => instance.id));

  const childrenOf = new Map<string, SceneInstance[]>();
  for (const instance of instances) {
    const parent = instance.parent;
    // A self-parent or a dangling parent cannot be shown as a child of
    // something; both become flagged roots rather than vanishing.
    if (parent === undefined || parent === instance.id || !known.has(parent)) continue;
    const bucket = childrenOf.get(parent);
    if (bucket === undefined) childrenOf.set(parent, [instance]);
    else bucket.push(instance);
  }

  // `rendered` is filled by `make` itself rather than by the root scan, because
  // "is a root" and "has been shown" are different questions once a cycle exists.
  const rendered = new Set<string>();

  // `onPath` is the chain of ids currently being rendered. A cycle the schema
  // should have refused (`a` parents `b`, `b` parents `a`) would recurse until
  // the stack gives out and take the whole outliner with it. The child that
  // closes the cycle is **dropped from the child list, not drawn as a leaf**:
  // it is already a row further up the same path, so drawing it again would put
  // the same instance on screen twice, with two delete buttons for one instance.
  // Dropping loses nothing — every id on the path is on screen by construction.
  const make = (
    instance: SceneInstance,
    depth: number,
    orphan: boolean,
    onPath: ReadonlySet<string>,
  ): OutlinerNode => {
    const failure = failedByName.get(instance.prefab) ?? null;
    rendered.add(instance.id);
    const nextPath = new Set(onPath).add(instance.id);
    const children = (childrenOf.get(instance.id) ?? [])
      .filter((child) => !onPath.has(child.id))
      .map((child) => make(child, depth + 1, false, nextPath));
    return {
      instance,
      label: instanceLabel(instance),
      depth,
      orphan,
      failed: failure !== null,
      failure,
      children,
    };
  };

  const isTrueRoot = (instance: SceneInstance): boolean => {
    const parent = instance.parent;
    return parent === undefined || parent === instance.id || !known.has(parent);
  };

  const roots: OutlinerNode[] = [];
  for (const instance of instances) {
    if (isTrueRoot(instance)) roots.push(make(instance, 0, instance.parent !== undefined, new Set()));
  }

  // Anything unreachable from a root is in a cycle the schema refused. It is
  // re-rooted rather than dropped, because an instance the outliner cannot show
  // is an instance the developer cannot select or delete (R9). Re-rooting the
  // first unrendered instance in file order keeps the result deterministic (R8).
  for (const instance of instances) {
    if (rendered.has(instance.id)) continue;
    roots.push(make(instance, 0, true, new Set()));
  }
  return roots;
}

/**
 * Does a row match the search box?
 *
 * Three fields, and all three because a developer searching a scene half-remembered
 * reaches for whichever one they remember: the instance id they typed, the name
 * they gave it, or the prefab they know it was made from. Matching is
 * case-insensitive and substring-based — a prefix search hides everything a
 * developer would want to see once they have not finished typing.
 */
export function matchesQuery(node: OutlinerNode, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return (
    node.instance.id.toLowerCase().includes(needle) ||
    node.label.toLowerCase().includes(needle) ||
    node.instance.prefab.toLowerCase().includes(needle)
  );
}

/** Why a filtered node is visible. Used for the "matched via child" hint. */
export type VisibleReason = 'match' | 'descendant' | 'ancestor';

/** A node that survived the search filter, with its surviving subtree. */
export interface VisibleNode {
  readonly node: OutlinerNode;
  readonly children: readonly VisibleNode[];
  readonly reason: VisibleReason;
}

/**
 * Filter the tree by the search box.
 *
 * The rule that matters: **a node is visible if it matches, if any descendant
 * matches, or if any ancestor matches.** The first two keep a search for a
 * deeply-nested id from losing its ancestors; the third means matching a parent
 * shows its whole subtree rather than only the parent. Without the third, a
 * developer who searches `crate` sees the parent and not the four children
 * hanging off it, and cannot tell whether the children were deleted.
 *
 * A descendant-only match is reported as `reason: 'descendant'` so the row can
 * say "shown because a child matches" rather than pretending it matched itself.
 */
export function filterTree(nodes: readonly OutlinerNode[], query: string): VisibleNode[] {
  const visit = (node: OutlinerNode, ancestorMatched: boolean): VisibleNode | null => {
    const selfMatch = matchesQuery(node, query);
    const children: VisibleNode[] = [];
    for (const child of node.children) {
      const kept = visit(child, ancestorMatched || selfMatch);
      if (kept !== null) children.push(kept);
    }
    if (selfMatch) return { node, children, reason: 'match' };
    if (children.length > 0) return { node, children, reason: 'descendant' };
    if (ancestorMatched) return { node, children, reason: 'ancestor' };
    return null;
  };

  const out: VisibleNode[] = [];
  for (const node of nodes) {
    const kept = visit(node, false);
    if (kept !== null) out.push(kept);
  }
  return out;
}

/** Depth-first flattening, for keyboard navigation. */
export function flattenTree(nodes: readonly OutlinerNode[]): OutlinerNode[] {
  const out: OutlinerNode[] = [];
  const visit = (node: OutlinerNode): void => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return out;
}

/** Flatten the *filtered* tree, so keyboard navigation skips hidden rows. */
export function flattenVisible(nodes: readonly VisibleNode[]): VisibleNode[] {
  const out: VisibleNode[] = [];
  const visit = (node: VisibleNode): void => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return out;
}

/** Direct children of a node. */
export function childCount(node: OutlinerNode): number {
  return node.children.length;
}

/** The node itself plus everything under it. */
export function countSubtree(node: OutlinerNode): number {
  let total = 1;
  for (const child of node.children) total += countSubtree(child);
  return total;
}

/** How many instances a delete would re-parent, directly and at any depth. */
export function countDirectChildren(node: OutlinerNode): number {
  return node.children.length;
}

/**
 * Where the children of `node` go if it is deleted.
 *
 * Core's `removeInstance` moves them to the removed instance's own parent
 * (SPEC §4.2 / `scene/edits.ts`), which is the answer the confirm text has to
 * give — a delete that silently flattens a stack to the scene root is a
 * destructive action the developer did not agree to.
 */
export function reparentTargetLabel(node: OutlinerNode): string {
  const parentId = node.instance.parent;
  if (parentId === undefined) return 'the scene root';
  return `“${parentId}”`;
}

/**
 * The sentence the delete confirmation shows.
 *
 * One function, so the wording cannot drift between the button's tooltip, the
 * confirm dialog and a future keyboard shortcut.
 */
export function describeRemoval(node: OutlinerNode): string {
  const children = countDirectChildren(node);
  if (children === 0) {
    return `Delete “${node.label}”? It has no children, so nothing else changes.`;
  }
  const plural = children === 1 ? 'child' : 'children';
  return `Delete “${node.label}”? Its ${children} ${plural} will be moved up to ${reparentTargetLabel(
    node,
  )}, and kept — nothing is deleted with it.`;
}

/** The outcome of a confirmed delete, emitted upward as an intent. */
export interface DeleteIntent {
  readonly instanceId: string;
  /** Where the removed instance's children will be re-parented, for the log. */
  readonly reparentedTo: string | null;
}

/** Build the delete intent for a confirmed deletion. */
export function deleteIntentFor(node: OutlinerNode): DeleteIntent {
  const parentId = node.instance.parent;
  return {
    instanceId: node.instance.id,
    reparentedTo: parentId === undefined ? null : parentId,
  };
}

/**
 * The outcome of picking a prefab in the add-instance list.
 *
 * Deliberately carries no `id`: an id must be unique within the scene and the
 * list of taken ids lives with the scene, so minting one here would be
 * inventing a value the rest of the system owns. The shell that owns the
 * snapshot assigns it and sends one `SceneEdit` (SPEC R10 / D5).
 */
export interface AddIntent {
  /** A name that came from `PrefabSummary.name`. Never synthesised here. */
  readonly prefab: string;
  /** Parent instance id, or `null` for a root. */
  readonly parent: string | null;
}

/** Build the add intent for a picked prefab, parented to the current selection. */
export function addIntentFor(prefabName: string, parentId: string | null): AddIntent {
  return { prefab: prefabName, parent: parentId };
}

// ── Prefab picker ────────────────────────────────────────────────────────────

/** What the picker's list is showing, and why. */
export type PickerState =
  | { readonly kind: 'empty-registry' }
  | { readonly kind: 'no-match'; readonly query: string }
  | { readonly kind: 'list'; readonly prefabs: readonly PrefabSummary[] };

/**
 * What the add-instance picker shows.
 *
 * A discriminated union rather than a filtered array plus a boolean, because
 * "the registry is empty" and "nothing matched what you typed" are different
 * situations and give the developer different next steps. Collapsing them into
 * one empty list means a developer who typed a typo cannot tell whether the
 * project has no prefabs or whether they spelled it wrong.
 */
export function pickerState(
  prefabs: readonly PrefabSummary[],
  query: string,
): PickerState {
  if (prefabs.length === 0) return { kind: 'empty-registry' };
  const needle = query.trim().toLowerCase();
  const matches =
    needle === ''
      ? prefabs
      : prefabs.filter(
          (prefab) =>
            prefab.name.toLowerCase().includes(needle) ||
            prefab.description.toLowerCase().includes(needle),
        );
  if (matches.length === 0) return { kind: 'no-match', query };
  return { kind: 'list', prefabs: matches };
}

/** The sentence the picker shows when it has nothing to list. */
export function pickerEmptyText(state: PickerState): string {
  switch (state.kind) {
    case 'empty-registry':
      return 'No prefabs loaded. The registry is empty, so there is nothing to place.';
    case 'no-match':
      return `No prefab matches “${state.query}”.`;
    case 'list':
      return '';
  }
}

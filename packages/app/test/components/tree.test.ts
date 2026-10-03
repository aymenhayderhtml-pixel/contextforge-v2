/**
 * tree.test.ts — the outliner's decisions, tested with no browser.
 *
 * The component is a rendering of these functions; every behaviour the brief
 * calls out (search keeping children of a matched parent, a delete that says
 * what happens to the children, a failed prefab being visible) is asserted
 * here so it cannot regress behind a markup change.
 */

import { describe, expect, it } from 'vitest';
import type { JsonSchema, PrefabFailure, PrefabSummary } from '../../src/ipc.js';
import type { SceneInstance } from '@contextforge/core';
import {
  addIntentFor,
  buildTree,
  countDirectChildren,
  countSubtree,
  deleteIntentFor,
  describeRemoval,
  filterTree,
  flattenTree,
  flattenVisible,
  instanceLabel,
  matchesQuery,
  pickerEmptyText,
  pickerState,
  reparentTargetLabel,
} from '../../src/renderer/components/tree.js';

/** A schema with no properties, for the picker cases that do not use one. */
const EMPTY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
};

function instance(
  id: string,
  extra: Partial<SceneInstance> = {},
): SceneInstance {
  return {
    id,
    prefab: 'crate',
    transform: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    params: {},
    ...extra,
  };
}

/** crate → coin-a, coin-b → gem, plus a loose root. */
const SCENE: SceneInstance[] = [
  instance('crate', { name: 'Crate' }),
  instance('coin-a', { prefab: 'coin', parent: 'crate' }),
  instance('coin-b', { prefab: 'coin', parent: 'crate' }),
  instance('gem', { prefab: 'gem', parent: 'coin-b' }),
  instance('lamp', { prefab: 'lamp' }),
];

function ids(nodes: ReturnType<typeof buildTree>): string[] {
  return nodes.map((node) => node.instance.id);
}

function visibleIds(nodes: ReturnType<typeof filterTree>): string[] {
  return flattenVisible(nodes).map((row) => row.node.instance.id);
}

describe('buildTree', () => {
  it('places instances with no parent at the root, in file order', () => {
    const tree = buildTree(SCENE);
    expect(ids(tree)).toEqual(['crate', 'lamp']);
  });

  it('nests children under their parent and reports depth', () => {
    const crate = buildTree(SCENE)[0];
    expect(crate).toBeDefined();
    expect(crate?.children.map((child) => child.instance.id)).toEqual(['coin-a', 'coin-b']);
    expect(crate?.children[0]?.depth).toBe(1);
    expect(crate?.children[1]?.children[0]?.depth).toBe(2);
  });

  it('accounts for every instance exactly once', () => {
    expect(flattenTree(buildTree(SCENE))).toHaveLength(SCENE.length);
  });

  it('uses the name for the label and falls back to the id', () => {
    expect(instanceLabel(instance('crate', { name: 'Crate' }))).toBe('Crate');
    expect(instanceLabel(instance('crate'))).toBe('crate');
    expect(instanceLabel(instance('crate', { name: '' }))).toBe('crate');
  });

  it('surfaces an instance with a dangling parent as a flagged root rather than dropping it', () => {
    const tree = buildTree([
      instance('orphan', { parent: 'does-not-exist' }),
      instance('ok'),
    ]);
    expect(ids(tree)).toEqual(['orphan', 'ok']);
    expect(tree[0]?.orphan).toBe(true);
    expect(tree[1]?.orphan).toBe(false);
  });

  it('treats a self-parent as a root instead of recursing forever', () => {
    const tree = buildTree([instance('loop', { parent: 'loop' })]);
    expect(ids(tree)).toEqual(['loop']);
    expect(tree[0]?.children).toHaveLength(0);
  });

  it('does not lose or duplicate a member of a two-instance parent cycle', () => {
    // A scene this malformed is refused by the schema, so the outliner still has
    // to draw it: a lost instance is one the developer cannot select or delete.
    const tree = buildTree([instance('a', { parent: 'b' }), instance('b', { parent: 'a' })]);
    const flat = flattenTree(tree).map((node) => node.instance.id);
    expect(flat).toHaveLength(2);
    expect(new Set(flat).size).toBe(2);
    // At least one root exists, and it is flagged so the reason is visible.
    expect(tree.length).toBeGreaterThan(0);
    expect(tree.some((node) => node.orphan)).toBe(true);
  });

  it('breaks a cycle at the point it closes rather than recursing forever', () => {
    // root → a → b → a. `a` is already on the path when `b` is rendered, so it
    // is not nested under `b` a second time.
    const tree = buildTree([
      instance('root'),
      instance('a', { parent: 'root' }),
      instance('b', { parent: 'a' }),
    ]);
    const flat = flattenTree(tree).map((node) => node.instance.id);
    expect(flat).toEqual(['root', 'a', 'b']);
    const b = flattenTree(tree).find((node) => node.instance.id === 'b');
    expect(b?.children).toEqual([]);
  });

  it('marks a row whose prefab is in the registry’s failed list, with the reason', () => {
    const failure: PrefabFailure = { name: 'gem', file: 'prefabs/gem.ts', reason: 'boom' };
    const byName = new Map([['gem', failure]]);
    const tree = buildTree(SCENE, byName);
    const gem = flattenTree(tree).find((node) => node.instance.id === 'gem');
    expect(gem?.failed).toBe(true);
    expect(gem?.failure).toBe(failure);
    const crate = tree[0];
    expect(crate?.failed).toBe(false);
    expect(crate?.failure).toBeNull();
  });

  it('returns nothing for an empty scene', () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe('matchesQuery', () => {
  const crate = buildTree(SCENE)[0];
  const coin = crate?.children[0];

  it('matches the instance id', () => {
    expect(matchesQuery(crate!, 'crat')).toBe(true);
  });

  it('matches the display name', () => {
    expect(matchesQuery(crate!, 'crate')).toBe(true);
  });

  it('matches the prefab name', () => {
    expect(coin ? matchesQuery(coin, 'coin') : false).toBe(true);
  });

  it('is case-insensitive and trims the query', () => {
    expect(matchesQuery(crate!, '  CRATE ')).toBe(true);
  });

  it('matches everything when the query is empty', () => {
    expect(matchesQuery(crate!, '   ')).toBe(true);
  });

  it('does not match an unrelated substring', () => {
    expect(matchesQuery(crate!, 'lamp')).toBe(false);
  });
});

describe('filterTree', () => {
  const tree = buildTree(SCENE);

  it('keeps the whole subtree when a parent matches', () => {
    // The bug this guards: a matched parent showing as a row with no children,
    // so the developer cannot tell whether the children were deleted.
    // 'crate' hits the parent's prefab name AND both children ("coin-a",
    // "coin-b") by prefab, so the expected list is not a guess.
    expect(visibleIds(filterTree(tree, 'crate'))).toEqual(['crate', 'coin-a', 'coin-b', 'gem']);
  });

  it('keeps the children of a matched parent even when only the parent matched', () => {
    // 'Crat' matches only the parent's display name. The two coins and the gem
    // are in its subtree, so they must be visible too.
    expect(visibleIds(filterTree(tree, 'Crat'))).toEqual(['crate', 'coin-a', 'coin-b', 'gem']);
  });

  it('keeps the ancestors of a deep match so the match is not orphaned', () => {
    const kept = filterTree(tree, 'gem');
    expect(visibleIds(kept)).toEqual(['crate', 'coin-b', 'gem']);
  });

  it('labels a row kept only because a descendant matched', () => {
    const kept = filterTree(tree, 'gem');
    const crate = kept[0];
    expect(crate?.reason).toBe('descendant');
    const gem = flattenVisible(kept).find((row) => row.node.instance.id === 'gem');
    expect(gem?.reason).toBe('match');
  });

  it('labels a row kept because an ancestor matched as an ancestor, not a match', () => {
    const crate = filterTree(tree, 'crate')[0];
    expect(crate?.reason).toBe('match');
    const coinA = crate?.children[0];
    expect(coinA?.reason).toBe('ancestor');
  });

  it('matches on prefab name and keeps the hierarchy of every hit', () => {
    // 'coin' hits two children of different depths, so both paths survive.
    expect(visibleIds(filterTree(tree, 'coin'))).toEqual(['crate', 'coin-a', 'coin-b', 'gem']);
  });

  it('returns everything for an empty query', () => {
    expect(visibleIds(filterTree(tree, ''))).toEqual(flattenTree(tree).map((n) => n.instance.id));
  });

  it('returns nothing when nothing matches', () => {
    expect(filterTree(tree, 'zzzz')).toEqual([]);
  });

  it('preserves file order among the surviving siblings', () => {
    const kept = filterTree(tree, 'coin');
    expect(kept[0]?.children.map((row) => row.node.instance.id)).toEqual(['coin-a', 'coin-b']);
  });
});

describe('subtree counts', () => {
  const crate = buildTree(SCENE)[0];

  it('counts direct children separately from the whole subtree', () => {
    expect(countDirectChildren(crate!)).toBe(2);
    expect(countSubtree(crate!)).toBe(4);
  });
});

describe('describeRemoval', () => {
  const tree = buildTree(SCENE);
  const crate = tree[0]!;
  const coinB = crate.children[1]!;
  const lamp = tree[1]!;

  it('says plainly that nothing else changes for a leaf', () => {
    expect(describeRemoval(lamp)).toContain('no children');
    expect(describeRemoval(lamp)).toContain('nothing else changes');
  });

  it('states the consequence for a childless-of-children parent', () => {
    expect(describeRemoval(coinB)).toContain('1 child');
    expect(describeRemoval(coinB)).toContain('moved up to');
  });

  it('names the re-parent target and says the children are kept', () => {
    const text = describeRemoval(crate);
    expect(text).toContain('2 children');
    expect(text).toContain('will be moved up to');
    expect(text).toContain('kept');
    // A root's children go to the scene root, not to the root's own id.
    expect(text).toContain('the scene root');
    expect(reparentTargetLabel(crate)).toBe('the scene root');
  });

  it('names the removed instance’s own parent as the destination', () => {
    expect(describeRemoval(coinB)).toContain('“crate”');
  });

  it('says a root’s children move to the scene root', () => {
    expect(reparentTargetLabel(crate)).toBe('the scene root');
    expect(reparentTargetLabel(coinB)).toBe('“crate”');
  });
});

describe('intents', () => {
  const tree = buildTree(SCENE);
  const crate = tree[0]!;

  it('carries the instance id and where its children will go', () => {
    expect(deleteIntentFor(crate)).toEqual({ instanceId: 'crate', reparentedTo: null });
    expect(deleteIntentFor(crate.children[0]!)).toEqual({
      instanceId: 'coin-a',
      reparentedTo: 'crate',
    });
  });

  it('carries a prefab name and the current parent for an add, and mints no id', () => {
    const intent = addIntentFor('coin', 'crate');
    expect(intent).toEqual({ prefab: 'coin', parent: 'crate' });
    expect(Object.keys(intent)).not.toContain('id');
  });
});

describe('pickerState', () => {
  const prefabs: PrefabSummary[] = [
    { name: 'crate', description: 'a wooden box', paramsJsonSchema: EMPTY_SCHEMA },
    { name: 'coin', description: 'a spinning coin', paramsJsonSchema: EMPTY_SCHEMA },
  ];

  it('distinguishes an empty registry from a query that matched nothing', () => {
    // The two need different next steps: one says "the project has no prefabs",
    // the other says "you spelled it wrong". One empty list would say neither.
    expect(pickerState([], '')).toEqual({ kind: 'empty-registry' });
    expect(pickerState(prefabs, 'nope')).toEqual({ kind: 'no-match', query: 'nope' });
  });

  it('lists everything for an empty query', () => {
    const state = pickerState(prefabs, '  ');
    expect(state.kind).toBe('list');
    if (state.kind === 'list') expect(state.prefabs.map((p) => p.name)).toEqual(['crate', 'coin']);
  });

  it('filters on the prefab name', () => {
    const state = pickerState(prefabs, 'coi');
    if (state.kind !== 'list') throw new Error('expected a list');
    expect(state.prefabs.map((p) => p.name)).toEqual(['coin']);
  });

  it('filters on the description, which is the only thing a developer remembers', () => {
    const state = pickerState(prefabs, 'wooden');
    if (state.kind !== 'list') throw new Error('expected a list');
    expect(state.prefabs.map((p) => p.name)).toEqual(['crate']);
  });

  it('never lists a prefab that is not in the registry', () => {
    const state = pickerState(prefabs, '');
    if (state.kind !== 'list') throw new Error('expected a list');
    expect(state.prefabs.every((p) => prefabs.includes(p))).toBe(true);
  });

  it('has a sentence for each empty case and none for a populated list', () => {
    expect(pickerEmptyText({ kind: 'empty-registry' })).toContain('No prefabs loaded');
    expect(pickerEmptyText({ kind: 'no-match', query: 'zzz' })).toContain('zzz');
    expect(pickerEmptyText({ kind: 'list', prefabs })).toBe('');
  });
});

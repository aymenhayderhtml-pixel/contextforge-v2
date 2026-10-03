/**
 * registry.ts — runtime prefab registry for the renderer viewport.
 *
 * Stores executable PrefabDefinitions loaded from browser bundles so the
 * scene graph builder can instantiate real prefabs with Three.js.
 */

import type { PrefabDefinition } from '@contextforge/core';

const registry = new Map<string, PrefabDefinition>();
type RegistryListener = () => void;
const listeners = new Set<RegistryListener>();

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.error('[registry] listener error:', err);
    }
  }
}

/** Subscribe to registry changes. Returns an unsubscribe callback. */
export function subscribeRegistry(listener: RegistryListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Register a single executable prefab definition. */
export function registerPrefab(prefab: PrefabDefinition): void {
  registry.set(prefab.name, prefab);
  notifyListeners();
}

/** Register multiple executable prefab definitions. */
export function registerPrefabs(prefabs: Iterable<PrefabDefinition>): void {
  for (const prefab of prefabs) {
    registry.set(prefab.name, prefab);
  }
  notifyListeners();
}

/** Get a registered prefab definition by name. */
export function getRegisteredPrefab(name: string): PrefabDefinition | undefined {
  return registry.get(name);
}

/** Get all currently registered prefab definitions. */
export function getAllRegisteredPrefabs(): PrefabDefinition[] {
  return [...registry.values()];
}

/** Clear all registered prefabs. */
export function clearRegisteredPrefabs(): void {
  registry.clear();
  notifyListeners();
}

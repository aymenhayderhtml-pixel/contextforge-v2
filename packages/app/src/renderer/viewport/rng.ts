/**
 * renderer/viewport/rng.ts — browser-safe seeded randomness.
 *
 * This is a verbatim copy of `packages/core/src/scene/rng.ts` kept here so the
 * renderer bundle has no Node.js dependency on core. Core's version is the
 * authoritative one; if you change the algorithm there, change it here too.
 *
 * Why copy rather than export from core's browser entry point:
 *
 * - core has no browser entry point — it is a Node.js package (tree-sitter,
 *   node:fs) and `nodeIntegration: false` means the renderer cannot require it.
 * - `rngFor` is a pure, dependency-free function. Moving it to a shared package
 *   would be correct but is out of scope for Step 3. The duplication is a
 *   single module with no observable behaviour difference.
 *
 * `rngFor` is the only runtime import the renderer takes from core. All other
 * core imports in the renderer are `import type`, which are erased at build time.
 */

/** A seeded random source. */
export interface Rng {
  next(): number;
  range(min: number, max: number): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
  fork(salt: number): Rng;
}

/** Build a generator from a 32-bit seed. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    range(min, max) { return min + next() * (max - min); },
    int(min, max) { return min + Math.floor(next() * (max - min + 1)); },
    pick(items) {
      const index = Math.floor(next() * items.length);
      return items[Math.min(index, items.length - 1)] as never;
    },
    chance(p) { return next() < p; },
    fork(salt) {
      return mulberry32((Math.imul(salt >>> 0, 0x9e3779b1) ^ state) >>> 0);
    },
  };
  return rng;
}

/**
 * Combine a scene seed and an instance id into one generator.
 *
 * Each instance gets its own reproducible stream so identical prefabs placed
 * at different positions produce different (but deterministic) results.
 */
export function rngFor(sceneSeed: number, instanceId: string): Rng {
  let hash = 0x811c9dc5;
  for (let i = 0; i < instanceId.length; i++) {
    hash ^= instanceId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return mulberry32((Math.imul(sceneSeed >>> 0, 0x9e3779b1) ^ hash) >>> 0);
}

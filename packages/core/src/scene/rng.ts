/**
 * scene/rng.ts — seeded randomness (SPEC R7).
 *
 * A prefab that places a scatter of rocks must place the *same* rocks every
 * time, given the same scene. `Math.random()` cannot do that: it is ambient,
 * unrecorded state, so the scene on disk no longer describes what is on screen.
 * Two AIs editing the same project would each get a different answer, and a
 * scene could not be diffed — a one-rock change would show as every rock moved.
 *
 * `mulberry32` is used because it is a whole 32-bit state in one line, has no
 * dependencies, and passes gjrand's basic suite. It is not cryptographically
 * secure and does not need to be: this is placement jitter, not a key.
 *
 * The seed is a **parameter**, never read from a global or a clock. That is what
 * makes a prefab pure, and it is why the scene file carries a `seed` field.
 */

/** A seeded random source. */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** A fresh generator advanced by `count` steps — handy for sub-streams. */
  fork(salt: number): Rng;
}

/**
 * Build a generator from a 32-bit seed.
 *
 * The seed is coerced with `>>> 0` so a negative or fractional seed from a JSON
 * file still produces a usable state. Refusing a negative seed would be correct
 * but unhelpful: `seed` is data a user types, and the useful behaviour of
 * `-1` is a well-defined state, not an error.
 */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    // The constants are the murmur3 finalizer's; the mixing is what keeps
    // adjacent seeds from producing adjacent first values, which is the
    // common failure of a naive LCG on a lattice.
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,

    range(min, max) {
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        throw new Error(`rng.range needs finite bounds, got [${min}, ${max}]`);
      }
      if (min > max) {
        throw new Error(`rng.range needs min <= max, got [${min}, ${max}]`);
      }
      return min + next() * (max - min);
    },

    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max)) {
        throw new Error(`rng.int needs integer bounds, got [${min}, ${max}]`);
      }
      if (min > max) {
        throw new Error(`rng.int needs min <= max, got [${min}, ${max}]`);
      }
      return min + Math.floor(next() * (max - min + 1));
    },

    pick(items) {
      if (items.length === 0) {
        throw new Error('rng.pick needs a non-empty array');
      }
      const index = Math.floor(next() * items.length);
      // `length - 1` is not reachable as a float-derived index once `next()`
      // can return values arbitrarily close to 1, so clamp rather than trust.
      return items[Math.min(index, items.length - 1)] as never;
    },

    chance(p) {
      if (!Number.isFinite(p) || p < 0 || p > 1) {
        throw new Error(`rng.chance needs p in [0, 1], got ${p}`);
      }
      return next() < p;
    },

    fork(salt) {
      return mulberry32((Math.imul(salt >>> 0, 0x9e3779b1) ^ state) >>> 0);
    },
  };

  return rng;
}

/**
 * Combine a scene seed and an instance id into one generator.
 *
 * A prefab with randomness is created once per placed instance, and each
 * instance must get a *different* stream — otherwise every rock in a scene
 * lands in the same place, which looks like the randomness is broken rather
 * than correct. Mixing the id into the seed gives each instance its own
 * reproducible stream while keeping the whole scene reproducible.
 */
export function rngFor(sceneSeed: number, instanceId: string): Rng {
  let hash = 0x811c9dc5;
  for (let i = 0; i < instanceId.length; i++) {
    hash ^= instanceId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return mulberry32((Math.imul(sceneSeed >>> 0, 0x9e3779b1) ^ hash) >>> 0);
}

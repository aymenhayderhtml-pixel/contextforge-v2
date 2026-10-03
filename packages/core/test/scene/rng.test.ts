/**
 * scene/rng.test.ts — seeded randomness (SPEC R7).
 *
 * The property that matters is **reproducibility**: the same seed must give the
 * same stream, forever, across runs and machines. Everything else — uniformity,
 * range bounds — is a sanity check on top of that.
 */

import { describe, expect, it } from 'vitest';
import { mulberry32, rngFor } from '../../src/scene/rng.js';

describe('mulberry32', () => {
  it('produces the same stream for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const first = Array.from({ length: 50 }, () => a.next());
    const second = Array.from({ length: 50 }, () => b.next());
    expect(first).toEqual(second);
  });

  it('produces a different stream for a different seed', () => {
    const r1 = mulberry32(1);
    const r2 = mulberry32(2);
    const s1 = Array.from({ length: 20 }, () => r1.next());
    const s2 = Array.from({ length: 20 }, () => r2.next());
    expect(s1).not.toEqual(s2);
  });

  it('is stable across a fresh call — a scene saved today reloads identically tomorrow', () => {
    // A golden value, taken from the published mulberry32 reference
    // implementation rather than from this code, so the test pins the *algorithm*
    // and not merely today's output. If this changes, every scene with a
    // randomised prefab silently re-randomises — which nobody notices until two
    // AIs disagree about where a rock is.
    const rng = mulberry32(12345);
    expect(Array.from({ length: 5 }, () => rng.next())).toEqual([
      0.9797282677609473, 0.3067522644996643, 0.484205421525985, 0.817934412509203,
      0.5094283693470061,
    ]);
  });

  it('stays within [0, 1)', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 5000; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('is roughly uniform', () => {
    // Ten buckets, 10k samples: a generator stuck in a lattice or a bad mixer
    // shows up here as a lopsided histogram.
    const rng = mulberry32(2024);
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 10_000; i++) {
      const bucket = Math.floor(rng.next() * 10);
      buckets[Math.min(bucket, 9)] = (buckets[Math.min(bucket, 9)] ?? 0) + 1;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(800);
      expect(count).toBeLessThan(1200);
    }
  });

  it('accepts a negative seed rather than refusing it', () => {
    // `seed` is data a user types. A well-defined state is more useful than a
    // refusal, and refusing would mean a scene the user cannot load.
    expect(() => mulberry32(-1).next()).not.toThrow();
    expect(mulberry32(-1).next()).toBe(mulberry32(-1).next());
  });

  describe('range', () => {
    it('stays within bounds', () => {
      const rng = mulberry32(9);
      for (let i = 0; i < 1000; i++) {
        const value = rng.range(-3, 7);
        expect(value).toBeGreaterThanOrEqual(-3);
        expect(value).toBeLessThan(7);
      }
    });

    it('throws on reversed bounds rather than silently swapping them', () => {
      expect(() => mulberry32(1).range(5, 1)).toThrow(/min <= max/);
    });

    it('throws on non-finite bounds', () => {
      expect(() => mulberry32(1).range(0, Number.NaN)).toThrow(/finite/);
    });
  });

  describe('int', () => {
    it('stays inclusive within bounds', () => {
      const rng = mulberry32(11);
      const seen = new Set<number>();
      for (let i = 0; i < 2000; i++) {
        const value = rng.int(1, 6);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(1);
        expect(value).toBeLessThanOrEqual(6);
        seen.add(value);
      }
      // All six faces reachable: a die that never rolls a 6 is broken.
      expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('throws on non-integer bounds', () => {
      expect(() => mulberry32(1).int(0, 1.5)).toThrow(/integer/);
    });
  });

  describe('pick', () => {
    it('only ever returns an element of the array', () => {
      const rng = mulberry32(3);
      const items = ['a', 'b', 'c'];
      for (let i = 0; i < 500; i++) {
        expect(items).toContain(rng.pick(items));
      }
    });

    it('throws on an empty array rather than returning undefined', () => {
      // Returning undefined would put `undefined` into a scene without complaint.
      expect(() => mulberry32(1).pick([])).toThrow(/non-empty/);
    });
  });

  describe('chance', () => {
    it('honours the probability', () => {
      const rng = mulberry32(5);
      let hits = 0;
      for (let i = 0; i < 10_000; i++) if (rng.chance(0.25)) hits++;
      expect(hits).toBeGreaterThan(2200);
      expect(hits).toBeLessThan(2800);
    });

    it('throws for a probability outside [0, 1]', () => {
      expect(() => mulberry32(1).chance(1.5)).toThrow(/\[0, 1\]/);
    });
  });

  describe('fork', () => {
    it('gives a different, reproducible sub-stream', () => {
      const a = mulberry32(1).fork(100);
      const b = mulberry32(1).fork(101);
      const c = mulberry32(1).fork(100);
      const sa = [a.next(), a.next(), a.next()];
      const sb = [b.next(), b.next(), b.next()];
      const sc = [c.next(), c.next(), c.next()];
      expect(sa).toEqual(sc);
      expect(sa).not.toEqual(sb);
    });
  });
});

describe('rngFor', () => {
  it('gives the same stream for the same scene seed and instance id', () => {
    const a = rngFor(100, 'crate');
    const b = rngFor(100, 'crate');
    const first = Array.from({ length: 20 }, () => a.next());
    const second = Array.from({ length: 20 }, () => b.next());
    expect(first).toEqual(second);
  });

  it('gives different instances different streams', () => {
    // Every crate in a scene landing in the same place would look like broken
    // randomness, so this is a real correctness property, not a nicety.
    const crate = rngFor(100, 'crate-1');
    const other = rngFor(100, 'crate-2');
    const a = Array.from({ length: 10 }, () => crate.next());
    const b = Array.from({ length: 10 }, () => other.next());
    expect(a).not.toEqual(b);
  });

  it('gives different scene seeds different streams', () => {
    const a = rngFor(1, 'crate');
    const b = rngFor(2, 'crate');
    expect(a.next()).not.toBe(b.next());
  });

  it('does not place instances on a lattice', () => {
    // A weak hash makes id ordering visible in the output: crate-1, crate-2 …
    // would produce values a constant step apart. Check the first values for
    // successive ids are not evenly spaced.
    const values = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => rngFor(7, id).next());
    const gaps = values.slice(1).map((v, i) => Math.abs((values[i] ?? 0) - v));
    for (const gap of gaps) {
      // Evenly spaced ids would give an identical gap each time.
      expect(gaps.filter((g) => g === gap).length).toBeLessThan(gaps.length);
    }
  });
});

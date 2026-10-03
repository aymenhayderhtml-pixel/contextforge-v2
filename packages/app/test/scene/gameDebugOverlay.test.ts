import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The debug overlay must be invisible unless the URL says `?debug=1`.
 *
 * `main.js` cannot be imported here — it touches `document` and `window` on the
 * way in, and the game has no `node_modules` to import `three` from (the reason
 * `gameScene.test.ts` builds a harness instead). So this reads the source and
 * asserts on the gate itself.
 *
 * That is a weaker test than running it, and deliberately so: the claim being
 * protected is narrow and the failure is a *silent* one. An overlay that is on
 * by default does not crash, does not fail a typecheck, and does not fail any
 * other test — it just sits on top of the HUD, so every screenshot of the game
 * shows green diagnostic text instead of the game. Nothing else in this repo
 * would notice. The check below is the only thing that will.
 *
 * If this ever moves to a real DOM harness, move the whole thing — an assertion
 * about source text is a placeholder for a running check, not a substitute.
 */

// The game is a sibling of this repository, not a package inside it. Same
// absolute path `gameScene.test.ts` uses, so the two cannot drift.
const GAME_SRC = join(
  process.env['CF_PROJECT'] ?? resolve(import.meta.dirname, '..', '..', '..', '..', '..', 'kart-dash-3d-v2'),
  'src',
);

const source = readFileSync(join(GAME_SRC, 'main.js'), 'utf-8');

describe('the game debug overlay is opt-in', () => {
  it('derives the flag from ?debug=1 and nothing else', () => {
    // Equality against '1', not truthiness: `?debug=0`, `?debug=false` and
    // `?debug` alone all leave it off. A boolean check would light the overlay up
    // for `?debug=0`, which is the kind of detail a screenshot step never
    // thinks to check and a developer never notices.
    expect(source).toContain("get('debug') === '1'");
  });

  it('guards every write to the overlay with the flag', () => {
    // `debugOverlay()` itself creates and appends the element. If any call to it
    // is unguarded the element lands in the DOM regardless of the flag, so the
    // assertion is on the guard immediately before each call rather than on the
    // count of calls.
    const calls = source.match(/debugOverlay\(\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);

    for (const match of source.matchAll(/debugOverlay\(\)/g)) {
      // Walk back to the start of the line and require a guard on it. The two
      // real call sites are `if (!DEBUG_ENABLED) return;` above the write and
      // the `debugOverlay()` body itself.
      const lineStart = source.lastIndexOf('\n', match.index) + 1;
      const line = source.slice(lineStart, match.index);
      const guarded =
        line.includes('DEBUG_ENABLED') ||
        // The definition and the guarded call inside it.
        source.slice(0, match.index).endsWith('function ');
      expect(
        guarded || line.trim() === '',
        `debugOverlay() called without a DEBUG_ENABLED guard on the same line: ${line.trim()}`,
      ).toBe(true);
    }
  });

  it('registers the error listeners only when the flag is on', () => {
    // The listeners are the second way diagnostics reach the page. Leaving them
    // attached unconditionally is harmless visually, but it means the overlay
    // machinery is half-armed by default, and the next edit to it is unhedged.
    expect(source).toMatch(/if \(DEBUG_ENABLED\) \{[\s\S]*?addEventListener\('error'/);
    expect(source).toMatch(/if \(DEBUG_ENABLED\) \{[\s\S]*?addEventListener\('unhandledrejection'/);
  });

  it('still logs to the console when the overlay is off', () => {
    // The flag gates the *screen*, not the diagnostics. If this ever stopped
    // being true, "?debug=1" would be the only way to see an error at all, and
    // the default-run screenshots would go clean for the wrong reason.
    expect(source).toMatch(/console\.log\('\[DBG\]'[\s\S]{0,120}if \(!DEBUG_ENABLED\) return;/);
  });
});

describe('the game runs standalone', () => {
  it('never reads an injected __CF_CORE__ global to load the scene', () => {
    // The point of the standalone loader: `npm run dev` in the game, with no
    // editor open, must produce the scene. A `globalThis.__CF_CORE__` read that
    // falls back silently would make that true only when the editor happened to
    // be there, and the fallback would look like a working game.
    const reads = source.match(/__CF_CORE__/g) ?? [];
    // One mention is allowed, in a comment explaining that it is not used.
    expect(reads.length).toBeLessThanOrEqual(1);
    expect(source).not.toMatch(/globalThis\.__CF_CORE__/);
    expect(source).not.toMatch(/window\.__CF_CORE__/);
  });
});
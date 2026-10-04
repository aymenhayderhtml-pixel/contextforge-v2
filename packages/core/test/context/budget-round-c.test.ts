/**
 * packages/core/test/context/budget-round-c.test.ts
 *
 * SEC-5 and CTX-2: the character budget was reported but never enforced (D53).
 *
 * Measured on main:
 *   SEC-5  a 4 MB file requested by a `NEED:` line produced a 4,195,802-character
 *          prompt against `maxChars: 1000` — a 4,000x overage. The audit's version
 *          of this used 64 MB, i.e. a 64 MB prompt and a 16.8M token estimate.
 *   CTX-2  budgets of 0, -100, 1, NaN and Infinity ALL returned the over-budget
 *          prompt unchanged, because the overflow appeared only as a `gaps[]`
 *          string and `maxChars` was never forwarded into any check.
 *
 * Two separate defects with one fix each:
 *   - a per-read size gate, so a file is never loaded into memory at all;
 *   - a total-budget enforcement that drops requested files rather than
 *     truncating them, because a half file with no marker is a lie the AI
 *     reasons confidently from.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compileContext,
  DEFAULT_MAX_CHARS,
  MAX_FULL_FILE_CHARS,
} from '../../src/context/compiler.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project with one file of `chars` characters of filler. */
function projectWith(chars: number, name = 'big.ts'): string {
  const root = mkdtempSync(join(tmpdir(), 'cf-budget-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', name), 'x'.repeat(chars) + '\n');
  return root;
}

describe('SEC-5 — an oversized file is never read into the prompt', () => {
  it('a 4 MB file does not produce a 4 MB prompt', () => {
    const root = projectWith(4 * 1024 * 1024);
    const result = compileContext({
      projectRoot: root,
      issue: 'NEED: src/big.ts',
      maxChars: 1000,
    });

    // Unfixed: 4,195,802 characters.
    expect(result.chars).toBeLessThan(4000);
  });

  it('the refusal names the file, its size, and the limit', () => {
    const root = projectWith(4 * 1024 * 1024);
    const result = compileContext({
      projectRoot: root,
      issue: 'NEED: src/big.ts',
      maxChars: 1000,
    });

    const note = result.gaps.find((g) => g.includes('src/big.ts')) ?? '';
    expect(note).toContain('Not attached');
    expect(note).toContain('src/big.ts');
    // The real size, so the developer can see how far over it is.
    expect(note).toMatch(/4,194,30\d characters/);
    expect(note).toContain('400,000-character limit');
    // The way out.
    expect(note).toMatch(/function name or a line number/);
  });

  it('the refused file is not listed as an attached section', () => {
    const root = projectWith(4 * 1024 * 1024);
    const result = compileContext({
      projectRoot: root,
      issue: 'NEED: src/big.ts',
    });

    // A section claiming a `full` attachment that contains nothing would be a
    // worse lie than the refusal.
    expect(result.sections.filter((s) => s.file === 'src/big.ts')).toEqual([]);
    expect(result.prompt).not.toContain('xxxxx');
  });

  it('a file just under the limit is still attached in full', () => {
    const root = projectWith(MAX_FULL_FILE_CHARS - 1000);
    const result = compileContext({
      projectRoot: root,
      issue: 'NEED: src/big.ts',
      maxChars: Number.MAX_SAFE_INTEGER,
    });

    // The gate is a real boundary, not "everything is refused".
    expect(result.sections.some((s) => s.file === 'src/big.ts')).toBe(true);
    expect(result.gaps.find((g) => g.includes('over the') && g.includes('limit for attaching'))).toBeUndefined();
  });

  it('a small file is unaffected by the gate', () => {
    const root = projectWith(500, 'small.ts');
    const result = compileContext({
      projectRoot: root,
      issue: 'NEED: src/small.ts',
      maxChars: 100_000,
    });

    expect(result.sections.some((s) => s.file === 'src/small.ts')).toBe(true);
    expect(result.gaps).toEqual([]);
  });
});

describe('CTX-2 — the budget is enforced, not merely reported', () => {
  it('maxChars: 0 does not return the full prompt', () => {
    // Unfixed: any budget, including 0, returned whatever the inputs produced.
    const root = projectWith(200_000, 'mid.ts');
    const result = compileContext({
      projectRoot: root,
      issue: 'NEED: src/mid.ts',
      maxChars: 0,
    });

    // Still over, because the prompt has a floor — but the FILE is gone, and the
    // gap says the floor is why.
    expect(result.prompt).not.toContain('xxxxx');
    expect(result.gaps.some((g) => /no budget below \d+ can be met/.test(g))).toBe(true);
  });

  it('a budget below the floor is named as a floor, not reported as a missed cap', () => {
    const root = projectWith(200_000, 'mid.ts');
    const result = compileContext({
      projectRoot: root,
      issue: 'NEED: src/mid.ts',
      maxChars: 10,
    });

    const budgetGap = result.gaps.find((g) => g.includes('over the 10 budget')) ?? '';
    expect(budgetGap).toMatch(/required parts/);
    expect(budgetGap).toMatch(/no budget below \d+ can be met/);
    // The distinction that matters: it says the request is impossible, not that
    // the app failed to keep a cap it could have kept.
    expect(budgetGap).toContain('this is that floor, not a missed cap');
  });

  it('a budget that can be met IS met', () => {
    const root = projectWith(200_000, 'mid.ts');
    const result = compileContext({
      projectRoot: root,
      issue: 'NEED: src/mid.ts',
      maxChars: 2000,
    });

    // Unfixed: 200,000+ characters against a 2,000 budget.
    expect(result.chars).toBeLessThanOrEqual(2000);
  });

  it('an over-budget file is dropped whole, never truncated', () => {
    const root = projectWith(200_000, 'mid.ts');
    const result = compileContext({
      projectRoot: root,
      issue: 'NEED: src/mid.ts',
      maxChars: 2000,
    });

    // A half file with no marker would let the AI reason about code that is not
    // there. The file must be wholly absent.
    expect(result.prompt).not.toContain('xxxxx');
    expect(result.sections.some((s) => s.file === 'src/mid.ts')).toBe(false);
  });

  it('the gap names which files were dropped and how to get them narrower', () => {
    const root = projectWith(200_000, 'mid.ts');
    const result = compileContext({
      projectRoot: root,
      issue: 'NEED: src/mid.ts',
      maxChars: 2000,
    });

    const dropGap = result.gaps.find((g) => g.startsWith('Dropped')) ?? '';
    expect(dropGap).toContain('src/mid.ts');
    expect(dropGap).toMatch(/function name or a line number/);
  });

  it('a negative budget falls back to the real default rather than being ignored', () => {
    // Unfixed: -100 made `prompt.length > maxChars` false for every prompt.
    const root = projectWith(200_000, 'mid.ts');
    const result = compileContext({
      projectRoot: root,
      issue: 'NEED: src/mid.ts',
      maxChars: -100,
    });

    // It behaves as DEFAULT_MAX_CHARS: the file is dropped, and the gap names
    // the default budget, not -100.
    expect(result.prompt).not.toContain('xxxxx');
    expect(result.gaps.some((g) => g.includes(String(DEFAULT_MAX_CHARS)))).toBe(true);
  });

  it('a NaN budget falls back to the real default rather than being ignored', () => {
    const root = projectWith(200_000, 'mid.ts');
    const result = compileContext({
      projectRoot: root,
      issue: 'NEED: src/mid.ts',
      maxChars: Number.NaN,
    });

    expect(result.prompt).not.toContain('xxxxx');
    expect(result.gaps.some((g) => g.includes(String(DEFAULT_MAX_CHARS)))).toBe(true);
  });

  it('Infinity is honoured as "no limit"', () => {
    // The one unusable-looking value that has a coherent meaning. The per-FILE
    // size gate still applies — Infinity waives the total budget, not the cap on
    // one read — so this file (200k, under the 400k gate) is attached in full.
    const root = projectWith(200_000, 'mid.ts');
    const result = compileContext({
      projectRoot: root,
      issue: 'NEED: src/mid.ts',
      maxChars: Number.POSITIVE_INFINITY,
    });

    expect(result.sections.some((s) => s.file === 'src/mid.ts')).toBe(true);
    expect(result.gaps).toEqual([]);
    // `projectWith` fills with 'x'; a long unbroken run proves the body is really
    // in the prompt without asserting on a 200,000-character exact match.
    expect(result.prompt).toContain('xxxxxxxxxx');
  });

  it('Infinity does not waive the per-file size gate', () => {
    const root = projectWith(4 * 1024 * 1024);
    const result = compileContext({
      projectRoot: root,
      issue: 'NEED: src/big.ts',
      maxChars: Number.POSITIVE_INFINITY,
    });

    // No total budget is not a licence to read anything, ever.
    expect(result.sections.filter((s) => s.file === 'src/big.ts')).toEqual([]);
    expect(result.gaps.some((g) => g.includes('limit for attaching one file'))).toBe(true);
  });

  it('the default budget still applies when maxChars is omitted', () => {
    const root = projectWith(200_000, 'mid.ts');
    const result = compileContext({
      projectRoot: root,
      issue: 'NEED: src/mid.ts',
    });

    expect(result.prompt).not.toContain('xxxxx');
  });
});

describe('CTX-2 parity — an in-budget prompt is byte-identical to before', () => {
  it('a small requested file is attached whole with no gaps', () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-budget-ok-'));
    roots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'kart.ts'), 'export function go() {\n  return 1;\n}\n');

    const result = compileContext({
      projectRoot: root,
      issue: 'NEED: src/kart.ts',
      maxChars: DEFAULT_MAX_CHARS,
    });

    expect(result.gaps).toEqual([]);
    expect(result.chars).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
    expect(result.prompt).toContain('export function go()');
    expect(result.prompt).toContain('SURGICAL PATCH CONTRACT');
  });

  it('a prompt with no requested file and a large budget is unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-budget-ok2-'));
    roots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'kart.ts'), 'export const a = 1;\n');

    const result = compileContext({
      projectRoot: root,
      issue: 'the kart does not move',
      targetFile: 'src/kart.ts',
      maxChars: DEFAULT_MAX_CHARS,
    });

    expect(result.hasGaps).toBe(false);
    expect(result.sections.length).toBeGreaterThan(0);
    expect(result.prompt).toContain('kart');
  });

  it('chars, tokens and fullChars still agree with the prompt', () => {
    const root = mkdtempSync(join(tmpdir(), 'cf-budget-ok3-'));
    roots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'kart.ts'), 'export const a = 1;\n');

    const result = compileContext({
      projectRoot: root,
      targetFile: 'src/kart.ts',
      maxChars: DEFAULT_MAX_CHARS,
    });

    expect(result.chars).toBe(result.prompt.length);
    expect(result.tokens).toBe(Math.round(result.prompt.length / 4));

    // Deliberately NOT asserting `fullChars >= chars`. D33 records that this is
    // not guaranteed, and this case is a concrete instance of why: for a
    // one-line target file the slice and the whole file are the same text, so
    // `fullChars` is SMALLER. Asserting the ordering here would encode a false
    // invariant; the arithmetic below is what actually has to hold.
    expect(result.savingsPercent).toBe(
      result.fullChars > 0
        ? Math.max(0, Math.round(((result.fullChars - result.chars) / result.fullChars) * 100))
        : 0,
    );
  });
});
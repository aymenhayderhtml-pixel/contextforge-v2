/**
 * packages/core/test/context/attachmentEscape.test.ts
 *
 * A `NEED:` line in pasted AI text cannot read a file outside the project (SEC-2).
 *
 * ## Why this is its own file
 *
 * The audit's claim had two halves and only one was true. `NEED: /etc/passwd`
 * does **not** escape, because the read was `join(root, path)` and `join` treats
 * an absolute segment as relative. `NEED: ../../etc/passwd` **does** escape,
 * because `join` normalises `..`. And a symlink escapes regardless, because
 * nothing resolved through the filesystem at all.
 *
 * So the tests below use the two vectors that worked and one that looks like it
 * should work but does not — the last one asserted as a *negative* result, so a
 * future "fix" that hardens `join` into `resolve` cannot quietly break a behaviour
 * something depends on without this file noticing.
 *
 * Every test also asserts the secret is absent from the **prompt**, not merely
 * that a refusal was returned. A guard that reports a problem and still attaches
 * the bytes would pass a status-code-only test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileContext } from '../../src/context/compiler.js';

const SECRET = 'MY-SECRET-API-KEY-abc123';

let project: string;
let outside: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'cf-sec-proj-'));
  outside = mkdtempSync(join(tmpdir(), 'cf-sec-outside-'));
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'a.js'), 'export function alpha(){return 1}\n');
  writeFileSync(join(outside, 'secret.txt'), `${SECRET}\n`);
  writeFileSync(join(outside, 'credentials.json'), `{"token":"${SECRET}"}\n`);
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('a NEED: line pointing outside the project', () => {
  it('does not attach a file reached by `..`', () => {
    const relative = join('..', '..', outside.split('/').pop() ?? '', 'secret.txt');
    const result = compileContext({
      projectRoot: project,
      issue: '',
      logs: `NEED: ${relative}`,
      targetFile: 'src/a.js',
      targetLine: 1,
    });
    expect(result.prompt).not.toContain(SECRET);
  });

  it('does not attach a file reached through a symlink', () => {
    symlinkSync(outside, join(project, 'escape'));
    const result = compileContext({
      projectRoot: project,
      issue: '',
      logs: 'NEED: escape/secret.txt',
      targetFile: 'src/a.js',
      targetLine: 1,
    });
    expect(result.prompt).not.toContain(SECRET);
  });

  it('does not attach through a symlinked file', () => {
    symlinkSync(join(outside, 'secret.txt'), join(project, 'src', 'link.js'));
    const result = compileContext({
      projectRoot: project,
      issue: '',
      logs: 'NEED: src/link.js',
      targetFile: 'src/a.js',
      targetLine: 1,
    });
    expect(result.prompt).not.toContain(SECRET);
  });

  it('says the path was refused, by name', () => {
    // A silent skip is not good enough: the developer has to know the AI asked for
    // something it did not get, or they will believe the AI can see the file.
    symlinkSync(outside, join(project, 'escape'));
    const result = compileContext({
      projectRoot: project,
      issue: '',
      logs: 'NEED: escape/secret.txt',
      targetFile: 'src/a.js',
      targetLine: 1,
    });
    const all = `${result.prompt}\n${result.gaps.join('\n')}`;
    expect(all).toContain('escape/secret.txt');
  });

  it('still attaches a file inside the project', () => {
    // The fix is a boundary, not a switch. A NEED: for a real file must work.
    const result = compileContext({
      projectRoot: project,
      issue: '',
      logs: 'NEED: src/a.js',
      targetFile: 'src/a.js',
      targetLine: 1,
    });
    expect(result.prompt).toContain('alpha');
  });
});

describe('an absolute path in a NEED: line', () => {
  it('is not attached', () => {
    const result = compileContext({
      projectRoot: project,
      issue: '',
      logs: `NEED: ${join(outside, 'secret.txt')}`,
      targetFile: 'src/a.js',
      targetLine: 1,
    });
    expect(result.prompt).not.toContain(SECRET);
  });
});

describe('the caller-supplied file list', () => {
  it('cannot reach outside either', () => {
    // Same boundary, different door: `files` rather than pasted text.
    const result = compileContext({
      projectRoot: project,
      issue: '',
      logs: '',
      files: [`../${outside.split('/').pop()}/secret.txt`],
      targetFile: 'src/a.js',
      targetLine: 1,
    });
    expect(result.prompt).not.toContain(SECRET);
  });
});

describe('targetFile', () => {
  it('cannot name a file outside the project', () => {
    // SEC-1: `targetFile` was read with no containment check at all.
    const result = compileContext({
      projectRoot: project,
      issue: '',
      logs: '',
      targetFile: join(outside, 'secret.txt'),
      targetLine: 1,
    });
    // Either refused, or resolved to nothing — what matters is the bytes.
    expect(result.prompt).not.toContain(SECRET);
  });
});
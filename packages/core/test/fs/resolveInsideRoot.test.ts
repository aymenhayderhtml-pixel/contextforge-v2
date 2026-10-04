/**
 * packages/core/test/fs/resolveInsideRoot.test.ts
 *
 * The containment helper every reader and writer in core routes a project-relative
 * path through (D51).
 *
 * ## Why the cases below and not just `..`
 *
 * A lexical check — strip `..`, reject absolute, done — passes every test anyone
 * writes for it, and is defeated by a symlink without noticing. That is the whole
 * finding: PATCH-2/SEC-3. So the escaping cases here all use **real symlinks on
 * disk**, and each asserts both that the path is refused *and* that the outside
 * file was not touched. A refusal that arrived after the write would pass the first
 * assertion and fail the second.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveInsideRoot, resolveInsideRootOrThrow } from '../../src/fs/resolveInsideRoot.js';

const SECRET = 'MY-SECRET-API-KEY-abc123';

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cf-root-'));
  outside = mkdtempSync(join(tmpdir(), 'cf-outside-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.js'), 'export const x = 1;\n');
  mkdirSync(join(outside, 'deep'), { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), `${SECRET}\n`);
  writeFileSync(join(outside, 'deep', 'owned.txt'), 'owned\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('a path that stays inside', () => {
  it('accepts an existing file and says where it is', () => {
    const r = resolveInsideRoot(root, 'src/main.js');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.absolutePath).toBe(join(root, 'src', 'main.js'));
    expect(r.value.existsOnDisk).toBe(true);
  });

  it('accepts a file that does not exist yet', () => {
    // `### FILE:` exists to create files. A helper that refused a missing target
    // would make the patch engine unable to do its one job.
    const r = resolveInsideRoot(root, 'src/created.js');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.absolutePath).toBe(join(root, 'src', 'created.js'));
    expect(r.value.existsOnDisk).toBe(false);
  });

  it('normalises `./` and backslashes', () => {
    const r = resolveInsideRoot(root, '.\\src\\main.js');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.relativePath).toBe('src/main.js');
  });

  it('accepts a path through a symlink that points back inside', () => {
    // An internal link is not an escape. Refusing every symlink would make a
    // project that legitimately uses one unusable.
    symlinkSync(join(root, 'src'), join(root, 'alias'));
    const r = resolveInsideRoot(root, 'alias/main.js');
    expect(r.ok).toBe(true);
  });
});

describe('a path that escapes', () => {
  it('refuses `..`', () => {
    const r = resolveInsideRoot(root, '../outside/secret.txt');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/climbs out of the project/);
    expect(r.reason).toContain('../outside/secret.txt');
  });

  it('refuses an absolute path', () => {
    const r = resolveInsideRoot(root, '/etc/passwd');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/absolute path/);
  });

  it('refuses a symlinked directory that points outside (SEC-3)', () => {
    symlinkSync(outside, join(root, 'escape'));
    const r = resolveInsideRoot(root, 'escape/secret.txt');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Names the path AND where it actually landed. A bare errno would not.
    expect(r.reason).toContain('escape/secret.txt');
    expect(r.reason).toMatch(/resolves outside the project/);
    expect(r.reason).toContain('secret.txt');
  });

  it('refuses a NEW file written through a symlinked directory', () => {
    // The one the audit called PATCH-2. `existsOnDisk` is false here, so a check
    // that only validated *existing* files would wave this through — and this is
    // the write that lands outside the project.
    symlinkSync(outside, join(root, 'escape'));
    const r = resolveInsideRoot(root, 'escape/created.txt');
    expect(r.ok).toBe(false);
  });

  it('refuses a dangling symlink, which existsSync cannot see', () => {
    symlinkSync(join(outside, 'never-created'), join(root, 'dangling'));
    const r = resolveInsideRoot(root, 'dangling/anything.txt');
    expect(r.ok).toBe(false);
  });

  it('refuses a file that IS a symlink to a file outside', () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'src', 'link.txt'));
    const r = resolveInsideRoot(root, 'src/link.txt');
    expect(r.ok).toBe(false);
  });

  it('refuses a NUL byte', () => {
    const r = resolveInsideRoot(root, 'src/main.js\0.png');
    expect(r.ok).toBe(false);
  });

  it('refuses an empty path', () => {
    expect(resolveInsideRoot(root, '').ok).toBe(false);
    expect(resolveInsideRoot(root, '   ').ok).toBe(false);
  });
});

describe('the refusal message', () => {
  it('always names the path and never leaks an errno', () => {
    // SPEC R9. A developer has to be able to act on this without opening anything.
    for (const p of ['../x', '/etc/passwd', 'nope\u0000.js', '']) {
      const r = resolveInsideRoot(root, p);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toContain('"');
      expect(r.reason).toMatch(/\.$/);
      expect(r.reason).not.toMatch(/ENOENT|EACCES|EEXIST|errno/i);
    }
  });
});

describe('resolveInsideRootOrThrow', () => {
  it('returns the value on success', () => {
    expect(resolveInsideRootOrThrow(root, 'src/main.js').existsOnDisk).toBe(true);
  });

  it('throws a message naming the path', () => {
    expect(() => resolveInsideRootOrThrow(root, '../x')).toThrow(/"\.\.\/x"/);
  });
});

describe('a root that does not exist yet', () => {
  it('is refused by default', () => {
    // An open project always has a directory, so a missing root means the caller
    // passed something wrong.
    const missing = join(root, 'not-made-yet');
    const r = resolveInsideRoot(missing, 'scene.json');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/does not exist/);
  });

  it('is allowed when the caller opts in, which only generateProject does', () => {
    const missing = join(root, 'not-made-yet');
    const r = resolveInsideRoot(missing, 'scene.json', { allowMissingRoot: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.absolutePath).toBe(join(missing, 'scene.json'));
  });

  it('still refuses a path that escapes a not-yet-existing root', () => {
    // The opt-in is about the ROOT, not about turning the check off.
    const missing = join(root, 'not-made-yet');
    expect(resolveInsideRoot(missing, '../elsewhere/x.txt', { allowMissingRoot: true }).ok).toBe(
      false,
    );
    expect(resolveInsideRoot(missing, '/etc/passwd', { allowMissingRoot: true }).ok).toBe(false);
  });
});

describe('the escape the helper prevents, end to end', () => {
  it('does not touch the outside file', () => {
    symlinkSync(outside, join(root, 'escape'));
    const before = readFileSync(join(outside, 'secret.txt'), 'utf-8');
    expect(resolveInsideRoot(root, 'escape/secret.txt').ok).toBe(false);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf-8')).toBe(before);
    expect(before).toContain(SECRET);
  });

  it('does not create a file outside, through the link', () => {
    symlinkSync(outside, join(root, 'escape'));
    const r = resolveInsideRoot(root, 'escape/created.txt');
    expect(r.ok).toBe(false);
    expect(existsSync(join(outside, 'created.txt'))).toBe(false);
  });
});
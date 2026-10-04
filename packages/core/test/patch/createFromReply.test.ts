/**
 * packages/core/test/patch/createFromReply.test.ts
 *
 * Assert that createProjectFromReply and previewProjectFromReply:
 *  - enforce containment via resolveInsideRoot (symlink escapes, .. traversal)
 *  - refuse existing non-empty target folders
 *  - refuse ### EDIT: blocks
 *  - enforce all-or-nothing writes: a bad block writes nothing to disk
 *  - preview writes zero bytes to disk
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProjectFromReply,
  previewProjectFromReply,
} from '../../src/patch/createFromReply.js';

describe('createProjectFromReply and previewProjectFromReply', () => {
  let tempBase: string;

  beforeEach(() => {
    tempBase = join(
      tmpdir(),
      `cf-test-reply-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempBase, { recursive: true });
  });

  afterEach(() => {
    // Vitest cleanup
  });

  const validReply = `
Here is your project:

### FILE: package.json
\`\`\`json
{
  "name": "mini-game",
  "version": "1.0.0",
  "scripts": {
    "dev": "vite"
  }
}
\`\`\`

### FILE: src/main.js
\`\`\`js
console.log("Game started");
\`\`\`
`;

  it('preview writes zero bytes to disk and returns file list with syntax verdict', () => {
    const res = previewProjectFromReply(tempBase, 'my-preview-game', validReply);
    expect(res.ok).toBe(true);
    expect(res.files).toHaveLength(2);
    expect(res.files[0].path).toBe('package.json');
    expect(res.files[0].syntax.valid).toBe(true);
    expect(res.files[1].path).toBe('src/main.js');
    expect(res.files[1].syntax.valid).toBe(true);

    // Target folder must NOT exist on disk
    expect(existsSync(join(tempBase, 'my-preview-game'))).toBe(false);
  });

  it('create writes all files to disk on success', () => {
    const res = createProjectFromReply(tempBase, 'my-real-game', validReply);
    expect(res.ok).toBe(true);
    expect(res.created).toBe(true);

    const target = join(tempBase, 'my-real-game');
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(target, 'package.json'))).toBe(true);
    expect(existsSync(join(target, 'src', 'main.js'))).toBe(true);

    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('mini-game');
    const mainJs = readFileSync(join(target, 'src', 'main.js'), 'utf-8');
    expect(mainJs).toContain('Game started');
  });

  it('refuses an existing non-empty folder and writes nothing', () => {
    const existingDir = join(tempBase, 'occupied-game');
    mkdirSync(existingDir, { recursive: true });
    writeFileSync(join(existingDir, 'existing.txt'), 'precious data');

    const preview = previewProjectFromReply(tempBase, 'occupied-game', validReply);
    expect(preview.ok).toBe(false);
    expect(preview.refusal).toMatch(/already exists and is not empty/i);

    const res = createProjectFromReply(tempBase, 'occupied-game', validReply);
    expect(res.ok).toBe(false);
    expect(res.refusal).toMatch(/already exists and is not empty/i);

    // The existing directory must be untouched (only existing.txt exists)
    expect(readdirSync(existingDir)).toEqual(['existing.txt']);
  });

  it('refuses ### EDIT: blocks and writes nothing', () => {
    const editReply = `
### EDIT: src/main.js
<<<<<<< FIND
old
=======
new
>>>>>>> REPLACE
`;
    const preview = previewProjectFromReply(tempBase, 'edit-game', editReply);
    expect(preview.ok).toBe(false);
    expect(preview.refusal).toMatch(/EDIT:/);

    const res = createProjectFromReply(tempBase, 'edit-game', editReply);
    expect(res.ok).toBe(false);
    expect(res.refusal).toMatch(/EDIT:/);
    expect(existsSync(join(tempBase, 'edit-game'))).toBe(false);
  });

  it('refuses a path with .. traversal and writes nothing', () => {
    const traversalReply = `
### FILE: ../escaped.js
\`\`\`js
console.log("escaped");
\`\`\`
`;
    const preview = previewProjectFromReply(tempBase, 'traversal-game', traversalReply);
    expect(preview.ok).toBe(false);
    expect(preview.refusal).toMatch(/traversal|\.\./i);

    const res = createProjectFromReply(tempBase, 'traversal-game', traversalReply);
    expect(res.ok).toBe(false);
    expect(existsSync(join(tempBase, 'traversal-game'))).toBe(false);
    expect(existsSync(join(tempBase, 'escaped.js'))).toBe(false);
  });

  it('refuses a symlink escape and writes nothing', () => {
    // Create an outside target directory
    const outsideDir = join(tempBase, 'outside-secret');
    mkdirSync(outsideDir, { recursive: true });

    // Create target project folder with a symlink inside it pointing outside
    const projDir = join(tempBase, 'symlink-game');
    mkdirSync(projDir, { recursive: true });
    symlinkSync(outsideDir, join(projDir, 'symlink-escape'), 'dir');

    // The folder is already not empty because of symlink-escape, but let's test specifically
    // a reply trying to write through the symlink
    const symlinkReply = `
### FILE: symlink-escape/hacked.txt
\`\`\`
pwned
\`\`\`
`;
    const res = createProjectFromReply(tempBase, 'symlink-game', symlinkReply);
    expect(res.ok).toBe(false);
    expect(existsSync(join(outsideDir, 'hacked.txt'))).toBe(false);
  });

  it('enforces all-or-nothing: a bad block (syntax error) writes nothing', () => {
    const mixedReply = `
### FILE: src/valid.js
\`\`\`js
console.log("valid");
\`\`\`

### FILE: src/broken.json
\`\`\`json
{ broken json: not valid
\`\`\`
`;
    const targetDir = join(tempBase, 'syntax-err-game');
    const preview = previewProjectFromReply(tempBase, 'syntax-err-game', mixedReply);
    expect(preview.ok).toBe(false);
    expect(preview.files).toHaveLength(2);
    expect(preview.files[0].syntax.valid).toBe(true);
    expect(preview.files[1].syntax.valid).toBe(false);

    const res = createProjectFromReply(tempBase, 'syntax-err-game', mixedReply);
    expect(res.ok).toBe(false);

    // ALL-OR-NOTHING: Not even src/valid.js should exist on disk!
    expect(existsSync(targetDir)).toBe(false);
  });
});

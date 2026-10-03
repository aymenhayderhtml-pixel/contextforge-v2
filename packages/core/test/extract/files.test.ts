import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IGNORED_DIRECTORIES, isVendorFile, scanFiles } from '../../src/extract/files.js';
import { extractJsProject } from '../../src/extract/js.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cf-scan-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = (relativePath: string, content = 'x') => {
  const absolute = join(root, relativePath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content, 'utf-8');
};

describe('scanFiles', () => {
  it('collects only the requested extensions', () => {
    write('a.js');
    write('b.ts');
    write('c.gd');
    write('d.png');

    const files = scanFiles(root, { extensions: new Set(['.js', '.ts']) });
    expect(files.map((f) => f.relativePath)).toEqual(['a.js', 'b.ts']);
  });

  it('returns paths relative to the scan root, with forward slashes', () => {
    write('src/deep/nested/a.js');
    const files = scanFiles(root, { extensions: new Set(['.js']) });
    expect(files[0]?.relativePath).toBe('src/deep/nested/a.js');
  });

  it('skips ignored directories', () => {
    for (const dir of IGNORED_DIRECTORIES) write(`${dir}/file.js`);
    write('src/keep.js');

    const files = scanFiles(root, { extensions: new Set(['.js']) });
    expect(files.map((f) => f.relativePath)).toEqual(['src/keep.js']);
  });

  it('skips hidden directories and files', () => {
    write('.hidden/a.js');
    write('.secret.js');
    write('keep.js');

    const files = scanFiles(root, { extensions: new Set(['.js']) });
    expect(files.map((f) => f.relativePath)).toEqual(['keep.js']);
  });

  it('skips vendored bundles, which are neither project code nor cheap to parse', () => {
    write('public/vendor/three.min.js');
    write('public/vendor/GLTFLoader.js');
    write('src/main.js');

    const files = scanFiles(root, { extensions: new Set(['.js']) });
    expect(files.map((f) => f.relativePath)).toEqual(['src/main.js']);
  });

  it('honours maxDepth', () => {
    write('a.js');
    write('one/b.js');
    write('one/two/c.js');

    const shallow = scanFiles(root, { extensions: new Set(['.js']), maxDepth: 1 });
    expect(shallow.map((f) => f.relativePath)).toEqual(['a.js', 'one/b.js']);
  });

  it('sorts results, so two scans agree (SPEC R8)', () => {
    for (const name of ['z.js', 'a.js', 'm/b.js', 'm/a.js']) write(name);

    const first = scanFiles(root, { extensions: new Set(['.js']) });
    const second = scanFiles(root, { extensions: new Set(['.js']) });
    expect(first.map((f) => f.relativePath)).toEqual(second.map((f) => f.relativePath));
    expect(first.map((f) => f.relativePath)).toEqual(['a.js', 'm/a.js', 'm/b.js', 'z.js']);
  });

  it('returns an empty list for a directory with no matching files', () => {
    write('notes.md');
    expect(scanFiles(root, { extensions: new Set(['.js']) })).toEqual([]);
  });
});

describe('isVendorFile', () => {
  it('recognises minified and bundle filenames', () => {
    expect(isVendorFile('three.min.js')).toBe(true);
    expect(isVendorFile('app.bundle.js')).toBe(true);
    expect(isVendorFile('vendor.umd.js')).toBe(true);
    expect(isVendorFile('package-lock.js')).toBe(true);
  });

  it('does not flag ordinary source files', () => {
    expect(isVendorFile('main.js')).toBe(false);
    expect(isVendorFile('minimap.js')).toBe(false);
    expect(isVendorFile('player.ts')).toBe(false);
  });
});

describe('extraction performance characteristic', () => {
  it('does not let a vendored minified file dominate extraction', () => {
    // A large synthetic minified bundle, as a project would vendor.
    const bulk = Array.from({ length: 4000 }, (_, i) => `!function(e){e.x${i}=${i}}(window);`).join('\n');
    write('public/vendor/engine.min.js', bulk);
    write('src/main.js', 'export const x = 1;\n');

    const started = Date.now();
    const graph = extractJsProject(root);
    const elapsed = Date.now() - started;

    expect(graph.nodes.map((n) => n.id)).toEqual(['src/main.js']);
    // Generous ceiling: the point is that a multi-megabyte bundle cannot make
    // extraction quadratic. Measured at ~6ms for the bundle being skipped.
    expect(elapsed).toBeLessThan(5_000);
  });
});

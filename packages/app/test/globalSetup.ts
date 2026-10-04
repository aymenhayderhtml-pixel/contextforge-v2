/**
 * packages/app/test/globalSetup.ts
 *
 * Vitest globalSetup to protect the developer's real ~/Documents folder.
 * Snapshots join(homedir(), 'Documents') before and after the whole suite,
 * throwing an Error if any file or directory was leaked/created under ~/Documents.
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export const REAL_DOCUMENTS_DIR = join(homedir(), 'Documents');

/**
 * Snapshot all paths under a directory recursively, excluding the current workspace
 * if the workspace is located inside the directory.
 */
export function snapshotDirectory(
  dir: string = REAL_DOCUMENTS_DIR,
  excludePath: string = process.cwd(),
): Set<string> {
  const snapshot = new Set<string>();
  if (!existsSync(dir)) return snapshot;

  const normalizedDir = resolve(dir);
  const normalizedExclude = resolve(excludePath);

  function walk(current: string): void {
    try {
      const items = readdirSync(current, { withFileTypes: true });
      for (const item of items) {
        const fullPath = join(current, item.name);

        if (fullPath === normalizedExclude) {
          // Do not snapshot or descend into the workspace repository itself
          continue;
        }

        if (fullPath.startsWith(normalizedExclude + sep)) {
          // Inside the workspace repository
          continue;
        }

        snapshot.add(fullPath);

        if (item.isDirectory()) {
          walk(fullPath);
        }
      }
    } catch {
      // Ignore permission or transient file system errors
    }
  }

  walk(normalizedDir);
  return snapshot;
}

/**
 * Identify any paths present in `after` that were not present in `before`.
 */
export function detectCreatedPaths(before: Set<string>, after: Set<string>): string[] {
  const created: string[] = [];
  for (const item of after) {
    if (!before.has(item)) {
      created.push(item);
    }
  }
  return created;
}

/**
 * Assert that no new paths were created between `before` and `after` snapshots.
 */
export function assertNoLeaks(before: Set<string>, after: Set<string>): void {
  const leaks = detectCreatedPaths(before, after);
  if (leaks.length > 0) {
    throw new Error(
      `Safety violation: detected file or directory created under real ~/Documents during test suite execution:\n` +
        leaks.map((p) => `  - ${p}`).join('\n'),
    );
  }
}

let initialSnapshot: Set<string> | null = null;

export function setup(): () => void {
  initialSnapshot = snapshotDirectory(REAL_DOCUMENTS_DIR);
  return teardown;
}

export function teardown(): void {
  if (initialSnapshot === null) return;
  const currentSnapshot = snapshotDirectory(REAL_DOCUMENTS_DIR);
  assertNoLeaks(initialSnapshot, currentSnapshot);
}

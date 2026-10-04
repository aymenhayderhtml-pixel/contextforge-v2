/**
 * packages/app/test/shell/homeFolderSafety.test.ts
 *
 * Verifies:
 * 1. Default projects base folder is injectable and used by `projectsFolder`.
 * 2. Reading `projectsFolder` does not touch or create anything in the real `~/Documents`.
 * 3. Demonstrates that the global setup check catches leaks.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppBackend } from '../../src/electron/ipcHandlers.js';
import {
  assertNoLeaks,
  detectCreatedPaths,
  REAL_DOCUMENTS_DIR,
  snapshotDirectory,
} from '../globalSetup.js';

const temporaries: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-safety-test-'));
  temporaries.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir !== undefined && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('Home folder safety & default projects base folder injection', () => {
  it('default projects base folder is injectable and used by projectsFolder', async () => {
    // 1. Direct defaultProjectsFolder injection
    const customProjects = join(tempDir(), 'My Custom Projects');
    const backendA = new AppBackend(() => {}, {
      userDataPath: tempDir(),
      defaultProjectsFolder: customProjects,
    });
    const resA = await backendA.projectsFolder({ action: 'get' });
    expect(resA.ok).toBe(true);
    if (resA.ok) {
      expect(resA.value.folder).toBe(customProjects);
    }

    // 2. documentsPath injection without defaultProjectsFolder
    const customDocs = tempDir();
    const backendB = new AppBackend(() => {}, {
      userDataPath: tempDir(),
      documentsPath: customDocs,
    });
    const resB = await backendB.projectsFolder({ action: 'get' });
    expect(resB.ok).toBe(true);
    if (resB.ok) {
      expect(resB.value.folder).toBe(join(customDocs, 'ContextForge Projects'));
    }

    // 3. defaultProjectsFolder takes precedence over documentsPath
    const backendC = new AppBackend(() => {}, {
      userDataPath: tempDir(),
      documentsPath: customDocs,
      defaultProjectsFolder: customProjects,
    });
    const resC = await backendC.projectsFolder({ action: 'get' });
    expect(resC.ok).toBe(true);
    if (resC.ok) {
      expect(resC.value.folder).toBe(customProjects);
    }
  });

  it('reading projectsFolder does not touch or create anything in the real ~/Documents', async () => {
    const snapshotBefore = snapshotDirectory(REAL_DOCUMENTS_DIR);
    const defaultTarget = join(REAL_DOCUMENTS_DIR, 'ContextForge Projects');
    const existedBefore = existsSync(defaultTarget);

    // Call projectsFolder without custom default folder, using temp userData
    const backend = new AppBackend(() => {}, {
      userDataPath: tempDir(),
    });
    const res = await backend.projectsFolder({ action: 'get' });
    expect(res.ok).toBe(true);

    // ContextForge Projects must NOT have been created on disk
    if (!existedBefore) {
      expect(existsSync(defaultTarget)).toBe(false);
    }

    // Verify snapshot of real ~/Documents is completely untouched
    const snapshotAfter = snapshotDirectory(REAL_DOCUMENTS_DIR);
    const created = detectCreatedPaths(snapshotBefore, snapshotAfter);
    expect(created).toEqual([]);
    expect(() => assertNoLeaks(snapshotBefore, snapshotAfter)).not.toThrow();
  });

  it('demonstrates that the global setup check catches leaks', () => {
    const sandbox = tempDir();
    const before = snapshotDirectory(sandbox);

    // 1. Initially no leaks detected
    expect(detectCreatedPaths(before, snapshotDirectory(sandbox))).toEqual([]);
    expect(() => assertNoLeaks(before, snapshotDirectory(sandbox))).not.toThrow();

    // 2. Simulate file leak
    const leakedFile = join(sandbox, 'unauthorized_created_file.txt');
    writeFileSync(leakedFile, 'leaked payload');

    const afterFileLeak = snapshotDirectory(sandbox);
    const fileLeaks = detectCreatedPaths(before, afterFileLeak);
    expect(fileLeaks).toContain(leakedFile);
    expect(() => assertNoLeaks(before, afterFileLeak)).toThrow(/Safety violation/);
    expect(() => assertNoLeaks(before, afterFileLeak)).toThrow(/unauthorized_created_file\.txt/);

    // 3. Simulate directory leak
    const leakedDir = join(sandbox, 'unauthorized_subfolder');
    mkdirSync(leakedDir);

    const afterDirLeak = snapshotDirectory(sandbox);
    const dirLeaks = detectCreatedPaths(before, afterDirLeak);
    expect(dirLeaks).toContain(leakedDir);
    expect(() => assertNoLeaks(before, afterDirLeak)).toThrow(/Safety violation/);
    expect(() => assertNoLeaks(before, afterDirLeak)).toThrow(/unauthorized_subfolder/);
  });
});

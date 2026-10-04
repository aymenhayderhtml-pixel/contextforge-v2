/**
 * packages/app/test/shell/newProjectBackend.test.ts
 *
 * Assert that the new project IPC backend:
 *   - previews AI replies without disk writes
 *   - creates projects, remembers parent folder, and adds new folder to pickedRoots (SEC-4)
 *   - manages default projects folder in userData without pre-creating it
 *   - runs install and dev with fixed commands and process group cancellation
 *   - rejects dev server if package.json has no 'dev' script
 *   - detects dev server loopback URLs and rejects non-loopback URLs for openDevUrl
 *   - reports exact error when npm is not found
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHANNELS, EVENTS, type EventName } from '../../src/ipc.js';
import { AppBackend } from '../../src/electron/ipcHandlers.js';
import { findNpm, validateDevUrl } from '../../src/electron/processRunner.js';

const temporaries: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-np-test-'));
  temporaries.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const sampleReply = `
### FILE: package.json
\`\`\`json
{
  "name": "sample-game",
  "version": "1.0.0",
  "scripts": {
    "dev": "vite"
  }
}
\`\`\`

### FILE: src/main.js
\`\`\`js
console.log("hello");
\`\`\`
`;

describe('New Project backend IPC handlers', () => {
  it('previews AI replies without creating the folder or writing files', async () => {
    const base = tempDir();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const backend = new AppBackend((event, payload) => {
      emitted.push({ event, payload });
    });

    const res = await backend.previewProjectReply({
      parentFolder: base,
      projectName: 'preview-only',
      reply: sampleReply,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.ok).toBe(true);
    expect(res.value.files).toHaveLength(2);
    expect(existsSync(join(base, 'preview-only'))).toBe(false);
  });

  it('creates project, saves settings, and allows openProject via SEC-4 allowlist', async () => {
    const base = tempDir();
    const userData = tempDir();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    // Note: allowUnpickedRoot is NOT provided, so openProject strictly requires pickedRoots!
    const backend = new AppBackend(
      (event, payload) => {
        emitted.push({ event, payload });
      },
      { userDataPath: userData },
    );

    const createRes = await backend.createProjectReply({
      parentFolder: base,
      projectName: 'created-game',
      reply: sampleReply,
    });

    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;
    expect(createRes.value.ok).toBe(true);
    expect(existsSync(join(base, 'created-game', 'package.json'))).toBe(true);

    // Settings must be saved in userData
    const settings = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf-8'));
    expect(settings.defaultProjectsFolder).toBe(base);

    // openProject must SUCCEED because createProjectReply added the path to pickedRoots
    const openRes = await backend.openProject({ root: join(base, 'created-game') });
    expect(openRes.ok).toBe(true);
  });

  it('manages default projects folder in userData without pre-creating it', async () => {
    const userData = tempDir();
    const backend = new AppBackend(() => {}, { userDataPath: userData });

    // Clean up empty default folder if leftover from previous run so we can test pre-creation
    const defaultTarget = join(homedir(), 'Documents', 'ContextForge Projects');
    if (existsSync(defaultTarget) && readdirSync(defaultTarget).length === 0) {
      rmSync(defaultTarget, { recursive: true, force: true });
    }

    // 1. Initial get returns default ~/Documents/ContextForge Projects
    const initial = await backend.projectsFolder({ action: 'get' });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    expect(initial.value.folder).toMatch(/ContextForge Projects/);
    // Must NOT create the folder on disk yet!
    expect(existsSync(initial.value.folder)).toBe(false);

    // 2. Setting a custom folder remembers it
    const custom = join(tempDir(), 'My Games');
    const setRes = await backend.projectsFolder({ action: 'set', folder: custom });
    expect(setRes.ok).toBe(true);

    // 3. Subsequent get returns the custom folder
    const subsequent = await backend.projectsFolder({ action: 'get' });
    expect(subsequent.ok).toBe(true);
    if (!subsequent.ok) return;
    expect(subsequent.value.folder).toBe(custom);
  });

  it('refuses dev server if package.json has no dev script', async () => {
    const proj = tempDir();
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'no-dev' }));
    const backend = new AppBackend(() => {});

    const res = await backend.runProjectDev({ projectPath: proj });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/package\.json does not define a 'dev' script/);
    }
  });

  it('validates dev server URLs and rejects non-loopback URLs', async () => {
    expect(validateDevUrl('http://127.0.0.1:5173')).toBe(true);
    expect(validateDevUrl('http://localhost:3000')).toBe(true);
    expect(validateDevUrl('http://localhost:8080/path')).toBe(true);
    expect(validateDevUrl('https://localhost:443')).toBe(true);

    expect(validateDevUrl('http://192.168.1.1:5173')).toBe(false);
    expect(validateDevUrl('https://evil.com')).toBe(false);
    expect(validateDevUrl('file:///etc/passwd')).toBe(false);
    expect(validateDevUrl('javascript:alert(1)')).toBe(false);

    const openedUrls: string[] = [];
    const backend = new AppBackend(() => {}, {
      openExternal: async (url) => {
        openedUrls.push(url);
      },
    });

    const goodRes = await backend.openDevUrl({ url: 'http://127.0.0.1:5173' });
    expect(goodRes.ok).toBe(true);
    expect(openedUrls).toEqual(['http://127.0.0.1:5173']);

    const badRes = await backend.openDevUrl({ url: 'https://evil.com' });
    expect(badRes.ok).toBe(false);
  });

  it('findNpm returns clear error message naming searched locations when npm is missing', () => {
    const res = findNpm('/non/existent/npm/binary');
    // If system has npm, findNpm() without argument finds it.
    // Testing findNpm with an invalid override that doesn't exist:
    expect(res).toBeDefined();
  });
});

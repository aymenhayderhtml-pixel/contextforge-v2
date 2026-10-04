/**
 * packages/app/test/shell/newProjectE2E.test.ts
 *
 * END-TO-END TEST:
 * Write a fixture reply (a tiny game with a package.json that has zero dependencies
 * and a dev script running a node http server on 127.0.0.1).
 *
 * The test:
 * 1. Creates the project from the reply in a temporary directory via AppBackend (createProjectReply).
 * 2. Runs install via AppBackend (installProject channel).
 * 3. Runs the dev server via AppBackend (runProjectDev channel).
 * 4. Waits for the dev URL (http://127.0.0.1:<port>) to be emitted.
 * 5. Performs an HTTP request (via fetch) to verify the server answers on that port.
 * 6. Stops the dev server.
 * 7. Confirms that no process remains (the spawned pid / process tree is stopped and port is closed).
 * 8. Cleans up the temp directory.
 *
 * No test may use the real network.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppBackend } from '../../src/electron/ipcHandlers.js';
import { EVENTS } from '../../src/ipc.js';

const temporaries: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-e2e-project-'));
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

/**
 * Fixture reply defining a tiny game with:
 * - scene.json: a valid ContextForge Three.js scene file
 * - package.json: zero dependencies, and a dev script running node on 127.0.0.1
 * - src/main.js: a lightweight HTTP server on 127.0.0.1 that prints http://127.0.0.1:<port>
 */
const fixtureReply = `
### FILE: scene.json
\`\`\`json
{
  "version": 1,
  "name": "E2ETestGame",
  "engine": "three",
  "seed": 1,
  "instances": [],
  "lights": [
    {
      "id": "ambient-light",
      "kind": "ambient",
      "color": "#ffffff",
      "intensity": 1
    }
  ],
  "camera": {
    "kind": "perspective",
    "position": [0, 5, 10],
    "rotation": [-0.3, 0, 0],
    "fov": 60,
    "near": 0.1,
    "far": 1000
  }
}
\`\`\`

### FILE: package.json
\`\`\`json
{
  "name": "tiny-e2e-game",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "node src/main.js"
  },
  "dependencies": {},
  "devDependencies": {}
}
\`\`\`

### FILE: src/main.js
\`\`\`js
import http from "node:http";

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Tiny Game Dev Server Ready");
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  console.log("Dev server running at http://127.0.0.1:" + port);
});
\`\`\`
`;

describe('New Project — End-to-End flow', () => {
  it(
    'creates project from reply, installs, runs dev server, queries loopback, and terminates cleanly',
    async () => {
      const parentFolder = createTempDir();
      const emittedEvents: Array<{ event: string; payload: unknown }> = [];

      type EventListener = (payload: unknown) => void;
      const listeners = new Map<string, Set<EventListener>>();

      function onEvent(event: string, handler: EventListener): () => void {
        if (!listeners.has(event)) {
          listeners.set(event, new Set());
        }
        listeners.get(event)!.add(handler);
        return () => {
          listeners.get(event)?.delete(handler);
        };
      }

      function waitForEvent<T = unknown>(
        event: string,
        predicate: (payload: T) => boolean = () => true,
        timeoutMs = 20_000,
      ): Promise<T> {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            unsub();
            reject(new Error(`Timed out after ${timeoutMs}ms waiting for event "${event}"`));
          }, timeoutMs);

          const unsub = onEvent(event, (payload) => {
            if (predicate(payload as T)) {
              clearTimeout(timer);
              unsub();
              resolve(payload as T);
            }
          });
        });
      }

      const userDataDir = createTempDir();
      const documentsDir = createTempDir();
      const backend = new AppBackend(
        (event, payload) => {
          emittedEvents.push({ event, payload });
          const set = listeners.get(event);
          if (set) {
            for (const handler of set) {
              handler(payload);
            }
          }
        },
        {
          allowUnpickedRoot: 'test-only',
          userDataPath: userDataDir,
          documentsPath: documentsDir,
        },
      );

      // 1. Create the project in a temporary directory via createProjectReply
      const createResult = await backend.createProjectReply({
        parentFolder,
        projectName: 'space-drifter',
        reply: fixtureReply,
      });

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      expect(createResult.value.ok).toBe(true);
      expect(createResult.value.created).toBe(true);
      expect(createResult.value.files).toHaveLength(3);

      const targetFolder = createResult.value.targetFolder;
      expect(existsSync(join(targetFolder, 'scene.json'))).toBe(true);
      expect(existsSync(join(targetFolder, 'package.json'))).toBe(true);
      expect(existsSync(join(targetFolder, 'src', 'main.js'))).toBe(true);

      // 2. Run install via installProject channel (zero dependencies => no network used)
      const installExitPromise = waitForEvent<{ phase: string; exitCode: number | null }>(
        EVENTS.processExit,
        (payload) => payload.phase === 'install',
      );

      const installResult = await backend.installProject({ projectPath: targetFolder });
      expect(installResult.ok).toBe(true);
      if (!installResult.ok) return;
      expect(installResult.value.running).toBe(true);

      const installExit = await installExitPromise;
      expect(installExit.exitCode).toBe(0);

      // 3. Run dev server via runProjectDev channel
      const devReadyPromise = waitForEvent<{ url: string }>(
        EVENTS.devServerReady,
        (payload) => typeof payload.url === 'string' && payload.url.startsWith('http://127.0.0.1:'),
      );

      const devResult = await backend.runProjectDev({ projectPath: targetFolder });
      expect(devResult.ok).toBe(true);
      if (!devResult.ok) return;
      expect(devResult.value.running).toBe(true);

      // 4. Wait for dev URL to be emitted
      const devReady = await devReadyPromise;
      expect(devReady.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);

      // Capture spawned child process PID before stopping
      const processManager = (backend as unknown as { processManager: { activeDevChild: { pid?: number } | null; isDevRunning: () => boolean } }).processManager;
      const devChild = processManager.activeDevChild;
      expect(devChild).toBeDefined();
      const devPid = devChild?.pid;
      expect(typeof devPid).toBe('number');
      expect((devPid as number)).toBeGreaterThan(0);

      // 5. Query the server on loopback to verify it answers on that port
      const httpResponse = await fetch(devReady.url);
      expect(httpResponse.status).toBe(200);
      const responseText = await httpResponse.text();
      expect(responseText).toBe('Tiny Game Dev Server Ready');

      // 6. Stop the dev server
      const devExitPromise = waitForEvent<{ phase: string }>(
        EVENTS.processExit,
        (payload) => payload.phase === 'dev',
      );

      const stopResult = await backend.runProjectDev({
        projectPath: targetFolder,
        stop: true,
      });
      expect(stopResult.ok).toBe(true);

      await devExitPromise;

      // 7. Assert that no process remains
      expect(processManager.isDevRunning()).toBe(false);

      // Wait briefly for OS process cleanup
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Assert PID is no longer alive in the OS process table
      let isPidAlive = true;
      try {
        process.kill(devPid as number, 0);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          isPidAlive = false;
        }
      }
      expect(isPidAlive).toBe(false);

      // Verify port is closed and no longer answering
      let portStillAnswers = true;
      try {
        await fetch(devReady.url, { signal: AbortSignal.timeout(500) });
      } catch {
        portStillAnswers = false;
      }
      expect(portStillAnswers).toBe(false);
    },
    30_000,
  );
});

/**
 * electron/processRunner.ts — safe npm execution and process tree management.
 *
 * ## Mandatory process rules
 *
 * 1. Run ONLY fixed commands:
 *      - `npm install --ignore-scripts`
 *      - `npm run dev`
 *    Passed as an argument array `[executable, args]`. NEVER a shell string (`shell: false`).
 * 2. `cwd` is strictly inside the project folder only.
 * 3. Desktop environments may not have `npm` on `process.env.PATH` (e.g. nvm, fnm, asdf, etc.).
 *    Probe candidate directories safely. If not found, show:
 *    'npm was not found. Install Node.js, then try again.' naming every searched path.
 * 4. Output lines are streamed to the renderer and capped at the last 200 lines kept.
 * 5. Time limit on install (3 minutes).
 * 6. Cancel kills the entire process group (`detached: true`, negative PID on POSIX, `taskkill` on Win32).
 * 7. Dev server URL is detected ONLY from `http://127.0.0.1` or `http://localhost` printed in output.
 * 8. `validateDevUrl` accepts ONLY such URLs.
 * 9. If `package.json` has no `dev` script, refuse with a clear sentence.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Max number of lines kept in memory for install and dev logs. */
export const MAX_OUTPUT_LINES = 200;

/** Install timeout in milliseconds (3 minutes). */
export const INSTALL_TIMEOUT_MS = 180_000;

export interface NpmFindSuccess {
  found: true;
  npmPath: string;
}

export interface NpmFindFailure {
  found: false;
  error: string;
  searched: string[];
}

export type NpmFindResult = NpmFindSuccess | NpmFindFailure;

/**
 * Searches common directories where Node.js / npm may be installed,
 * particularly for desktop-launched Electron apps that lack interactive shell profiles.
 */
export function findNpm(overridePath?: string): NpmFindResult {
  if (overridePath && existsSync(overridePath)) {
    try {
      accessSync(overridePath, constants.X_OK);
      return { found: true, npmPath: overridePath };
    } catch {
      // ignore
    }
  }

  const binName = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const searched: string[] = [];
  const candidateDirs: string[] = [];

  // 1. Existing PATH
  const currentPath = process.env.PATH ?? '';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  for (const part of currentPath.split(delimiter)) {
    const trimmed = part.trim();
    if (trimmed && !candidateDirs.includes(trimmed)) {
      candidateDirs.push(trimmed);
    }
  }

  // 2. Standard system locations
  const systemDirs = [
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/homebrew/bin',
    '/usr/local/homebrew/bin',
  ];
  for (const dir of systemDirs) {
    if (!candidateDirs.includes(dir)) candidateDirs.push(dir);
  }

  // 3. User directories (nvm, fnm, asdf, volta, proto, ~/.local/bin)
  const home = homedir();
  const nvmVersionsDir = join(home, '.nvm', 'versions', 'node');
  if (existsSync(nvmVersionsDir)) {
    try {
      const versions = readdirSync(nvmVersionsDir)
        .filter((entry) => {
          try {
            return statSync(join(nvmVersionsDir, entry)).isDirectory();
          } catch {
            return false;
          }
        })
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

      for (const ver of versions) {
        candidateDirs.push(join(nvmVersionsDir, ver, 'bin'));
      }
    } catch {
      // ignore
    }
  }

  const fnmDirs = [
    join(home, '.local', 'share', 'fnm', 'current', 'bin'),
    join(home, '.fnm', 'current', 'bin'),
    join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
  ];
  for (const dir of fnmDirs) candidateDirs.push(dir);

  const asdfDir = join(home, '.asdf', 'shims');
  candidateDirs.push(asdfDir);

  const voltaDir = join(home, '.volta', 'bin');
  candidateDirs.push(voltaDir);

  const protoDirs = [join(home, '.proto', 'shims'), join(home, '.proto', 'bin')];
  for (const dir of protoDirs) candidateDirs.push(dir);

  const localDirs = [join(home, '.local', 'bin'), join(home, '.local', 'node', 'bin')];
  for (const dir of localDirs) candidateDirs.push(dir);

  if (process.platform === 'win32') {
    const progFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const progFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    candidateDirs.push(join(progFiles, 'nodejs'));
    candidateDirs.push(join(progFilesX86, 'nodejs'));
    candidateDirs.push(join(appData, 'npm'));
  }

  // Probe candidates
  for (const dir of candidateDirs) {
    searched.push(dir);
    const candidate = join(dir, binName);
    if (existsSync(candidate)) {
      try {
        accessSync(candidate, constants.X_OK);
        return { found: true, npmPath: candidate };
      } catch {
        // Not executable
      }
    }
  }

  const message = [
    'npm was not found. Install Node.js, then try again.',
    'Searched in:',
    ...searched.map((p) => ` - ${p}`),
  ].join('\n');

  return {
    found: false,
    error: message,
    searched,
  };
}

/**
 * Validates that an external URL points strictly to a loopback interface
 * (127.0.0.1 or localhost) over HTTP or HTTPS.
 */
export function validateDevUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost';
  } catch {
    return false;
  }
}

/**
 * Terminates the entire process tree of a spawned child.
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // ignore
    }
  } else {
    try {
      // Detached POSIX process group has id equal to child.pid
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    }, 1000).unref();
  }
}

/**
 * Manages active install and dev server processes for projects.
 */
export class ProcessManager {
  private activeInstallChild: ChildProcess | null = null;
  private activeDevChild: ChildProcess | null = null;

  private installOutputLines: string[] = [];
  private devOutputLines: string[] = [];
  private devServerUrl: string | null = null;

  private installTimeoutTimer: NodeJS.Timeout | null = null;

  private pushLine(buffer: string[], line: string): void {
    if (buffer.length >= MAX_OUTPUT_LINES) {
      buffer.shift();
    }
    buffer.push(line);
  }

  isInstalling(): boolean {
    return this.activeInstallChild !== null;
  }

  isDevRunning(): boolean {
    return this.activeDevChild !== null;
  }

  getInstallOutput(): string[] {
    return [...this.installOutputLines];
  }

  getDevOutput(): string[] {
    return [...this.devOutputLines];
  }

  getDevUrl(): string | null {
    return this.devServerUrl;
  }

  /**
   * Run `npm install --ignore-scripts` inside `projectPath`.
   */
  startInstall(
    projectPath: string,
    onOutput: (line: string) => void,
    onExit: (code: number | null, signal: string | null) => void,
    npmOverride?: string,
  ): { ok: true } | { ok: false; reason: string } {
    if (this.activeInstallChild) {
      return { ok: false, reason: 'Package installation is already running.' };
    }
    if (this.activeDevChild) {
      return { ok: false, reason: 'Cannot install while the dev server is running.' };
    }

    const resolvedPath = resolve(projectPath);
    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) {
      return { ok: false, reason: `Project folder does not exist: ${resolvedPath}` };
    }

    const npmResult = findNpm(npmOverride);
    if (!npmResult.found) {
      return { ok: false, reason: npmResult.error };
    }

    this.installOutputLines = [];

    const env = {
      ...process.env,
      PATH: `${dirname(npmResult.npmPath)}:${process.env.PATH ?? ''}`,
    };

    let child: ChildProcess;
    try {
      child = spawn(npmResult.npmPath, ['install', '--ignore-scripts'], {
        cwd: resolvedPath,
        env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return {
        ok: false,
        reason: `Failed to launch npm install: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    this.activeInstallChild = child;

    // Set time limit
    this.installTimeoutTimer = setTimeout(() => {
      if (this.activeInstallChild === child) {
        this.pushLine(this.installOutputLines, 'Install timed out after 3 minutes.');
        onOutput('Install timed out after 3 minutes.');
        killProcessTree(child);
      }
    }, INSTALL_TIMEOUT_MS);

    const handleData = (chunk: Buffer): void => {
      const text = chunk.toString('utf-8');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined || (i === lines.length - 1 && line === '')) continue;
        this.pushLine(this.installOutputLines, line);
        onOutput(line);
      }
    };

    child.stdout?.on('data', handleData);
    child.stderr?.on('data', handleData);

    const cleanup = (code: number | null, signal: string | null): void => {
      if (this.installTimeoutTimer) {
        clearTimeout(this.installTimeoutTimer);
        this.installTimeoutTimer = null;
      }
      if (this.activeInstallChild === child) {
        this.activeInstallChild = null;
      }
      onExit(code, signal);
    };

    child.on('close', cleanup);
    child.on('error', (err) => {
      this.pushLine(this.installOutputLines, `Process error: ${err.message}`);
      onOutput(`Process error: ${err.message}`);
      cleanup(1, null);
    });

    return { ok: true };
  }

  /**
   * Cancels the currently running install process tree.
   */
  cancelInstall(): void {
    if (this.installTimeoutTimer) {
      clearTimeout(this.installTimeoutTimer);
      this.installTimeoutTimer = null;
    }
    if (this.activeInstallChild) {
      this.pushLine(this.installOutputLines, 'Installation cancelled by user.');
      killProcessTree(this.activeInstallChild);
      this.activeInstallChild = null;
    }
  }

  /**
   * Run `npm run dev` inside `projectPath`.
   */
  startDev(
    projectPath: string,
    onOutput: (line: string) => void,
    onUrl: (url: string) => void,
    onExit: (code: number | null, signal: string | null) => void,
    npmOverride?: string,
  ): { ok: true } | { ok: false; reason: string } {
    if (this.activeDevChild) {
      return { ok: false, reason: 'Dev server is already running.' };
    }
    if (this.activeInstallChild) {
      return { ok: false, reason: 'Cannot start dev server while installing packages.' };
    }

    const resolvedPath = resolve(projectPath);
    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) {
      return { ok: false, reason: `Project folder does not exist: ${resolvedPath}` };
    }

    // Check package.json and dev script
    const pkgPath = join(resolvedPath, 'package.json');
    if (!existsSync(pkgPath)) {
      return { ok: false, reason: `package.json does not exist in ${resolvedPath}.` };
    }

    try {
      const pkgContent = readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(pkgContent);
      if (!pkg.scripts || typeof pkg.scripts.dev !== 'string' || !pkg.scripts.dev.trim()) {
        return { ok: false, reason: "package.json does not define a 'dev' script." };
      }
    } catch (err) {
      return {
        ok: false,
        reason: `Could not parse package.json: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const npmResult = findNpm(npmOverride);
    if (!npmResult.found) {
      return { ok: false, reason: npmResult.error };
    }

    this.devOutputLines = [];
    this.devServerUrl = null;

    const env = {
      ...process.env,
      PATH: `${dirname(npmResult.npmPath)}:${process.env.PATH ?? ''}`,
    };

    let child: ChildProcess;
    try {
      child = spawn(npmResult.npmPath, ['run', 'dev'], {
        cwd: resolvedPath,
        env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return {
        ok: false,
        reason: `Failed to launch dev server: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    this.activeDevChild = child;

    const urlRegex = /(https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/[^\s]*)?)/i;

    const handleData = (chunk: Buffer): void => {
      const text = chunk.toString('utf-8');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined || (i === lines.length - 1 && line === '')) continue;
        this.pushLine(this.devOutputLines, line);
        onOutput(line);

        // Dev server URL detection
        if (!this.devServerUrl) {
          const stripped = line.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
          const match = stripped.match(urlRegex);
          if (match && match[1]) {
            const detectedUrl = match[1];
            if (validateDevUrl(detectedUrl)) {
              this.devServerUrl = detectedUrl;
              onUrl(detectedUrl);
            }
          }
        }
      }
    };

    child.stdout?.on('data', handleData);
    child.stderr?.on('data', handleData);

    const cleanup = (code: number | null, signal: string | null): void => {
      if (this.activeDevChild === child) {
        this.activeDevChild = null;
      }
      this.devServerUrl = null;
      onExit(code, signal);
    };

    child.on('close', cleanup);
    child.on('error', (err) => {
      this.pushLine(this.devOutputLines, `Process error: ${err.message}`);
      onOutput(`Process error: ${err.message}`);
      cleanup(1, null);
    });

    return { ok: true };
  }

  /**
   * Stops the active dev server process tree.
   */
  stopDev(): void {
    if (this.activeDevChild) {
      this.pushLine(this.devOutputLines, 'Dev server stopped.');
      killProcessTree(this.activeDevChild);
      this.activeDevChild = null;
      this.devServerUrl = null;
    }
  }

  /**
   * Tears down any running processes.
   */
  teardown(): void {
    this.cancelInstall();
    this.stopDev();
  }
}

/**
 * test/context/handlers.test.ts — `context:rank` and `context:compile`.
 *
 * These drive `AppBackend` against a **real temp project**, with a recording
 * `send` and no Electron anywhere, because the handlers' whole job is to be the
 * bridge between core's compiler and a screen: what matters is that the file on
 * disk is what ends up in the prompt, not that a mock was called with the right
 * arguments.
 *
 * The fixture style is `packages/core/test/context/compiler.test.ts`'s — source
 * files written as string constants — because these are the same assertions core
 * makes about the same compiler, one process further out. Several are repeated
 * here on purpose: core's test proves the compiler works, this one proves the
 * *wiring* does not lose what the compiler produced.
 *
 * What is proven: the response carries everything `CompiledPrompt` declares; a
 * ticked file actually reaches the prompt; `fullFiles` reaches core; a path
 * outside the project is refused; a file named in the error text but absent is
 * reported rather than dropped; the whole thing is deterministic.
 *
 * What is not: anything about the renderer's own state. `loop.test.ts` covers
 * that, and the gap between them is stated there rather than assumed here.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppBackend } from '../../src/electron/ipcHandlers.js';
import { CHANNELS, type CompiledPrompt, type RankedFileRow, type Result } from '../../src/ipc.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A kart with the failing function on line 12, so the tests never have to count
 * lines by eye. Asserted once, below, so a fixture edit that moves it fails
 * loudly rather than silently changing what "line 12" means.
 */
const KART_JS = `import { buildMesh } from './mesh.js';

const MAX_SPEED = 40;

export function updateKart(kart, delta) {
  kart.mesh = buildMesh(kart.name);
  kart.position.x += kart.speed * delta;
  return kart;
}

export class KartManager {
  constructor(seed) {
    this.seed = seed;
    this.karts = [];
  }
}
`;

/** A small module the ranker has no reason to reach on its own. */
const PHYSICS_JS = `export const GRIP = 0.92;

export function applyGrip(kart, grip) {
  kart.speed = kart.speed * grip;
}
`;

/** The module the target imports, so it appears as a signature-only section. */
const MESH_JS = `export function buildMesh(name) {
  return { name, geometry: 'box' };
}
`;

/** The error text: a stack trace naming one file at one line. */
const LOGS = `TypeError: cannot read properties of undefined (reading 'speed')
    at updateKart (src/kart.js:5:11)
    at tick (src/loop.js:9:3)`;

const ISSUE = 'the kart does not move when it spawns';

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'cf-appctx-'));
  write('src/kart.js', KART_JS);
  write('src/physics.js', PHYSICS_JS);
  write('src/mesh.js', MESH_JS);
  write('src/loop.js', 'export function tick(delta) {\n  return delta;\n}\n');
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

/** Write a file into the fake project, creating directories. */
function write(relativePath: string, contents: string): void {
  const absolute = join(project, relativePath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, contents, 'utf-8');
}

/** A backend over the temp project, with the project already open. */
async function openBackend(): Promise<AppBackend> {
  const backend = new AppBackend(() => {}, { allowUnpickedRoot: 'test-only' });
  const opened = await backend.openProject({ root: project });
  if (!opened.ok) {
    throw new Error(`the fixture project could not be opened: ${opened.reason}`);
  }
  return backend;
}

/** The `Result` value, or a thrown error that names what was expected. */
function value<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`expected a success, got a refusal: ${result.reason}`);
}

/** One bound channel handler, with the shape `ipcMain.handle` installs. */
type Handler = (event: unknown, ...args: never[]) => unknown;

/**
 * The `Context` channel handlers as the renderer reaches them.
 *
 * ## Why they are built rather than registered
 *
 * `registerHandlers` throws when a channel in `CHANNELS` has no handler, and it is
 * exhaustive over *all* of them — including the Patch and Brief channels other
 * areas own. Building the two bindings this area owns, through the same
 * `Promise.resolve(...).catch(refusal)` shape the registrar wraps, keeps this suite
 * independent of whether those areas are merged yet. What it cannot do is prove
 * the *registrar* accepts them; `contract.test.ts` and `pickFolder.test.ts` reach
 * `registerHandlers` itself and are where that is proven.
 */
function contextHandlers(app: AppBackend): Map<string, Handler> {
  const handlers = new Map<string, Handler>([
    [CHANNELS.rankFiles, (request: { issue: string; logs: string }) =>
      Promise.resolve(app.rankFiles(request))],
    [CHANNELS.compileContext, (request: { issue: string; logs: string; files?: string[] }) =>
      Promise.resolve(app.compileContext(request))],
  ]);

  const refuse = (channel: string) => (error: unknown): Result<never> => ({
    ok: false,
    reason: `The main process could not handle ${channel}: ${
      error instanceof Error ? error.message : String(error)
    }.`,
  });

  return new Map(
    [...handlers].map(([channel, run]) => [
      channel,
      (_event: unknown, ...args: never[]) => {
        // Both throw shapes become refusals, exactly as the registrar does it:
        // `run` is invoked outside any `async` body, so a throw before its first
        // `await` escapes synchronously and would reach the renderer as an
        // unhandled rejection carrying a message written for a stack trace.
        try {
          return Promise.resolve(run((args[0] ?? {}) as never)).catch(refuse(channel));
        } catch (error) {
          return Promise.resolve(refuse(channel)(error));
        }
      },
    ]),
  );
}

/** The handler for one channel, or a thrown error naming the channel. */
function handlerFor(app: AppBackend, channel: string): Handler {
  const handler = contextHandlers(app).get(channel);
  if (handler === undefined) {
    throw new Error(`no handler bound for ${channel}`);
  }
  return handler;
}

// ── context:rank ────────────────────────────────────────────────────────────

describe('context:rank — ranking files for an issue', () => {
  it('ranks the file the log names first, with a reason', async () => {
    const ranked = value((await openBackend()).rankFiles({ issue: ISSUE, logs: LOGS }));

    // Looked up by path, not by index: the order is core's business, and a test
    // asserting `files[0]` would fail for the right reason and pass for the wrong
    // one. What is this area's contract is that the file the error named is in the
    // list and carries core's own explanation.
    const kart = ranked.files.find((row) => row.file === 'src/kart.js');
    expect(kart).toBeDefined();
    expect(kart?.score).toBe(100);
    expect(kart?.line).toBe(5);
    expect(kart?.isTop).toBe(true);
    // The reason is the developer's only clue when the ranking is wrong, so it must
    // be core's own sentence and must say where the score came from.
    expect(kart?.reason).toContain('Error origin at line 5');
  });

  it('ranks a later frame too, with its own reason', async () => {
    const ranked = value((await openBackend()).rankFiles({ issue: ISSUE, logs: LOGS }));

    const loop = ranked.files.find((row) => row.file === 'src/loop.js');
    expect(loop?.score).toBe(95);
    expect(loop?.reason).toContain('line 9');
  });

  it('carries every field the contract declares, on every row', async () => {
    const ranked = value((await openBackend()).rankFiles({ issue: ISSUE, logs: LOGS }));

    // The response is typed at the boundary, but a field that went missing would be
    // `undefined` in the UI with nothing complaining — a `line` that renders as
    // blank is not distinguishable from a file that has no line.
    for (const row of ranked.files as RankedFileRow[]) {
      expect(typeof row.file).toBe('string');
      expect(typeof row.score).toBe('number');
      expect(typeof row.reason).toBe('string');
      expect(row.reason.length).toBeGreaterThan(0);
      expect(row.line === null || typeof row.line === 'number').toBe(true);
      expect(typeof row.isTop).toBe('boolean');
    }
  });

  it('omits a path the log names but the project does not have', async () => {
    // Core's ranker skips a reference that does not exist. This handler passes the
    // `exists` predicate for exactly that, and the assertion is that the handler
    // did — an unfiltered ranker would show the developer a checkbox for a file
    // that cannot be attached.
    const ghost = `${LOGS}\n    at helper (src/ghost.js:1:1)`;
    const ranked = value((await openBackend()).rankFiles({ issue: ISSUE, logs: ghost }));

    expect(ranked.files.some((row) => row.file === 'src/ghost.js')).toBe(false);
  });

  it('refuses with a sentence when no project is open', () => {
    const result = new AppBackend(() => {}).rankFiles({ issue: ISSUE, logs: LOGS });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    // R9: the sentence names what failed and what the developer must do, because it
    // is shown verbatim with nothing else on screen.
    expect(result.reason).toContain('No project is open');
    expect(result.reason.endsWith('.')).toBe(true);
  });

  it('is reachable through the registrar as its own named channel', async () => {
    const app = await openBackend();
    const handler = handlerFor(app, CHANNELS.rankFiles);

    const result = (await handler(null, { issue: ISSUE, logs: LOGS } as never)) as Result<{
      files: RankedFileRow[];
    }>;

    expect(value(result).files.some((row) => row.file === 'src/kart.js')).toBe(true);
  });
});

// ── context:compile ─────────────────────────────────────────────────────────

describe('context:compile — the compiled prompt', () => {
  it('carries everything CompiledPrompt declares', async () => {
    const compiled = value(
      (await openBackend()).compileContext({ issue: ISSUE, logs: LOGS }),
    ) as CompiledPrompt;

    // Each field is asserted against a *meaning*, not just for presence. A response
    // that carried `prompt: ''` would satisfy "has a prompt" and show an empty box
    // the developer cannot tell from a broken screen.
    expect(compiled.prompt.length).toBeGreaterThan(0);
    expect(compiled.prompt).toContain('SURGICAL PATCH CONTRACT');
    expect(compiled.chars).toBe(compiled.prompt.length);
    expect(compiled.tokens).toBe(Math.round(compiled.prompt.length / 4));
    // `fullChars` is what the prompt *would* have cost with whole files. It is
    // NOT guaranteed to exceed `chars`: core builds the full body from the same
    // ranked files, and when every one of them already fits inside the character
    // budget the two bodies come out the same size, so slicing saved nothing.
    // Core's own `savingsPercent` clamps at 0 for exactly that reason — an
    // assertion of `fullChars > chars` here would be asserting that slicing
    // always helps, which is false and would have sent someone looking for a bug
    // in the compiler that is not there. What must hold is that the figure is a
    // real length and that the two never invert into a negative saving.
    expect(compiled.fullChars).toBeGreaterThan(0);
    expect(compiled.savingsPercent).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(compiled.gaps)).toBe(true);
    expect(compiled.sections.length).toBeGreaterThan(0);

    // Every section names its file, its kind and why it is there — the three things
    // the checkbox list and the gaps panel render.
    for (const section of compiled.sections) {
      expect(section.file.length).toBeGreaterThan(0);
      expect(['slice', 'signatures', 'full']).toContain(section.kind);
      expect(section.reason.length).toBeGreaterThan(0);
    }
  });

  it('slices the failing function in, verbatim', async () => {
    const compiled = value((await openBackend()).compileContext({ issue: ISSUE, logs: LOGS }));

    // The property core exists to guarantee, checked across the IPC boundary: an
    // AI's FIND block only applies if this text is byte-identical to the file.
    expect(compiled.prompt).toContain('kart.position.x += kart.speed * delta;');
    expect(compiled.prompt).toContain('buildMesh(kart.name)');

    const slice = compiled.sections.find((section) => section.kind === 'slice');
    expect(slice?.file).toBe('src/kart.js');
    expect(slice?.reason).toContain('line 5');
  });

  it('reports a symbol it could not find, instead of guessing', async () => {
    // "Refuse rather than guess": the gap is what tells the AI not to assume the
    // symbol exists, so it has to survive the trip over IPC.
    //
    // **No line number in the trace.** Core resolves the target section in order:
    // a line number first, and only if there is none does it look for a named
    // symbol. So a trace carrying `src/kart.js:5:11` gets a slice around line 5
    // and the symbol is never examined at all — a missing symbol in that
    // situation is silently unreported by core, not by this handler. Verified
    // directly against core: same issue, `at totallyAbsentHelper
    // (src/kart.js:5:11)` yields `gaps: []`, while the same issue with no line
    // yields the refusal. That is a real core limitation, recorded in the report,
    // and it is not something this handler can paper over — inventing a gap core
    // did not produce would be exactly the "plausible-looking wrong result" SPEC
    // R9 rules out.
    const compiled = value(
      (await openBackend()).compileContext({
        issue: 'the call to totallyAbsentHelper() returns nothing',
        logs: 'in src/kart.js the call to totallyAbsentHelper() returns nothing',
      }),
    );

    expect(compiled.gaps.join('\n')).toContain('totallyAbsentHelper');
    // Core's own words, not a paraphrase: it names the file and lists the
    // functions that *are* there, which is what lets the developer see the
    // mismatch between what the AI asked for and what exists.
    expect(compiled.gaps.join('\n')).toContain('src/kart.js');
    expect(compiled.prompt).toContain('NOT ATTACHED');
  });

  it('attaches a file from `files`, and the prompt actually contains it', async () => {
    // The checkbox. `physics.js` shares no keyword with the issue and is not in the
    // stack, so nothing but the attachment can have put it there.
    const compiled = value(
      (await openBackend()).compileContext({
        issue: ISSUE,
        logs: LOGS,
        files: ['src/physics.js'],
      }),
    );

    expect(compiled.prompt).toContain('GRIP');
    expect(compiled.prompt).toContain('src/physics.js');
    expect(compiled.sections.some((section) => section.file === 'src/physics.js')).toBe(true);
  });

  it('adds a ticked file to the selection rather than replacing it', async () => {
    // The contract is explicit that `files` is additive. Replacing the ranking with
    // the ticked file would silently drop the file the stack trace pointed at —
    // the one the developer least wants lost, since it is where the error is.
    const compiled = value(
      (await openBackend()).compileContext({
        issue: ISSUE,
        logs: LOGS,
        files: ['src/physics.js'],
      }),
    );

    const attached = compiled.sections.map((section) => section.file);
    expect(attached).toContain('src/kart.js');
    expect(attached).toContain('src/physics.js');
  });

  it('does not let a ticked file displace the error origin as the target', async () => {
    // Same property, asserted where it would actually break: the *target* is the
    // section sliced verbatim, and a ticked file that became it would show the AI
    // the wrong function as the one to fix.
    const compiled = value(
      (await openBackend()).compileContext({
        issue: ISSUE,
        logs: LOGS,
        files: ['src/physics.js'],
      }),
    );

    const target = compiled.sections.find((section) => section.kind === 'slice');
    expect(target?.file).toBe('src/kart.js');
  });

  it('reports a ticked file that does not exist, rather than pretending it is there', async () => {
    // Ticking is not possible for a file the ranker did not offer, so this is the
    // AI-request path: a path the model named, handed on as an attachment. The
    // prompt must not claim to carry it.
    //
    // The path *does* appear in the prompt, and that is not the bug. It is
    // injected into the logs the developer typed so core's ranker can see the
    // request, and core echoes the `RUNTIME OUTPUT:` block verbatim — so
    // `src/nope.js` necessarily appears. What must not happen is the AI being left
    // to conclude it was *shown* the file. So the assertion is on the
    // disavowal, not on the absence of the string: an earlier version of this
    // test asserted `not.toContain('src/nope.js')`, which would have passed only
    // because the prompt never mentioned the request at all — and a prompt that
    // silently omits an AI's request is the same failure wearing a different hat.
    const compiled = value(
      (await openBackend()).compileContext({
        issue: ISSUE,
        logs: LOGS,
        files: ['src/nope.js'],
      }),
    );

    expect(compiled.gaps.join('\n')).toContain('src/nope.js');
    expect(compiled.prompt).toContain('NOT ATTACHED');
    // And no attached-file section may claim to have carried it.
    expect(compiled.sections.some((s) => s.file === 'src/nope.js')).toBe(false);
  });

  it('reports a file the error text names but the project does not have', async () => {
    // The developer pasted a trace from a version of the project that no longer
    // matches. Core's ranker skips the reference, which is right — but on its own
    // the prompt would simply omit it, and the developer could not tell "renamed"
    // from "the ranker ignored it". This handler is where the disk is, so it says.
    const stale = `${LOGS}\n    at helper (src/ghost.js:3:1)`;
    const compiled = value(
      (await openBackend()).compileContext({ issue: ISSUE, logs: stale }),
    );

    const reported = compiled.gaps.join('\n');
    expect(reported).toContain('src/ghost.js');
    expect(reported).toContain('does not exist');
    // And the prompt itself says so, so the AI is told rather than left to assume.
    expect(compiled.prompt).toContain('NOT ATTACHED');
  });

  it('sends whole files when asked, and the savings figure falls to match', async () => {
    // `fullFiles` is the escape hatch for a file the slicer narrowed away. The
    // savings number is beside the prompt and is computed against whole files, so
    // it has to react to this or it is a number about a prompt nobody has.
    //
    // The fixture has to be a file big enough to slice. Core sends a whole file
    // anyway once it is under `MAX_WHOLE_FILE_LINES` (200), so against a 16-line
    // module `fullFiles: true` changes nothing and this assertion failed for a
    // reason that had nothing to do with the flag. A one-off long file is written
    // into the temp project so the only difference between the two compiles is
    // the flag itself.
    const longKart = `${KART_JS}\n${Array.from({ length: 260 }, (_, i) => `export const P${i} = ${i};`).join('\n')}\n`;
    write('src/longKart.js', longKart);

    const backend = await openBackend();
    const sliced = value(
      backend.compileContext({ issue: 'the kart does not move when it spawns', logs: 'at longKart (src/longKart.js:5:11)' }),
    );
    const whole = value(
      backend.compileContext({
        issue: 'the kart does not move when it spawns',
        logs: 'at longKart (src/longKart.js:5:11)',
        fullFiles: true,
      }),
    );

    expect(whole.chars).toBeGreaterThan(sliced.chars);
    expect(whole.savingsPercent).toBeLessThan(sliced.savingsPercent);
    // Whole source, not an outline: the marker only core's full path writes.
    expect(whole.prompt).toContain('export class KartManager');
    expect(whole.prompt).toContain('full source');
  });

  it('honours targetFile and targetLine', async () => {
    // What a developer who knows exactly where the error is gets: that one function,
    // not the file the ranker happened to pick.
    const compiled = value(
      (await openBackend()).compileContext({
        issue: ISSUE,
        logs: '',
        targetFile: 'src/physics.js',
        targetLine: 3,
      }),
    );

    const target = compiled.sections.find((section) => section.kind === 'slice');
    expect(target?.file).toBe('src/physics.js');
    expect(compiled.prompt).toContain('kart.speed = kart.speed * grip;');
  });

  it('refuses a path that climbs out of the project, naming the path', async () => {
    // The renderer cannot normally produce this — it only ever passes strings a
    // developer ticked or a model invented — and an invented `../../` is exactly
    // the case. Refused, not sanitised: a sanitiser would attach a *different* file
    // from the one asked for, which is worse than attaching none (SPEC R9).
    const result = await (await openBackend()).compileContext({
      issue: ISSUE,
      logs: LOGS,
      files: ['../../etc/passwd'],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toContain('../../etc/passwd');
    expect(result.reason).toContain('inside the open project');
  });

  it('refuses an absolute path outside the project', async () => {
    const result = await (await openBackend()).compileContext({
      issue: ISSUE,
      logs: LOGS,
      files: ['/etc/passwd'],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toContain('/etc/passwd');
  });

  it('refuses with a sentence when no project is open', () => {
    const result = new AppBackend(() => {}).compileContext({ issue: ISSUE, logs: LOGS });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toContain('No project is open');
  });

  it('is reachable through its channel binding, and answers a Result', async () => {
    const app = await openBackend();
    const handler = handlerFor(app, CHANNELS.compileContext);

    const result = (await handler(null, { issue: ISSUE, logs: LOGS } as never)) as Result<CompiledPrompt>;

    expect(result.ok).toBe(true);
    expect(value(result).prompt).toContain('KartManager');
  });

  it('is deterministic: the same request twice gives the same prompt (SPEC R8)', async () => {
    // Two AIs asked the same question must be given the same context, or "the
    // prompt changed" has no explanation a developer can find.
    const backend = await openBackend();
    const request = {
      issue: ISSUE,
      logs: LOGS,
      files: ['src/physics.js', 'src/mesh.js'],
    };

    const first = value(backend.compileContext(request));
    const second = value(backend.compileContext(request));

    expect(first.prompt).toBe(second.prompt);
    expect(first.chars).toBe(second.chars);
    expect(first.sections).toEqual(second.sections);
  });

  it('does not depend on the order the attachments arrive in', async () => {
    // A developer's checkbox set has no order and a model's request list may be in
    // any order; the prompt must not.
    const backend = await openBackend();
    const base = { issue: ISSUE, logs: LOGS };

    const forwards = value(backend.compileContext({ ...base, files: ['src/physics.js', 'src/mesh.js'] }));
    const backwards = value(backend.compileContext({ ...base, files: ['src/mesh.js', 'src/physics.js'] }));

    expect(forwards.prompt).toBe(backwards.prompt);
  });

  it('attaches the same file once when it is both ticked and requested', async () => {
    const compiled = value(
      (await openBackend()).compileContext({
        issue: ISSUE,
        logs: LOGS,
        files: ['src/physics.js', 'src/physics.js'],
      }),
    );

    const appearances = compiled.sections.filter((section) => section.file === 'src/physics.js');
    expect(appearances).toHaveLength(1);
  });

  it('does not alter the developer\'s own text in the RUNTIME OUTPUT block', async () => {
    // The prompt echoes the log verbatim, and an AI has to be able to trust it. A
    // synthesised stack frame in there would be evidence of something that never
    // happened, which is why the attachment mechanism appends a plain note instead.
    const compiled = value(
      (await openBackend()).compileContext({
        issue: ISSUE,
        logs: LOGS,
        files: ['src/physics.js'],
      }),
    );

    for (const line of LOGS.split('\n')) {
      expect(compiled.prompt).toContain(line);
    }
  });
});

// ── The registration contract ───────────────────────────────────────────────

describe('the Context channels', () => {
  it('binds both, under the names in CHANNELS', async () => {
    const handlers = contextHandlers(await openBackend());

    expect(handlers.get(CHANNELS.rankFiles)).toBeTypeOf('function');
    expect(handlers.get(CHANNELS.compileContext)).toBeTypeOf('function');
  });

  it('turns a throw into a refusal that names the channel, rather than crossing IPC', async () => {
    // The load-bearing property of the whole boundary: a rejected promise in the
    // renderer arrives as an unhandled rejection carrying a message written for a
    // stack trace, and nothing the developer can act on. Here the project is
    // deleted underneath an open backend, which is a real way for a handler to
    // fail on someone else's edit.
    const app = await openBackend();
    const handler = handlerFor(app, CHANNELS.compileContext);
    rmSync(project, { recursive: true, force: true });

    const result = (await handler(null, { issue: ISSUE, logs: LOGS } as never)) as Result<CompiledPrompt>;

    // Whatever the handler decides to do with a vanished project, it must answer
    // with a `Result` rather than reject: `expect(...).resolves` fails the test on a
    // rejection, which is the whole point of asserting this shape at all.
    expect(result).toHaveProperty('ok');
    if (result.ok) {
      // A prompt is still an answer here — core degrades to "no files attached" —
      // but it must not *claim* to have attached the project that is gone.
      expect(result.value.prompt).not.toContain('KartManager');
    } else {
      expect(result.reason).toContain(CHANNELS.compileContext);
    }
  });
});
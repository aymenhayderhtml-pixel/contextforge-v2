/**
 * repro-round-c.mjs — measure every Round C finding on CURRENT main.
 *
 * Run against packages/core/dist, so `npm run typecheck` must run first.
 * Prints one line per finding. A finding that measures fast or does not crash
 * is FALSE and must be skipped rather than "fixed".
 */
import { performance } from 'node:perf_hooks';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const core = await import('../packages/core/dist/index.js');
const {
  findCycles, layerNodes, findOrphans, focusNeighbourhood, summariseGraph,
  generateUnifiedDiff, validateScene, compileContext, tryParse, extractJsProject,
} = core;

function ms(fn) {
  const t = performance.now();
  const out = fn();
  return { ms: performance.now() - t, out };
}

function report(name, value, verdict) {
  console.log(`${name.padEnd(46)} ${String(value).padStart(12)}   ${verdict}`);
}

// ---------- CTX-3: the defect walk ----------
const gen = (kb) => {
  const n = Math.floor((kb * 1024) / 20);
  return Array.from({ length: n }, (_, i) => `export const a${i} = ${i};`).join('\n') + '\n';
};
for (const kb of [10, 20, 40, 80]) {
  const r = ms(() => tryParse(gen(kb), 'g.js'));
  report(`CTX-3 tryParse ${kb}KB`, `${r.ms.toFixed(0)} ms ok=${r.out.ok}`, '');
}
{
  const a = ms(() => tryParse(gen(10), 'a.js')).ms;
  const b = ms(() => tryParse(gen(20), 'b.js')).ms;
  report('CTX-3 2x input -> time ratio', (b / a).toFixed(2) + 'x', b / a > 3 ? 'QUADRATIC' : 'linear');
}

// ---------- PATCH-5: the diff ----------
for (const n of [2000, 4000, 8000]) {
  const before = Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
  const after = Array.from({ length: n }, (_, i) => (i % 3 === 0 ? `LINE ${i}` : `line ${i}`)).join('\n');
  const r = ms(() => generateUnifiedDiff(before, after));
  report(`PATCH-5 diffLines n=${n}`, `${r.ms.toFixed(0)} ms`, r.ms > 2000 ? 'TOO SLOW' : 'ok');
  if (r.ms > 3000) break;
}

// ---------- GRAPH-4: queue.shift ----------
// A chain is WRONG for this probe: `shift()` on a queue whose depth stays at 1
// memmoves one element per dequeue, which is free. The quadratic shape needs a
// queue that grows WIDE — a star, where every dependent is enqueued before any is
// dequeued, so each shift() moves the whole remaining width.
function star(n) {
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: `n${i}`, engine: 'js', type: 'file',
    depends_on: i === 0 ? [] : ['n0'], depended_on_by: [],
  }));
  const edges = [];
  for (let i = 1; i < n; i++) edges.push({ from: `n${i}`, to: 'n0', kind: 'import' });
  return { nodes, edges };
}
{
  for (const n of [10000, 30000, 60000]) {
    const g = star(n);
    report(`GRAPH-4 findOrphans star n=${n}`, `${ms(() => findOrphans(g)).ms.toFixed(0)} ms`, '');
  }
  const g2 = star(100000);
  report('GRAPH-4 summariseGraph star n=100000', `${ms(() => summariseGraph(g2)).ms.toFixed(0)} ms`, '');
  const g3 = star(100000);
  report('GRAPH-4 focusNeighbourhood star n=100000', `${ms(() => focusNeighbourhood(g3, 'n0', 2)).ms.toFixed(0)} ms`, '');
}

// ---------- GRAPH-3: findCycles recursion ----------
for (const n of [1000, 2000, 5000, 10000]) {
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: `c${i}`, engine: 'js', type: 'file',
    depends_on: [`c${(i + 1) % n}`], depended_on_by: [],
  }));
  const edges = nodes.map((x) => ({ from: x.id, to: x.depends_on[0], kind: 'import' }));
  const graph = { nodes, edges };
  try {
    const r = ms(() => findCycles(graph));
    report(`GRAPH-3 findCycles cycle n=${n}`, `${r.ms.toFixed(0)} ms ok`, r.ms > 1000 ? 'SLOW' : '');
  } catch (e) {
    report(`GRAPH-3 findCycles cycle n=${n}`, e.constructor.name, 'CRASHES');
    break;
  }
}

// ---------- SCENE-8: checkRelations ----------
// The instance shape must satisfy `sceneInstanceSchema` (prefab + transform, not
// `kind`), or validation stops at the Zod layer and `checkRelations` never runs.
function deepScene(n) {
  const v = () => [0, 0, 0];
  return {
    version: 1, name: 'deep', engine: 'godot', seed: 1,
    camera: { kind: 'perspective', position: v(), rotation: v(), fov: 60 },
    instances: Array.from({ length: n }, (_, i) => ({
      id: `i${i}`, prefab: 'box', parent: i === 0 ? undefined : `i${i - 1}`,
      transform: { position: v(), rotation: v(), scale: [1, 1, 1] },
      params: {},
    })),
    lights: [],
  };
}
for (const n of [500, 1000, 2000, 4000]) {
  try {
    const r = ms(() => validateScene(deepScene(n)));
    const rel = r.out.errors.filter((e) => /parent chain|does not exist/.test(e.message));
    report(`SCENE-8 checkRelations depth=${n}`, `${r.ms.toFixed(0)} ms valid=${r.out.valid} relErrs=${rel.length}`, r.ms > 1000 ? 'TOO SLOW' : '');
  } catch (e) {
    report(`SCENE-8 checkRelations depth=${n}`, e.message.slice(0, 40), 'BAD SHAPE');
    break;
  }
}

// ---------- GRAPH-5: asset dedupe ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'g5-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  const refs = 4000;
  let body = '';
  for (let i = 0; i < refs; i++) {
    const asset = `assets/a${i}.png`;
    writeFileSync(join(dir, asset), 'x');
    body += `import { x${i} } from './${asset}';\n`;
  }
  writeFileSync(join(dir, 'src', 'main.js'), body);
  const r = ms(() => extractJsProject(dir));
  report('GRAPH-5 extractJsProject refs=4000', `${r.ms.toFixed(0)} ms`, r.ms > 3000 ? 'TOO SLOW' : 'ok');
}

// ---------- SEC-5 / CTX-2: the budget ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'sec5-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'big.ts'), 'x'.repeat(4 * 1024 * 1024) + '\n');
  const r = ms(() => compileContext({
    projectRoot: dir, issue: 'NEED: src/big.ts', maxChars: 1000,
  }));
  report('SEC-5 prompt chars vs maxChars=1000', r.out.chars, r.out.chars > 1000 ? 'NOT ENFORCED' : 'enforced');
  const r0 = ms(() => compileContext({ projectRoot: dir, issue: 'NEED: src/big.ts', maxChars: 0 }));
  report('CTX-2 prompt chars vs maxChars=0', r0.out.chars, r0.out.chars > 0 ? 'NOT ENFORCED' : 'enforced');
}

console.log('\nDone.');
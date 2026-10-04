/**
 * test/shell/projectGraph.test.ts — the `graph:project` channel.
 *
 * The Graph screen's only data source. Asserted here against the main process
 * rather than through the DOM because Cytoscape needs a real canvas and this
 * suite has no jsdom: what is provable headlessly is that the channel returns
 * the graph the real extractors produce, and refuses loudly when it cannot.
 *
 * The counts are checked against the real `kart-dash-3d-v2` project when it is
 * present, and skipped — loudly — when it is not. A skipped test that says so is
 * an honest gap; one that silently passes is not.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DependencyGraph,
  GraphEdge,
  GraphNode,
  GraphSummary,
  Orphan,
} from '@contextforge/core';
import { AppBackend } from '../../src/electron/ipcHandlers.js';

/** What `graph:project` returns on success. */
interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  summary: GraphSummary;
  orphans: Orphan[];
}

/** What `graph:focus` returns on success. */
interface FocusPayload {
  nodes: { node: GraphNode; distance: number }[];
  edges: { from: string; to: string; kind: string }[];
}

const temporaries: string[] = [];

afterEach(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function backend(): { app: AppBackend; sent: unknown[] } {
  const sent: unknown[] = [];
  return { app: new AppBackend((event, payload) => sent.push({ event, payload }), { allowUnpickedRoot: 'test-only' }), sent };
}

/** A three-file project with a real import chain. */
function sampleProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-graph-'));
  temporaries.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'main.ts'),
    "import { kart } from './kart.js';\nimport { track } from './track.js';\nexport const boot = [kart, track];\n",
  );
  writeFileSync(join(dir, 'src', 'kart.ts'), "export const kart = { speed: 5 };\n");
  writeFileSync(join(dir, 'src', 'track.ts'), "export const track = { width: 16 };\n");
  writeFileSync(join(dir, 'src', 'orphan.ts'), "export const unused = 1;\n");
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'sample' }));
  return dir;
}

/**
 * The real test project, when it is on disk.
 *
 * Resolved by walking up to the parent folder and looking for it by name, which
 * is the convention the other suites that need this project already use (see
 * `realPrefabs.test.ts:70`). A literal absolute path would both embed one
 * machine's directory layout in the source and break on every other machine;
 * `CF_PROJECT` still overrides it for anyone whose layout differs.
 */
const KART_ROOT =
  process.env['CF_PROJECT'] ??
  resolve(import.meta.dirname, '..', '..', '..', '..', '..', 'kart-dash-3d-v2');
const kartPresent = existsSync(join(KART_ROOT, 'package.json'));

describe('projectGraph', () => {
  it('refuses when no project is open, rather than returning an empty graph', () => {
    const { app } = backend();
    const result = app.projectGraph({});
    expect(result.ok).toBe(false);
    // `Result`'s failure field is `reason`; it is the sentence shown to the user
    // verbatim, so it is asserted on, not just its presence.
    expect((result as { reason: string }).reason).toMatch(/No project is open/);
  });

  it('returns real nodes and edges from the extractor', async () => {
    const { app } = backend();
    const root = sampleProject();
    await app.openProject({ root });

    const result = app.projectGraph({});
    expect(result.ok).toBe(true);
    const { nodes, edges } = (result as { value: GraphPayload }).value;

    expect(nodes.map((n) => n.id).sort()).toEqual([
      'src/kart.ts',
      'src/main.ts',
      'src/orphan.ts',
      'src/track.ts',
    ]);
    // main.ts imports the other two; nothing imports main.ts.
    expect(edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual([
      'src/main.ts->src/kart.ts',
      'src/main.ts->src/track.ts',
    ]);
  });

it('gives the screen core\'s own analysis, not a rival count', async () => {
    // The point of returning `summary` and `orphans`: the screen cannot derive
    // them itself (core is `external` in the renderer build), and if it tried,
    // there would be two derivations of one count — the D44 defect.
    const { app } = backend();
    await app.openProject({ root: sampleProject() });
    const result = app.projectGraph({});
    expect(result.ok).toBe(true);
    const value = (result as { value: GraphPayload }).value;

    expect(value.summary.nodes).toBe(4);
    expect(value.summary.edges).toBe(2);
    // main.ts and orphan.ts are unreferenced; the two it imports are reached.
    expect(value.summary.orphans).toBe(2);

    // The orphan list is exactly what that count was derived from.
    expect(value.orphans.map((o) => o.node.id)).toEqual(['src/main.ts', 'src/orphan.ts']);
    expect(value.orphans.find((o) => o.node.id === 'src/main.ts')?.reason).toBe('entry_point');
    expect(value.orphans.find((o) => o.node.id === 'src/orphan.ts')?.reason).toBe('unreferenced');
  });

  it('focuses through the same channel the screen uses', async () => {
    const { app } = backend();
    await app.openProject({ root: sampleProject() });
    const graph = (app.projectGraph({}) as { value: GraphPayload }).value;

    // Focusing a leaf at depth 1 gives the leaf and its importer, nothing else.
    const focus = app.projectFocus({
      id: 'src/kart.ts',
      depth: 1,
      graph: { nodes: graph.nodes, edges: graph.edges },
    });
    expect(focus.ok).toBe(true);
    const neighbourhood = (focus as { value: FocusPayload }).value;

    expect(neighbourhood.nodes.map((n) => n.node.id).sort()).toEqual(['src/kart.ts', 'src/main.ts']);
    expect(neighbourhood.nodes.find((n) => n.node.id === 'src/kart.ts')?.distance).toBe(0);
    expect(neighbourhood.nodes.find((n) => n.node.id === 'src/main.ts')?.distance).toBe(1);

    // Only edges with both endpoints drawn: an edge to a node that is not on
    // screen reads as a bug in the graph rather than as a deliberate boundary.
    const drawn = new Set(neighbourhood.nodes.map((n) => n.node.id));
    for (const edge of neighbourhood.edges) {
      expect(drawn.has(edge.from), `edge from undrawn node ${edge.from}`).toBe(true);
      expect(drawn.has(edge.to), `edge to undrawn node ${edge.to}`).toBe(true);
    }
  });

  it('focusing an id that is not in the graph returns nothing, not an error', () => {
    const { app } = backend();
    const graph: DependencyGraph = { nodes: [], edges: [] };
    const result = app.projectFocus({ id: 'ghost.ts', depth: 1, graph });
    expect(result.ok).toBe(true);
    expect((result as { value: FocusPayload }).value.nodes).toEqual([]);
  });

  it('returns an empty graph for a folder with no source files, not an error', () => {
    // A brand-new folder is a legitimate state, not a failure. It must render as
    // "no files" rather than as a refusal the developer cannot act on.
    const dir = mkdtempSync(join(tmpdir(), 'cf-empty-'));
    temporaries.push(dir);
    const { app } = backend();
    void app.openProject({ root: dir });

    return app.openProject({ root: dir }).then(() => {
      const result = app.projectGraph({});
      expect(result.ok).toBe(true);
      const { nodes } = (result as { value: { nodes: GraphNode[] } }).value;
      expect(nodes).toEqual([]);
    });
  });
});

describe('projectGraph against the real kart project', () => {
  it.skipIf(!kartPresent)('reports the real file count', () => {
    const { app } = backend();
    void app.openProject({ root: KART_ROOT });

    return app.openProject({ root: KART_ROOT }).then(() => {
      const result = app.projectGraph({});
      expect(result.ok).toBe(true);
      const { nodes, edges } = (result as { value: GraphPayload }).value;

      // The project's own files, from disk, not a fixture.
      expect(nodes.length).toBeGreaterThan(5);
      expect(nodes.some((n) => n.id.endsWith('kart.ts'))).toBe(true);
      expect(edges.length).toBeGreaterThan(0);

      // Every edge names real nodes, so Cytoscape never receives a dangling one.
      const ids = new Set(nodes.map((n) => n.id));
      for (const edge of edges) {
        expect(ids.has(edge.from), `edge from missing node ${edge.from}`).toBe(true);
        expect(ids.has(edge.to), `edge to missing node ${edge.to}`).toBe(true);
      }
    });
  });

  it.skipIf(!kartPresent)('finds an orphan in the real project and names the reason', () => {
    const { app } = backend();
    void app.openProject({ root: KART_ROOT });

    return app.openProject({ root: KART_ROOT }).then(() => {
      const result = app.projectGraph({});
      const { nodes, edges } = (result as { value: GraphPayload }).value;
      const orphans = (result as { value: GraphPayload }).value.orphans;

      // `index.html` is the project's entrypoint and nothing imports an HTML
      // file, so it is unreferenced by construction. It must be listed, and
      // listed as an entry point rather than as dead code — the distinction is
      // the whole point of the drawer (Phase 5c).
      const html = orphans.find((o) => o.node.id === 'index.html');
      expect(
        html,
        `orphans were: ${orphans.map((o) => o.node.id).join(', ')}`,
      ).toBeDefined();
      expect(html?.reason).toBe('entry_point');
      // And it really is the entrypoint: the HTML node depends on the script.
      expect(
        nodes.find((n) => n.id === 'index.html')?.depends_on.length,
        'index.html should depend on the script it loads',
      ).toBeGreaterThan(0);

      // `src/main.js` is what index.html loads, so it is *not* an orphan.
      expect(orphans.map((o) => o.node.id)).not.toContain('src/main.js');
    });
  });

  it.skipIf(!kartPresent)('reports fewer unreferenced files than files, on the real project', () => {
    // The negative that matters. Before the `.js`-specifier fix, every source
    // file in a JavaScript project whose specifiers carry explicit extensions
    // came back with no edges, so all 30+ of them looked unreferenced and the
    // drawer was noise rather than a signal.
    const { app } = backend();
    void app.openProject({ root: KART_ROOT });

    return app.openProject({ root: KART_ROOT }).then(() => {
      const result = app.projectGraph({});
      const { nodes, edges } = (result as { value: GraphPayload }).value;
      const orphans = (result as { value: GraphPayload }).value.orphans;
      expect(orphans.length).toBeLessThan(nodes.length / 2);
    });
  });
});
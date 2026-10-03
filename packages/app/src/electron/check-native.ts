/**
 * check-native.ts — does tree-sitter work inside Electron's main process?
 *
 * This is the single riskiest assumption in the whole build, so it is checked
 * before anything is written on top of it. Core (SPEC D1) uses *native*
 * tree-sitter bindings because the prebuilt wasm grammar set has no GDScript
 * grammar, and GDScript is half of this app's target engines. Native bindings
 * are compiled against Node's ABI, so the same `.node` file that works under
 * `node` will refuse to load inside Electron unless it has been rebuilt against
 * Electron's headers and linked to the right shared library.
 *
 * Rather than discover that at Step 3, this program does the smallest real
 * version of the job: it loads core's parser in the Electron **main** process
 * and parses one JavaScript and one GDScript string. Not a stub, not a
 * `require` that resolves — actual parses, through the same code path core
 * uses, printing what the trees contain.
 *
 * It runs as a main-process entry point (`electron dist/electron/check-native.js`),
 * so it exercises the main process, not a renderer. Nothing is displayed and no
 * window is opened: this is a headless capability probe.
 *
 * Exit code is the verdict: 0 if both grammars parsed, 1 otherwise, with the
 * failing reason on stderr (SPEC R9 — a tool that cannot verify a result must
 * refuse rather than look successful).
 *
 * Run with `--no-sandbox` (see the package's `check:native` script). Electron's
 * setuid sandbox helper ships unprivileged, so Chromium refuses to start
 * without that flag on a dev machine; it is irrelevant here because the program
 * opens no window and loads no remote content.
 */

import { app } from 'electron';
import { parseJsModule, parseGdScript, tryParse } from '@contextforge/core';

/** The JavaScript sample: a named export and an import, so the tree has shape. */
const JS_SAMPLE = `import { Mesh } from 'three';

export function buildFloor(size) {
  return new Mesh();
}
`;

/** The GDScript sample: a signal, an export, and a function — the three things
 *  the Godot extractor cares about, and the reason we need this grammar. */
const GD_SAMPLE = `extends Node2D

signal died

@export var speed: float = 120.0

func take_damage(amount: int) -> void:
\tdied.emit()
`;

/** One parsed sample, reported in the same shape whether it passed or failed. */
interface CheckResult {
  language: string;
  ok: boolean;
  detail: string;
  rootType: string | null;
}

function checkJavaScript(): CheckResult {
  const outcome = tryParse(JS_SAMPLE, 'sample.js');
  if (!outcome.ok) {
    return {
      language: 'javascript',
      ok: false,
      detail: outcome.line === null ? outcome.message : `${outcome.message} (line ${outcome.line})`,
      rootType: null,
    };
  }

  const contract = parseJsModule(JS_SAMPLE, 'sample.js');
  return {
    language: 'javascript',
    ok: contract.exports.some((e) => e.name === 'buildFloor'),
    detail: `root ${outcome.tree.tree.rootNode.type}; imports: [${contract.imports
      .map((i) => i.specifier)
      .join(', ')}]; exports: [${contract.exports.map((e) => e.name).join(', ')}]`,
    rootType: outcome.tree.tree.rootNode.type,
  };
}

function checkGDScript(): CheckResult {
  const outcome = tryParse(GD_SAMPLE, 'sample.gd');
  if (!outcome.ok) {
    return {
      language: 'gdscript',
      ok: false,
      detail: outcome.line === null ? outcome.message : `${outcome.message} (line ${outcome.line})`,
      rootType: null,
    };
  }

  const contract = parseGdScript(GD_SAMPLE, 'sample.gd');
  return {
    language: 'gdscript',
    ok:
      contract.signals.some((s) => s.name === 'died') &&
      contract.publicFunctions.some((f) => f.name === 'take_damage'),
    detail: `root ${outcome.tree.tree.rootNode.type}; signals: [${contract.signals
      .map((s) => s.name)
      .join(', ')}]; exports: [${contract.exports.map((e) => e.name).join(', ')}]; functions: [${contract.publicFunctions
      .map((f) => f.name)
      .join(', ')}]`,
    rootType: outcome.tree.tree.rootNode.type,
  };
}

function main(): void {
  let results: CheckResult[] = [];
  let fatal: string | null = null;

  try {
    results = [checkJavaScript(), checkGDScript()];
  } catch (error) {
    // A load failure surfaces here as a thrown module-level import error. The
    // usual cause is a tree-sitter .node compiled against Node's headers rather
    // than Electron's — the exact thing this check exists to catch.
    fatal = error instanceof Error ? error.message : String(error);
  }

  if (fatal !== null) {
    process.stderr.write(
      'ELECTRON NATIVE TREE-SITTER CHECK: FAILED\n\n' +
        "Could not load core's parsers inside the Electron main process.\n\n" +
        `${fatal}\n\n` +
        'If the message mentions NODE_MODULE_VERSION, a .node ABI, or dlopen,\n' +
        'the native modules are built for Node, not Electron. Fix with:\n' +
        '  npm run rebuild:native -w @contextforge/app\n'
    );
    app.exit(1);
    return;
  }

  const failed = results.filter((r) => !r.ok);

  for (const result of results) {
    const mark = result.ok ? 'ok  ' : 'FAIL';
    process.stdout.write(`  [${mark}] ${result.language.padEnd(11)} ${result.detail}\n`);
  }

  if (failed.length > 0) {
    process.stderr.write(
      `\nELECTRON NATIVE TREE-SITTER CHECK: FAILED — ${failed.length} of ${results.length} grammar(s) did not parse.\n`
    );
    app.exit(1);
    return;
  }

  process.stdout.write(
    '\nELECTRON NATIVE TREE-SITTER CHECK: PASSED — javascript and gdscript both parse in the Electron main process.\n'
  );
  app.exit(0);
}

app.whenReady().then(main);

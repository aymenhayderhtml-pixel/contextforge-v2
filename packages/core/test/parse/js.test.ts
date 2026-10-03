import { describe, expect, it } from 'vitest';
import { parseJsModule, jsContractExports } from '../../src/parse/js.js';

describe('parseJsModule — exports', () => {
  it('reads functions, classes and variables', () => {
    const contract = parseJsModule(
      [
        'export function startGame() {}',
        'export class Player {}',
        'export const GAME_VERSION = "0.1.0";',
      ].join('\n'),
      'main.js',
    );
    const names = jsContractExports(contract);
    expect(names).toContain('function startGame()');
    expect(names).toContain('class Player');
    expect(names).toContain('const GAME_VERSION');
  });

  it('reads an export whose declaration spans several lines', () => {
    // A regex reading `^export\s+function` only sees the first line, so the
    // parameter list on the next line is lost — here the whole binding is.
    const contract = parseJsModule(
      'export function deferred(\n  a,\n  b\n) {}\n',
      'a.js',
    );
    expect(jsContractExports(contract)).toContain('function deferred(a, b)');
  });

  it('reads a destructuring export as the bindings it declares', () => {
    const contract = parseJsModule('export const { a, b } = config;\n', 'a.js');
    const names = jsContractExports(contract);
    expect(names).toContain('const a');
    expect(names).toContain('const b');
  });

  it('reads a named export list with an alias', () => {
    const contract = parseJsModule(
      "const a = 1;\nconst b = 2;\nexport { a, b as c };\n",
      'a.js',
    );
    const names = jsContractExports(contract);
    expect(names).toContain('a');
    expect(names).toContain('b as c');
  });

  it('reads a default export, whether anonymous or a named reference', () => {
    expect(jsContractExports(parseJsModule('export default function main() {}', 'a.js')))
      .toContain('default function main()');
    expect(jsContractExports(parseJsModule('const v = {};\nexport default v;', 'a.js')))
      .toContain('default v');
  });

  it('reads a re-export list and a star re-export', () => {
    const contract = parseJsModule(
      ["export { helper } from './helper.js';", "export * from './all.js';"].join('\n'),
      'a.js',
    );
    const names = jsContractExports(contract);
    expect(names).toContain('helper');
    expect(names).toContain('*');
  });

  it('ignores the word export inside a comment', () => {
    // A regex reading line starts would report a phantom export here.
    const contract = parseJsModule(
      ['// export function fake() {}', '/* export class Ghost {} */', 'export const real = 1;'].join('\n'),
      'a.js',
    );
    const names = jsContractExports(contract);
    expect(names).toEqual(['const real']);
  });

  it('deduplicates an export declared then re-listed', () => {
    const contract = parseJsModule(
      'export const dup = 1;\nexport { dup };\n',
      'a.js',
    );
    const names = jsContractExports(contract);
    expect(names.filter((n) => n.includes('dup'))).toEqual(['const dup']);
  });

  it('captures parameter list and TypeScript return type', () => {
    const contract = parseJsModule(
      'export function load(path: string): Promise<string> { return path; }',
      'a.ts',
    );
    const names = jsContractExports(contract);
    expect(names[0]).toContain('function load(');
    expect(names[0]).toContain('Promise<string>');
  });
});

describe('parseJsModule — imports', () => {
  it('reads named, default, namespace and side-effect imports', () => {
    const contract = parseJsModule(
      [
        "import { a, b as c } from './one.js';",
        "import d from './two.js';",
        "import * as ns from './three.js';",
        "import './four.js';",
      ].join('\n'),
      'main.js',
    );
    expect(contract.imports.map((i) => i.specifier)).toEqual([
      './one.js',
      './two.js',
      './three.js',
      './four.js',
    ]);
    expect(contract.imports[0]?.names).toEqual(['a', 'b as c']);
    expect(contract.imports[2]?.names).toEqual(['* as ns']);
  });

  it('reads a dynamic import() as a dependency', () => {
    const contract = parseJsModule("const m = await import('./lazy.js');", 'main.js');
    expect(contract.imports.map((i) => i.specifier)).toEqual(['./lazy.js']);
    expect(contract.imports[0]?.isNamespaceOrSideEffect).toBe(true);
  });
});

describe('parseJsModule — asset references', () => {
  it('finds asset paths in string literals', () => {
    const contract = parseJsModule(
      [
        "loadModel('models/character.glb');",
        'loadTexture("textures/wood.png");',
      ].join('\n'),
      'asset-loader.js',
    );
    expect(contract.assetRefs).toEqual(['models/character.glb', 'textures/wood.png']);
  });

  it('does not treat an asset path inside a comment as a dependency', () => {
    const contract = parseJsModule("// loadModel('models/ghost.glb')\n", 'a.js');
    expect(contract.assetRefs).toEqual([]);
  });

  it('ignores non-asset string literals', () => {
    const contract = parseJsModule("const name = 'Player.tscn';", 'a.js');
    expect(contract.assetRefs).toEqual([]);
  });
});

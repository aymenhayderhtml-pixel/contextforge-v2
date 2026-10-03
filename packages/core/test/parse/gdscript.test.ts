import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  formatGdExport,
  formatGdFunction,
  formatGdSignal,
  parseGdScript,
} from '../../src/parse/gdscript.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (rel: string): string =>
  readFileSync(join(here, '..', '..', 'test-fixtures', rel), 'utf-8');

describe('parseGdScript — signals and exports', () => {
  const source = [
    'extends CharacterBody2D',
    '',
    'signal died()',
    'signal health_changed(new_value: int)',
    '',
    '@export var speed: float = 200.0',
    '@export var jump_force: float = 400.0',
    '@export_range(0, 10) var ratio: float = 1.0',
    'export var legacy: int = 3',
    '',
    'var health: int = 100',
  ].join('\n');

  it('reads signal declarations with their parameter lists', () => {
    const contract = parseGdScript(source, 'Player.gd');
    const signals = contract.signals.map(formatGdSignal);
    expect(signals).toContain('died()');
    expect(signals).toContain('health_changed(new_value: int)');
  });

  it('reads @export vars', () => {
    const contract = parseGdScript(source, 'Player.gd');
    const exports = contract.exports.map(formatGdExport);
    expect(exports).toContain('speed: float');
    expect(exports).toContain('jump_force: float');
  });

  it('reads @export_range with arguments', () => {
    const contract = parseGdScript(source, 'Player.gd');
    const ratio = contract.exports.find((e) => e.name === 'ratio');
    expect(ratio).toBeDefined();
    expect(ratio?.annotation).toBe('@export_range(0, 10)');
  });

  it('reads Godot 3 style export(Type) var', () => {
    const contract = parseGdScript(source, 'Player.gd');
    const legacy = contract.exports.find((e) => e.name === 'legacy');
    expect(legacy?.type).toBe('int');
    expect(legacy?.annotation).toBe('export');
  });

  it('does not treat a plain var as exported', () => {
    const contract = parseGdScript(source, 'Player.gd');
    expect(contract.exports.some((e) => e.name === 'health')).toBe(false);
  });
});

describe('parseGdScript — functions', () => {
  it('excludes underscore-prefixed functions from the public contract', () => {
    const contract = parseGdScript(
      [
        'func take_damage(amount: int) -> void:',
        '\tpass',
        '',
        'func get_health() -> int:',
        '\treturn 1',
        '',
        'func _process(delta: float) -> void:',
        '\tpass',
        '',
        'func _physics_process(delta: float) -> void:',
        '\tpass',
      ].join('\n'),
      'Player.gd',
    );
    const names = contract.publicFunctions.map(formatGdFunction);
    expect(names).toContain('take_damage(amount: int) -> void');
    expect(names).toContain('get_health() -> int');
    expect(names.some((n) => n.includes('_process'))).toBe(false);
    expect(names.some((n) => n.includes('_physics_process'))).toBe(false);
  });

  it('defaults an unannotated return type to void', () => {
    const contract = parseGdScript('func ping():\n\tpass\n', 'a.gd');
    expect(contract.publicFunctions[0]?.returnType).toBe('void');
  });

  it('does not report a nested function as file-level API', () => {
    // A line-based scanner with an indentation heuristic would include this.
    const contract = parseGdScript(
      ['func outer() -> void:', '\tfunc helper() -> void:', '\t\tpass', '', '\tpass'].join('\n'),
      'a.gd',
    );
    expect(contract.publicFunctions.map((f) => f.name)).toEqual(['outer']);
  });

  it('does not report members of an inner class as file-level API', () => {
    const contract = parseGdScript(
      ['class Inner:', '\tvar x = 1', '\tfunc run() -> void:', '\t\tpass'].join('\n'),
      'a.gd',
    );
    expect(contract.publicFunctions).toEqual([]);
  });
});

describe('parseGdScript — constants, enums, identifiers', () => {
  it('reads top-level constants and enums, skipping private ones', () => {
    const contract = parseGdScript(
      [
        'const MAX: int = 10',
        'const _HIDDEN: int = 1',
        'enum Kind { A, B }',
        'enum _Private { X }',
      ].join('\n'),
      'a.gd',
    );
    expect(contract.constants.map((c) => c.name)).toEqual(['MAX']);
    expect(contract.enums.map((e) => e.name)).toEqual(['Kind']);
  });

  it('treats an inferred const type as Variant', () => {
    const contract = parseGdScript('const MAX := 10\n', 'a.gd');
    expect(contract.constants[0]?.type).toBe('Variant');
  });

  it('finds an autoload referenced as a global', () => {
    const contract = parseGdScript(
      ['func add() -> void:', '\tGameManager.add_score(1)', '\tpass'].join('\n'),
      'a.gd',
    );
    expect(contract.referencedIdentifiers).toContain('GameManager');
  });

  it('does not treat an autoload name inside a comment or string as a reference', () => {
    const contract = parseGdScript(
      [
        '# GameManager is not used here',
        'var label: String = "GameManager"',
      ].join('\n'),
      'a.gd',
    );
    expect(contract.referencedIdentifiers).not.toContain('GameManager');
  });
});

describe('parseGdScript — against the godot-sample fixture', () => {
  it('reads Player.gd exactly as the contract the old extractor produced', () => {
    const contract = parseGdScript(fixture('godot-sample/scripts/Player.gd'), 'Player.gd');

    expect(contract.signals.map(formatGdSignal).sort()).toEqual([
      'died()',
      'health_changed(new_value: int)',
    ]);

    const exportNames = contract.exports.map((e) => e.name).sort();
    expect(exportNames).toEqual(['jump_force', 'speed']);

    const funcNames = contract.publicFunctions.map((f) => f.name).sort();
    expect(funcNames).toEqual(['get_health', 'take_damage']);
  });

  it('reads GameManager.gd as having no exports', () => {
    const contract = parseGdScript(
      fixture('godot-sample/scripts/GameManager.gd'),
      'GameManager.gd',
    );
    expect(contract.exports).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  parseTscn,
  resToRelative,
  rootScriptId,
  TscnParseError,
} from '../../src/parse/tscn.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (rel: string): string =>
  readFileSync(join(here, '..', '..', 'test-fixtures', rel), 'utf-8');

describe('parseTscn — headers', () => {
  it('reads the [gd_scene] header', () => {
    const doc = parseTscn('[gd_scene load_steps=2 format=3 uid="uid://player001"]\n');
    expect(doc.header['format']).toBe('3');
    expect(doc.header['load_steps']).toBe('2');
    expect(doc.header['uid']).toBe('uid://player001');
  });

  it('reads ext_resource headers and converts res:// paths', () => {
    const doc = parseTscn(
      [
        '[gd_scene load_steps=2 format=3]',
        '[ext_resource type="Script" path="res://scripts/Player.gd" id="1_abc"]',
      ].join('\n'),
    );
    expect(doc.extResources).toHaveLength(1);
    expect(doc.extResources[0]).toMatchObject({
      id: '1_abc',
      type: 'Script',
      rawPath: 'res://scripts/Player.gd',
      path: 'scripts/Player.gd',
    });
  });

  it('reads sub_resource headers', () => {
    const doc = parseTscn(
      [
        '[gd_scene format=3]',
        '[sub_resource type="CapsuleShape2D" id="Shape_1"]',
      ].join('\n'),
    );
    expect(doc.subResources).toEqual([{ type: 'CapsuleShape2D', id: 'Shape_1' }]);
    expect(doc.extResources).toEqual([]);
  });
});

describe('parseTscn — nodes', () => {
  it('reads a node with a type and no parent (the root)', () => {
    const doc = parseTscn(
      [
        '[gd_scene format=3]',
        '[node name="Player" type="CharacterBody2D"]',
        'script = ExtResource("1_abc")',
      ].join('\n'),
    );
    expect(doc.nodes).toHaveLength(1);
    expect(doc.nodes[0]).toMatchObject({
      name: 'Player',
      type: 'CharacterBody2D',
      parent: null,
    });
  });

  it('reads child nodes with a parent reference', () => {
    const doc = parseTscn(
      [
        '[gd_scene format=3]',
        '[node name="Player" type="CharacterBody2D"]',
        '[node name="CollisionShape2D" type="CollisionShape2D" parent="."]',
      ].join('\n'),
    );
    expect(doc.nodes).toHaveLength(2);
    expect(doc.nodes[1]).toMatchObject({
      name: 'CollisionShape2D',
      type: 'CollisionShape2D',
      parent: '.',
    });
  });

  it('reads an instanced sub-scene node and resolves its ExtResource id', () => {
    const doc = parseTscn(
      [
        '[gd_scene format=3]',
        '[ext_resource type="PackedScene" path="res://scenes/Player.tscn" id="1_p"]',
        '[node name="Level1" type="Node2D"]',
        '[node name="Player" parent="." instance=ExtResource("1_p")]',
        'position = Vector2(100, 300)',
      ].join('\n'),
    );
    const instanced = doc.nodes[1];
    expect(instanced?.name).toBe('Player');
    expect(instanced?.type).toBeNull();
    expect(instanced?.instanceOf).toBe('1_p');
    expect(instanced?.properties['position']).toBe('Vector2(100, 300)');
  });

  it('collects property assignments under the node they belong to', () => {
    const doc = parseTscn(
      [
        '[gd_scene format=3]',
        '[node name="A" type="Node2D"]',
        'position = Vector2(1, 2)',
        '[node name="B" type="Node2D"]',
        'visible = false',
      ].join('\n'),
    );
    expect(doc.nodes[0]?.properties).toEqual({ position: 'Vector2(1, 2)' });
    expect(doc.nodes[1]?.properties).toEqual({ visible: 'false' });
  });

  it('records the line each node header was found on', () => {
    const doc = parseTscn(
      ['[gd_scene format=3]', '[node name="A" type="Node2D"]'].join('\n'),
    );
    expect(doc.nodes[0]?.line).toBe(2);
  });
});

describe('parseTscn — connections', () => {
  it('reads [connection] blocks', () => {
    const doc = parseTscn(
      [
        '[gd_scene format=3]',
        '[connection signal="died" from="Player" to="." method="_on_player_died"]',
        '[connection signal="defeated" from="Enemy" to="." method="_on_enemy_defeated"]',
      ].join('\n'),
    );
    expect(doc.connections).toEqual([
      { signal: 'died', from: 'Player', to: '.', method: '_on_player_died', binds: null },
      {
        signal: 'defeated',
        from: 'Enemy',
        to: '.',
        method: '_on_enemy_defeated',
        binds: null,
      },
    ]);
  });

  it('reads a connection with a binds= ExtResource reference', () => {
    const doc = parseTscn(
      [
        '[gd_scene format=3]',
        '[ext_resource type="Script" path="res://scripts/H.gd" id="1_h"]',
        '[connection signal="pressed" from="Btn" to="." method="_on_p" binds=ExtResource("1_h")]',
      ].join('\n'),
    );
    expect(doc.connections[0]?.binds).toBe('1_h');
  });
});

describe('parseTscn — robustness', () => {
  it('does not end a section at a ] inside a quoted value', () => {
    const doc = parseTscn(
      [
        '[gd_scene format=3]',
        '[ext_resource type="Script" path="res://a]b.gd" id="1"]',
        '[node name="N" type="Node"]',
      ].join('\n'),
    );
    expect(doc.extResources[0]?.path).toBe('a]b.gd');
    expect(doc.nodes).toHaveLength(1);
  });

  it('keeps a quoted value containing a space intact', () => {
    const doc = parseTscn('[gd_scene format=3 uid="uid://a b c"]\n');
    expect(doc.header['uid']).toBe('uid://a b c');
  });

  it('ignores comments', () => {
    const doc = parseTscn(
      [
        '; leading comment',
        '[gd_scene format=3]',
        '; another comment',
        '[node name="A" type="Node"]',
      ].join('\n'),
    );
    expect(doc.nodes).toHaveLength(1);
  });

  it('reports an unclosed section header with its line', () => {
    try {
      parseTscn('[gd_scene format=3]\n[ext_resource type="Script"\n');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TscnParseError);
      expect((error as TscnParseError).line).toBe(2);
    }
  });

  it('refuses a file with no [gd_scene] header', () => {
    expect(() => parseTscn('[node name="A" type="Node"]\n')).toThrow(/gd_scene/);
  });

  it('reports an ext_resource missing its path', () => {
    expect(() =>
      parseTscn('[gd_scene format=3]\n[ext_resource type="Script" id="1"]\n'),
    ).toThrow(/path/);
  });
});

describe('parseTscn — resToRelative', () => {
  it('strips the res:// prefix', () => {
    expect(resToRelative('res://scripts/Player.gd')).toBe('scripts/Player.gd');
  });

  it('leaves a plain path untouched', () => {
    expect(resToRelative('scripts/Player.gd')).toBe('scripts/Player.gd');
  });
});

describe('parseTscn — against the godot-sample fixtures', () => {
  it('reads Player.tscn and finds its root script', () => {
    const doc = parseTscn(fixture('godot-sample/scenes/Player.tscn'), 'Player.tscn');
    expect(doc.extResources.map((r) => r.path)).toEqual(['scripts/Player.gd']);
    expect(rootScriptId(doc)).toBe('1_abc');
    expect(doc.nodes.map((n) => n.name)).toEqual([
      'Player',
      'CollisionShape2D',
      'Sprite2D',
    ]);
  });

  it('reads Level1.tscn with two instances and two connections', () => {
    const doc = parseTscn(fixture('godot-sample/scenes/Level1.tscn'), 'Level1.tscn');
    expect(doc.extResources.map((r) => r.path).sort()).toEqual([
      'scenes/Enemy.tscn',
      'scenes/Player.tscn',
    ]);
    expect(doc.nodes.filter((n) => n.instanceOf !== null)).toHaveLength(2);
    expect(doc.connections).toHaveLength(2);
    expect(doc.connections[0]?.signal).toBe('died');
  });
});

/**
 * parse/tscn.ts — A hand-written `.tscn` parser (SPEC R5, §4.3).
 *
 * `.tscn` is Godot's text scene format. There is no maintained tree-sitter
 * grammar for it, so v2 writes its own rather than falling back to regex —
 * v1 swept the file with `/^\[ext_resource\s+(.+)\]/gm`, which breaks the moment
 * a path or attribute value contains the character the pattern is anchored on.
 *
 * The format is line-oriented with sections in square brackets, so a real
 * tokenizer is small:
 *
 *     [gd_scene load_steps=3 format=3]
 *     [ext_resource type="Script" path="res://scripts/Player.gd" id="1_abc"]
 *     [node name="Player" type="CharacterBody2D"]
 *     script = ExtResource("1_abc")
 *     [node name="Hero" parent="." instance=ExtResource("1_p")]
 *     [connection signal="died" from="Player" to="." method="_on_died"]
 *
 * Three things this parser gets right that a regex does not:
 *   - `]` and quotes inside a quoted value do not end the section;
 *   - `sub_resource` sections are read as resources, not mistaken for headers;
 *   - `ExtResource("id")` references are resolved to the resource they name,
 *     so a scene can be built without a second pass.
 */

/** An `[ext_resource ...]` header: a file this scene depends on. */
export interface TscnExtResource {
  /** The Godot-assigned id, e.g. "1_abc". */
  id: string;
  /** Resource type, e.g. "Script", "PackedScene", "Texture2D". */
  type: string;
  /** Path as written, e.g. "res://scripts/Player.gd". */
  rawPath: string;
  /** Path converted to project-relative form, e.g. "scripts/Player.gd". */
  path: string;
}

/** A `[sub_resource ...]` header: a resource defined inline in this scene. */
export interface TscnSubResource {
  type: string;
  id: string;
}

/** A `[node ...]` header: one node in the scene tree. */
export interface TscnNode {
  name: string;
  /**
   * Godot node class, e.g. "CharacterBody2D".
   *
   * This is the *engine's* type name, not the graph's `NodeType` — a `.tscn`
   * node's class says nothing about whether it is a scene, script or asset in
   * the dependency graph. Null for an instanced sub-scene node, which has no
   * class of its own.
   */
  type: string | null;
  /** Parent node name, or "." for a root child. Null when omitted. */
  parent: string | null;
  /** Id of the ext_resource this node instances, when it is an instance. */
  instanceOf: string | null;
  /** Raw property assignments that followed the header. */
  properties: Record<string, string>;
  /** 1-based line the header appeared on. */
  line: number;
}

/** A `[connection ...]` block: a signal wired to a method. */
export interface TscnConnection {
  signal: string;
  /** Emitting node name, or "." for the scene root. */
  from: string;
  /** Receiving node name, or "." for the scene root. */
  to: string;
  method: string;
  /** Id of the ext_resource this connection is bound to, if any. */
  binds: string | null;
}

/** A parsed `.tscn` document. */
export interface TscnDocument {
  /** Attributes of the `[gd_scene ...]` header. */
  header: Record<string, string>;
  extResources: TscnExtResource[];
  subResources: TscnSubResource[];
  nodes: TscnNode[];
  connections: TscnConnection[];
}

/** A parse failure, carrying the position so the message can be acted on. */
export class TscnParseError extends Error {
  readonly line: number;
  readonly column: number;
  readonly filePath: string;

  constructor(message: string, filePath: string, line: number, column: number) {
    super(`${filePath}:${line}:${column} — ${message}`);
    this.name = 'TscnParseError';
    this.filePath = filePath;
    this.line = line;
    this.column = column;
  }
}

/** Convert a `res://` path to a project-relative path. */
export function resToRelative(resPath: string): string {
  return resPath.startsWith('res://') ? resPath.slice('res://'.length) : resPath;
}

/**
 * Parse `.tscn` source text.
 *
 * Throws `TscnParseError` on malformed input. A half-parsed scene would produce
 * a dependency graph with missing edges, and an AI would then be told a
 * dependency does not exist when it does (SPEC R9).
 */
export function parseTscn(source: string, filePath = '<memory>'): TscnDocument {
  const scene: TscnDocument = {
    header: {},
    extResources: [],
    subResources: [],
    nodes: [],
    connections: [],
  };

  const lines = source.split(/\r?\n/);
  let currentNode: TscnNode | null = null;
  let sawSceneHeader = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    // Property assignments and comments.
    if (!sawSceneHeader || trimmed === '') {
      if (trimmed.startsWith(';')) continue;
    } else if (trimmed.startsWith(';')) {
      continue;
    }

    if (trimmed.startsWith('[')) {
      const closing = findSectionEnd(trimmed);
      if (closing === -1) {
        throw new TscnParseError(
          `Unclosed section header: ${trimmed}`,
          filePath,
          i + 1,
          1,
        );
      }

      const body = trimmed.slice(1, closing);
      const kind = firstWord(body);
      // The section keyword ("gd_scene", "node", ...) leads the body and is not
      // an attribute; the attribute list is whatever follows it.
      const attrs = parseAttributes(attributesPart(body), filePath, i + 1);

      switch (kind) {
        case 'gd_scene':
          scene.header = attrs;
          sawSceneHeader = true;
          currentNode = null;
          break;

        case 'ext_resource': {
          const id = attrs['id'];
          const path = attrs['path'];
          if (!id || !path) {
            throw new TscnParseError(
              'ext_resource requires both "path" and "id"',
              filePath,
              i + 1,
              1,
            );
          }
          scene.extResources.push({
            id,
            type: attrs['type'] ?? 'Unknown',
            rawPath: path,
            path: resToRelative(path),
          });
          currentNode = null;
          break;
        }

        case 'sub_resource': {
          const id = attrs['id'];
          if (!id) {
            throw new TscnParseError(
              'sub_resource requires an "id"',
              filePath,
              i + 1,
              1,
            );
          }
          scene.subResources.push({ type: attrs['type'] ?? 'Unknown', id });
          currentNode = null;
          break;
        }

        case 'node': {
          const name = attrs['name'];
          if (!name) {
            throw new TscnParseError(
              'node header requires a "name"',
              filePath,
              i + 1,
              1,
            );
          }
          const node: TscnNode = {
            name,
            type: attrs['type'] ?? null,
            parent: attrs['parent'] ?? null,
            instanceOf: readExtResourceId(attrs['instance'] ?? null),
            properties: {},
            line: i + 1,
          };
          scene.nodes.push(node);
          currentNode = node;
          break;
        }

        case 'connection': {
          const signal = attrs['signal'];
          const from = attrs['from'];
          const to = attrs['to'];
          if (!signal || !from || !to) {
            throw new TscnParseError(
              'connection requires "signal", "from" and "to"',
              filePath,
              i + 1,
              1,
            );
          }
          scene.connections.push({
            signal,
            from,
            to,
            method: attrs['method'] ?? '',
            binds: readExtResourceId(attrs['binds'] ?? null),
          });
          currentNode = null;
          break;
        }

        case 'editable':
        case 'resource':
          // Editor bookkeeping; carries no dependency information.
          currentNode = null;
          break;

        default:
          // An unknown section is not an error: Godot adds sections over time,
          // and refusing to open a newer scene would be worse than ignoring it.
          currentNode = null;
          break;
      }
      continue;
    }

    // Inside a node block: `key = value`.
    const assignment = trimmed.indexOf('=');
    if (assignment > 0 && currentNode) {
      const key = trimmed.slice(0, assignment).trim();
      const value = trimmed.slice(assignment + 1).trim();
      if (key) currentNode.properties[key] = value;
    }
  }

  if (!sawSceneHeader) {
    throw new TscnParseError(
      'Missing [gd_scene] header — not a valid .tscn file',
      filePath,
      1,
      1,
    );
  }

  return scene;
}

/**
 * Find the `]` that closes a section header, ignoring any inside a quoted value.
 *
 * Returns -1 when the header is never closed, which the caller reports rather
 * than silently truncating the scene.
 */
function findSectionEnd(header: string): number {
  let inQuotes: '"' | "'" | null = null;
  for (let i = 0; i < header.length; i++) {
    const char = header[i];
    if (inQuotes) {
      if (char === inQuotes) inQuotes = null;
      continue;
    }
    if (char === '"' || char === "'") {
      inQuotes = char;
      continue;
    }
    if (char === ']') return i;
  }
  return -1;
}

/** The first whitespace-delimited word of a section body, e.g. "ext_resource". */
function firstWord(body: string): string {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(body);
  return match?.[1] ?? '';
}

/** A section body with its leading keyword removed. */
function attributesPart(body: string): string {
  return body.replace(/^\s*[A-Za-z_][A-Za-z0-9_]*/, '');
}

/**
 * Parse `key=value key="value with spaces"` attribute lists.
 *
 * Values may be quoted with `"` or `'`; an unquoted value runs to the next
 * whitespace. An escaped quote inside a double-quoted value does not end it.
 */
function parseAttributes(
  body: string,
  filePath: string,
  line: number,
): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = 0;

  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i] ?? '')) i++;
    if (i >= body.length) break;

    const keyStart = i;
    while (i < body.length && body[i] !== '=' && !/\s/.test(body[i] ?? '')) i++;
    const key = body.slice(keyStart, i);
    if (key === '') {
      i++;
      continue;
    }

    // Skip whitespace before the "=".
    while (i < body.length && /\s/.test(body[i] ?? '')) i++;
    if (body[i] !== '=') {
      throw new TscnParseError(
        `Expected "=" after attribute "${key}"`,
        filePath,
        line,
        i + 1,
      );
    }
    i++;

    while (i < body.length && /\s/.test(body[i] ?? '')) i++;

    const value = readValue(body, i, filePath, line);
    attrs[key] = value.value;
    i = value.nextIndex;
  }

  return attrs;
}

function readValue(
  body: string,
  start: number,
  filePath: string,
  line: number,
): { value: string; nextIndex: number } {
  const quote = body[start];
  if (quote === '"' || quote === "'") {
    let out = '';
    let i = start + 1;
    while (i < body.length) {
      const char = body[i];
      if (char === '\\' && i + 1 < body.length) {
        out += body[i + 1];
        i += 2;
        continue;
      }
      if (char === quote) {
        return { value: out, nextIndex: i + 1 };
      }
      out += char;
      i++;
    }
    throw new TscnParseError(
      'Unterminated quoted value in section header',
      filePath,
      line,
      start + 1,
    );
  }

  let i = start;
  while (i < body.length && !/\s/.test(body[i] ?? '')) i++;
  return { value: body.slice(start, i), nextIndex: i };
}

/**
 * Extract the id from an `ExtResource("1_abc")` value.
 * Returns null when the value is absent or is some other expression.
 */
function readExtResourceId(value: string | null): string | null {
  if (!value) return null;
  const match = /^ExtResource\(\s*"([^"]*)"\s*\)$/.exec(value.trim());
  return match?.[1] ?? null;
}

/** The ext_resource id referenced by a node's `instance=` property, if any. */
export function instanceSourceId(node: TscnNode): string | null {
  return node.instanceOf;
}

/** The script ext_resource id assigned to a node's root, if any. */
export function rootScriptId(scene: TscnDocument): string | null {
  for (const node of scene.nodes) {
    const assignment = node.properties['script'];
    if (assignment === undefined) continue;
    const id = readExtResourceId(assignment);
    if (id) return id;
  }
  return null;
}

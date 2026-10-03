/**
 * extract/assets.ts — Asset recognition and slot contracts.
 *
 * A slot is a promise a consumer makes about an asset: "this file will always be
 * a rigged GLB with idle/walk/run clips". Without that promise, swapping
 * `character.glb` for an unrigged mesh produces a game that loads cleanly and
 * then animates as a statue — the failure this module exists to make loud.
 *
 * The contract is resolved from four sources, in priority order:
 *   1. a companion file — `character.slot.json` or `character.glb.slot.json`
 *   2. a project registry — `slots.json` or `asset-slots.json`
 *   3. an in-source annotation — `// @slot models/character.glb: format=glb, ...`
 *   4. a default derived from the file extension
 *
 * Annotations are read from comments, which are plain text rather than code
 * syntax, so a regex is the correct tool there (SPEC R5 allows it) — but the
 * annotation is only ever merged into an asset that already exists, so a
 * malformed annotation can never invent a node.
 */

import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { SlotContract } from '../graph/types.js';
import { pathExists } from './files.js';

/** Extensions treated as assets rather than source. */
export const ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  '.glb', '.gltf', '.obj', '.fbx',
  '.png', '.jpg', '.jpeg', '.svg', '.webp', '.ktx', '.hdr',
  '.wav', '.ogg', '.mp3',
  '.tres', '.res',
]);

/** True when the path names an asset file. */
export function isAssetFile(filePath: string): boolean {
  return ASSET_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/** In-source slot hints, keyed by project-relative asset path. */
export type SlotHints = Record<string, Partial<SlotContract>>;

/**
 * Resolve an asset's slot contract.
 *
 * Never throws: an unreadable or malformed companion file falls through to the
 * next source. A broken annotation must not stop an extraction — the resulting
 * default contract is still useful, just less specific.
 */
export function findDeclaredSlot(
  assetId: string,
  projectRoot: string,
  hints: SlotHints = {},
): SlotContract {
  const normalizedId = assetId.replaceAll('\\', '/');
  const extension = extname(normalizedId).toLowerCase();
  const formatDefault = extension.replace(/^\./, '');
  const baseName = basename(normalizedId, extension);

  const raw =
    readCompanionSlot(projectRoot, normalizedId) ??
    readRegistrySlot(projectRoot, normalizedId, baseName) ??
    hints[normalizedId] ??
    { slot: baseName, format: formatDefault };

  return normalizeSlot(raw, baseName, formatDefault);
}

/** Read `x.slot.json` or `x.glb.slot.json` next to the asset. */
function readCompanionSlot(
  projectRoot: string,
  assetId: string,
): Record<string, unknown> | null {
  const candidates = [
    join(projectRoot, `${assetId}.slot.json`),
    join(projectRoot, assetId.replace(/\.[^/.]+$/, '.slot.json')),
  ];

  for (const candidate of candidates) {
    if (!pathExists(candidate)) continue;
    const parsed = readJsonFile(candidate);
    if (parsed) return parsed;
  }
  return null;
}

/** Look the asset up in a project-level slot registry. */
function readRegistrySlot(
  projectRoot: string,
  assetId: string,
  baseName: string,
): Record<string, unknown> | null {
  for (const registryName of ['slots.json', 'asset-slots.json']) {
    const registryPath = join(projectRoot, registryName);
    if (!pathExists(registryPath)) continue;
    const registry = readJsonFile(registryPath);
    if (!registry) continue;

    const value = pick(registry, [assetId, baseName, basename(assetId)]);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

function pick(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Coerce a raw slot object into the validated shape, filling in defaults. */
function normalizeSlot(
  raw: Record<string, unknown>,
  baseName: string,
  formatDefault: string,
): SlotContract {
  const slot: SlotContract = {
    slot: readString(raw, 'slot') ?? readString(raw, 'name') ?? baseName,
    format: (readString(raw, 'format') ?? formatDefault).toLowerCase(),
  };

  const animations = readAnimationList(raw);
  if (animations.length > 0) slot.expected_animations = animations;

  const dimensions = readString(raw, 'dimensions');
  if (dimensions) slot.dimensions = dimensions;

  const rigged = readBoolean(raw, 'rigged');
  if (rigged !== undefined) slot.rigged = rigged;

  const maxSize = readNumber(raw, 'max_size_kb');
  if (maxSize !== undefined) slot.max_size_kb = maxSize;

  return slot;
}

/**
 * Read the animation list.
 *
 * Accepts an array, a comma-separated string, or the `animations` alias — a
 * slot file is usually hand-written, and refusing it because it used the other
 * spelling would just push the developer to skip the contract.
 */
function readAnimationList(raw: Record<string, unknown>): string[] {
  const source = raw['expected_animations'] ?? raw['animations'];

  let list: string[];
  if (Array.isArray(source)) {
    list = source.filter((v): v is string => typeof v === 'string');
  } else if (typeof source === 'string') {
    list = source.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    list = [];
  }

  return [...new Set(list)].sort((a, b) => a.localeCompare(b));
}

function readString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(raw: Record<string, unknown>, key: string): boolean | undefined {
  const value = raw[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse in-source slot annotations from file text.
 *
 * Two forms are supported:
 *
 *   // @slot models/character.glb: format=glb, animations=[idle, walk], rigged=true
 *   # @slot res://icon.png { "format": "png", "dimensions": "64x64" }
 *
 * Returns hints keyed by project-relative asset path.
 */
export function parseInCodeSlotHints(content: string): SlotHints {
  const hints: SlotHints = {};
  if (!content) return hints;

  // JSON object form.
  const jsonPattern = /(?:\/\/|#|\/\*)\s*@slot\s+([^\s{]+)\s*(\{[^{}]*\})/g;
  for (const match of content.matchAll(jsonPattern)) {
    const assetPath = normalizeHintPath(match[1] ?? '');
    const body = match[2];
    if (!assetPath || !body) continue;
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        hints[assetPath] = { ...hints[assetPath], ...(parsed as Partial<SlotContract>) };
      }
    } catch {
      // A malformed JSON annotation is ignored rather than failing extraction.
    }
  }

  // Key-value form.
  const kvPattern = /(?:\/\/|#)\s*@slot\s+([^:\n]+):\s*([^\n]+)/g;
  for (const match of content.matchAll(kvPattern)) {
    const assetPath = normalizeHintPath(match[1] ?? '');
    const pairs = match[2];
    if (!assetPath || !pairs) continue;

    const parsed: Partial<SlotContract> = {};
    const format = /\bformat\s*=\s*([a-zA-Z0-9]+)/.exec(pairs);
    if (format?.[1]) parsed.format = format[1];

    const dimensions = /\bdimensions?\s*=\s*([0-9]+x[0-9]+)/.exec(pairs);
    if (dimensions?.[1]) parsed.dimensions = dimensions[1];

    const rigged = /\brigged\s*=\s*(true|false)/.exec(pairs);
    if (rigged?.[1]) parsed.rigged = rigged[1] === 'true';

    const animations =
      /\banimations?\s*=\s*\[([^\]]*)\]/.exec(pairs) ??
      /\banimations?\s*=\s*([a-zA-Z0-9_,\s]+)/.exec(pairs);
    if (animations?.[1] !== undefined) {
      parsed.expected_animations = animations[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    hints[assetPath] = { ...hints[assetPath], ...parsed };
  }

  return hints;
}

function normalizeHintPath(rawPath: string): string {
  return rawPath
    .replace(/^res:\/\//, '')
    .replaceAll('\\', '/')
    .replace(/^[`'"]+|[`'" ]+$/g, '')
    .trim();
}

/**
 * Render a slot contract as the human-readable strings that go into
 * `contract.exports`, so an asset node carries its contract in the same shape as
 * every other node.
 */
export function buildSlotContractExports(slot: SlotContract): string[] {
  const exportsList: string[] = [];

  for (const animation of [...(slot.expected_animations ?? [])].sort()) {
    exportsList.push(`animation: ${animation}`);
  }
  if (slot.dimensions) exportsList.push(`dimensions: ${slot.dimensions}`);
  if (slot.format) exportsList.push(`format: ${slot.format}`);
  if (slot.max_size_kb !== undefined) {
    exportsList.push(`max_size_kb: ${slot.max_size_kb}`);
  }
  if (slot.rigged !== undefined) exportsList.push(`rigged: ${slot.rigged}`);

  return exportsList.sort((a, b) => a.localeCompare(b));
}

/** A slot contract plus the exports derived from it. */
export interface SlotResolution {
  slot: SlotContract;
  exports: string[];
}

/** Resolve an asset's slot and its contract exports in one call. */
export function parseSlotContract(
  assetId: string,
  projectRoot: string,
  hints: SlotHints = {},
): SlotResolution {
  const slot = findDeclaredSlot(assetId, projectRoot, hints);
  return { slot, exports: buildSlotContractExports(slot) };
}

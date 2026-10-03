/**
 * scene/slots.ts — refuse a model swap that does not satisfy its slot contract.
 *
 * The failure this exists to catch is SPEC §1's fourth one: an AI swaps
 * `character.glb` for a mesh with no rig and no `idle` clip, the game loads,
 * and the character is a floating statue until someone plays it. The slot
 * contract already declares what the asset promised (`extract/assets.ts`); this
 * module is the check that the promise is still kept by the *candidate* file.
 *
 * Design choices worth stating:
 *
 *  - **The candidate is described by the same parser as everything else.**
 *    `parseSlotContract` resolves the candidate's own declared contract
 *    (companion `x.slot.json`, registry, in-source annotation, extension
 *    default) and `buildSlotContractExports` renders it as the same
 *    `animation: idle` strings the graph nodes carry. Nothing here re-derives
 *    what an asset declares — a second parser would drift from the first.
 *  - **Every rejection is a sentence, not a flag** (SPEC R9). A caller gets the
 *    file, the slot, and the exact expectation that failed, so the message can
 *    go straight into a UI toast.
 *  - **Rejections are sorted, and the whole list is returned.** A swap that is
 *    both the wrong type and 400 KB too big should not need two round-trips to
 *    diagnose, and sorting keeps the verdict byte-identical for the same inputs
 *    (SPEC R8).
 *  - **Size is the one thing read from disk.** `rigged` and `expected_animations`
 *    are declarations; a file's weight is not, so it is measured with `statSync`.
 *    `node:fs` is not a DOM dependency (SPEC R3) and core already uses it.
 */

import { statSync } from 'node:fs';
import { extname, isAbsolute, join, relative } from 'node:path';
import {
  buildSlotContractExports,
  parseSlotContract,
  type SlotHints,
} from '../extract/assets.js';
import type { SlotContract } from '../graph/types.js';

/** What kind of expectation a rejection is about. */
export type SlotRejectionKind =
  | 'file_not_found'
  | 'wrong_slot_type'
  | 'missing_rig'
  | 'missing_animation'
  | 'exceeds_max_size';

/** One failed expectation: the kind, the expectation text, and a full sentence. */
export interface SlotRejection {
  kind: SlotRejectionKind;
  /** The expectation that was not met, e.g. `rigged model`, `animation "idle"`. */
  expectation: string;
  /** A complete sentence naming the file and what was expected of it. */
  reason: string;
}

/** The verdict on one candidate file. */
export interface SlotVerdict {
  /** True when the candidate satisfies every declared expectation. */
  ok: boolean;
  /** The candidate path exactly as it was passed in, for echoing back. */
  model: string;
  /** Empty when `ok`. Sorted, and never a bare `false` reason. */
  rejections: SlotRejection[];
  /** `ok ? '' :` every rejection joined into one paragraph. */
  reason: string;
}

/**
 * The validator shape `swapModel` accepts.
 *
 * Deliberately `(modelPath) => verdict` and nothing more: the scene edit knows
 * the model path and nothing about project roots, slot registries or files, so
 * the validator is the single seam where asset knowledge enters.
 */
export type SlotValidator = (modelPath: string) => SlotVerdict;

/**
 * A `SlotResolution` from `parseSlotContract` — the `{ slot, exports }` shape —
 * accepted anywhere a raw `SlotContract` is, because the natural caller already
 * has the resolution in hand and should not have to unwrap it.
 *
 * `exports` is required here (the extractor always produces it) even though
 * `SlotResolution` types it as a plain array: that is what makes it a usable
 * discriminator, since `SlotContract` has no `exports` key at all.
 */
export interface SlotExpectations {
  slot: SlotContract;
  exports: readonly string[];
}

/** Options shared by the validator and the curried factory. */
export interface SlotValidationOptions {
  /** Project root the candidate path is resolved against. */
  projectRoot: string;
  /** In-source `@slot` hints, as the extractors produce them. */
  hints?: SlotHints | undefined;
}

/**
 * Validate a candidate model path against the expectations a slot declares.
 *
 * `expected` accepts either a raw `SlotContract` or a `SlotResolution` from
 * `parseSlotContract`, because the natural caller — the Modeling screen —
 * already has the resolution in hand and should not have to unwrap it.
 *
 * Never throws: an unreadable file is a rejection, not an exception, for the
 * same reason `applySceneEdit` converts a `saveScene` throw into a refusal.
 */
export function validateModelSlot(
  modelPath: string,
  expected: SlotContract | SlotExpectations,
  options: SlotValidationOptions,
): SlotVerdict {
  const expectations: SlotContract = toSlotContract(expected);

  const rejections: SlotRejection[] = [];
  const slotName = expectations.slot ?? 'default';

  const size = readFileSizeKb(modelPath, options.projectRoot);
  if (size === null) {
    // Nothing else can be checked without the file, so there is one rejection
    // and it names the slot — rather than four cascading "missing rig" style
    // complaints about a file that was never there.
    return sortVerdict(modelPath, [
      {
        kind: 'file_not_found',
        expectation: 'an existing file',
        reason:
          `"${modelPath}" cannot be used for slot "${slotName}": the file does not exist, ` +
          'so none of the slot expectations could be checked.',
      },
    ]);
  }

  const candidateId = assetId(modelPath, options.projectRoot);
  const candidate = parseSlotContract(candidateId, options.projectRoot, options.hints).slot;

  // Slot identity and format: a 2D sprite offered as the character is the most
  // obvious wrong swap, and it is also the one a size check alone would miss.
  if (expectations.slot !== undefined && candidate.slot !== expectations.slot) {
    rejections.push({
      kind: 'wrong_slot_type',
      expectation: `slot "${expectations.slot}"`,
      reason:
        `"${modelPath}" cannot be used for slot "${expectations.slot}": it declares ` +
        `slot "${candidate.slot}", not slot "${expectations.slot}".`,
    });
  }

  if (expectations.format !== undefined && candidate.format !== expectations.format) {
    rejections.push({
      kind: 'wrong_slot_type',
      expectation: `format "${expectations.format}"`,
      reason:
        `"${modelPath}" cannot be used for slot "${slotName}": the slot requires ` +
        `format "${expectations.format}" but this file is format "${candidate.format}".`,
    });
  }

  // Rig. `rigged: false` is not checked: a slot that does not care about skinning
  // must not reject a plain mesh, which is the common case for props.
  if (expectations.rigged === true && candidate.rigged !== true) {
    rejections.push({
      kind: 'missing_rig',
      expectation: 'a rigged model with a skeleton and skin',
      reason:
        `"${modelPath}" cannot be used for slot "${slotName}": the slot requires a ` +
        'rigged model, but this file declares no rig.',
    });
  }

  // Named animations. Compared against the candidate's own contract exports, so
  // an animation declared in a `.slot.json` companion counts the same as one
  // found by the extractor — the swap must not care where the promise lives.
  const candidateExports = buildSlotContractExports(candidate);
  for (const animation of [...(expectations.expected_animations ?? [])].sort()) {
    if (candidateExports.includes(`animation: ${animation}`)) continue;
    rejections.push({
      kind: 'missing_animation',
      expectation: `animation "${animation}"`,
      reason:
        `"${modelPath}" cannot be used for slot "${slotName}": the slot requires the ` +
        `animation "${animation}", which this file does not declare.`,
    });
  }

  // Size, measured rather than declared.
  const maxSizeKb = expectations.max_size_kb;
  if (maxSizeKb !== undefined && size > maxSizeKb) {
    rejections.push({
      kind: 'exceeds_max_size',
      expectation: `at most ${maxSizeKb} KB`,
      reason:
        `"${modelPath}" cannot be used for slot "${slotName}": the slot allows at most ` +
        `${maxSizeKb} KB, but the file is ${formatKb(size)}.`,
    });
  }

  return sortVerdict(modelPath, rejections);
}

/**
 * Build a reusable validator bound to one slot's expectations.
 *
 * The form `swapModel` takes. Built once per instance or per screen and passed
 * in, so the edit itself stays a pure function of `(scene, id, model)`.
 */
export function makeSlotValidator(
  expected: SlotContract | SlotExpectations,
  options: SlotValidationOptions,
): SlotValidator {
  return (modelPath: string) => validateModelSlot(modelPath, expected, options);
}

/**
 * The validator for replacing a scene instance's current model.
 *
 * `expected` comes from the instance's *existing* model: that file's declared
 * contract is what the scene already depends on, so it is the right set of
 * expectations to hold a replacement to. An instance with no model yet, or one
 * whose current model declares nothing beyond a slot name, yields `undefined` —
 * there is nothing to hold the swap to, and inventing expectations would refuse
 * legitimate first-time placements.
 */
export function instanceSlotValidator(
  projectRoot: string,
  currentModel: string | undefined,
  hints?: SlotHints | undefined,
): SlotValidator | undefined {
  if (currentModel === undefined || currentModel.trim() === '') return undefined;

  const resolution = parseSlotContract(currentModel, projectRoot, hints);
  const slot = resolution.slot;
  const extensionDefault = extname(currentModel).replace(/^\./, '').toLowerCase();

  // The extension default is not an expectation: every asset has a format, so
  // counting it would make *every* swap demand the current file's format rather
  // than a format anyone declared.
  const hasExpectations =
    slot.expected_animations !== undefined ||
    slot.rigged !== undefined ||
    slot.max_size_kb !== undefined ||
    slot.dimensions !== undefined ||
    (slot.format !== undefined && slot.format !== extensionDefault);

  return hasExpectations
    ? makeSlotValidator(resolution, { projectRoot, ...(hints !== undefined ? { hints } : {}) })
    : undefined;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The candidate's project-relative asset id.
 *
 * A scene stores project-relative model paths, but a caller (a file picker, a
 * terminal) can hand over an absolute one. `parseSlotContract` joins the id onto
 * the project root to find the companion `x.slot.json`, so an absolute id would
 * be joined onto the root and find nothing — the candidate would silently look
 * like a bare mesh with no contract. Reducing it here keeps an absolute path and
 * a relative one behaving identically.
 */
function assetId(modelPath: string, projectRoot: string): string {
  if (!isAbsolute(modelPath)) return modelPath.replaceAll('\\', '/');
  return relative(projectRoot, modelPath).replaceAll('\\', '/');
}

/** Unwrap the two accepted expectation shapes into the contract itself. */
function toSlotContract(expected: SlotContract | SlotExpectations): SlotContract {
  // Note it must be `exports` and not `slot`: a raw contract *has* a `slot`
  // key, so testing for that would unwrap to the string `"character"`, and a
  // string has no `rigged` property — every expectation would read as met.
  return 'exports' in expected ? expected.slot : expected;
}

/** Sort rejections so the same inputs always produce the same verdict (R8). */
function sortVerdict(modelPath: string, rejections: SlotRejection[]): SlotVerdict {
  const sorted = [...rejections].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.expectation.localeCompare(b.expectation),
  );
  return {
    ok: sorted.length === 0,
    model: modelPath,
    rejections: sorted,
    reason: sorted.map((rejection) => rejection.reason).join(' '),
  };
}

/** The file's size in KB (1024 bytes), or `null` when it cannot be read. */
function readFileSizeKb(modelPath: string, projectRoot: string): number | null {
  const absolute = isAbsolute(modelPath) ? modelPath : join(projectRoot, modelPath);
  try {
    const stats = statSync(absolute);
    if (!stats.isFile()) return null;
    return stats.size / 1024;
  } catch {
    return null;
  }
}

/** Sizes are reported as a whole number of KB, so a message reads as a fact. */
function formatKb(kb: number): string {
  const rounded = Math.round(kb * 100) / 100;
  return `${rounded} KB`;
}
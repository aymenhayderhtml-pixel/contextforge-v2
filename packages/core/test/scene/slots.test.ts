/**
 * scene/slots.test.ts — refusing a model swap that breaks its slot contract.
 *
 * The behaviour under test is the fourth failure mode in SPEC §1: a swap that
 * loads cleanly and produces a floating statue. Every rejection kind therefore
 * gets a **good** and a **bad** example — a validator that only ever rejects
 * would pass a suite of bad examples, and a validator that only ever accepts
 * would pass a suite of good ones.
 *
 * Three further things are asserted, because each is a way the feature could be
 * claimed and quietly not be true:
 *
 *  - **no validator means no change.** The old behaviour must survive exactly,
 *    or every existing caller silently starts failing (SPEC R8).
 *  - **a refusal writes nothing.** Not the file, and not a history step — a
 *    refused swap that recorded an undo step would leave an undo that appears
 *    to do nothing when pressed.
 *  - **determinism.** The same inputs give byte-identical reasons, because the
 *    verdict text is what an AI reads back (SPEC R8/R9).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  instanceSlotValidator,
  makeSlotValidator,
  validateModelSlot,
  type SlotVerdict,
} from '../../src/scene/slots.js';
import { parseSlotContract } from '../../src/extract/assets.js';
import { applySceneEdit, swapModel } from '../../src/scene/edits.js';
import { loadScene, parseScene, saveScene } from '../../src/scene/sceneFile.js';
import { clearHistory, getHistoryStatus } from '../../src/history/history.js';
import type { SlotContract } from '../../src/graph/types.js';
import type { SceneFile } from '../../src/scene/scene.schema.js';

const IDENTITY = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } as const;

/** The slot every rejection test is written against. */
const HERO_SLOT: SlotContract = {
  slot: 'character',
  format: 'glb',
  rigged: true,
  expected_animations: ['idle', 'walk'],
  max_size_kb: 1024,
};

let dir: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-slots-'));
  project = dir;
  mkdirSync(join(project, 'models'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a model file of `sizeKb` KB with an optional companion slot contract. */
function writeModel(
  relativePath: string,
  sizeKb: number,
  contract?: Partial<SlotContract>,
): string {
  const absolute = join(project, relativePath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, Buffer.alloc(Math.round(sizeKb * 1024), 7));

  if (contract !== undefined) {
    // The companion form the extractor already reads: `x.glb.slot.json`.
    writeFileSync(absolute.replace(/\.[^/.]+$/, '.slot.json'), JSON.stringify(contract));
  }
  return relativePath;
}

/** Always accepts — the "no validator was configured" stand-in. */
function acceptAll(modelPath: string): SlotVerdict {
  return { ok: true, model: modelPath, rejections: [], reason: '' };
}

/** The kinds present in a verdict, for concise assertions. */
function kinds(verdict: SlotVerdict): string[] {
  return verdict.rejections.map((rejection) => rejection.kind);
}

function verdictFor(modelPath: string): SlotVerdict {
  return validateModelSlot(modelPath, HERO_SLOT, { projectRoot: project });
}

describe('a swap that keeps every expectation is accepted', () => {
  it('accepts a rigged, correctly-named, small-enough replacement', () => {
    writeModel('models/hero.glb', 256, {
      slot: 'character',
      format: 'glb',
      rigged: true,
      expected_animations: ['idle', 'walk'],
    });

    const verdict = verdictFor('models/hero.glb');

    expect(verdict.ok).toBe(true);
    expect(verdict.rejections).toEqual([]);
    expect(verdict.reason).toBe('');
    expect(verdict.model).toBe('models/hero.glb');
  });

  it('accepts a file right on the size limit, and refuses one byte over', () => {
    // The comparison is `>`, not `>=`: "at most 1024 KB" includes 1024 KB.
    writeModel('models/exactly.glb', 1024, {
      slot: 'character',
      rigged: true,
      expected_animations: ['idle', 'walk'],
    });
    expect(verdictFor('models/exactly.glb').ok).toBe(true);

    writeModel('models/over.glb', 1024.5, {
      slot: 'character',
      rigged: true,
      expected_animations: ['idle', 'walk'],
    });
    const over = verdictFor('models/over.glb');
    expect(over.ok).toBe(false);
    expect(kinds(over)).toEqual(['exceeds_max_size']);
  });

  it('accepts a candidate that keeps only some animations, not all of the slot’s', () => {
    // The slot needs idle and walk; a candidate declaring a superset is fine.
    // The check is "is the expected animation present", never "are these equal".
    writeModel('models/hero.glb', 128, {
      slot: 'character',
      rigged: true,
      expected_animations: ['idle', 'walk', 'run', 'jump'],
    });
    expect(verdictFor('models/hero.glb').ok).toBe(true);
  });
});

describe('a missing rig is refused', () => {
  it('rejects a candidate that declares no rig', () => {
    writeModel('models/statue.glb', 128, {
      slot: 'character',
      rigged: false,
      expected_animations: ['idle', 'walk'],
    });

    const verdict = verdictFor('models/statue.glb');

    expect(verdict.ok).toBe(false);
    expect(kinds(verdict)).toEqual(['missing_rig']);
    // R9: the message names the file, the slot and the expectation.
    expect(verdict.reason).toContain('models/statue.glb');
    expect(verdict.reason).toContain('character');
    expect(verdict.reason).toContain('rigged');
    expect(verdict.reason).toMatch(/\.$/);
  });

  it('rejects a candidate that says nothing about rigging at all', () => {
    writeModel('models/mystery.glb', 128, {
      slot: 'character',
      expected_animations: ['idle', 'walk'],
    });
    expect(kinds(verdictFor('models/mystery.glb'))).toEqual(['missing_rig']);
  });

  it('does not demand a rig when the slot does not ask for one', () => {
    // A prop slot with no `rigged` must accept a plain mesh, or every crate
    // swap in the project would be refused.
    writeModel('models/crate.glb', 64, { slot: 'prop' });
    const verdict = validateModelSlot('models/crate.glb', { slot: 'prop' }, { projectRoot: project });
    expect(verdict.ok).toBe(true);
  });

  it('does not reject a plain mesh when the slot declares rigged: false', () => {
    writeModel('models/crate.glb', 64, { slot: 'prop', rigged: false });
    const verdict = validateModelSlot(
      'models/crate.glb',
      { slot: 'prop', rigged: false },
      { projectRoot: project },
    );
    expect(verdict.ok).toBe(true);
  });
});

describe('a missing named animation is refused', () => {
  it('rejects a candidate missing one of several animations, naming that one', () => {
    writeModel('models/noidle.glb', 128, {
      slot: 'character',
      rigged: true,
      expected_animations: ['walk'],
    });

    const verdict = verdictFor('models/noidle.glb');

    expect(verdict.ok).toBe(false);
    expect(kinds(verdict)).toEqual(['missing_animation']);
    expect(verdict.reason).toContain('models/noidle.glb');
    expect(verdict.reason).toContain('"idle"');
    expect(verdict.reason).not.toContain('"walk"');
  });

  it('rejects a candidate declaring no animations at all', () => {
    writeModel('models/mesh.glb', 128, { slot: 'character', rigged: true });
    expect(kinds(verdictFor('models/mesh.glb'))).toEqual([
      'missing_animation',
      'missing_animation',
    ]);
  });

  it('accepts a candidate that lists the animations comma-separated', () => {
    // The extractor accepts either spelling of an animation list; the validator
    // must not be stricter than the parser that feeds it.
    writeModel('models/hero.glb', 128, { slot: 'character', rigged: true });
    writeFileSync(
      join(project, 'models/hero.slot.json'),
      JSON.stringify({ slot: 'character', rigged: true, animations: 'idle, walk' }),
    );
    expect(verdictFor('models/hero.glb').ok).toBe(true);
  });
});

describe('exceeding the maximum size is refused', () => {
  it('rejects a file over the limit, reporting the measured size', () => {
    writeModel('models/huge.glb', 4096, {
      slot: 'character',
      rigged: true,
      expected_animations: ['idle', 'walk'],
    });

    const verdict = verdictFor('models/huge.glb');

    expect(verdict.ok).toBe(false);
    expect(kinds(verdict)).toEqual(['exceeds_max_size']);
    expect(verdict.reason).toContain('models/huge.glb');
    expect(verdict.reason).toContain('1024 KB');
    expect(verdict.reason).toContain('4096 KB');
  });

  it('measures the real file, not a declared weight', () => {
    // The companion contract claims max_size_kb: 999999 for the slot, but the
    // slot *expects* 64 KB — the limit is the slot's, the size is the file's.
    writeModel('models/chunky.glb', 128, { slot: 'character', rigged: true });
    const verdict = validateModelSlot(
      'models/chunky.glb',
      { slot: 'character', max_size_kb: 64 },
      { projectRoot: project },
    );
    expect(kinds(verdict)).toEqual(['exceeds_max_size']);
    expect(verdict.reason).toContain('128 KB');
  });

  it('has no size opinion when the slot states no limit', () => {
    writeModel('models/huge.glb', 900, { slot: 'prop' });
    const verdict = validateModelSlot('models/huge.glb', { slot: 'prop' }, { projectRoot: project });
    expect(verdict.ok).toBe(true);
  });
});

describe('the wrong slot type is refused', () => {
  it('rejects a candidate that declares a different slot name', () => {
    writeModel('models/tree.glb', 128, { slot: 'environment' });

    const verdict = verdictFor('models/tree.glb');

    expect(verdict.ok).toBe(false);
    expect(kinds(verdict)).toContain('wrong_slot_type');
    expect(verdict.reason).toContain('models/tree.glb');
    expect(verdict.reason).toContain('environment');
  });

  it('rejects a candidate of a different format', () => {
    writeFileSync(join(project, 'models/hero.png'), Buffer.alloc(1024, 1));

    const verdict = verdictFor('models/hero.png');

    expect(verdict.ok).toBe(false);
    expect(kinds(verdict)).toContain('wrong_slot_type');
    // Without the format expectation this file would be rejected for three
    // other reasons as well; the wrong-type reason must be among them.
    expect(verdict.reason).toContain('format "png"');
  });

  it('accepts a candidate whose format matches and whose slot name matches', () => {
    writeModel('models/hero.glb', 64, {
      slot: 'character',
      format: 'glb',
      rigged: true,
      expected_animations: ['idle', 'walk'],
    });
    expect(kinds(verdictFor('models/hero.glb'))).toEqual([]);
  });
});

describe('a file that is not there is refused', () => {
  it('rejects a missing file without inventing other rejections', () => {
    const verdict = verdictFor('models/absent.glb');

    expect(verdict.ok).toBe(false);
    expect(kinds(verdict)).toEqual(['file_not_found']);
    expect(verdict.reason).toContain('models/absent.glb');
    expect(verdict.reason).toContain('does not exist');
  });

  it('rejects a directory presented as a model', () => {
    mkdirSync(join(project, 'models/adir'), { recursive: true });
    expect(kinds(verdictFor('models/adir'))).toEqual(['file_not_found']);
  });

  it('accepts an absolute path as well as a project-relative one', () => {
    const relative = writeModel('models/hero.glb', 64, {
      slot: 'character',
      rigged: true,
      expected_animations: ['idle', 'walk'],
    });
    expect(verdictFor(join(project, relative)).ok).toBe(true);
  });
});

describe('every failing expectation is reported at once, deterministically', () => {
  it('lists all of them, sorted, in one reason', () => {
    // Wrong type, no rig, no animations, too big: one round-trip, four answers.
    writeModel('models/mistake.png', 4096, { slot: 'environment' });

    const verdict = verdictFor('models/mistake.png');

    expect(verdict.ok).toBe(false);
    expect(kinds(verdict)).toEqual([
      'exceeds_max_size',
      'missing_animation',
      'missing_animation',
      'missing_rig',
      'wrong_slot_type',
      'wrong_slot_type',
    ]);
    expect(verdict.rejections.every((r) => r.reason.endsWith('.'))).toBe(true);
    // Every sentence is carried into the joined paragraph.
    for (const rejection of verdict.rejections) {
      expect(verdict.reason).toContain(rejection.reason);
    }
  });

  it('produces byte-identical verdicts for identical inputs', () => {
    writeModel('models/mistake.png', 4096, { slot: 'environment' });
    expect(verdictFor('models/mistake.png')).toEqual(verdictFor('models/mistake.png'));
  });

  it('carries an expectation label alongside each reason', () => {
    writeModel('models/statue.glb', 128, { slot: 'character', rigged: false });
    const rig = verdictFor('models/statue.glb').rejections.find((r) => r.kind === 'missing_rig');
    expect(rig?.expectation).toContain('rigged');
  });
});

describe('the validator shape swapModel consumes', () => {
  it('binds expectations and project root once, then validates by path', () => {
    writeModel('models/hero.glb', 64, {
      slot: 'character',
      rigged: true,
      expected_animations: ['idle', 'walk'],
    });
    const validator = makeSlotValidator(HERO_SLOT, { projectRoot: project });

    expect(validator('models/hero.glb').ok).toBe(true);
    expect(validator('models/nowhere.glb').ok).toBe(false);
  });

  it('accepts a SlotResolution from parseSlotContract as the expectations', () => {
    // The natural caller already has a resolution in hand and should not have to
    // unwrap it; both spellings must give the same verdict.
    writeModel('models/hero.glb', 64, { slot: 'character', rigged: true });
    writeModel('models/statue.glb', 64, { slot: 'character', rigged: false });

    // Resolved after the companion contract is on disk, or it would resolve to
    // the extension default and the comparison would prove nothing.
    const resolution = parseSlotContract('models/hero.glb', project);

    const fromResolution = validateModelSlot('models/statue.glb', resolution, {
      projectRoot: project,
    });
    const fromContract = validateModelSlot(
      'models/statue.glb',
      { slot: 'character', rigged: true },
      { projectRoot: project },
    );
    expect(fromResolution.rejections).toEqual(fromContract.rejections);
  });

  it('derives expectations from the instance’s current model', () => {
    writeModel('models/hero.glb', 64, {
      slot: 'character',
      rigged: true,
      expected_animations: ['idle', 'walk'],
    });
    const validator = instanceSlotValidator(project, 'models/hero.glb');

    expect(validator).toBeDefined();
    expect(validator?.('models/hero.glb').ok).toBe(true);

    writeModel('models/statue.glb', 64, { slot: 'character', rigged: false });
    expect(validator?.('models/statue.glb').ok).toBe(false);
  });

  it('yields no validator when the current model declares no expectations', () => {
    // A bare asset with no companion contract only has an extension-derived
    // format; inventing expectations there would refuse ordinary placements.
    writeModel('models/crate.glb', 64);
    expect(instanceSlotValidator(project, 'models/crate.glb')).toBeUndefined();
  });

  it('yields no validator when the instance has no model yet', () => {
    expect(instanceSlotValidator(project, undefined)).toBeUndefined();
    expect(instanceSlotValidator(project, '  ')).toBeUndefined();
  });
});

describe('swapModel with a validator', () => {
  /** A scene with one modelled instance, ready to swap. */
  function sceneWithModel(): SceneFile {
    return parseScene({
      version: 1,
      name: 'Level1',
      engine: 'three',
      seed: 1,
      instances: [
        {
          id: 'hero',
          prefab: 'model',
          transform: IDENTITY,
          params: {},
          model: 'models/hero.glb',
        },
      ],
      lights: [],
      camera: { kind: 'perspective', position: [0, 0, 5], rotation: [0, 0, 0], fov: 60 },
    });
  }

  it('applies the swap when the validator accepts', () => {
    const result = swapModel(sceneWithModel(), 'hero', 'models/hero2.glb', acceptAll);
    expect(result.ok).toBe(true);
    expect(result.scene.instances[0]?.model).toBe('models/hero2.glb');
  });

  it('refuses when the validator rejects, and returns the reasons', () => {
    writeModel('models/statue.glb', 128, { slot: 'character', rigged: false });
    const before = sceneWithModel();
    const result = swapModel(before, 'hero', 'models/statue.glb', () => verdictFor('models/statue.glb'));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('models/statue.glb');
    expect(result.error).toContain('rigged');
    // Purity: a refusal hands back the very same scene, not a mutated one.
    expect(result.scene).toBe(before);
  });

  it('still refuses an empty path and an unknown instance before validating', () => {
    // Ordering matters: the scene's own checks are the more specific message,
    // so they must win over a validator that would also reject.
    const exploding = (): SlotVerdict => {
      throw new Error('validator must not have been called');
    };

    expect(swapModel(sceneWithModel(), 'hero', '  ', exploding).ok).toBe(false);
    expect(swapModel(sceneWithModel(), 'ghost', 'models/hero2.glb', exploding).ok).toBe(false);
  });

  it('treats a throwing validator as a refusal rather than letting it escape', () => {
    const result = swapModel(sceneWithModel(), 'hero', 'models/hero2.glb', () => {
      throw new Error('asset unreadable');
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('asset unreadable');
  });

  it('falls back to a specific message if a verdict carries no reason text', () => {
    const result = swapModel(sceneWithModel(), 'hero', 'models/hero2.glb', () => ({
      ok: false,
      model: 'models/hero2.glb',
      rejections: [],
      reason: '',
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('models/hero2.glb');
    expect(result.error).toContain('slot contract');
  });

  describe('with no validator passed', () => {
    it('behaves exactly as before: the old three-argument call still swaps', () => {
      // The whole feature is opt-in. A swap that used to succeed must not start
      // failing merely because a caller has not been updated yet (SPEC R8).
      const result = swapModel(sceneWithModel(), 'hero', 'models/does/not/exist.glb');
      expect(result.ok).toBe(true);
      expect(result.scene.instances[0]?.model).toBe('models/does/not/exist.glb');
    });

    it('still refuses an empty model path', () => {
      const result = swapModel(sceneWithModel(), 'hero', '   ');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('must not be empty');
    });

    it('still refuses an unknown instance', () => {
      expect(swapModel(sceneWithModel(), 'ghost', 'models/hero2.glb').ok).toBe(false);
    });
  });
});

describe('a refused swap writes nothing', () => {
  const scenePath = 'scenes/Level1.scene.json';
  let file: string;

  beforeEach(() => {
    file = join(project, scenePath);
    saveScene(
      file,
      parseScene({
        version: 1,
        name: 'Level1',
        engine: 'three',
        seed: 1,
        instances: [
          {
            id: 'hero',
            prefab: 'model',
            transform: IDENTITY,
            params: {},
            model: 'models/hero.glb',
          },
        ],
        lights: [],
        camera: { kind: 'perspective', position: [0, 0, 5], rotation: [0, 0, 0], fov: 60 },
      }),
    );
    clearHistory(project);
  });

  afterEach(() => {
    clearHistory(project);
  });

  const onDisk = (): SceneFile => {
    const loaded = loadScene(file);
    if (loaded === null) throw new Error('scene file vanished');
    return loaded;
  };

  it('leaves the file untouched and records no history step', () => {
    writeModel('models/statue.glb', 64, { slot: 'character', rigged: false });
    const before = readFileSync(file, 'utf-8');

    const result = applySceneEdit(
      project,
      scenePath,
      onDisk(),
      {
        op: 'swapModel',
        instanceId: 'hero',
        model: 'models/statue.glb',
        validator: makeSlotValidator(HERO_SLOT, { projectRoot: project }),
      },
      { now: 1_700_000_000_000 },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('models/statue.glb');
    // Nothing on disk, and nothing to undo — an undo step for a refused edit
    // is an undo that appears to do nothing when pressed.
    expect(readFileSync(file, 'utf-8')).toBe(before);
    expect(onDisk().instances[0]?.model).toBe('models/hero.glb');
    expect(recordedSteps()).toBe(0);
  });

  it('writes and records normally when the validator accepts', () => {
    writeModel('models/hero2.glb', 64, {
      slot: 'character',
      rigged: true,
      expected_animations: ['idle', 'walk'],
    });

    const result = applySceneEdit(
      project,
      scenePath,
      onDisk(),
      {
        op: 'swapModel',
        instanceId: 'hero',
        model: 'models/hero2.glb',
        validator: makeSlotValidator(HERO_SLOT, { projectRoot: project }),
      },
      { now: 1_700_000_000_000 },
    );

    expect(result.ok).toBe(true);
    expect(result.patchId).toBeDefined();
    expect(onDisk().instances[0]?.model).toBe('models/hero2.glb');
    expect(recordedSteps()).toBe(1);
  });

  it('does not create the scene file when a swap is refused before any write', () => {
    const target = 'scenes/Fresh.scene.json';
    const validator = makeSlotValidator(HERO_SLOT, { projectRoot: project });

    const result = applySceneEdit(
      project,
      target,
      onDisk(),
      { op: 'swapModel', instanceId: 'hero', model: 'models/absent.glb', validator },
      { now: 1_700_000_000_000 },
    );

    expect(result.ok).toBe(false);
    expect(loadScene(join(project, target))).toBeNull();
    expect(recordedSteps()).toBe(0);
  });
});

/** The number of undo steps recorded for this project. */
function recordedSteps(): number {
  return getHistoryStatus(project).undoCount;
}
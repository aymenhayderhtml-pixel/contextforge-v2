/**
 * test/context/contextInsufficient.test.ts — the `CONTEXT INSUFFICIENT:` detector.
 *
 * The detector is a pure function on a string, so this suite has no Electron, no
 * project and no renderer — which is the point of it being one. Every case here
 * is a sentence an AI actually wrote, and the properties asserted are the ones
 * whose failure costs something:
 *
 *  - **a miss is silent.** A reply with no marker must read as a complete answer,
 *    or the screen will attach files the AI never asked for and recompile a prompt
 *    that was already fine.
 *  - **a requested path that does not exist is reported.** Silently dropping it
 *    produces a recompiled prompt missing exactly what was asked for — the failure
 *    this mechanism exists to prevent.
 *  - **one item per entry.** A reply asking for three files must yield three
 *    entries, or two of them are never attached and nothing says so.
 */

import { describe, expect, it } from 'vitest';
import {
  detectContextInsufficient,
  findMissingRequests,
} from '../../src/renderer/contextInsufficient.js';

/** An `exists` that answers from a fixed set. */
function existing(...files: string[]): (file: string) => boolean {
  const set = new Set(files);
  return (file: string): boolean => set.has(file);
}

describe('detectContextInsufficient — detecting the marker', () => {
  it('detects the marker in the form the contract block specifies', () => {
    const result = detectContextInsufficient('CONTEXT INSUFFICIENT: src/kart.js');

    expect(result.detected).toBe(true);
    expect(result.requested).toEqual(['src/kart.js']);
  });

  it('detects the interactive brief NEED: marker', () => {
    const result = detectContextInsufficient('NEED: src/track.js');

    expect(result.detected).toBe(true);
    expect(result.requested).toEqual(['src/track.js']);
  });

  it('is case-insensitive, because models do not copy the caps lock', () => {
    for (const spelling of [
      'context insufficient: src/kart.js',
      'Context Insufficient: src/kart.js',
      'CONTEXT INSUFFICIENT: src/kart.js',
      'cOnTeXt iNsUfFiCiEnT: src/kart.js',
    ]) {
      expect(detectContextInsufficient(spelling)).toMatchObject({
        detected: true,
        requested: ['src/kart.js'],
      });
    }
  });

  it('finds the marker surrounded by prose, and ignores the prose', () => {
    const reply = [
      "I can't fix this reliably yet — I would be guessing at the physics API.",
      '',
      'CONTEXT INSUFFICIENT: src/physics.js — the grip constants',
      '',
      'Once I can see that file I can tell you whether the value is a bug or a tuning choice.',
    ].join('\n');

    const result = detectContextInsufficient(reply);

    expect(result.detected).toBe(true);
    // The dash is the boundary the contract's own example uses, so what follows it
    // is the *reason* the AI wants the file, not a second request. Keeping it in
    // the attachment list would put prose on a list of paths.
    expect(result.requested).toEqual(['src/physics.js']);
  });

  it('drops the contract\'s own "Need" word from the request', () => {
    // The contract says: `CONTEXT INSUFFICIENT: Need <file path> — <what you need>`.
    // Reading the request as literally "Need src/kart.js" would attach nothing and
    // report the file as missing, which is the loop failing on its own prompt.
    const result = detectContextInsufficient('CONTEXT INSUFFICIENT: Need src/kart.js — the update loop');

    expect(result.requested).toEqual(['src/kart.js']);
  });

  it('strips a space before the colon, which models do produce', () => {
    expect(detectContextInsufficient('CONTEXT INSUFFICIENT : src/kart.js').requested).toEqual([
      'src/kart.js',
    ]);
  });

  it('reads a marker a Markdown bullet put in front of the line', () => {
    // Models format refusals as a list. Treating that as prose would miss the
    // single most likely way the marker is actually written.
    const result = detectContextInsufficient('Here is what I still need:\n- CONTEXT INSUFFICIENT: src/kart.js');

    expect(result.requested).toEqual(['src/kart.js']);
  });

  it('finds a second marker further down the reply', () => {
    const reply = 'CONTEXT INSUFFICIENT: src/kart.js\n\nAlso:\n\nCONTEXT INSUFFICIENT: src/track.js';

    expect(detectContextInsufficient(reply).requested).toEqual(['src/kart.js', 'src/track.js']);
  });

  it('is deterministic, so the same reply attaches the same files every time', () => {
    // (SPEC R8.) A detector that carried state between calls would attach
    // different files for the same conversation, and the developer would have no
    // way to tell a model change from a tool change.
    const reply = 'CONTEXT INSUFFICIENT: src/kart.js, src/track.js';

    const first = detectContextInsufficient(reply);
    const second = detectContextInsufficient(reply);

    expect(first).toEqual(second);
    expect(first).toEqual(second);
  });

  it('deduplicates a repeated request, keeping the order the AI asked in', () => {
    // An AI that repeats itself must not produce three identical attachments.
    const reply = 'CONTEXT INSUFFICIENT: src/track.js, src/kart.js\nCONTEXT INSUFFICIENT: src/track.js';

    expect(detectContextInsufficient(reply).requested).toEqual(['src/track.js', 'src/kart.js']);
  });
});

describe('detectContextInsufficient — several items at once', () => {
  it('splits a comma-separated list into one entry each', () => {
    const result = detectContextInsufficient('CONTEXT INSUFFICIENT: src/kart.js, src/track.js, src/mesh.js');

    expect(result.detected).toBe(true);
    // One entry each, in the order asked: the developer reads this list in the
    // order the AI needed things, and attaching out of order would make the
    // recompile look arbitrary.
    expect(result.requested).toEqual(['src/kart.js', 'src/track.js', 'src/mesh.js']);
  });

  it('does not detect a marker whose colon ends the line, by design', () => {
    // The contract is explicit that the marker requires a colon and *at least one
    // character after it*, and this is the cost of that rule: a model that puts the
    // list on the following lines is not detected.
    //
    // It is the right trade. The alternative — accepting a bare marker and then
    // harvesting the next lines — would attach whatever happened to be written
    // after the marker, including prose about the protocol, which is the confident
    // wrong answer this whole screen exists to avoid. A missed marker is visible:
    // the reply sits on screen with the words "context insufficient" in it, and the
    // developer presses Compile again with a better description.
    expect(detectContextInsufficient('CONTEXT INSUFFICIENT:\n- src/kart.js\n- src/track.js')).toEqual({
      detected: false,
      requested: [],
      missing: [],
    });
  });

  it("reads the marker's own line and stops there", () => {
    // The payload is line-scoped, and that is deliberate. Letting it run on would
    // swallow whatever the model wrote next — usually an offer to continue once it
    // has the file — and that prose would then be attached as if it were a path.
    // One request per marker line is the whole of the contract's format; a model
    // wanting three files writes them on one line, or writes three markers.
    const reply = 'CONTEXT INSUFFICIENT: src/kart.js\n- src/track.js\n- src/mesh.js';

    expect(detectContextInsufficient(reply).requested).toEqual(['src/kart.js']);
  });

  it('splits two paths joined by "and", because two files were named', () => {
    const result = detectContextInsufficient('CONTEXT INSUFFICIENT: src/kart.js and src/track.js');

    expect(result.requested).toEqual(['src/kart.js', 'src/track.js']);
  });

  it('does not split a conjunction in prose, because one thing was named', () => {
    // "the update loop and the renderer" is a single need. Splitting it would put
    // two meaningless half-sentences on a list of files.
    const result = detectContextInsufficient(
      'CONTEXT INSUFFICIENT: I need the update loop and the way the renderer seeds it',
    );

    expect(result.requested).toHaveLength(1);
    expect(result.requested[0]).toContain('update loop');
  });

  it('keeps a description as one request rather than discarding it', () => {
    // It is a real answer from the model, and the developer is entitled to read
    // what the AI said it needed even when it is not a path.
    const result = detectContextInsufficient('CONTEXT INSUFFICIENT: the physics constants');

    expect(result.detected).toBe(true);
    expect(result.requested).toEqual(['the physics constants']);
  });
});

describe('detectContextInsufficient — replies with no marker', () => {
  it('does not detect a plain answer', () => {
    const reply = [
      'Here is the patch. The bug was that `speed` is read before it is set, so the',
      'first frame after a respawn always uses the previous kart\'s value.',
      '',
      '### EDIT: src/kart.js',
      '<<<<<<< FIND',
      '  this.speed = kart.speed;',
      '=======',
      '  this.speed = kart.speed ?? 0;',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = detectContextInsufficient(reply);

    expect(result.detected).toBe(false);
    expect(result.requested).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('does not detect an empty reply', () => {
    expect(detectContextInsufficient('')).toEqual({ detected: false, requested: [], missing: [] });
  });

  it('does not detect a bare marker with nothing after the colon', () => {
    // The contract quoted with no request. Attaching "nothing" is not possible, and
    // treating it as a request would recompile a prompt that did not need it.
    expect(detectContextInsufficient('CONTEXT INSUFFICIENT:').detected).toBe(false);
  });

  it('does not detect the rule quoted inside a sentence', () => {
    // The model is explaining the protocol, not using it. Anchoring to the start of
    // a line is what keeps this apart from a request.
    const reply = 'As I was told, I should reply CONTEXT INSUFFICIENT: <path> when I cannot see enough.';

    expect(detectContextInsufficient(reply).detected).toBe(false);
  });

  it('does not detect prose that merely mentions files', () => {
    const reply = 'I have looked at src/kart.js and src/track.js and I think the fix is in the latter.';

    expect(detectContextInsufficient(reply).detected).toBe(false);
  });

  it('does not detect the word "context" on its own', () => {
    expect(detectContextInsufficient('The context you gave me is ambiguous.').detected).toBe(false);
  });

  it('does not detect a marker whose colon was replaced by a dash', () => {
    // The contract is specific about the colon; anything looser starts matching
    // prose, and prose is not evidence.
    expect(detectContextInsufficient('CONTEXT INSUFFICIENT - src/kart.js').detected).toBe(false);
  });
});

describe('findMissingRequests — the paths that are not there', () => {
  it('reports a requested path that does not exist as missing', () => {
    // The case the whole mechanism exists for: the AI asked for `src/nope.js`
    // because it is wrong about the layout or a file was renamed. Silently dropping
    // it would produce a recompiled prompt missing exactly what was asked for.
    const missing = findMissingRequests(['src/nope.js'], existing('src/kart.js'));

    expect(missing).toEqual(['src/nope.js']);
  });

  it('does not report a path that does exist', () => {
    const missing = findMissingRequests(['src/kart.js'], existing('src/kart.js'));

    expect(missing).toEqual([]);
  });

  it('reports each absent path of several, and leaves the present one out', () => {
    const missing = findMissingRequests(
      ['src/kart.js', 'src/nope.js', 'res://scripts/Ghost.gd'],
      existing('src/kart.js'),
    );

    expect(missing).toEqual(['src/nope.js', 'res://scripts/Ghost.gd']);
  });

  it('does not judge existence for a request that is a description', () => {
    // There is nothing to look up, and guessing either way would put a false
    // finding next to real ones. The request stays in `requested` to be read.
    const missing = findMissingRequests(['the physics constants'], existing());

    expect(missing).toEqual([]);
  });

  it('treats a predicate that throws as "not found" for that item only', () => {
    // One unreachable path must not cost the developer the whole detection.
    const missing = findMissingRequests(
      ['src/kart.js', 'src/nope.js'],
      (file) => {
        if (file === 'src/kart.js') return true;
        throw new Error('EACCES');
      },
    );

    expect(missing).toEqual(['src/nope.js']);
  });

  it('reports nothing when nothing was requested', () => {
    expect(findMissingRequests([], existing())).toEqual([]);
  });
});

describe('the two halves together', () => {
  it('separates "what it asked for" from "what is not there"', () => {
    // Composed by hand rather than through a screen, which is what a renderer-free
    // test is for: the detector plus the existence check, with no store and no
    // component involved.
    const reply = 'CONTEXT INSUFFICIENT: src/kart.js, src/nope.js';
    const detected = detectContextInsufficient(reply);

    expect(detected.detected).toBe(true);
    expect(detected.requested).toEqual(['src/kart.js', 'src/nope.js']);

    const missing = findMissingRequests(detected.requested, existing('src/kart.js'));
    // Nothing was dropped: both requests are still on the list, and the absent one
    // is additionally flagged rather than quietly removed.
    expect(detected.requested).toHaveLength(2);
    expect(missing).toEqual(['src/nope.js']);
  });
});
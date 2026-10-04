/**
 * packages/core/test/scene/scaffoldPrompt.test.ts
 *
 * The New Project step 3 prompt, and the gate that decides whether it may be
 * copied at all.
 *
 * The gate is the point of this file. A copy button that is enabled for a
 * half-filled brief produces the worst outcome available: the developer pastes a
 * prompt, the AI builds nothing, and nothing anywhere says why. So the rule is
 * asserted three ways — that an empty idea blocks, that a real one does not, and
 * that the gate is literally `checkBrief` rather than a second implementation of
 * it that could drift.
 */

import { describe, expect, it } from 'vitest';
import { buildScaffoldPrompt, scaffoldPromptProblems } from '../../src/scene/scaffoldPrompt.js';
import { checkBrief } from '../../src/scene/template.js';
import { PREFAB_RULES } from '../../src/scene/lint.js';
import { SCENE_SCHEMA_VERSION } from '../../src/scene/scene.schema.js';

/** A brief that passes every rule. */
const good = { name: 'star-crawler', idea: 'You drive a hover car around a collapsing space station.' };

describe('scaffoldPromptProblems — the gate', () => {
  it('blocks an empty idea, which is the rule this phase exists for', () => {
    const problems = scaffoldPromptProblems({ name: 'star-crawler', idea: '' });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(/idea/);
  });

  it('blocks a whitespace-only idea', () => {
    // A developer who types spaces has not written an idea, and a prompt built
    // from `trim()`ed emptiness would silently scaffold a blank game.
    expect(scaffoldPromptProblems({ name: 'x', idea: '     ' }).length).toBeGreaterThan(0);
  });

  it('blocks a placeholder idea, and says it is a placeholder rather than too short', () => {
    // The specific message matters: "4 characters, need 20" sends the developer
    // to pad the text when what they need is to write something.
    const [problem] = scaffoldPromptProblems({ name: 'x', idea: 'TODO' });
    expect(problem).toMatch(/placeholder/);
  });

  it('blocks a too-short idea', () => {
    expect(scaffoldPromptProblems({ name: 'x', idea: 'a racing game' }).length).toBeGreaterThan(0);
  });

  it('blocks a missing or unusable name', () => {
    expect(scaffoldPromptProblems({ name: '', idea: good.idea }).length).toBeGreaterThan(0);
    expect(scaffoldPromptProblems({ name: 'has spaces', idea: good.idea }).length).toBeGreaterThan(0);
  });

  it('allows a complete brief', () => {
    expect(scaffoldPromptProblems(good)).toEqual([]);
  });

  it('is checkBrief itself, not a second implementation of it', () => {
    // If these ever diverge, the screen would enable a copy button that
    // `generateProject` then refuses. Asserting they agree on a spread of
    // briefs — including the ones just above — is what keeps them one function.
    const cases = [
      { name: '', idea: '' },
      { name: 'ok', idea: '' },
      { name: 'ok', idea: 'TODO' },
      { name: 'ok', idea: 'short' },
      { name: 'ok', idea: 'a genuinely specific description of the game' },
      { name: 'bad name', idea: 'a genuinely specific description of the game' },
    ];
    for (const brief of cases) {
      expect(scaffoldPromptProblems(brief), `brief ${JSON.stringify(brief)}`).toEqual(
        checkBrief(brief),
      );
    }
  });
});

describe('buildScaffoldPrompt', () => {
  const prompt = buildScaffoldPrompt(good);

  it("embeds the developer's idea verbatim", () => {
    // The whole point of the prompt. A paraphrase would be the AI's idea, not
    // the developer's, and the developer would only find out after the wrong
    // game had been built.
    expect(prompt).toContain(good.idea);
    expect(prompt).toContain(good.name);
  });

  it('names the scene schema version it expects, from the constant', () => {
    // Read from the constant, so the prompt cannot describe a version the code
    // no longer writes.
    expect(prompt).toContain(`schema_version ${SCENE_SCHEMA_VERSION}`);
  });

  it('states every prefab rule the linter enforces, by id', () => {
    // If a rule is added to the linter and not here, an AI told to follow the
    // prompt would break it — and the linter would be the only thing saying so.
    for (const rule of PREFAB_RULES) {
      expect(prompt, `prompt is missing prefab rule ${rule}`).toContain(rule);
    }
  });

  it('tells the AI the pin rule, which is a build error otherwise', () => {
    expect(prompt).toMatch(/pinned \*\*exactly\*\*/i);
    expect(prompt).toMatch(/\^/);
  });

  it('tells the AI to ask for a file it cannot see rather than guess', () => {
    // `\s+` rather than a literal space because the sentence wraps across a
    // newline. The rule is line-wrapped in the prompt for readability, and the
    // test must not care where the wrap falls.
    expect(prompt).toMatch(/do\s+not\s+guess/i);
  });

  it('is byte-identical across runs with the same brief', () => {
    // Determinism: the prompt is compared as a string by tests and diffed by
    // developers, so two runs must produce the same bytes.
    expect(buildScaffoldPrompt(good)).toBe(prompt);
  });

  it('changes when the idea changes', () => {
    const other = buildScaffoldPrompt({ ...good, idea: 'You dig tunnels under a frozen sea.' });
    expect(other).not.toBe(prompt);
    expect(other).toContain('You dig tunnels under a frozen sea.');
  });

  it('still renders a readable prompt for an empty brief, marked as unwritten', () => {
    // The screen shows a preview before the brief is valid, and a builder that
    // threw would leave the developer staring at an error instead of the thing
    // they are about to fill in. The placeholder is visibly a placeholder.
    const preview = buildScaffoldPrompt({ name: '', idea: '' });
    expect(preview).toContain('(not written yet)');
    expect(preview.length).toBeGreaterThan(500);
  });

  it('removes mentions of kart and trackSegment and two prefabs (C1, C2)', () => {
    expect(prompt).not.toContain('trackSegment');
    expect(prompt).not.toContain('kart');
    expect(prompt).not.toContain('two prefabs');
  });

  it('includes the How to reply section (C3)', () => {
    expect(prompt).toContain(
      'How to reply: reply with every file, one block per file, no other text. Each block is a line starting with ### FILE: followed by the project-relative path, then the full file contents in a code fence. First version must be small and must run with npm install then npm run dev.',
    );
  });
});
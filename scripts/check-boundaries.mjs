#!/usr/bin/env node
/**
 * scripts/check-boundaries.mjs
 *
 * Enforces SPEC.md rule R4: packages/core never imports from packages/app,
 * and rule R3: core never imports UI/DOM/Electron packages.
 *
 * Fails with a non-zero exit code and a list of offending file:line so the
 * violation is impossible to miss in CI.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreSrc = join(repoRoot, 'packages', 'core', 'src');

/** Packages core is never allowed to import (SPEC R3/R4). */
const FORBIDDEN_SPECIFIERS = [
  '@contextforge/app',
  'svelte',
  'electron',
  'svelte/electron',
];

/** Substrings of a bare specifier that mean "UI layer". */
const FORBIDDEN_SUBSTRINGS = ['/app/', 'svelte', 'electron', 'three'];

/** DOM globals core must never touch (SPEC R3). */
const FORBIDDEN_DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'HTMLElement',
];

function isIgnoredDir(name) {
  return name === 'node_modules' || name === 'dist' || name.startsWith('.');
}

/**
 * Blank out comments and string literals, keeping the code structure intact.
 *
 * Purpose: a DOM global mentioned only inside a comment or a string is not a
 * DOM access, and flagging it would make the check unusable.
 *
 * Implemented as a single forward scan rather than regexes. The obvious regex
 * `(['"`])(?:\\.|(?!\1).)*\1` backtracks catastrophically on an unterminated
 * quote or an escaped backslash — which is common in the regex literals these
 * files contain — and hangs the checker. A scanner always terminates.
 *
 * `keepQuotedContents` exists because the two checks need different masks, and
 * conflating them silently disables one of them:
 *
 *  - the **DOM global** check needs every string blanked, because a string is
 *    where a false positive is most likely;
 *  - the **import** check needs single- and double-quoted contents *kept*,
 *    because that is where the specifier lives — blanking them reduces
 *    `from 'three'` to `from ""` and the check finds nothing at all.
 *
 * Template literals are always blanked, including their `${...}`. That is what
 * makes the import check correct for this repository: core emits whole modules
 * as template literals (the project-template generator writes a `loadScene.ts`
 * that imports Three.js), and that generated import must not be reported as if
 * core had imported Three.js itself.
 */
function stripCommentsAndStrings(source, { keepQuotedContents = false } = {}) {
  let out = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const char = source[i];
    const next = source[i + 1];

    // Line comment
    if (char === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }

    // Block comment
    if (char === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      // Preserve the newline so line numbers stay accurate.
      out += '\n';
      continue;
    }

    // String or template literal
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      const keep = keepQuotedContents && quote !== '`';
      let blanked = '';

      i++;
      while (i < n) {
        if (source[i] === '\\') {
          if (keep) blanked += source[i] + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        if (keep) {
          blanked += source[i];
        } else if (quote === '`' && source[i] === '\n') {
          // A template literal can span lines; keep the newline so the line
          // numbers reported downstream still line up with the real file.
          out += '\n';
        }
        i++;
      }

      out += keep ? `${quote}${blanked}${quote}` : '""';
      continue;
    }

    out += char;
    i++;
  }

  return out;
}

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (isIgnoredDir(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
})(coreSrc);

const violations = [];

for (const file of files) {
  const rel = relative(repoRoot, file);
  const source = readFileSync(file, 'utf-8');

  // The import scan runs against a mask that keeps quoted contents but blanks
  // template literals.
  //
  // Core contains modules that emit whole source files as template literals —
  // the project-template generator writes a `loadScene.ts` that imports Three.js.
  // Scanning raw lines reported that generated import as if core had imported
  // Three.js itself. Blanking template literals fixes exactly that, and cannot
  // hide a real import: an import statement is never inside a template literal.
  const importScanSource = stripCommentsAndStrings(source, { keepQuotedContents: true });
  const lines = importScanSource.split('\n');

  lines.forEach((line, i) => {
    // Only look at real import/export statements and dynamic import().
    const importMatch =
      /(?:^|\s)(?:import|export)\s[^(]*?from\s*['"]([^'"]+)['"]/.exec(line) ??
      /(?:^|\s)import\s*['"]([^'"]+)['"]/.exec(line) ??
      /(?:^|\s)import\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(line) ??
      /(?:^|\s)(?:const|let|var)\s+[\w${}*\s]*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(line);
    if (!importMatch || !importMatch[1]) return;

    const specifier = importMatch[1];
    const lineNo = i + 1;

    for (const forbidden of FORBIDDEN_SPECIFIERS) {
      if (specifier === forbidden || specifier.startsWith(`${forbidden}/`)) {
        violations.push(`${rel}:${lineNo} — imports forbidden package "${specifier}" (SPEC R3/R4)`);
      }
    }

    if (!specifier.startsWith('.') && !specifier.startsWith('node:') && !specifier.startsWith('@')) {
      const bare = specifier.split('/').slice(0, 2).join('/');
      for (const needle of FORBIDDEN_SUBSTRINGS) {
        if (bare.includes(needle)) {
          violations.push(`${rel}:${lineNo} — imports UI-layer package "${specifier}" (SPEC R3)`);
        }
      }
    }

    // Relative import reaching outside packages/core
    if (specifier.startsWith('.')) {
      const resolved = join(dirname(file), specifier);
      const insideCore = resolved.startsWith(coreSrc);
      if (!insideCore) {
        violations.push(`${rel}:${lineNo} — relative import "${specifier}" escapes packages/core (SPEC R4)`);
      }
    }
  });

  // DOM globals: only flag real references, not the word inside a comment or a
  // string literal. The negative lookahead rejects identifiers that merely start
  // with the global's name — `TscnDocument` and `document` are unrelated, and
  // core uses the former legitimately.
  //
  // This mask blanks *every* string, unlike the import mask above: a DOM global
  // mentioned in prose inside a string is exactly the false positive to avoid.
  const domScanSource = stripCommentsAndStrings(source);

  for (const globalName of FORBIDDEN_DOM_GLOBALS) {
    const re = new RegExp(`(?<![A-Za-z0-9_$])${globalName}(?![A-Za-z0-9_$])`);
    const match = re.exec(domScanSource);
    if (match) {
      const lineNo = domScanSource.slice(0, match.index).split('\n').length;
      violations.push(`${rel}:${lineNo} — references DOM global "${globalName}" (SPEC R3)`);
    }
  }
}

if (violations.length > 0) {
  console.error('Package boundary violations:\n');
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error(`\n${violations.length} violation(s). Core must stay headless (SPEC R3/R4).`);
  process.exit(1);
}

console.log(`check:boundaries — ${files.length} core source files, 0 violations.`);

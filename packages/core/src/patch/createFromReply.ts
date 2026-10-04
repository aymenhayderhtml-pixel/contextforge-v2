/**
 * patch/createFromReply.ts — create a new project from an AI reply.
 *
 * ## The flow (Step 4 logic)
 *
 * The developer pastes the AI's reply into Step 4 of the New Project wizard.
 * The core logic:
 *   1. Parses the reply with core's existing `parseFileBlocks`.
 *   2. Refuses any `### EDIT:` blocks — a new project has no existing files to edit.
 *   3. Refuses any file path that escapes the new folder, validated through
 *      `resolveInsideRoot` (symlink-safe, traversal-safe).
 *   4. Refuses if the target folder already exists and is not empty.
 *   5. Validates the syntax of every file (tree-sitter for JS/TS/GDScript, JSON.parse for JSON).
 *   6. Writes all files or none (all-or-nothing atomic write).
 *   7. `previewProjectFromReply` performs all the exact same checks without writing anything.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveInsideRoot } from '../fs/resolveInsideRoot.js';
import { parseEditBlocks } from './editBlocks.js';
import { parseFileBlocks } from './fileBlocks.js';
import { validateContentSyntax, type SyntaxCheckResult } from './syntaxCheck.js';

export interface CreateProjectOptions {
  parentFolder: string;
  projectName: string;
  reply: string;
}

export interface ProjectReplyFileVerdict {
  path: string;
  content: string;
  syntax: SyntaxCheckResult;
}

export interface PreviewProjectResult {
  ok: boolean;
  targetFolder: string;
  files: ProjectReplyFileVerdict[];
  refusal?: string | undefined;
}

export interface CreateProjectResult {
  ok: boolean;
  targetFolder: string;
  files: ProjectReplyFileVerdict[];
  refusal?: string | undefined;
  created?: boolean | undefined;
}

function normalizeArgs(
  parentFolderOrOpts: string | CreateProjectOptions,
  projectName?: string,
  reply?: string,
): { parentFolder: string; projectName: string; reply: string } {
  if (typeof parentFolderOrOpts === 'object' && parentFolderOrOpts !== null) {
    return {
      parentFolder: parentFolderOrOpts.parentFolder ?? '',
      projectName: parentFolderOrOpts.projectName ?? '',
      reply: parentFolderOrOpts.reply ?? '',
    };
  }
  return {
    parentFolder: parentFolderOrOpts ?? '',
    projectName: projectName ?? '',
    reply: reply ?? '',
  };
}

/**
 * Validates the project name against safe naming conventions.
 */
function validateProjectName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return 'Project name cannot be empty.';
  }
  if (trimmed === '.' || trimmed === '..') {
    return 'Project name cannot be "." or "..".';
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return 'Project name cannot contain path separators.';
  }
  // Lowercase letters, numbers, and dashes per UI hint (plus underscores)
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return 'Project name may only contain letters, numbers, dashes, and underscores.';
  }
  return null;
}

/**
 * Preview the files and checks that would be applied from the pasted reply.
 *
 * Pure read-only validation: writes nothing to disk.
 */
export function previewProjectFromReply(
  parentFolder: string,
  projectName: string,
  reply: string,
): PreviewProjectResult;
export function previewProjectFromReply(opts: CreateProjectOptions): PreviewProjectResult;
export function previewProjectFromReply(
  parentFolderOrOpts: string | CreateProjectOptions,
  projectNameArg?: string,
  replyArg?: string,
): PreviewProjectResult {
  const { parentFolder, projectName, reply } = normalizeArgs(
    parentFolderOrOpts,
    projectNameArg,
    replyArg,
  );

  const nameError = validateProjectName(projectName);
  if (nameError) {
    return {
      ok: false,
      targetFolder: '',
      files: [],
      refusal: nameError,
    };
  }

  const trimmedParent = parentFolder.trim();
  if (!trimmedParent) {
    return {
      ok: false,
      targetFolder: '',
      files: [],
      refusal: 'Parent folder cannot be empty.',
    };
  }

  const targetFolder = resolve(trimmedParent, projectName.trim());

  // 1. Refuse if target folder already exists and is not empty
  if (existsSync(targetFolder)) {
    try {
      const st = statSync(targetFolder);
      if (!st.isDirectory()) {
        return {
          ok: false,
          targetFolder,
          files: [],
          refusal: `Target path already exists and is not a folder: ${targetFolder}`,
        };
      }
      const entries = readdirSync(targetFolder);
      if (entries.length > 0) {
        return {
          ok: false,
          targetFolder,
          files: [],
          refusal: `This folder already exists and is not empty: ${targetFolder}`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        targetFolder,
        files: [],
        refusal: `Could not inspect target folder ${targetFolder}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 2. Refuse ### EDIT: blocks (there are no existing files)
  const editBlocks = parseEditBlocks(reply);
  if (editBlocks.length > 0) {
    return {
      ok: false,
      targetFolder,
      files: [],
      refusal:
        'The reply contains ### EDIT: blocks. A new project must be created from ### FILE: blocks only.',
    };
  }

  // 3. Parse ### FILE: blocks
  const fileBlocks = parseFileBlocks(reply);
  if (fileBlocks.length === 0) {
    return {
      ok: false,
      targetFolder,
      files: [],
      refusal: 'No ### FILE: blocks found in the reply.',
    };
  }

  // 4. Validate containment and syntax for each file
  const verdicts: ProjectReplyFileVerdict[] = [];
  let hasSyntaxError = false;
  let syntaxErrorMessage: string | undefined;

  for (const block of fileBlocks) {
    // Check containment via resolveInsideRoot (symlink-safe, traversal-safe)
    const containment = resolveInsideRoot(targetFolder, block.path, { allowMissingRoot: true });
    if (!containment.ok) {
      return {
        ok: false,
        targetFolder,
        files: verdicts,
        refusal: containment.reason,
      };
    }

    // Run syntax verification
    const syntax = validateContentSyntax(containment.value.relativePath, block.content);
    if (!syntax.valid) {
      hasSyntaxError = true;
      if (!syntaxErrorMessage) {
        syntaxErrorMessage = `Syntax error in ${syntax.file}${syntax.line ? ` line ${syntax.line}` : ''}: ${syntax.message}`;
      }
    }

    verdicts.push({
      path: containment.value.relativePath,
      content: block.content,
      syntax,
    });
  }

  if (hasSyntaxError) {
    return {
      ok: false,
      targetFolder,
      files: verdicts,
      refusal: syntaxErrorMessage ?? 'Syntax check failed on one or more files.',
    };
  }

  return {
    ok: true,
    targetFolder,
    files: verdicts,
  };
}

/**
 * Creates the project folder and writes all files from the AI reply.
 *
 * Guarantees all-or-nothing atomicity: if any file fails validation or any
 * write operation fails, writes nothing or cleans up completely.
 */
export function createProjectFromReply(
  parentFolder: string,
  projectName: string,
  reply: string,
): CreateProjectResult;
export function createProjectFromReply(opts: CreateProjectOptions): CreateProjectResult;
export function createProjectFromReply(
  parentFolderOrOpts: string | CreateProjectOptions,
  projectNameArg?: string,
  replyArg?: string,
): CreateProjectResult {
  const args = normalizeArgs(parentFolderOrOpts, projectNameArg, replyArg);
  const preview = previewProjectFromReply(args.parentFolder, args.projectName, args.reply);

  // If preview failed any check (refusal or syntax error), write nothing
  if (!preview.ok) {
    return {
      ok: false,
      targetFolder: preview.targetFolder,
      files: preview.files,
      refusal: preview.refusal,
      created: false,
    };
  }

  const { targetFolder, files } = preview;
  const targetFolderExistedBefore = existsSync(targetFolder);
  const writtenFiles: string[] = [];

  try {
    if (!targetFolderExistedBefore) {
      mkdirSync(targetFolder, { recursive: true });
    }

    for (const file of files) {
      const absPath = join(targetFolder, file.path);
      const parentDir = dirname(absPath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
      writeFileSync(absPath, file.content, 'utf-8');
      writtenFiles.push(absPath);
    }

    return {
      ok: true,
      targetFolder,
      files,
      created: true,
    };
  } catch (err) {
    // Rollback: clean up written files and targetFolder if newly created
    for (const f of writtenFiles) {
      try {
        unlinkSync(f);
      } catch {
        // ignore rollback errors
      }
    }
    if (!targetFolderExistedBefore) {
      try {
        rmSync(targetFolder, { recursive: true, force: true });
      } catch {
        // ignore rollback errors
      }
    }

    return {
      ok: false,
      targetFolder,
      files,
      refusal: `Failed to write project files: ${err instanceof Error ? err.message : String(err)}`,
      created: false,
    };
  }
}

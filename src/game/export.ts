/**
 * Export a workspace as a ZIP that passes Flaxia Arcade's upload validators.
 *
 * A studio workspace contains project files (README.md, `.flaxia/`) that
 * Arcade refuses: dotfiles are never served and only an allowlist of game
 * assets may be uploaded. This module filters those out before encoding and
 * reports what was left behind so the UI can explain the selection.
 */

import { exportZip, type ZipFile } from '../fs/zip.ts';
import { isPlayPayloadPath, mimeForPath, pickEntryPoint, playPathProblem } from '../play/policy.ts';

export interface ExcludedFile {
  path: string;
  reason: string;
}

export interface ArcadeExportResult {
  bytes: Uint8Array;
  entry: string;
  included: string[];
  excluded: ExcludedFile[];
}

/** Why a workspace file cannot be published, or null when it is game content. */
export function arcadeExclusionReason(path: string): string | null {
  const problem = playPathProblem(path);
  if (problem) return problem;
  if (mimeForPath(path) === null) return `File type is not in the Arcade allowlist: ${path}`;
  return null;
}

/** Splits workspace files into publishable content and excluded project files. */
export function selectArcadeFiles(files: readonly ZipFile[]): {
  included: ZipFile[];
  excluded: ExcludedFile[];
} {
  const included: ZipFile[] = [];
  const excluded: ExcludedFile[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const reason =
      arcadeExclusionReason(file.path) ?? (isPlayPayloadPath(file.path) ? null : 'Not game content');
    if (reason !== null) {
      excluded.push({ path: file.path, reason });
      continue;
    }
    if (seen.has(file.path)) {
      excluded.push({ path: file.path, reason: `Duplicate path: ${file.path}` });
      continue;
    }
    seen.add(file.path);
    included.push(file);
  }

  return { included, excluded };
}

/** Builds an Arcade-ready ZIP, requiring a usable entry document. */
export function buildArcadeZip(files: readonly ZipFile[]): ArcadeExportResult {
  const { included, excluded } = selectArcadeFiles(files);
  const entry = pickEntryPoint(included.map((file) => file.path));
  if (!entry) throw new Error('No index.html found among publishable files.');
  return {
    bytes: exportZip(included),
    entry,
    included: included.map((file) => file.path),
    excluded,
  };
}

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { normalizePath } from './path.ts';

export interface ZipImportResult {
  files: Array<{ path: string; content: string }>;
  directories: string[];
  skipped: string[];
  bytes: number;
}

const MAX_ENTRIES = 2000;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function importZip(data: Uint8Array): ZipImportResult {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data);
  } catch (error) {
    throw new Error(`Invalid ZIP archive: ${error instanceof Error ? error.message : String(error)}`);
  }

  const names = Object.keys(entries);
  if (names.length > MAX_ENTRIES) {
    throw new Error(`ZIP contains too many entries (${names.length} > ${MAX_ENTRIES}).`);
  }

  const files: Array<{ path: string; content: string }> = [];
  const directories = new Set<string>();
  const skipped: string[] = [];
  let total = 0;

  for (const name of names) {
    if (name.startsWith('__MACOSX/') || name.endsWith('.DS_Store')) continue;
    const raw = entries[name];
    if (!raw) continue;
    let path: string;
    try {
      path = normalizePath(name.replace(/\/+$/, ''));
    } catch {
      skipped.push(name);
      continue;
    }
    if (!path) continue;

    if (name.endsWith('/')) {
      directories.add(path);
      continue;
    }

    total += raw.byteLength;
    if (total > MAX_TOTAL_BYTES) throw new Error('ZIP expands beyond the 50 MB workspace limit.');
    if (raw.byteLength > MAX_FILE_BYTES) {
      skipped.push(path);
      continue;
    }

    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      files.push({ path, content });
    } catch {
      skipped.push(path);
    }
  }

  return { files, directories: [...directories], skipped, bytes: total };
}

export function exportZip(files: Array<{ path: string; content: string }>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) {
    entries[file.path] = strToU8(file.content);
  }
  return zipSync(entries, { level: 6 });
}

export function decodeZipEntry(data: Uint8Array): string {
  return strFromU8(data);
}

import { strToU8, unzipSync, zipSync } from 'fflate';
import { base64ToBytes, bytesToBase64 } from './base64.ts';
import { normalizePath } from './path.ts';

export interface ZipFile {
  path: string;
  content: string;
  binary?: boolean;
}

export interface ZipImportResult {
  files: ZipFile[];
  directories: string[];
  skipped: string[];
  bytes: number;
}

const MAX_ENTRIES = 2000;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

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

  const files: ZipFile[] = [];
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

    const text = tryDecodeText(raw);
    if (text !== null) {
      files.push({ path, content: text });
    } else {
      files.push({ path, content: bytesToBase64(raw), binary: true });
    }
  }

  return { files, directories: [...directories], skipped, bytes: total };
}

export function exportZip(files: ZipFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) {
    entries[file.path] = file.binary ? base64ToBytes(file.content) : strToU8(file.content);
  }
  return zipSync(entries, { level: 6 });
}

function tryDecodeText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}

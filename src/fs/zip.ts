import { strToU8, unzipSync, zipSync } from 'fflate';
import { normalizePath } from './path.ts';

/** A workspace file restored from a ZIP archive. */
export type ZipFile =
  | { path: string; type: 'text'; text: string }
  | { path: string; type: 'binary'; bytes: Uint8Array };

export interface ZipImportResult {
  files: ZipFile[];
  directories: string[];
  skipped: string[];
  bytes: number;
}

const MAX_ENTRIES = 4000;
/** 1 GiB uncompressed; `unzipSync` holds the archive in memory. */
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
/** 512 MiB per entry. */
const MAX_FILE_BYTES = 512 * 1024 * 1024;

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
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(`ZIP expands beyond the ${MAX_TOTAL_BYTES / (1024 * 1024 * 1024)} GB workspace limit.`);
    }
    if (raw.byteLength > MAX_FILE_BYTES) {
      throw new Error(`${path} is larger than the ${MAX_FILE_BYTES / (1024 * 1024)} MB file limit.`);
    }

    const text = tryDecodeText(raw);
    if (text !== null) files.push({ path, type: 'text', text });
    else files.push({ path, type: 'binary', bytes: raw });
  }

  return { files, directories: [...directories], skipped, bytes: total };
}

export function exportZip(files: ZipFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) {
    entries[file.path] = file.type === 'binary' ? file.bytes : strToU8(file.text);
  }
  return zipSync(entries, { level: 6 });
}

/** Decodes UTF-8 text, or null when the bytes are binary. */
export function tryDecodeText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}

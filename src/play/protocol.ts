/**
 * postMessage protocols used by Test Play.
 *
 * 1. Studio ↔ shell (`/play/shell.html`), same origin, typed handshake:
 *    `ready → init → init-ack → execute → result` (or `stopped`).
 * 2. Shell ↔ runtime (`/play/runtime.html`), the runtime runs inside the
 *    sandboxed game frame and therefore has an opaque origin. It owns the
 *    blob URLs: a blob created by the studio can not be loaded by an opaque
 *    document, so the game assets must be materialised inside the frame.
 *
 * Both sides validate the payload shape before acting on it.
 */

import type { PlayFile } from './policy.ts';
import { PLAY_STORAGE_MAX_BYTES, type PlayStorageOperation } from './storage.ts';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ERROR_LENGTH = 500;

/** Sent by a game inside the sandboxed iframe to request fullscreen. */
export const PLAY_FULLSCREEN_REQUEST = 'REQUEST_FULLSCREEN';

/** Console level relayed from the sandboxed game to the studio Output panel. */
export type PlayConsoleLevel = 'log' | 'info' | 'warn' | 'error';

export interface PlayConsoleEntry {
  level: PlayConsoleLevel;
  message: string;
  /** Payload-relative script path when known. */
  source?: string;
  line?: number;
  column?: number;
}

const CONSOLE_LEVELS = new Set<string>(['log', 'info', 'warn', 'error']);
const MAX_CONSOLE_SOURCE_LENGTH = 255;

export type PlayHostMessage =
  | { type: 'play:init'; requestId: string }
  | {
      type: 'play:execute';
      requestId: string;
      entry: string;
      files: PlayFile[];
      totalBytes: number;
      /** Namespaced save of the preview, seeded into the game frame. */
      storage: Record<string, string>;
    }
  | { type: 'play:stop'; requestId: string };

export type PlayShellMessage =
  | { type: 'play:ready' }
  | { type: 'play:init-ack'; requestId: string }
  | { type: 'play:result'; requestId: string; ok: boolean; error?: string }
  | { type: 'play:stopped'; requestId: string }
  | {
      type: 'play:storage-write';
      operation: PlayStorageOperation;
      key?: string;
      value?: string;
    }
  | { type: 'play:console'; entry: PlayConsoleEntry };

export interface PlayRuntimeFile {
  path: string;
  mime: string;
  bytes: Uint8Array;
}

export interface PlayRuntimePayload {
  entry: string;
  files: PlayRuntimeFile[];
  /** Rewritten documents: HTML and CSS with runtime asset placeholders. */
  texts: Record<string, string>;
  /** Seed for the game's localStorage shim. */
  storage: Record<string, string>;
}

export type PlayRuntimeMessage =
  | { type: 'play:runtime-ready' }
  | { type: 'play:runtime-started' }
  | { type: 'play:runtime-error'; error: string }
  | {
      type: 'play:storage-write';
      operation: PlayStorageOperation;
      key?: string;
      value?: string;
    }
  | { type: 'play:runtime-console'; entry: PlayConsoleEntry };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

function isPlayFile(value: unknown): value is PlayFile {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    value.bytes instanceof Uint8Array &&
    value.path.length > 0
  );
}

/** Storage snapshots are plain string maps, capped like Arcade's bridged save. */
function isStorageSnapshot(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  let size = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return false;
    size += key.length + entry.length;
    if (size > PLAY_STORAGE_MAX_BYTES) return false;
  }
  return true;
}

function isConsoleEntry(value: unknown): value is PlayConsoleEntry {
  if (!isRecord(value)) return false;
  if (typeof value.level !== 'string' || !CONSOLE_LEVELS.has(value.level)) return false;
  if (typeof value.message !== 'string' || value.message.length > MAX_ERROR_LENGTH) return false;
  if (value.source !== undefined) {
    if (typeof value.source !== 'string' || value.source.length > MAX_CONSOLE_SOURCE_LENGTH) return false;
  }
  if (value.line !== undefined && (!Number.isInteger(value.line) || (value.line as number) < 0)) return false;
  if (value.column !== undefined && (!Number.isInteger(value.column) || (value.column as number) < 0))
    return false;
  return true;
}

function isStorageWrite(value: unknown): value is {
  operation: PlayStorageOperation;
  key?: string;
  value?: string;
} {
  if (!isRecord(value)) return false;
  if (value.operation !== 'set' && value.operation !== 'remove' && value.operation !== 'clear') {
    return false;
  }
  if (value.key !== undefined && typeof value.key !== 'string') return false;
  if (value.value !== undefined && typeof value.value !== 'string') return false;
  if (value.operation !== 'clear' && typeof value.key !== 'string') return false;
  if (value.operation === 'set' && typeof value.value !== 'string') return false;
  return true;
}

export function isPlayHostMessage(value: unknown): value is PlayHostMessage {
  if (!isRecord(value)) return false;
  if (value.type === 'play:init') return isRequestId(value.requestId);
  if (value.type === 'play:stop') return isRequestId(value.requestId);
  if (value.type === 'play:execute') {
    return (
      isRequestId(value.requestId) &&
      typeof value.entry === 'string' &&
      Array.isArray(value.files) &&
      value.files.every(isPlayFile) &&
      typeof value.totalBytes === 'number' &&
      Number.isFinite(value.totalBytes) &&
      isStorageSnapshot(value.storage)
    );
  }
  return false;
}

export function isPlayShellMessage(value: unknown): value is PlayShellMessage {
  if (!isRecord(value)) return false;
  if (value.type === 'play:ready') return true;
  if (value.type === 'play:init-ack') return isRequestId(value.requestId);
  if (value.type === 'play:stopped') return isRequestId(value.requestId);
  if (value.type === 'play:storage-write') return isStorageWrite(value);
  if (value.type === 'play:console') return isConsoleEntry(value.entry);
  if (value.type === 'play:result') {
    if (!isRequestId(value.requestId) || typeof value.ok !== 'boolean') return false;
    return (
      value.error === undefined || (typeof value.error === 'string' && value.error.length <= MAX_ERROR_LENGTH)
    );
  }
  return false;
}

export function isPlayRuntimeMessage(value: unknown): value is PlayRuntimeMessage {
  if (!isRecord(value)) return false;
  if (value.type === 'play:runtime-ready') return true;
  if (value.type === 'play:runtime-started') return true;
  if (value.type === 'play:storage-write') return isStorageWrite(value);
  if (value.type === 'play:runtime-console') return isConsoleEntry(value.entry);
  if (value.type === 'play:runtime-error') {
    return typeof value.error === 'string' && value.error.length <= MAX_ERROR_LENGTH;
  }
  return false;
}

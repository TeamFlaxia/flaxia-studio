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

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ERROR_LENGTH = 500;

/** Sent by a game inside the sandboxed iframe to request fullscreen. */
export const PLAY_FULLSCREEN_REQUEST = 'REQUEST_FULLSCREEN';

export type PlayHostMessage =
  | { type: 'play:init'; requestId: string }
  | { type: 'play:execute'; requestId: string; entry: string; files: PlayFile[]; totalBytes: number }
  | { type: 'play:stop'; requestId: string };

export type PlayShellMessage =
  | { type: 'play:ready' }
  | { type: 'play:init-ack'; requestId: string }
  | { type: 'play:result'; requestId: string; ok: boolean; error?: string }
  | { type: 'play:stopped'; requestId: string };

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
}

export type PlayRuntimeMessage =
  | { type: 'play:runtime-ready' }
  | { type: 'play:runtime-started' }
  | { type: 'play:runtime-error'; error: string };

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
      Number.isFinite(value.totalBytes)
    );
  }
  return false;
}

export function isPlayShellMessage(value: unknown): value is PlayShellMessage {
  if (!isRecord(value)) return false;
  if (value.type === 'play:ready') return true;
  if (value.type === 'play:init-ack') return isRequestId(value.requestId);
  if (value.type === 'play:stopped') return isRequestId(value.requestId);
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
  if (value.type === 'play:runtime-error') {
    return typeof value.error === 'string' && value.error.length <= MAX_ERROR_LENGTH;
  }
  return false;
}

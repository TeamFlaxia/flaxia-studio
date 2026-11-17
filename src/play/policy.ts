/**
 * Flaxia Arcade execution policy for Test Play.
 *
 * Limits, sandbox flags and the extension allowlist mirror Flaxia Arcade
 * (`flaxia/src/lib/file-extensions.ts`, `flaxia/src/lib/zip-constants.ts`,
 * `flaxia/sandbox/zip-preview.js`) so a workspace runs under the same rules as
 * a published game. `allow-same-origin` is permanently banned.
 *
 * The path rules follow the strictest of the Arcade validators
 * (`flaxia/src/lib/wvfs-zip-server.ts`, `flaxia/sandbox/game-loader/protocol.js`):
 * no traversal, no absolute paths, no dotfiles, no control characters and no
 * duplicate entries.
 */

export const PLAY_MAX_FILE_COUNT = 1024;
export const PLAY_MAX_PATH_LENGTH = 255;
export const PLAY_MAX_PATH_DEPTH = 10;
export const PLAY_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const PLAY_MAX_TRANSFER_BYTES = 25 * 1024 * 1024;
export const PLAY_HANDSHAKE_TIMEOUT_MS = 10_000;
export const PLAY_LOAD_TIMEOUT_MS = 30_000;

export const PLAY_SANDBOX_FLAGS = 'allow-scripts allow-pointer-lock allow-forms allow-popups';
export const PLAY_FRAME_ALLOW = 'fullscreen; web-share';

export const ALLOWED_EXTENSIONS: Record<string, string> = {
  // Web content
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',

  // Images (no '.svg': scriptable SVG is an XSS vector, same as Arcade)
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',

  // Fonts
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',

  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/opus',

  // Video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',

  // WebAssembly and binary
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.unityweb': 'application/octet-stream',
  '.wasm.code': 'application/wasm',
  '.wasm.framework': 'application/octet-stream',

  // Text and shaders
  '.txt': 'text/plain',
  '.glsl': 'text/plain',
  '.wgsl': 'text/plain',
  '.rsp': 'text/plain',
  '.cf': 'text/plain',
  '.zip': 'application/zip',
};

export interface PlayFile {
  path: string;
  bytes: Uint8Array;
}

export interface PlayPayload {
  entry: string;
  files: PlayFile[];
  totalBytes: number;
}

/**
 * Characters Arcade refuses inside a path segment: the Windows-illegal set
 * (`flaxia/sandbox/game-loader/protocol.js`) plus control characters, which are
 * checked by code point so the rule stays readable.
 */
const INVALID_SEGMENT = /[<>:"|?*]/;

function hasControlCharacter(segment: string): boolean {
  for (const character of segment) {
    if (character.charCodeAt(0) < 32) return true;
  }
  return false;
}

/** Extension resolved from the basename, lowercased; empty when there is none. */
export function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? path;
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index).toLowerCase();
}

export function mimeForPath(path: string): string | null {
  return ALLOWED_EXTENSIONS[extensionOf(path)] ?? null;
}

/**
 * Why a path may not be part of a payload, or null when it is fine.
 *
 * Arcade validates a sealed ZIP where every entry must be allowlisted; a
 * workspace is a project, so the same rules decide what may enter the payload
 * and what is simply left out.
 */
export function playPathProblem(path: string): string | null {
  if (path.length > PLAY_MAX_PATH_LENGTH) return `Path too long: ${path}`;
  if ((path.match(/\//g) ?? []).length > PLAY_MAX_PATH_DEPTH) return `Directory too deep: ${path}`;
  if (path.includes('\\') || path.split('/').some((segment) => segment === '..')) {
    return 'Path traversal or ambiguous separators are not allowed';
  }
  if (path.startsWith('/') || /^[a-z]:/i.test(path)) return 'Absolute paths are not allowed';
  for (const segment of path.split('/')) {
    if (!segment) return `Invalid path segment: ${path}`;
    // Arcade never serves dotfiles (#91): they are not game content and they
    // would expose a file listing.
    if (segment.startsWith('.')) return `Dotfiles are not game content: ${segment}`;
    if (INVALID_SEGMENT.test(segment) || hasControlCharacter(segment)) {
      return `Invalid path segment: ${segment}`;
    }
  }
  return null;
}

/**
 * Whether a workspace file can be part of the play payload.
 *
 * Files outside the allowlist (README.md, sources, …) are simply not part of
 * the payload instead of failing the run.
 */
export function isPlayPayloadPath(path: string): boolean {
  if (mimeForPath(path) === null) return false;
  // Arcade rejects nested ZIPs outright; a workspace archive is not playable
  // content, so it stays out of the payload instead of failing the whole run.
  if (path.toLowerCase().endsWith('.zip')) return false;
  return playPathProblem(path) === null;
}

/** Shallowest `index.html` / `index.htm`, ties broken lexicographically. */
export function pickEntryPoint(paths: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  for (const path of paths) {
    const name = (path.split('/').pop() ?? '').toLowerCase();
    if (name !== 'index.html' && name !== 'index.htm') continue;
    const depth = (path.match(/\//g) ?? []).length;
    if (depth > bestDepth) continue;
    if (depth === bestDepth && best !== null && path >= best) continue;
    best = path;
    bestDepth = depth;
  }
  return best;
}

/** Arcade's `validateZip` rules, applied to the payload the shell receives. */
export function validatePlayFiles(files: PlayFile[]): PlayPayload {
  if (files.length > PLAY_MAX_FILE_COUNT) {
    throw new Error(`Too many files (max ${PLAY_MAX_FILE_COUNT})`);
  }

  let totalBytes = 0;
  const seen = new Set<string>();
  for (const file of files) {
    const path = file.path;
    const problem = playPathProblem(path);
    if (problem) throw new Error(problem);

    if (seen.has(path)) throw new Error(`Duplicate path: ${path}`);
    seen.add(path);

    if (path.toLowerCase().endsWith('.zip')) {
      throw new Error('Nested ZIP files are not allowed');
    }
    if (mimeForPath(path) === null) {
      throw new Error(`File type not allowed: ${path}`);
    }

    totalBytes += file.bytes.byteLength;
    if (totalBytes > PLAY_MAX_TOTAL_BYTES) {
      throw new Error('Extracted size too large (max 100MB)');
    }
  }

  if (totalBytes > PLAY_MAX_TRANSFER_BYTES) {
    throw new Error(`Payload too large for Test Play (max ${PLAY_MAX_TRANSFER_BYTES / (1024 * 1024)}MB)`);
  }

  const entry = pickEntryPoint(files.map((file) => file.path));
  if (!entry) throw new Error('index.html not found in the workspace');

  return { entry, files, totalBytes };
}

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

/**
 * Pre-publication compatibility checker.
 *
 * Unlike `validatePlayFiles` (which throws on the first problem), this collects
 * every issue so the IDE can show them all in a Problems panel. Hard Arcade
 * publish blockers are separated from Test Play-only transfer advice and from
 * static hints that may be harmless but are risky in the sandboxed frame.
 */

export type CompatibilityScope = 'arcade' | 'test-play';

export interface CompatibilityIssue {
  code: string;
  scope: CompatibilityScope;
  severity: 'error' | 'warning';
  path: string | null;
  message: string;
}

export interface CompatibilityFile {
  path: string;
  content?: string;
  size?: number;
  binary?: boolean;
}

/** Shared note appended to every static hint: opaque origin and no CDN. */
const COMPATIBILITY_SANDBOX_NOTE =
  ' Flaxia Arcade forbids CDN dependencies: bundle every asset locally and use same-origin URLs.' +
  ' The game frame is sandboxed with an opaque origin, so Web Storage and cookies are unavailable.';

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Prefer an explicit size; otherwise measure the UTF-8 text content. */
function compatibilityFileSize(file: CompatibilityFile): number {
  if (typeof file.size === 'number' && Number.isFinite(file.size)) {
    return Math.max(0, file.size);
  }
  if (file.content !== undefined) return new TextEncoder().encode(file.content).length;
  // Binary files with neither a size nor content have no measurable payload;
  // count them as 0 instead of guessing.
  return 0;
}

/** Same control-character rule as the path validator, applied for issue coding. */
function hasCompatibilityControlCharacter(path: string): boolean {
  for (const character of path) {
    if (character.charCodeAt(0) < 32) return true;
  }
  return false;
}

/** Turn the message from `playPathProblem` into a stable, scoping-friendly code. */
function compatibilityPathCode(problem: string, path: string): string {
  if (problem.startsWith('Path too long')) return 'path-too-long';
  if (problem.startsWith('Directory too deep')) return 'path-too-deep';
  if (problem.startsWith('Path traversal')) return 'path-traversal';
  if (problem.startsWith('Absolute paths')) return 'absolute-path';
  if (problem.startsWith('Dotfiles')) return 'dotfile';
  if (hasCompatibilityControlCharacter(path)) return 'control-character';
  return 'invalid-path';
}

/**
 * Drop `//` lines and C-style block comments before scanning for risky APIs.
 * This is intentionally simple: string literals are not parsed, but the common
 * commented-out-code case no longer produces noisy warnings.
 */
function stripCompatibilityComments(source: string): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const line of source.split(/\r?\n/)) {
    let current = line;
    if (inBlock) {
      const end = current.indexOf('*/');
      if (end < 0) {
        kept.push('');
        continue;
      }
      current = current.slice(end + 2);
      inBlock = false;
    }
    let start = current.indexOf('/*');
    while (start >= 0) {
      const end = current.indexOf('*/', start + 2);
      if (end < 0) {
        current = current.slice(0, start);
        inBlock = true;
        break;
      }
      current = current.slice(0, start) + current.slice(end + 2);
      start = current.indexOf('/*');
    }
    if (current.trimStart().startsWith('//')) {
      kept.push('');
      continue;
    }
    kept.push(current);
  }
  return kept.join('\n');
}

const BARE_IMPORT_PATTERNS = [
  /^\s*(?:import|export)\s+[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
];

/** Module specifiers that need a bundler/resolver, which the archive has none of. */
function bareSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of BARE_IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
      const specifier = match[1] ?? '';
      if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) continue; // URL or node: scheme
      found.add(specifier);
    }
  }
  return [...found];
}

/**
 * All Arcade/Test Play compatibility problems in a candidate Web project.
 *
 * Counts and sizes reuse the Play limits, so a clean result here means the
 * same files also pass `validatePlayFiles`. Static hints are warnings only:
 * they flag sandbox-hostile APIs and unresolved imports for the author to
 * review, not malformed archives.
 */
export function checkArcadeCompatibility(files: readonly CompatibilityFile[]): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  const add = (
    code: string,
    scope: CompatibilityScope,
    severity: CompatibilityIssue['severity'],
    path: string | null,
    message: string,
  ): void => {
    issues.push({ code, scope, severity, path, message });
  };

  for (const file of files) {
    const path = file.path;
    const problem = playPathProblem(path);
    if (problem !== null) {
      add(compatibilityPathCode(problem, path), 'arcade', 'error', path, problem);
    }
    if (path.toLowerCase().endsWith('.zip')) {
      add('nested-zip', 'arcade', 'error', path, `Nested ZIP files are not allowed: ${path}`);
    } else if (mimeForPath(path) === null) {
      add(
        'disallowed-extension',
        'arcade',
        'error',
        path,
        `File type not allowed by the Arcade allowlist: ${path}`,
      );
    }
  }

  if (files.length > PLAY_MAX_FILE_COUNT) {
    add(
      'too-many-files',
      'arcade',
      'error',
      null,
      `Too many files (${files.length}); the Arcade limit is ${PLAY_MAX_FILE_COUNT}.`,
    );
  }

  let totalBytes = 0;
  for (const file of files) totalBytes += compatibilityFileSize(file);

  if (totalBytes > PLAY_MAX_TOTAL_BYTES) {
    add(
      'extracted-too-large',
      'arcade',
      'error',
      null,
      `Extracted size too large (${totalBytes} bytes; max ${PLAY_MAX_TOTAL_BYTES} bytes).`,
    );
  }
  if (totalBytes > PLAY_MAX_TRANSFER_BYTES) {
    add(
      'transfer-too-large',
      'test-play',
      'warning',
      null,
      `Payload exceeds the Test Play transfer cap of ${PLAY_MAX_TRANSFER_BYTES / (1024 * 1024)}MB ` +
        `(${totalBytes} bytes). This cap is specific to Test Play; Flaxia Arcade has no transfer cap.`,
    );
  }

  const entry = pickEntryPoint(files.map((file) => file.path));
  if (entry === null) {
    add(
      'missing-entry',
      'arcade',
      'error',
      null,
      'index.html not found; a published game needs an entry document.',
    );
  } else if (!entry.toLowerCase().endsWith('.html')) {
    add(
      'entry-not-html',
      'arcade',
      'warning',
      entry,
      `Entry point ${entry} is not index.html; rename it for Arcade.`,
    );
  }

  for (const file of files) {
    if (file.binary === true || file.content === undefined) continue;
    const source = stripCompatibilityComments(file.content);
    if (/\blocalStorage\b/.test(source)) {
      add(
        'local-storage',
        'arcade',
        'warning',
        file.path,
        `localStorage is unavailable in the opaque game frame.${COMPATIBILITY_SANDBOX_NOTE}`,
      );
    }
    if (/\bdocument\s*\.\s*cookie\b/.test(source)) {
      add(
        'document-cookie',
        'arcade',
        'warning',
        file.path,
        `document.cookie is unavailable in the opaque game frame.${COMPATIBILITY_SANDBOX_NOTE}`,
      );
    }
    if (/new\s+(?:Shared)?Worker\s*\(/.test(source)) {
      add(
        'worker',
        'arcade',
        'warning',
        file.path,
        'new Worker() requires a same-origin script URL; cross-origin and CDN workers are blocked.' +
          COMPATIBILITY_SANDBOX_NOTE,
      );
    }
    if (/\bimport\s*\(/.test(source)) {
      add(
        'dynamic-import',
        'arcade',
        'warning',
        file.path,
        'Dynamic import() cannot resolve remote/CDN modules in the sandbox; bundle every chunk locally.' +
          COMPATIBILITY_SANDBOX_NOTE,
      );
    }
    for (const specifier of bareSpecifiers(source)) {
      add(
        'bare-import',
        'arcade',
        'warning',
        file.path,
        `Bare module specifier "${specifier}" has no resolver in the published archive; ` +
          'use a relative path to a bundled local file.' +
          COMPATIBILITY_SANDBOX_NOTE,
      );
    }
  }

  // The Problems panel renders this directly: no duplicates, stable order.
  const seen = new Set<string>();
  const unique = issues.filter((issue) => {
    const key = [issue.code, issue.scope, issue.path ?? '', issue.severity, issue.message].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort(
    (a, b) =>
      compareText(a.code, b.code) ||
      compareText(a.scope, b.scope) ||
      compareText(a.path ?? '', b.path ?? '') ||
      compareText(a.severity, b.severity) ||
      compareText(a.message, b.message),
  );
  return unique;
}

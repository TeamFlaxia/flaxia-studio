export class PathError extends Error {}

export function normalizePath(input: string): string {
  const raw = input.replace(/\\/g, '/').trim();
  if (!raw || raw === '.') return '';
  if (raw.startsWith('/')) {
    throw new PathError('Absolute paths are not allowed in the workspace.');
  }
  const segments: string[] = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) throw new PathError('Path escapes the workspace root.');
      segments.pop();
      continue;
    }
    const hasControl = Array.from(segment).some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127;
    });
    if (segment.includes('\0') || hasControl) {
      throw new PathError('Invalid path segment.');
    }
    segments.push(segment);
  }
  return segments.join('/');
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/'));
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}

export function extname(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index).toLowerCase();
}

export function stem(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf('.');
  return index <= 0 ? name : name.slice(0, index);
}

export function parentTrail(path: string): string[] {
  const normalized = normalizePath(path);
  if (!normalized) return [];
  const parts = normalized.split('/');
  parts.pop();
  const trail: string[] = [];
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    trail.push(current);
  }
  return trail;
}

export function isPathInside(child: string, parent: string): boolean {
  if (!parent) return true;
  return child === parent || child.startsWith(`${parent}/`);
}

export function uniquePath(existing: Set<string>, desired: string): string {
  if (!existing.has(desired)) return desired;
  const dir = dirname(desired);
  const name = basename(desired);
  const ext = extname(desired);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; i < 10_000; i += 1) {
    const candidate = joinPath(dir, `${base} ${i}${ext}`);
    if (!existing.has(candidate)) return candidate;
  }
  return joinPath(dir, `${base}-${Date.now()}${ext}`);
}

export function languageForPath(path: string): string {
  switch (extname(path)) {
    case '.ts':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.jsx':
      return 'javascript';
    case '.json':
    case '.jsonc':
      return 'json';
    case '.css':
      return 'css';
    case '.scss':
      return 'scss';
    case '.less':
      return 'less';
    case '.html':
    case '.htm':
      return 'html';
    case '.md':
    case '.markdown':
      return 'markdown';
    case '.py':
      return 'python';
    case '.rs':
      return 'rust';
    case '.go':
      return 'go';
    case '.c':
    case '.h':
      return 'c';
    case '.cpp':
    case '.cc':
    case '.cxx':
    case '.hpp':
      return 'cpp';
    case '.sh':
    case '.bash':
      return 'shell';
    case '.yml':
    case '.yaml':
      return 'yaml';
    case '.toml':
      return 'ini';
    case '.xml':
      return 'xml';
    case '.svg':
      return 'xml';
    case '.sql':
      return 'sql';
    default:
      return 'plaintext';
  }
}

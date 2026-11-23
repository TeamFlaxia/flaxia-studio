import { randomId } from '../lib/id.ts';
import { base64ByteLength, base64ToBytes } from './base64.ts';
import {
  deleteBlobs,
  deleteFiles,
  type FileRecord,
  getActiveWorkspaceId,
  getBlob,
  getWorkspace,
  listFiles,
  listWorkspaces,
  putBlob,
  putFiles,
  putWorkspace,
  setActiveWorkspaceId,
  type WorkspaceRecord,
} from './indexeddb.ts';
import { isPathInside, joinPath, normalizePath, stem, uniquePath } from './path.ts';
import { exportZip, importZip, type ZipFile, type ZipImportResult } from './zip.ts';

export interface WorkspaceEntry {
  path: string;
  type: 'file' | 'dir';
  content: string;
  binary?: boolean;
  /** Blob payload id for binaries stored outside the record (large media). */
  blobId?: string;
  /** Byte length of a binary file. */
  size?: number;
  mime?: string;
  updatedAt: number;
  /** Incremented whenever this entry is overwritten; 1 for a new entry. */
  version: number;
}

const DEFAULT_WORKSPACE_NAME = 'flaxia-studio';

/** Hard cap for one binary file (2 GiB) — video clips are big, not unlimited. */
export const MAX_BINARY_BYTES = 2 * 1024 * 1024 * 1024;

/** A `BlobPart` copy: `Uint8Array` views may share a larger buffer. */
function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

/** Thrown when a write carries a stale per-file version (optimistic lock). */
export class ConflictError extends Error {
  readonly path: string;
  readonly expected: number;
  readonly actual: number;

  constructor(path: string, expected: number, actual: number) {
    super(`"${path}" changed: expected version ${expected}, found ${actual}.`);
    this.name = 'ConflictError';
    this.path = path;
    this.expected = expected;
    this.actual = actual;
  }
}

export class Workspace {
  readonly id: string;
  name: string;
  readonly createdAt: number;
  updatedAt: number;
  /** Monotonic revision of the workspace record (cross-tab change signal). */
  rev: number;
  private entries = new Map<string, WorkspaceEntry>();
  private changeNotifier: ((rev: number) => void) | null = null;

  private constructor(record: WorkspaceRecord) {
    this.id = record.id;
    this.name = record.name;
    this.createdAt = record.createdAt;
    this.updatedAt = record.updatedAt;
    this.rev = record.rev ?? 1;
  }

  static async openDefault(): Promise<Workspace> {
    const [activeId, records] = await Promise.all([getActiveWorkspaceId(), listWorkspaces()]);
    // A stale/missing active id falls back to the most recently touched record.
    const record =
      (activeId ? records.find((item) => item.id === activeId) : undefined) ??
      [...records].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!record) return Workspace.create();
    const workspace = new Workspace(record);
    await workspace.hydrate();
    // An existing record with no files is legitimate — never re-seed it.
    await setActiveWorkspaceId(workspace.id);
    return workspace;
  }

  /** Creates a fresh workspace record, seeds it, and makes it active. */
  static async create(name?: string): Promise<Workspace> {
    const record = await createRecord(name);
    const workspace = new Workspace(record);
    await workspace.seed();
    await setActiveWorkspaceId(workspace.id);
    return workspace;
  }

  static async open(id: string): Promise<Workspace | null> {
    const record = await getWorkspace(id);
    if (!record) return null;
    const workspace = new Workspace(record);
    await workspace.hydrate();
    // Switching records also makes the opened one the default for next launch.
    await setActiveWorkspaceId(workspace.id);
    return workspace;
  }

  private async hydrate(): Promise<void> {
    const records = await listFiles(this.id);
    for (const record of records) {
      this.entries.set(record.path, {
        path: record.path,
        type: record.type,
        content: record.content,
        binary: record.binary === true,
        blobId: record.blobId,
        size: record.size,
        mime: record.mime,
        updatedAt: record.updatedAt,
        version: record.version ?? 1,
      });
    }
  }

  private async seed(): Promise<void> {
    this.entries.clear();
    this.entries.set('', this.dirEntry(''));
    this.entries.set('README.md', this.fileEntry('README.md', SAMPLE_README));
    this.entries.set('src', this.dirEntry('src'));
    this.entries.set('src/main.js', this.fileEntry('src/main.js', SAMPLE_MAIN_JS));
    this.entries.set('src/style.css', this.fileEntry('src/style.css', SAMPLE_CSS));
    this.entries.set('index.html', this.fileEntry('index.html', SAMPLE_HTML));
    await this.persistAll();
    await this.touch();
  }

  private fileEntry(path: string, content: string): WorkspaceEntry {
    return { path, type: 'file', content, binary: false, version: 1, updatedAt: Date.now() };
  }

  private dirEntry(path: string): WorkspaceEntry {
    return { path, type: 'dir', content: '', version: 1, updatedAt: Date.now() };
  }

  private toRecord(entry: WorkspaceEntry): FileRecord {
    return {
      id: recordId(this.id, entry.path),
      workspaceId: this.id,
      path: entry.path,
      type: entry.type,
      content: entry.content,
      binary: entry.binary === true,
      blobId: entry.blobId,
      size: entry.size,
      mime: entry.mime,
      updatedAt: entry.updatedAt,
      version: entry.version ?? 1,
    };
  }

  private async persistAll(): Promise<void> {
    await putFiles([...this.entries.values()].map((entry) => this.toRecord(entry)));
  }

  private async persist(entry: WorkspaceEntry): Promise<void> {
    await putFiles([this.toRecord(entry)]);
    await this.touch();
  }

  private async touch(): Promise<void> {
    this.updatedAt = Date.now();
    this.rev += 1;
    await putWorkspace({
      id: this.id,
      name: this.name,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      rev: this.rev,
    });
    this.changeNotifier?.(this.rev);
  }

  /** Called by the app to broadcast revisions to other tabs. */
  setChangeNotifier(notifier: ((rev: number) => void) | null): void {
    this.changeNotifier = notifier;
  }

  list(): WorkspaceEntry[] {
    return [...this.entries.values()].sort(compareEntries);
  }

  filePaths(): string[] {
    return this.list()
      .filter((entry) => entry.type === 'file')
      .map((entry) => entry.path);
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  get(path: string): WorkspaceEntry | undefined {
    return this.entries.get(path);
  }

  /** Current file version for optimistic locking; 0 when the path is absent. */
  versionOf(path: string): number {
    return this.entries.get(normalizePath(path))?.version ?? 0;
  }

  /** Authoritative persisted version, used to catch writes from other tabs. */
  private async storedVersionOf(path: string): Promise<number> {
    const records = await listFiles(this.id);
    return records.find((record) => record.path === path)?.version ?? 0;
  }

  /** Resolves the version a write must supersede, enforcing a lock if given. */
  private async versionForWrite(path: string, expectedVersion?: number): Promise<number> {
    const local = this.versionOf(path);
    if (expectedVersion !== undefined && local !== expectedVersion) {
      throw new ConflictError(path, expectedVersion, local);
    }
    const stored = await this.storedVersionOf(path);
    if (expectedVersion !== undefined && stored !== expectedVersion) {
      throw new ConflictError(path, expectedVersion, stored);
    }
    return Math.max(local, stored);
  }

  readFile(path: string): string | null {
    const entry = this.entries.get(path);
    return entry?.type === 'file' && !entry.binary ? entry.content : null;
  }

  isBinary(path: string): boolean {
    return this.entries.get(path)?.binary === true;
  }

  /** Byte length of a file, without materialising a blob. */
  sizeOf(path: string): number {
    const entry = this.entries.get(path);
    if (entry?.type !== 'file') return 0;
    if (entry.size !== undefined) return entry.size;
    return entry.binary ? base64ByteLength(entry.content) : entry.content.length;
  }

  mimeOf(path: string): string | undefined {
    return this.entries.get(path)?.mime;
  }

  /** The binary payload of a file, whether it is a blob or a legacy record. */
  async readBlob(path: string): Promise<Blob | null> {
    const entry = this.entries.get(path);
    if (entry?.type !== 'file' || !entry.binary) return null;
    if (entry.blobId) {
      const record = await getBlob(entry.blobId);
      if (record) return record.blob;
    }
    // Legacy base64 record (written before the blob store existed).
    return new Blob([toBlobPart(base64ToBytes(entry.content))], { type: entry.mime ?? '' });
  }

  async readBinary(path: string): Promise<Uint8Array | null> {
    const entry = this.entries.get(path);
    if (entry?.type !== 'file' || !entry.binary) return null;
    const blob = await this.readBlob(path);
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    const entry = this.entries.get(path);
    if (entry?.type !== 'file') return null;
    if (!entry.binary) return new TextEncoder().encode(entry.content);
    const blob = await this.readBlob(path);
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }

  async writeFile(path: string, content: string, expectedVersion?: number): Promise<void> {
    const normalized = normalizePath(path);
    if (!normalized) throw new Error('Cannot write to the workspace root.');
    const actual = await this.versionForWrite(normalized, expectedVersion);
    await this.ensureParents(normalized);
    const previous = this.entries.get(normalized)?.blobId;
    const entry: WorkspaceEntry = {
      path: normalized,
      type: 'file',
      content,
      binary: false,
      version: actual + 1,
      updatedAt: Date.now(),
    };
    this.entries.set(normalized, entry);
    await this.persist(entry);
    if (previous) await deleteBlobs([previous]);
  }

  /**
   * Stores a binary file as a Blob, so video and audio are never base64.
   *
   * Returns the normalized path so callers can open the file right away.
   */
  async writeBinaryFile(
    path: string,
    data: Uint8Array | Blob,
    mime?: string,
    expectedVersion?: number,
  ): Promise<string> {
    const normalized = normalizePath(path);
    if (!normalized) throw new Error('Cannot write to the workspace root.');
    const actual = await this.versionForWrite(normalized, expectedVersion);
    const blob = data instanceof Blob ? data : new Blob([toBlobPart(data)], { type: mime ?? '' });
    if (blob.size > MAX_BINARY_BYTES) {
      throw new Error(`${normalized} is larger than the 2 GB file limit.`);
    }
    await this.ensureParents(normalized);
    const previous = this.entries.get(normalized)?.blobId;
    const blobId = randomId();
    await putBlob({ id: blobId, blob, size: blob.size });
    const entry: WorkspaceEntry = {
      path: normalized,
      type: 'file',
      content: '',
      binary: true,
      blobId,
      size: blob.size,
      mime: mime ?? (blob.type || undefined),
      version: actual + 1,
      updatedAt: Date.now(),
    };
    this.entries.set(normalized, entry);
    try {
      await this.persist(entry);
    } catch (error) {
      await deleteBlobs([blobId]);
      throw error;
    }
    if (previous) await deleteBlobs([previous]);
    return normalized;
  }

  async createFile(path: string, content = ''): Promise<string> {
    const normalized = normalizePath(path);
    if (!normalized) throw new Error('File name is required.');
    if (this.entries.has(normalized)) throw new Error(`"${normalized}" already exists.`);
    await this.ensureParents(normalized);
    const entry = this.fileEntry(normalized, content);
    this.entries.set(normalized, entry);
    await this.persist(entry);
    return normalized;
  }

  async createFolder(path: string): Promise<string> {
    const normalized = normalizePath(path);
    if (!normalized) throw new Error('Folder name is required.');
    if (this.entries.has(normalized)) throw new Error(`"${normalized}" already exists.`);
    await this.ensureParents(normalized);
    const entry = this.dirEntry(normalized);
    this.entries.set(normalized, entry);
    await this.persist(entry);
    return normalized;
  }

  async remove(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (!normalized) throw new Error('Cannot remove the workspace root.');
    const removed: string[] = [];
    const blobIds: string[] = [];
    for (const key of this.entries.keys()) {
      if (isPathInside(key, normalized)) removed.push(key);
    }
    for (const key of removed) {
      const blobId = this.entries.get(key)?.blobId;
      if (blobId) blobIds.push(blobId);
      this.entries.delete(key);
    }
    await deleteFiles(removed.map((key) => recordId(this.id, key)));
    await deleteBlobs(blobIds);
    await this.touch();
  }

  async rename(from: string, to: string): Promise<string> {
    const source = normalizePath(from);
    const target = normalizePath(to);
    if (!source || !target) throw new Error('Source and destination are required.');
    if (source === target) return target;
    if (this.entries.has(target)) throw new Error(`"${target}" already exists.`);
    if (isPathInside(target, source)) throw new Error('Cannot move a folder inside itself.');

    const moving: Array<{ oldPath: string; entry: WorkspaceEntry }> = [];
    for (const [key, entry] of this.entries) {
      if (!isPathInside(key, source)) continue;
      const suffix = key.slice(source.length);
      const nextPath = normalizePath(`${target}${suffix}`);
      moving.push({
        oldPath: key,
        entry: {
          ...entry,
          path: nextPath,
          version: (entry.version ?? 1) + 1,
          updatedAt: Date.now(),
        },
      });
    }
    if (moving.length === 0) throw new Error(`"${source}" does not exist.`);

    await this.ensureParents(target);
    for (const item of moving) this.entries.delete(item.oldPath);
    for (const item of moving) this.entries.set(item.entry.path, item.entry);
    await deleteFiles(moving.map((item) => recordId(this.id, item.oldPath)));
    await putFiles(moving.map((item) => this.toRecord(item.entry)));
    await this.touch();
    return target;
  }

  async importFiles(result: ZipImportResult): Promise<{ imported: number; skipped: string[] }> {
    const existing = new Set(this.entries.keys());
    const records: WorkspaceEntry[] = [];
    for (const dir of result.directories) {
      const normalized = normalizePath(dir);
      if (!normalized || this.entries.has(normalized)) continue;
      const entry = this.dirEntry(normalized);
      this.entries.set(normalized, entry);
      records.push(entry);
    }
    for (const file of result.files) {
      const normalized = uniquePath(existing, file.path);
      existing.add(normalized);
      await this.ensureParents(normalized);
      const now = Date.now();
      if (file.type === 'text') {
        const entry: WorkspaceEntry = {
          path: normalized,
          type: 'file',
          content: file.text,
          binary: false,
          version: 1,
          updatedAt: now,
        };
        this.entries.set(normalized, entry);
        records.push(entry);
        continue;
      }
      // Binaries go straight to the blob store instead of base64.
      const blob = new Blob([toBlobPart(file.bytes)]);
      const blobId = randomId();
      await putBlob({ id: blobId, blob, size: blob.size });
      const entry: WorkspaceEntry = {
        path: normalized,
        type: 'file',
        content: '',
        binary: true,
        blobId,
        size: blob.size,
        version: 1,
        updatedAt: now,
      };
      this.entries.set(normalized, entry);
      records.push(entry);
    }
    await putFiles(records.map((entry) => this.toRecord(entry)));
    await this.touch();
    return { imported: result.files.length, skipped: result.skipped };
  }

  async exportZip(): Promise<Uint8Array> {
    const files: ZipFile[] = [];
    for (const entry of this.list()) {
      if (entry.type !== 'file') continue;
      if (!entry.binary) {
        files.push({ path: entry.path, type: 'text', text: entry.content });
        continue;
      }
      const blob = await this.readBlob(entry.path);
      if (!blob) continue;
      files.push({ path: entry.path, type: 'binary', bytes: new Uint8Array(await blob.arrayBuffer()) });
    }
    return exportZip(files);
  }

  async importZipBytes(data: Uint8Array): Promise<{ imported: number; skipped: string[] }> {
    return this.importFiles(importZip(data));
  }

  async renameWorkspace(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.name = trimmed;
    await this.touch();
    window.dispatchEvent(new CustomEvent('flaxia:workspace-renamed', { detail: { name: trimmed } }));
  }

  private async ensureParents(path: string): Promise<void> {
    const parts = path.split('/').slice(0, -1);
    let current = '';
    const missing: WorkspaceEntry[] = [];
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (this.entries.has(current)) continue;
      const entry = this.dirEntry(current);
      this.entries.set(current, entry);
      missing.push(entry);
    }
    if (missing.length > 0) await putFiles(missing.map((entry) => this.toRecord(entry)));
  }
}

function recordId(workspaceId: string, path: string): string {
  return `${workspaceId}:${path}`;
}

function compareEntries(a: WorkspaceEntry, b: WorkspaceEntry): number {
  if (a.path === '') return -1;
  if (b.path === '') return 1;
  const depthA = a.path.split('/').length;
  const depthB = b.path.split('/').length;
  if (depthA !== depthB) return depthA - depthB;
  return a.path.localeCompare(b.path, 'en', { numeric: true });
}

async function createRecord(name = DEFAULT_WORKSPACE_NAME): Promise<WorkspaceRecord> {
  const now = Date.now();
  const record: WorkspaceRecord = {
    id: randomId(),
    name,
    createdAt: now,
    updatedAt: now,
    rev: 1,
  };
  await putWorkspace(record);
  return record;
}

export function suggestFileName(directory: string, existing: Set<string>, extension = '.ts'): string {
  const base = joinPath(directory, `untitled${extension}`);
  return uniquePath(existing, base);
}

export function displayWorkspaceName(name: string): string {
  return stem(name) || name;
}

const SAMPLE_README = `# Welcome to Flaxia Studio

Flaxia Studio is a browser IDE for web development that keeps the Flaxia
design language: emerald accents, 1px hairlines, calm 150ms motion, and
nothing that glows.

## Try this

1. Press \`Ctrl/Cmd + Shift + Enter\` to run **Test Play** on \`index.html\`.
2. Edit \`src/main.js\` — the sandboxed preview reloads after each save.
3. Press \`Ctrl/Cmd + K\` to open the command palette.
4. Press \`Ctrl/Cmd + \`\` to focus the terminal and run \`help\`.
5. Boot Linux from the container panel when you need a real shell.

Everything you create is stored in this browser (IndexedDB). Use
**Export ZIP** from the command palette to take it with you.
`;

const SAMPLE_MAIN_JS = `const greeting = {
  message: 'Hello from Flaxia Studio',
  accent: '#10b981',
};

const heading = document.querySelector('h1');
if (heading) {
  heading.textContent = greeting.message;
  heading.style.color = greeting.accent;
}

console.log(greeting.message);
`;

const SAMPLE_CSS = `:root {
  --accent: #10b981;
  --canvas: #181d28;
}

body {
  margin: 0;
  display: grid;
  place-items: center;
  min-height: 100dvh;
  background: var(--canvas);
  color: #f8fafc;
  font-family: system-ui, sans-serif;
}

h1 {
  color: var(--accent);
  letter-spacing: -0.03em;
}
`;

const SAMPLE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Flaxia Studio sample</title>
    <link rel="stylesheet" href="./src/style.css" />
  </head>
  <body>
    <h1>Hello from Flaxia Studio</h1>
    <script type="module" src="./src/main.js"></script>
  </body>
</html>
`;

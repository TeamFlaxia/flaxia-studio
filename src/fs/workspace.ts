import {
  deleteFiles,
  type FileRecord,
  getWorkspace,
  listFiles,
  listWorkspaces,
  putFiles,
  putWorkspace,
  type WorkspaceRecord,
} from './indexeddb.ts';
import { isPathInside, joinPath, normalizePath, stem, uniquePath } from './path.ts';
import { exportZip, importZip, type ZipImportResult } from './zip.ts';

export interface WorkspaceEntry {
  path: string;
  type: 'file' | 'dir';
  content: string;
  updatedAt: number;
}

const DEFAULT_WORKSPACE_NAME = 'flaxia-studio';

export class Workspace {
  readonly id: string;
  name: string;
  readonly createdAt: number;
  updatedAt: number;
  private entries = new Map<string, WorkspaceEntry>();

  private constructor(record: WorkspaceRecord) {
    this.id = record.id;
    this.name = record.name;
    this.createdAt = record.createdAt;
    this.updatedAt = record.updatedAt;
  }

  static async openDefault(): Promise<Workspace> {
    const records = await listWorkspaces();
    const record = records.sort((a, b) => a.createdAt - b.createdAt)[0] ?? (await createRecord());
    const workspace = new Workspace(record);
    await workspace.hydrate();
    if (workspace.entries.size === 0) await workspace.seed();
    return workspace;
  }

  static async open(id: string): Promise<Workspace | null> {
    const record = await getWorkspace(id);
    if (!record) return null;
    const workspace = new Workspace(record);
    await workspace.hydrate();
    return workspace;
  }

  private async hydrate(): Promise<void> {
    const records = await listFiles(this.id);
    for (const record of records) {
      this.entries.set(record.path, {
        path: record.path,
        type: record.type,
        content: record.content,
        updatedAt: record.updatedAt,
      });
    }
  }

  private async seed(): Promise<void> {
    this.entries.clear();
    this.entries.set('', this.dirEntry(''));
    this.entries.set('README.md', this.fileEntry('README.md', SAMPLE_README));
    this.entries.set('src', this.dirEntry('src'));
    this.entries.set('src/main.ts', this.fileEntry('src/main.ts', SAMPLE_MAIN));
    this.entries.set('src/style.css', this.fileEntry('src/style.css', SAMPLE_CSS));
    this.entries.set('index.html', this.fileEntry('index.html', SAMPLE_HTML));
    await this.persistAll();
    await this.touch();
  }

  private fileEntry(path: string, content: string): WorkspaceEntry {
    return { path, type: 'file', content, updatedAt: Date.now() };
  }

  private dirEntry(path: string): WorkspaceEntry {
    return { path, type: 'dir', content: '', updatedAt: Date.now() };
  }

  private toRecord(entry: WorkspaceEntry): FileRecord {
    return {
      id: recordId(this.id, entry.path),
      workspaceId: this.id,
      path: entry.path,
      type: entry.type,
      content: entry.content,
      updatedAt: entry.updatedAt,
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
    await putWorkspace({
      id: this.id,
      name: this.name,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    });
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

  readFile(path: string): string | null {
    const entry = this.entries.get(path);
    return entry?.type === 'file' ? entry.content : null;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const normalized = normalizePath(path);
    if (!normalized) throw new Error('Cannot write to the workspace root.');
    await this.ensureParents(normalized);
    const entry: WorkspaceEntry = { path: normalized, type: 'file', content, updatedAt: Date.now() };
    this.entries.set(normalized, entry);
    await this.persist(entry);
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
    for (const key of this.entries.keys()) {
      if (isPathInside(key, normalized)) removed.push(key);
    }
    for (const key of removed) this.entries.delete(key);
    await deleteFiles(removed.map((key) => recordId(this.id, key)));
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
      moving.push({ oldPath: key, entry: { ...entry, path: nextPath, updatedAt: Date.now() } });
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
      const entry = this.fileEntry(normalized, file.content);
      this.entries.set(normalized, entry);
      records.push(entry);
    }
    await putFiles(records.map((entry) => this.toRecord(entry)));
    await this.touch();
    return { imported: result.files.length, skipped: result.skipped };
  }

  exportZip(): Uint8Array {
    return exportZip(
      this.list()
        .filter((entry) => entry.type === 'file')
        .map((entry) => ({ path: entry.path, content: entry.content })),
    );
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

async function createRecord(): Promise<WorkspaceRecord> {
  const now = Date.now();
  const record: WorkspaceRecord = {
    id: crypto.randomUUID(),
    name: DEFAULT_WORKSPACE_NAME,
    createdAt: now,
    updatedAt: now,
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

Flaxia Studio is a Monaco-based IDE that keeps the Flaxia design language:
emerald accents, 1px hairlines, calm 150ms motion, and nothing that glows.

## Try this

1. Open \`src/main.ts\` and edit the greeting.
2. Press \`Ctrl/Cmd + K\` to open the command palette.
3. Press \`Ctrl/Cmd + \`\` to focus the terminal and run \`help\`.
4. Boot Linux from the container panel when an image is configured.

Everything you create is stored in this browser (IndexedDB). Use
**Export ZIP** from the command palette to take it with you.
`;

const SAMPLE_MAIN = `type Greeting = {
  message: string;
  accent: string;
};

const greeting: Greeting = {
  message: 'Hello from Flaxia Studio',
  accent: '#10b981',
};

export function render(target: HTMLElement, value: Greeting): void {
  target.textContent = value.message;
  target.style.color = value.accent;
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
    <link rel="stylesheet" href="/src/style.css" />
  </head>
  <body>
    <h1>Hello from Flaxia Studio</h1>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;

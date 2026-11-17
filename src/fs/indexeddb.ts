export const DB_NAME = 'flaxia-studio';
export const DB_VERSION = 2;

export interface WorkspaceRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface FileRecord {
  id: string;
  workspaceId: string;
  path: string;
  type: 'file' | 'dir';
  /** UTF-8 text, or base64 for legacy binary records (see `blobId`). */
  content: string;
  binary?: boolean;
  /** Blob payload for binary files that are too big for base64. */
  blobId?: string;
  /** Byte length of a binary file. */
  size?: number;
  mime?: string;
  updatedAt: number;
}

/** A binary payload stored as-is, so video and audio never inflate to base64. */
export interface BlobRecord {
  id: string;
  blob: Blob;
  size: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('workspaces')) {
        db.createObjectStore('workspaces', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('files')) {
        const files = db.createObjectStore('files', { keyPath: 'id' });
        files.createIndex('workspaceId', 'workspaceId', { unique: false });
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
      // v2: binary payloads live in their own store. Legacy base64 records in
      // `files` keep working; they are upgraded the next time they are written.
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked by another tab.'));
  });
  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export async function listWorkspaces(): Promise<WorkspaceRecord[]> {
  const db = await openDatabase();
  const tx = db.transaction('workspaces', 'readonly');
  return requestToPromise(tx.objectStore('workspaces').getAll());
}

export async function getWorkspace(id: string): Promise<WorkspaceRecord | undefined> {
  const db = await openDatabase();
  const tx = db.transaction('workspaces', 'readonly');
  return requestToPromise(tx.objectStore('workspaces').get(id));
}

export async function putWorkspace(record: WorkspaceRecord): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction('workspaces', 'readwrite');
  tx.objectStore('workspaces').put(record);
  await transactionDone(tx);
}

export async function listFiles(workspaceId: string): Promise<FileRecord[]> {
  const db = await openDatabase();
  const tx = db.transaction('files', 'readonly');
  const index = tx.objectStore('files').index('workspaceId');
  return requestToPromise(index.getAll(IDBKeyRange.only(workspaceId)));
}

export async function putFiles(records: FileRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await openDatabase();
  const tx = db.transaction('files', 'readwrite');
  const store = tx.objectStore('files');
  for (const record of records) store.put(record);
  await transactionDone(tx);
}

export async function deleteFiles(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDatabase();
  const tx = db.transaction('files', 'readwrite');
  const store = tx.objectStore('files');
  for (const id of ids) store.delete(id);
  await transactionDone(tx);
}

export async function putBlob(record: BlobRecord): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction('blobs', 'readwrite');
  tx.objectStore('blobs').put(record);
  await transactionDone(tx);
}

export async function getBlob(id: string): Promise<BlobRecord | undefined> {
  const db = await openDatabase();
  const tx = db.transaction('blobs', 'readonly');
  return requestToPromise(tx.objectStore('blobs').get(id));
}

export async function deleteBlobs(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDatabase();
  const tx = db.transaction('blobs', 'readwrite');
  const store = tx.objectStore('blobs');
  for (const id of ids) store.delete(id);
  await transactionDone(tx);
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await openDatabase();
  const tx = db.transaction('kv', 'readonly');
  const result = await requestToPromise(tx.objectStore('kv').get(key));
  return (result as { key: string; value: T } | undefined)?.value;
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').put({ key, value });
  await transactionDone(tx);
}

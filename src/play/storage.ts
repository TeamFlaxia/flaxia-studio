/**
 * Preview storage for the sandboxed game.
 *
 * The game frame runs with an opaque origin, so `localStorage` and
 * `document.cookie` throw inside it. Flaxia Arcade bridges a namespaced save
 * to the app origin (`flaxia:game:<postId>`, see
 * `flaxia/src/lib/game-storage-broker.ts`) and injects a disabled-cookie
 * compatibility shim (`flaxia/src/lib/wvfs-cookie-compat.ts`). Test Play
 * mirrors both rules, namespaced per workspace.
 */

/** Storage key prefix — one namespace per workspace. */
const STORAGE_PREFIX = 'flaxia:studio:';

/** Arcade caps a bridged save at 64 KiB (`flaxia/packages/game-sdk/src/protocol.ts`). */
export const PLAY_STORAGE_MAX_BYTES = 64 * 1024;

export type PlayStorageOperation = 'set' | 'remove' | 'clear';

export function previewStorageKey(namespace: string): string {
  return `${STORAGE_PREFIX}${namespace}`;
}

/** Reads the saved snapshot for a workspace. */
export function readPreviewStorage(namespace: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(previewStorageKey(namespace));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const snapshot: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key === 'string' && typeof value === 'string') snapshot[key] = value;
    }
    return snapshot;
  } catch {
    return {};
  }
}

/**
 * Applies one storage operation and persists the result.
 *
 * Writes that would push the snapshot past the size cap are dropped, so a game
 * can not fill the origin's quota.
 */
export function writePreviewStorage(
  namespace: string,
  operation: PlayStorageOperation,
  key?: string,
  value?: string,
): void {
  try {
    const snapshot = readPreviewStorage(namespace);
    if (operation === 'clear') {
      snapshotLocalStorage(namespace, {});
      return;
    }
    if (typeof key !== 'string') return;
    if (operation === 'set') {
      if (typeof value !== 'string') return;
      snapshot[key] = value;
    } else {
      delete snapshot[key];
    }
    const encoded = JSON.stringify(snapshot);
    if (encoded.length > PLAY_STORAGE_MAX_BYTES) return;
    snapshotLocalStorage(namespace, snapshot);
  } catch {
    // Storage is best-effort: a full quota must not break the preview.
  }
}

function snapshotLocalStorage(namespace: string, snapshot: Record<string, string>): void {
  const key = previewStorageKey(namespace);
  if (Object.keys(snapshot).length === 0) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(snapshot));
}

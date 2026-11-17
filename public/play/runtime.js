/*
 * Test Play runtime — runs INSIDE the sandboxed game frame.
 *
 * The frame has an opaque origin (sandbox without allow-same-origin), and
 * Chromium refuses to load blob URLs that were created by another origin.
 * The studio therefore hands over plain bytes plus rewritten documents that
 * point at `blob:flaxia-play/<encoded path>` placeholders; this runtime owns
 * the blob registry, replaces the placeholders and writes the entry document.
 *
 * The rules mirror Flaxia Arcade's runtime preview:
 * - storage: the game gets a `localStorage` shim whose writes are relayed to
 *   the studio, and `document.cookie` degrades to an empty string instead of
 *   throwing (`flaxia/src/lib/game-storage-broker.ts`,
 *   `flaxia/src/lib/wvfs-cookie-compat.ts`).
 * - document hygiene: a `<base>` element and a `<meta http-equiv>` policy are
 *   removed before the game document is written
 *   (`flaxia/sandbox/game-loader/runtime.js`,
 *   `flaxia/src/sandbox-worker.ts`).
 * - assets: local references resolve inside the payload only, and only for
 *   read-only methods (`flaxia/sandbox/game-loader/runtime.js`).
 *
 * It is intentionally a classic script with no imports: an opaque-origin
 * document can not load cross-origin module scripts without CORS headers.
 */
(() => {
  const PLACEHOLDER = /blob:flaxia-play\/([^"'()\s]+)/g;
  const ARCHIVE_ORIGIN = 'https://zip.invalid/';

  let files = new Map();
  let texts = {};
  let storage = {};
  const blobs = new Map();
  const creating = new Set();
  let entry = '';

  const isTextMime = (mime) =>
    mime.indexOf('text/') === 0 || mime === 'application/javascript' || mime === 'application/json';

  const rawText = (path) => {
    const file = files.get(path);
    if (!file) return '';
    if (typeof texts[path] === 'string') return texts[path];
    return new TextDecoder().decode(file.bytes);
  };

  const substitute = (text) => {
    if (typeof text !== 'string') return text;
    return text.replace(PLACEHOLDER, (match, token) => {
      let suffix = '';
      const cut = token.search(/[?#]/);
      if (cut >= 0) {
        suffix = token.slice(cut);
        token = token.slice(0, cut);
      }
      let path;
      try {
        path = decodeURIComponent(token);
      } catch {
        return match;
      }
      const url = blobUrl(path);
      return url ? url + suffix : match;
    });
  };

  function blobUrl(path) {
    const cached = blobs.get(path);
    if (cached !== undefined) return cached;
    if (creating.has(path)) return '';
    const file = files.get(path);
    if (!file) return '';
    creating.add(path);
    const body = isTextMime(file.mime) ? substitute(rawText(path)) : file.bytes;
    const url = URL.createObjectURL(new Blob([body], { type: file.mime }));
    blobs.set(path, url);
    creating.delete(path);
    return url;
  }

  /** Revokes the blobs of the previous run so a reload does not leak them. */
  const revokeBlobs = () => {
    for (const url of blobs.values()) URL.revokeObjectURL(url);
    blobs.clear();
  };

  /**
   * Resolves a reference inside the payload.
   *
   * The archive has a virtual origin, so a relative reference can never
   * resolve to a real host and `..` can not climb out of the payload.
   */
  const assetPath = (reference) => {
    if (typeof reference !== 'string' || !reference) return null;
    if (reference.startsWith('#') || reference.startsWith('?')) return null;
    try {
      const base = new URL(entry || 'index.html', ARCHIVE_ORIGIN);
      const resolved = new URL(reference, base);
      if (resolved.origin !== ARCHIVE_ORIGIN.replace(/\/$/, '')) return null;
      return decodeURIComponent(resolved.pathname.slice(1));
    } catch {
      return null;
    }
  };

  const installFetch = () => {
    if (typeof window.fetch !== 'function') return;
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      try {
        const reference =
          typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : '';
        const method = (
          init?.method ?? (input && typeof input.method === 'string' ? input.method : 'GET')
        ).toUpperCase();
        const path = reference ? assetPath(reference) : null;
        if (path !== null) {
          // Archive assets are read-only (`flaxia/sandbox/game-loader/runtime.js`).
          if (method !== 'GET' && method !== 'HEAD') {
            return Promise.reject(new Error('Archive assets are read-only'));
          }
          const file = files.get(path);
          if (!file) {
            return Promise.reject(new Error(`Missing archive asset: ${path}`));
          }
          const body = isTextMime(file.mime) ? substitute(rawText(path)) : file.bytes;
          return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': file.mime } }));
        }
      } catch {
        // Fall through to the network.
      }
      return original(input, init);
    };
  };

  /** Relays a storage write to the studio through the shell. */
  const relayStorage = (operation, key, value) => {
    try {
      window.parent.postMessage({ type: 'play:storage-write', operation, key, value }, '*');
    } catch {
      // The frame may be detached; the save is lost, the game keeps running.
    }
  };

  /**
   * Storage shim for the opaque-origin frame.
   *
   * `localStorage` is seeded with the workspace save and every write is
   * relayed to the studio; `sessionStorage` stays in memory and is never
   * persisted.
   */
  const installStorage = () => {
    const makeStorage = (persistent) => {
      const values = new Map(Object.entries(persistent ? storage : {}));
      return {
        get length() {
          return values.size;
        },
        key(index) {
          return Array.from(values.keys())[index] ?? null;
        },
        getItem(key) {
          key = String(key);
          return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
          key = String(key);
          value = String(value);
          values.set(key, value);
          if (persistent) relayStorage('set', key, value);
        },
        removeItem(key) {
          key = String(key);
          values.delete(key);
          if (persistent) relayStorage('remove', key);
        },
        clear() {
          values.clear();
          if (persistent) relayStorage('clear');
        },
      };
    };
    try {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: makeStorage(true),
      });
    } catch {
      // A frame without storage support still runs.
    }
    try {
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        value: makeStorage(false),
      });
    } catch {
      // Ignore: session storage is optional.
    }
  };

  /**
   * Cookie compatibility: an opaque-origin document throws on `document.cookie`
   * and aborts SDKs that read it. Expose the disabled behavior instead —
   * cookies are never read, written or persisted for a game.
   */
  const installCookieCompat = () => {
    try {
      void document.cookie;
      return;
    } catch (error) {
      if (error?.name !== 'SecurityError') return;
    }
    try {
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get() {
          return '';
        },
        set() {},
      });
    } catch {
      // Ignore: the game may not touch cookies at all.
    }
  };

  /**
   * Document hygiene: a `<base>` element would move every relative reference
   * to another origin, and a `<meta http-equiv>` policy would fight the
   * runtime's own CSP. Both are removed before the game document is written.
   */
  const sanitizeDocument = (html) => {
    let clean = html;
    try {
      const parsed = new DOMParser().parseFromString(clean, 'text/html');
      parsed.querySelectorAll('base, meta[http-equiv]').forEach((node) => {
        node.remove();
      });
      const doctype = parsed.doctype
        ? `<!DOCTYPE ${parsed.doctype.name}${
            parsed.doctype.publicId ? ` PUBLIC "${parsed.doctype.publicId}"` : ''
          }${parsed.doctype.systemId ? ` "${parsed.doctype.systemId}"` : ''}>`
        : '';
      clean = doctype + parsed.documentElement.outerHTML;
    } catch {
      // Fall back to the regex rules below.
    }
    return clean
      .replace(/<base[^>]*>/gi, '')
      .replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*\/?>/gi, '');
  };

  const start = (payload) => {
    revokeBlobs();
    files = new Map();
    for (const file of payload.files || []) files.set(file.path, file);
    texts = payload.texts || {};
    storage = payload.storage || {};
    entry = payload.entry || '';
    installStorage();
    installCookieCompat();
    installFetch();

    const html = sanitizeDocument(substitute(rawText(entry)));
    document.open();
    document.write(html);
    document.close();
    window.parent.postMessage({ type: 'play:runtime-started' }, '*');
  };

  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'play:runtime-run') return;
    try {
      start(event.data.payload || {});
    } catch (error) {
      const message = (error?.message ? error.message : String(error)).slice(0, 500);
      window.parent.postMessage({ type: 'play:runtime-error', error: message }, '*');
    }
  });

  window.addEventListener('pagehide', () => revokeBlobs());

  window.parent.postMessage({ type: 'play:runtime-ready' }, '*');
})();

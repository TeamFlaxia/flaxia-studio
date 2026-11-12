/*
 * Test Play runtime — runs INSIDE the sandboxed game frame.
 *
 * The frame has an opaque origin (sandbox without allow-same-origin), and
 * Chromium refuses to load blob URLs that were created by another origin.
 * The studio therefore hands over plain bytes plus rewritten documents that
 * point at `blob:flaxia-play/<encoded path>` placeholders; this runtime owns
 * the blob registry, replaces the placeholders and writes the entry document.
 *
 * It is intentionally a classic script with no imports: an opaque-origin
 * document can not load cross-origin module scripts without CORS headers.
 */
(() => {
  const PLACEHOLDER = /blob:flaxia-play\/([^"'()\s]+)/g;

  let files = new Map();
  let texts = {};
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

  const entryDirectory = () => {
    const slash = entry.lastIndexOf('/');
    return slash >= 0 ? entry.slice(0, slash) : '';
  };

  const assetPath = (reference) => {
    let clean = reference.split('#')[0].split('?')[0];
    while (clean.startsWith('./')) clean = clean.slice(2);
    if (clean.startsWith('/')) clean = clean.slice(1);
    const base = entryDirectory();
    const segments = [];
    for (const segment of `${base ? `${base}/` : ''}${clean}`.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') {
        segments.pop();
        continue;
      }
      segments.push(segment);
    }
    return segments.join('/');
  };

  const installFetch = () => {
    if (typeof window.fetch !== 'function') return;
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      try {
        const reference =
          typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : '';
        if (reference && !/^[a-z][a-z0-9+.-]*:/i.test(reference)) {
          const path = assetPath(reference);
          const file = files.get(path);
          if (file) {
            const body = isTextMime(file.mime) ? substitute(rawText(path)) : file.bytes;
            return Promise.resolve(
              new Response(body, { status: 200, headers: { 'Content-Type': file.mime } }),
            );
          }
        }
      } catch {
        // Fall through to the network.
      }
      return original(input, init);
    };
  };

  const start = (payload) => {
    files = new Map();
    for (const file of payload.files || []) files.set(file.path, file);
    texts = payload.texts || {};
    entry = payload.entry || '';
    installFetch();

    const html = substitute(rawText(entry));
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

  window.parent.postMessage({ type: 'play:runtime-ready' }, '*');
})();

/*
 * Flaxia Studio Linux worker.
 *
 * Runs a container2wasm WASI image inside a module Web Worker using the
 * browser_wasi_shim build shipped by the container2wasm project, then
 * synchronises a text-only /workspace snapshot in and out of the guest.
 *
 * Command mode (one process per command) is intentional: it lets the host
 * mirror the workspace after every run without requiring a second shared
 * filesystem channel. Interactive full-screen programs are out of scope for
 * the MVP.
 */
import { Directory, File, PreopenDirectory, WASI, WASIProcExit } from './browser_wasi_shim/index.js';

const IMAGE_CACHE = 'flaxia-studio-linux-v1';
let busy = false;
let imageCacheEntry = { key: null, bytes: null };
let moduleCacheEntry = { key: null, module: null };

self.onmessage = (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'run') {
    if (busy) {
      post({ type: 'error', message: 'A Linux process is already running.' });
      return;
    }
    void run(message);
  } else if (message.type === 'cancel') {
    self.close();
  }
};

async function run(message) {
  busy = true;
  const startedAt = performance.now();
  try {
    const bytes = await loadImage(message, (progress) => post({ type: 'progress', ...progress }));
    const logicalKey = `${message.digest ?? message.version ?? message.imageUrl}:${message.chunks ?? 1}`;
    let module;
    if (moduleCacheEntry.key === logicalKey && moduleCacheEntry.module) {
      module = moduleCacheEntry.module;
    } else {
      post({ type: 'progress', phase: 'compile', loaded: bytes.byteLength, total: bytes.byteLength });
      module = await WebAssembly.compile(bytes);
      moduleCacheEntry = { key: logicalKey, module };
    }

    const files = Array.isArray(message.files) ? message.files : [];
    const workspaceDir = buildWorkspaceDirectory(files);
    const preopen = new PreopenDirectory('/workspace', workspaceDir.contents);

    const output = new OutputFd((text) => post({ type: 'output', text }));
    const stdin = new File(new Uint8Array(0));
    const fds = [stdin, output, output, preopen];

    const cwd = normalizeGuestPath(message.cwd ?? '');
    const command = message.command ?? 'true';
    const work = '/tmp/flaxia-work';
    const shellCommand = [
      `rm -rf ${work} && mkdir -p ${work}`,
      `cp -a /workspace/. ${work}/ 2>/dev/null`,
      `cd ${shellQuote(cwd ? `${work}/${cwd}` : work)} 2>/dev/null || cd ${work}`,
      command,
      '__flaxia_status=$?',
      'find /workspace -mindepth 1 -delete 2>/dev/null',
      `cp -a ${work}/. /workspace/ 2>/dev/null`,
      'exit $__flaxia_status',
    ].join('\n');
    const args = ['arg0', '-entrypoint', '/bin/sh', '--', '-c', shellCommand];
    const env = [
      'HOME=/workspace',
      'USER=flaxia',
      'TERM=dumb',
      'PWD=/workspace',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'LANG=C.UTF-8',
    ];

    const wasi = new WASI(args, env, fds, { debug: false });
    let exitCode = 0;
    try {
      const instantiated = await WebAssembly.instantiate(module, {
        wasi_snapshot_preview1: wasi.wasiImport,
      });
      const instance = instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance;
      const result = wasi.start(instance);
      if (typeof result === 'number') exitCode = result;
    } catch (error) {
      if (error instanceof WASIProcExit) {
        exitCode = error.code;
      } else {
        const parsed = parseExit(error);
        if (parsed === null) {
          post({
            type: 'output',
            text: `\r\n[linux] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\r\n`,
          });
          exitCode = 1;
        } else {
          exitCode = parsed;
        }
      }
    }

    const guestFiles = collectFiles(preopen);
    post({
      type: 'done',
      files: guestFiles,
      exitCode,
      durationMs: Math.round(performance.now() - startedAt),
    });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    busy = false;
  }
}

async function loadImage(message, onProgress) {
  const imageUrl = message.imageUrl;
  if (!imageUrl) throw new Error('Linux image URL is missing.');
  const chunkCount = Number(message.chunks ?? 1);
  const totalBytes = Number(message.totalBytes ?? 0);
  const logicalKey = `${message.digest ?? message.version ?? imageUrl}:${chunkCount}`;
  const cacheKey = new Request(`flaxia-linux-cache:${logicalKey}`);
  if (imageCacheEntry.key === logicalKey && imageCacheEntry.bytes) {
    onProgress({ phase: 'cache', loaded: 1, total: 1 });
    return imageCacheEntry.bytes;
  }

  let cache = null;
  try {
    cache = await caches.open(IMAGE_CACHE);
    const cached = await cache.match(cacheKey);
    if (cached) {
      onProgress({ phase: 'cache', loaded: 1, total: 1 });
      return new Uint8Array(await cached.arrayBuffer());
    }
  } catch {
    cache = null;
  }

  const template = message.chunkUrlTemplate ?? './{index}.wasm';
  const chunks = [];
  let loaded = 0;
  for (let index = 0; index < chunkCount; index += 1) {
    const url = template.replace('{index}', String(index).padStart(2, '0'));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch Linux image chunk ${index} (${response.status}).`);
    const buffer = await readWithProgress(response, (delta) => {
      loaded += delta;
      onProgress({ phase: 'download', loaded, total: totalBytes || loaded });
    });
    chunks.push(buffer);
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (message.digest) {
    onProgress({ phase: 'verify', loaded: total, total });
    const actual = await sha256(bytes);
    if (actual !== message.digest.toLowerCase()) {
      throw new Error(`Linux image digest mismatch (expected ${message.digest}, got ${actual}).`);
    }
  }

  let finalBytes = bytes;
  if (message.compression === 'gzip') {
    onProgress({ phase: 'decompress', loaded: total, total });
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    finalBytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }

  if (cache) {
    try {
      await cache.put(
        cacheKey,
        new Response(finalBytes, { headers: { 'content-type': 'application/wasm' } }),
      );
    } catch {
      // Quota failures should not block execution.
    }
  }
  onProgress({ phase: 'downloaded', loaded: finalBytes.byteLength, total: finalBytes.byteLength });
  imageCacheEntry = { key: logicalKey, bytes: finalBytes };
  return finalBytes;
}

async function readWithProgress(response, onDelta) {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    onDelta(buffer.byteLength);
    return buffer;
  }
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      parts.push(value);
      total += value.byteLength;
      onDelta(value.byteLength);
    }
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function buildWorkspaceDirectory(files) {
  const root = new Map();
  for (const file of files) {
    const path = normalizeGuestPath(file.path);
    if (!path) continue;
    const segments = path.split('/');
    let directory = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      const existing = directory.get(segment);
      if (existing instanceof Directory) {
        directory = existing.contents;
      } else {
        const next = new Map();
        directory.set(segment, new Directory(next));
        directory = next;
      }
    }
    const name = segments[segments.length - 1];
    directory.set(name, new File(new TextEncoder().encode(file.content ?? '')));
  }
  return new Directory(root);
}

function collectFiles(preopen) {
  const files = [];
  const strict = new TextDecoder('utf-8', { fatal: true });
  const walk = (contents, prefix) => {
    for (const [name, entry] of contents) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry instanceof Directory) {
        walk(entry.contents, path);
      } else if (entry && entry.data instanceof Uint8Array) {
        if (entry.data.byteLength > 2 * 1024 * 1024) continue;
        try {
          files.push({ path, content: strict.decode(entry.data) });
        } catch {
          // Binary output from the guest is intentionally not mirrored into the
          // text-only browser workspace.
        }
      }
    }
  };
  walk(preopen.dir.contents, '');
  return files;
}

class OutputFd {
  constructor(onWrite) {
    this.onWrite = onWrite;
    this.decoder = new TextDecoder('utf-8', { fatal: false });
  }

  fd_write(data) {
    if (data && data.byteLength > 0) {
      this.onWrite(this.decoder.decode(data, { stream: true }));
      return { ret: 0, nwritten: data.byteLength };
    }
    return { ret: 0, nwritten: 0 };
  }

  fd_fdstat_get() {
    return { ret: 0, fdstat: null };
  }

  fd_filestat_get() {
    return { ret: 0, filestat: null };
  }

  fd_close() {
    return 0;
  }

  fd_seek() {
    return { ret: 0, offset: 0 };
  }

  fd_tell() {
    return { ret: 0, offset: 0 };
  }

  fd_read() {
    return { ret: 0, data: new Uint8Array(0) };
  }
}

function normalizeGuestPath(input) {
  const segments = [];
  for (const segment of String(input).replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseExit(error) {
  const message = String(error);
  const match = /exit with exit code (\d+)/.exec(message);
  if (match) return Number(match[1]);
  return null;
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function post(message) {
  self.postMessage(message);
}

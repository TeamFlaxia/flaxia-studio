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
import {
  Directory,
  File,
  OpenFile,
  PreopenDirectory,
  WASI,
  WASIProcExit,
} from './browser_wasi_shim/index.js';
import {
  Ciovec,
  EVENTTYPE_CLOCK,
  EVENTTYPE_FD_READ,
  Event,
  Iovec,
  Subscription,
} from './browser_wasi_shim/wasi_defs.js';

const SESSION_SCRIPT = String.raw`set +e
rm -rf /tmp/flaxia-work
mkdir -p /tmp/flaxia-work
cp -a /workspace/. /tmp/flaxia-work/ 2>/dev/null
chmod -R u+rwx /tmp/flaxia-work 2>/dev/null
cd /tmp/flaxia-work
stty -echo 2>/dev/null
__flaxia_status=0
__flaxia_sync() {
  printf '\n__FLAXIA_SYNC_BEGIN_@NONCE@__\n'
  find /tmp/flaxia-work -type f ! -path '/tmp/flaxia-work/.flaxia/*' | while IFS= read -r __f; do
    printf 'F:%s\n' "@DOLLAR@{__f#/tmp/flaxia-work/}"
    base64 -w0 "$__f" 2>/dev/null || base64 "$__f" | tr -d '\n'
    printf '\n'
  done
  printf '__FLAXIA_DONE_@NONCE@__%s\n' "$__flaxia_status"
  printf '__FLAXIA_SYNC_END_@NONCE@__\n'
}
__flaxia_run=0
printf '__FLAXIA_READY_@NONCE@__\n'
while IFS= read -r __line; do
  case "$__line" in
    __FLAXIA_RUN_BEGIN__)
      : > /tmp/flaxia-run.b64
      __flaxia_run=1
      ;;
    __FLAXIA_RUN_END__)
      base64 -d /tmp/flaxia-run.b64 > /tmp/flaxia-run.sh
      . /tmp/flaxia-run.sh
      __flaxia_status=$?
      __flaxia_run=0
      ;;
    __FLAXIA_SYNC__)
      __flaxia_sync
      ;;
    __FLAXIA_QUIT__)
      break
      ;;
    *)
      if [ "$__flaxia_run" = "1" ]; then
        printf '%s\n' "$__line" >> /tmp/flaxia-run.b64
      fi
      ;;
  esac
done
`.replaceAll('@DOLLAR@', '$');

const IMAGE_CACHE = 'flaxia-studio-linux-v1';
const FETCH_SCRIPT = String.raw`import socket, ssl, sys, urllib.parse
url = sys.argv[1]
u = urllib.parse.urlsplit(url)
host = u.hostname
port = u.port or (443 if u.scheme == "https" else 80)
path = (u.path or "/") + (("?" + u.query) if u.query else "")
s = socket.create_connection(("192.168.127.253", 80), 10)
if u.scheme == "https":
    s.sendall(("CONNECT " + host + ":" + str(port) + " HTTP/1.1\r\nHost: " + host + ":" + str(port) + "\r\n\r\n").encode())
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = s.recv(4096)
        if not chunk:
            break
        head += chunk
    s = ssl._create_unverified_context().wrap_socket(s, server_hostname=host)
else:
    s.sendall(("GET " + url + " HTTP/1.1\r\nHost: " + host + "\r\nConnection: close\r\n\r\n").encode())
s.sendall(("GET " + path + " HTTP/1.1\r\nHost: " + host + "\r\nConnection: close\r\nUser-Agent: FlaxiaStudio\r\n\r\n").encode())
data = b""
while True:
    chunk = s.recv(65536)
    if not chunk:
        break
    data += chunk
s.close()
head, _, body = data.partition(b"\r\n\r\n")
if b"transfer-encoding: chunked" in head.lower():
    out = b""
    while body:
        line, _, rest = body.partition(b"\r\n")
        try:
            size = int(line.split(b";")[0], 16)
        except ValueError:
            break
        if size == 0:
            break
        out += rest[:size]
        body = rest[size + 2 :]
    body = out
sys.stdout.buffer.write(body)
`;

let busy = false;
let imageCacheEntry = { key: null, bytes: null };
let moduleCacheEntry = { key: null, module: null };
let socketState = null;

self.onmessage = (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if ((message.type === 'net-init' || message.type === 'init') && message.buf instanceof SharedArrayBuffer) {
    registerSocketBuffer(message.buf);
    return;
  }
  if (message.type === 'session-start') {
    void startSession(message);
    return;
  }
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

    let cert = null;
    if (message.network && socketState) {
      try {
        cert = await recvCert(20000);
      } catch {
        cert = null;
      }
    }
    const activeNetwork = Boolean(cert && cert.byteLength > 0);
    const output = new OutputFd((text) => post({ type: 'output', text }));
    const stdin = new OpenFile(new File(new Uint8Array(0)));

    const cwd = normalizeGuestPath(message.cwd ?? '');
    const command = message.command ?? 'true';
    const work = '/tmp/flaxia-work';
    const shellCommand = [
      `rm -rf ${work} && mkdir -p ${work}`,
      `cp -a /workspace/. ${work}/ 2>/dev/null`,
      // The preopen directory does not carry POSIX mode bits. Give the
      // temporary copy normal permissions so compiled binaries can execute.
      `chmod -R u+rwx ${work} 2>/dev/null`,
      `cd ${shellQuote(cwd ? `${work}/${cwd}` : work)} 2>/dev/null || cd ${work}`,
      command,
      '__flaxia_status=$?',
      `find /workspace -mindepth 1 ! -path '/workspace/.flaxia' ! -path '/workspace/.flaxia/*' -delete 2>/dev/null`,
      `cp -a ${work}/. /workspace/ 2>/dev/null`,
      'exit $__flaxia_status',
    ].join('\n');
    const workspaceDir = buildWorkspaceDirectory([
      ...files,
      { path: '.flaxia/run.sh', content: shellCommand },
      { path: '.flaxia/fetch.py', content: FETCH_SCRIPT },
    ]);
    const preopen = new PreopenDirectory('/workspace', workspaceDir.contents);
    let fds;
    if (activeNetwork) {
      const certDir = new PreopenDirectory('/.wasmenv', new Map([['proxy.crt', new File(cert)]]));
      fds = [stdin, output, output, certDir, undefined, undefined, preopen];
    } else {
      fds = [stdin, output, output, preopen];
    }
    const args = ['arg0'];
    if (activeNetwork) args.push('--net=socket=listenfd=4', '--mac', genMac(), '-no-stdin');
    args.push('-entrypoint', '/bin/sh', '--', '/workspace/.flaxia/run.sh');
    const env = [
      'HOME=/workspace',
      'USER=flaxia',
      'TERM=dumb',
      'PWD=/workspace',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'LANG=C.UTF-8',
    ];
    if (activeNetwork) {
      env.push(
        'SSL_CERT_FILE=/.wasmenv/proxy.crt',
        'https_proxy=http://192.168.127.253:80',
        'http_proxy=http://192.168.127.253:80',
        'HTTPS_PROXY=http://192.168.127.253:80',
        'HTTP_PROXY=http://192.168.127.253:80',
      );
    }

    const wasi = new WASI(args, env, fds, { debug: false });
    if (activeNetwork) {
      installSocketHooks(wasi, 4, 5);
    }
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
    const data = file.binary
      ? base64ToBytes(file.content ?? '')
      : new TextEncoder().encode(file.content ?? '');
    directory.set(name, new File(data));
  }
  return new Directory(root);
}

function collectFiles(preopen) {
  const files = [];
  const strict = new TextDecoder('utf-8', { fatal: true });
  const walk = (contents, prefix) => {
    for (const [name, entry] of contents) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (path === '.flaxia' || path.startsWith('.flaxia/')) continue;
      if (entry instanceof Directory) {
        walk(entry.contents, path);
      } else if (entry && entry.data instanceof Uint8Array) {
        if (entry.data.byteLength > 20 * 1024 * 1024) continue;
        try {
          const text = strict.decode(entry.data);
          if (text.includes('\0')) throw new Error('binary');
          files.push({ path, content: text, binary: false });
        } catch {
          files.push({ path, content: bytesToBase64(entry.data), binary: true });
        }
      }
    }
  };
  walk(preopen.dir.contents, '');
  return files;
}

// ------------------------------------------------------------
// container2wasm browser Fetch networking
// ------------------------------------------------------------
function registerSocketBuffer(shared) {
  socketState = {
    ctrl: new Int32Array(shared, 0, 1),
    status: new Int32Array(shared, 4, 1),
    len: new Int32Array(shared, 8, 1),
    data: new Uint8Array(shared, 12),
  };
}

function recvCert(timeoutMs) {
  if (!socketState) return Promise.reject(new Error('Network stack is not initialized.'));
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + timeoutMs;
    let buffer = new Uint8Array(0);
    const getCert = () => {
      socketState.ctrl[0] = 0;
      post({ type: 'recv_cert' });
      Atomics.wait(socketState.ctrl, 0, 0);
      if (socketState.status[0] < 0) {
        if (performance.now() > deadline) {
          reject(new Error('Timed out waiting for the browser proxy certificate.'));
          return;
        }
        setTimeout(getCert, 100);
        return;
      }
      const length = socketState.len[0];
      buffer = appendData(buffer, socketState.data.slice(0, length));
      if (socketState.status[0] === 0) {
        resolve(buffer);
      } else {
        setTimeout(getCert, 0);
      }
    };
    getCert();
  });
}

function sockAccept() {
  if (!socketState) return false;
  socketState.ctrl[0] = 0;
  post({ type: 'accept' });
  Atomics.wait(socketState.ctrl, 0, 0);
  return socketState.data[0] === 1;
}

function sockSend(data) {
  if (!socketState) return -1;
  socketState.ctrl[0] = 0;
  post({ type: 'send', buf: data });
  Atomics.wait(socketState.ctrl, 0, 0);
  return socketState.status[0];
}

function sockRecv(length) {
  if (!socketState) return new Uint8Array(0);
  socketState.ctrl[0] = 0;
  post({ type: 'recv', len: length });
  Atomics.wait(socketState.ctrl, 0, 0);
  if (socketState.status[0] < 0) return null;
  return socketState.data.slice(0, socketState.len[0]);
}

function sockWaitForReadable(timeoutSeconds) {
  if (!socketState) return false;
  socketState.ctrl[0] = 0;
  post({ type: 'recv-is-readable', timeout: timeoutSeconds });
  Atomics.wait(socketState.ctrl, 0, 0);
  if (socketState.status[0] < 0) return null;
  return socketState.data[0] === 1;
}

function genMac() {
  return '02:XX:XX:XX:XX:XX'.replace(/X/g, () => '0123456789ABCDEF'.charAt(Math.floor(Math.random() * 16)));
}

function appendData(first, second) {
  const merged = new Uint8Array(first.byteLength + second.byteLength);
  merged.set(first, 0);
  merged.set(second, first.byteLength);
  return merged;
}

function sleep(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function installSocketHooks(wasi, listenfd, connfd) {
  const ERRNO_INVAL = 28;
  const ERRNO_AGAIN = 6;
  let connfdUsed = false;

  const fdClose = wasi.wasiImport.fd_close;
  wasi.wasiImport.fd_close = (fd) => {
    if (fd === connfd) {
      connfdUsed = false;
      return 0;
    }
    return fdClose.apply(wasi.wasiImport, [fd]);
  };

  const fdRead = wasi.wasiImport.fd_read;
  wasi.wasiImport.fd_read = (fd, iovsPtr, iovsLen, nreadPtr) => {
    if (fd === connfd) return wasi.wasiImport.sock_recv(fd, iovsPtr, iovsLen, 0, nreadPtr, 0);
    return fdRead.apply(wasi.wasiImport, [fd, iovsPtr, iovsLen, nreadPtr]);
  };

  const fdWrite = wasi.wasiImport.fd_write;
  wasi.wasiImport.fd_write = (fd, iovsPtr, iovsLen, nwrittenPtr) => {
    if (fd === connfd) return wasi.wasiImport.sock_send(fd, iovsPtr, iovsLen, 0, nwrittenPtr);
    return fdWrite.apply(wasi.wasiImport, [fd, iovsPtr, iovsLen, nwrittenPtr]);
  };

  const fdFdstatGet = wasi.wasiImport.fd_fdstat_get;
  wasi.wasiImport.fd_fdstat_get = (fd, fdstatPtr) => {
    if (fd === listenfd || (fd === connfd && connfdUsed)) {
      const view = new DataView(wasi.inst.exports.memory.buffer);
      view.setUint8(fdstatPtr, 6);
      view.setUint8(fdstatPtr + 1, 2);
      return 0;
    }
    return fdFdstatGet.apply(wasi.wasiImport, [fd, fdstatPtr]);
  };

  const fdPrestatGet = wasi.wasiImport.fd_prestat_get;
  wasi.wasiImport.fd_prestat_get = (fd, prestatPtr) => {
    if (fd === listenfd || fd === connfd) {
      const view = new DataView(wasi.inst.exports.memory.buffer);
      view.setUint8(prestatPtr, 1);
      return 0;
    }
    return fdPrestatGet.apply(wasi.wasiImport, [fd, prestatPtr]);
  };

  wasi.wasiImport.sock_accept = (fd, _flags, fdPtr) => {
    if (fd !== listenfd) return ERRNO_INVAL;
    if (connfdUsed) return ERRNO_INVAL;
    if (!sockAccept()) return ERRNO_AGAIN;
    connfdUsed = true;
    new DataView(wasi.inst.exports.memory.buffer).setUint32(fdPtr, connfd, true);
    return 0;
  };

  wasi.wasiImport.sock_send = (fd, iovsPtr, iovsLen, _flags, nwrittenPtr) => {
    if (fd !== connfd) return ERRNO_INVAL;
    const view = new DataView(wasi.inst.exports.memory.buffer);
    const bytes = new Uint8Array(wasi.inst.exports.memory.buffer);
    const iovecs = Ciovec.read_bytes_array(view, iovsPtr, iovsLen);
    let total = 0;
    for (const iovec of iovecs) {
      const data = bytes.slice(iovec.buf, iovec.buf + iovec.buf_len);
      if (data.byteLength === 0) continue;
      if (sockSend(data) < 0) return ERRNO_INVAL;
      total += data.byteLength;
    }
    view.setUint32(nwrittenPtr, total, true);
    return 0;
  };

  wasi.wasiImport.sock_recv = (fd, iovsPtr, iovsLen, _flags, nreadPtr) => {
    if (fd !== connfd) return ERRNO_INVAL;
    const readable = sockWaitForReadable();
    if (readable === null) return ERRNO_INVAL;
    if (readable === false) return ERRNO_AGAIN;
    const view = new DataView(wasi.inst.exports.memory.buffer);
    const bytes = new Uint8Array(wasi.inst.exports.memory.buffer);
    const iovecs = Iovec.read_bytes_array(view, iovsPtr, iovsLen);
    let total = 0;
    for (const iovec of iovecs) {
      if (iovec.buf_len === 0) continue;
      const data = sockRecv(iovec.buf_len);
      if (data === null) return ERRNO_INVAL;
      bytes.set(data, iovec.buf);
      total += data.byteLength;
    }
    view.setUint32(nreadPtr, total, true);
    return 0;
  };

  wasi.wasiImport.sock_shutdown = (fd) => {
    if (fd === connfd) connfdUsed = false;
    return 0;
  };

  wasi.wasiImport.poll_oneoff = (inPtr, outPtr, subscriptions, neventsPtr) => {
    if (subscriptions === 0) return ERRNO_INVAL;
    const view = new DataView(wasi.inst.exports.memory.buffer);
    const subs = [];
    for (let index = 0; index < subscriptions; index += 1) {
      subs.push(Subscription.read_bytes(view, inPtr + 48 * index));
    }
    const events = [];
    const clocks = [];
    for (let index = 0; index < subs.length; index += 1) {
      const sub = subs[index];
      if (sub.eventtype === EVENTTYPE_FD_READ) {
        const fd = view.getUint32(inPtr + 48 * index + 16, true);
        if (fd === 0) {
          // Command mode has no interactive stdin. Do not report EOF as a
          // readable event; the guest would treat it as a closed terminal.
        } else if (fd === connfd) {
          const readable = sockWaitForReadable(0.002);
          if (readable === null) return ERRNO_INVAL;
          if (readable) events.push(new Event(sub.userdata, 0, sub.eventtype));
        } else {
          return ERRNO_INVAL;
        }
      } else if (sub.eventtype === 2) {
        events.push(new Event(sub.userdata, 0, sub.eventtype));
      } else if (sub.eventtype === EVENTTYPE_CLOCK) {
        clocks.push(sub);
      } else {
        return ERRNO_INVAL;
      }
    }
    if (events.length === 0 && clocks.length > 0) {
      const waitMs = Math.min(100, ...clocks.map((sub) => Math.max(0, Number(sub.timeout) / 1_000_000)));
      sleep(waitMs);
      for (const sub of clocks) events.push(new Event(sub.userdata, 0, sub.eventtype));
    }
    for (let index = 0; index < events.length; index += 1) {
      events[index].write_bytes(view, outPtr + 32 * index);
    }
    view.setUint32(neventsPtr, events.length, true);
    return 0;
  };
}

// ------------------------------------------------------------
// Persistent session mode
// ------------------------------------------------------------
class SessionInput {
  constructor(shared) {
    this.ctrl = new Int32Array(shared, 0, 1);
    this.lengthView = new Int32Array(shared, 4, 1);
    this.data = new Uint8Array(shared, 12);
    this.pos = 0;
    this.length = 0;
  }

  fd_read(size) {
    if (this.pos >= this.length) {
      this.pos = 0;
      this.length = 0;
    }
    while (Atomics.load(this.ctrl, 0) === 0) {
      Atomics.wait(this.ctrl, 0, 0);
    }
    this.length = Atomics.load(this.lengthView, 0);
    const count = Math.min(size, this.length - this.pos);
    const data = this.data.slice(this.pos, this.pos + count);
    this.pos += count;
    if (this.pos >= this.length) {
      this.pos = 0;
      this.length = 0;
      Atomics.store(this.ctrl, 0, 0);
    }
    return { ret: 0, data };
  }

  hasData() {
    return Atomics.load(this.ctrl, 0) !== 0 && Atomics.load(this.lengthView, 0) > 0;
  }

  fd_fdstat_get() {
    return { ret: 0, fdstat: null };
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
}

function createSessionParser(nonce) {
  const readyMarker = `__FLAXIA_READY_${nonce}__`;
  const beginMarker = `__FLAXIA_SYNC_BEGIN_${nonce}__`;
  const endMarker = `__FLAXIA_SYNC_END_${nonce}__`;
  const donePattern = new RegExp(`__FLAXIA_DONE_${nonce}__(\\d+)`);
  let raw = '';
  let inDump = false;
  let readySent = false;
  const maxMarker = Math.max(readyMarker.length, beginMarker.length, endMarker.length);

  return (text) => {
    raw += text;
    for (;;) {
      if (inDump) {
        const endIndex = raw.indexOf(endMarker);
        if (endIndex === -1) return;
        const dump = raw.slice(0, endIndex);
        raw = raw.slice(endIndex + endMarker.length);
        inDump = false;
        const done = donePattern.exec(dump);
        post({
          type: 'session-files',
          files: decodeDumpFiles(dump),
          exitCode: done ? Number(done[1]) : 0,
        });
        continue;
      }
      if (!readySent && raw.includes(readyMarker)) {
        raw = raw.replace(readyMarker, '');
        readySent = true;
        post({ type: 'session-ready' });
        continue;
      }
      const beginIndex = raw.indexOf(beginMarker);
      if (beginIndex !== -1) {
        if (beginIndex > 0) post({ type: 'output', text: raw.slice(0, beginIndex) });
        raw = raw.slice(beginIndex + beginMarker.length);
        inDump = true;
        continue;
      }
      const keep = maxMarker - 1;
      if (raw.length > keep) {
        const safe = raw.slice(0, raw.length - keep);
        if (safe) post({ type: 'output', text: safe });
        raw = raw.slice(raw.length - keep);
      }
      return;
    }
  };
}

function decodeDumpFiles(dump) {
  const files = [];
  const strict = new TextDecoder('utf-8', { fatal: true });
  const lines = dump.split('\n');
  let current = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('F:')) {
      current = line.slice(2);
      continue;
    }
    if (!current || !line) continue;
    try {
      const bytes = base64ToBytes(line);
      try {
        const text = strict.decode(bytes);
        if (text.includes('\0')) throw new Error('binary');
        files.push({ path: current, content: text, binary: false });
      } catch {
        files.push({ path: current, content: line, binary: true });
      }
    } catch {
      // Ignore a malformed dump line rather than failing the session.
    }
    current = null;
  }
  return files;
}

function installSessionPoll(wasi, input) {
  wasi.wasiImport.poll_oneoff = (inPtr, outPtr, subscriptions, neventsPtr) => {
    if (subscriptions === 0) return 28;
    const view = new DataView(wasi.inst.exports.memory.buffer);
    const subs = [];
    for (let index = 0; index < subscriptions; index += 1) {
      subs.push(Subscription.read_bytes(view, inPtr + 48 * index));
    }
    const events = [];
    let clockTimeout = Infinity;
    const clocks = [];
    for (let index = 0; index < subs.length; index += 1) {
      const sub = subs[index];
      if (sub.eventtype === EVENTTYPE_FD_READ) {
        const fd = view.getUint32(inPtr + 48 * index + 16, true);
        if (fd !== 0) return 28;
      } else if (sub.eventtype === EVENTTYPE_CLOCK) {
        clocks.push(sub);
        clockTimeout = Math.min(clockTimeout, Number(sub.timeout) / 1_000_000);
      } else {
        return 28;
      }
    }
    if (subs.some((sub) => sub.eventtype === EVENTTYPE_FD_READ)) {
      const deadline = clockTimeout === Infinity ? Infinity : performance.now() + clockTimeout;
      while (!input.hasData()) {
        const remaining = deadline === Infinity ? 100 : Math.max(0, deadline - performance.now());
        if (remaining <= 0) break;
        const state = Atomics.load(input.ctrl, 0);
        if (state === 0) Atomics.wait(input.ctrl, 0, 0, Math.min(remaining, 100));
      }
      if (input.hasData()) {
        for (let index = 0; index < subs.length; index += 1) {
          if (subs[index].eventtype === EVENTTYPE_FD_READ) {
            events.push(new Event(subs[index].userdata, 0, EVENTTYPE_FD_READ));
          }
        }
      }
    }
    if (events.length === 0 && clocks.length > 0) {
      const waitMs = Math.min(100, clockTimeout);
      if (waitMs > 0) {
        const signal = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(signal, 0, 0, waitMs);
      }
      for (const sub of clocks) events.push(new Event(sub.userdata, 0, EVENTTYPE_CLOCK));
    }
    for (let index = 0; index < events.length; index += 1) {
      events[index].write_bytes(view, outPtr + 32 * index);
    }
    view.setUint32(neventsPtr, events.length, true);
    return 0;
  };
}

async function startSession(message) {
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

    const nonce = randomNonce();
    const files = Array.isArray(message.files) ? message.files : [];
    const workspaceDir = buildWorkspaceDirectory([
      ...files,
      { path: '.flaxia/session.sh', content: SESSION_SCRIPT.replaceAll('@NONCE@', nonce) },
      { path: '.flaxia/fetch.py', content: FETCH_SCRIPT },
    ]);
    const preopen = new PreopenDirectory('/workspace', workspaceDir.contents);
    const parser = createSessionParser(nonce);
    const input = new SessionInput(message.inputBuf);
    const output = new OutputFd((text) => {
      parser(text);
    });
    const args = ['arg0', '-entrypoint', '/bin/sh', '--', '/workspace/.flaxia/session.sh'];
    const env = [
      'HOME=/workspace',
      'USER=flaxia',
      'TERM=dumb',
      'PWD=/workspace',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'LANG=C.UTF-8',
    ];
    const wasi = new WASI(args, env, [input, output, output, preopen], { debug: false });
    installSessionPoll(wasi, input);
    const instantiated = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: wasi.wasiImport,
    });
    const instance = instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance;
    const result = wasi.start(instance);
    post({ type: 'session-ended', code: typeof result === 'number' ? result : 0 });
  } catch (error) {
    post({
      type: 'session-error',
      message: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
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

function randomNonce() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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

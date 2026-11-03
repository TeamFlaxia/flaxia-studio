import { bytesToBase64 } from '../fs/base64';
import type { ResolvedLinuxImage } from './manifest';
import type { LinuxFile, LinuxRunResult } from './runtime';

interface SessionMessage {
  type: 'session-ready' | 'session-files' | 'session-ended' | 'session-error' | 'output' | 'progress';
  text?: string;
  files?: LinuxFile[];
  exitCode?: number;
  code?: number;
  message?: string;
}

interface PendingCommand {
  resolve: (result: LinuxRunResult) => void;
  reject: (error: Error) => void;
  onOutput: (text: string) => void;
  timer: number;
  startedAt: number;
}

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const INPUT_BYTES = 1024 * 1024;
const MAX_SCRIPT_BYTES = 700 * 1024;

export class LinuxSession {
  private readonly worker: Worker;
  private readonly input = new SharedArrayBuffer(12 + INPUT_BYTES);
  private readonly ctrl = new Int32Array(this.input, 0, 1);
  private readonly inputLength = new Int32Array(this.input, 4, 1);
  private readonly inputData = new Uint8Array(this.input, 12);
  private lastFiles = new Map<string, LinuxFile>();
  private ready: { resolve: () => void; reject: (error: Error) => void; timer: number } | null = null;
  private pending: PendingCommand | null = null;
  private closed = false;

  constructor(
    workerUrl: string,
    private readonly image: ResolvedLinuxImage,
  ) {
    this.worker = new Worker(workerUrl, { type: 'module' });
    this.worker.addEventListener('message', (event: MessageEvent<SessionMessage>) => {
      this.handleMessage(event.data);
    });
    this.worker.onerror = (event) => {
      this.fail(new Error(event.message || 'Linux session worker crashed.'));
    };
  }

  async start(files: LinuxFile[]): Promise<void> {
    this.lastFiles = new Map(files.map((file) => [file.path, file]));
    const ready = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.ready = null;
        reject(new Error('Linux session did not become ready.'));
      }, 60_000);
      this.ready = { resolve, reject, timer };
    });
    this.worker.postMessage({
      type: 'session-start',
      imageUrl: this.image.imageUrl,
      chunks: this.image.chunks,
      chunkUrlTemplate: this.image.chunkUrlTemplate,
      compression: this.image.compression ?? 'none',
      totalBytes: this.image.totalBytes,
      digest: this.image.digest,
      version: this.image.version,
      files,
      inputBuf: this.input,
    });
    await ready;
  }

  run(
    command: string,
    cwd: string,
    onOutput: (text: string) => void,
    files: LinuxFile[],
  ): Promise<LinuxRunResult> {
    if (this.closed) return Promise.reject(new Error('Linux session is closed.'));
    if (this.pending) return Promise.reject(new Error('Linux session is busy.'));
    const startedAt = performance.now();
    const script = this.buildScript(command, cwd, files);
    const encoded = bytesToBase64(new TextEncoder().encode(script));
    const chunks = encoded.match(/.{1,1000}/g) ?? [];
    const payload = ['__FLAXIA_RUN_BEGIN__', ...chunks, '__FLAXIA_RUN_END__', '__FLAXIA_SYNC__', ''].join(
      '\n',
    );
    const payloadBytes = new TextEncoder().encode(payload);
    if (payloadBytes.byteLength > MAX_SCRIPT_BYTES) {
      return Promise.reject(new Error('Workspace diff is too large for the live Linux session.'));
    }

    return new Promise<LinuxRunResult>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.fail(new Error('Linux session command timed out.'));
      }, COMMAND_TIMEOUT_MS);
      this.pending = { resolve, reject, onOutput, timer, startedAt };
      Atomics.store(this.ctrl, 0, 0);
      this.inputData.set(payloadBytes, 0);
      Atomics.store(this.inputLength, 0, payloadBytes.byteLength);
      Atomics.store(this.ctrl, 0, 1);
      Atomics.notify(this.ctrl, 0);
    });
  }

  dispose(): void {
    this.closed = true;
    this.worker.terminate();
    this.fail(new Error('Linux session disposed.'));
  }

  private buildScript(command: string, cwd: string, files: LinuxFile[]): string {
    const current = new Map(files.map((file) => [file.path, file]));
    const lines: string[] = [];
    for (const file of files) {
      const previous = this.lastFiles.get(file.path);
      if (previous && previous.content === file.content && previous.binary === file.binary) continue;
      const parent = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
      if (parent) lines.push(`mkdir -p ${quote(`/tmp/flaxia-work/${parent}`)}`);
      const data = file.binary ? base64ToBytesSafe(file.content) : new TextEncoder().encode(file.content);
      const encoded = bytesToBase64(data);
      lines.push(': > /tmp/flaxia-upload.b64');
      for (let offset = 0; offset < encoded.length; offset += 1000) {
        lines.push(`printf '%s\n' ${quote(encoded.slice(offset, offset + 1000))} >> /tmp/flaxia-upload.b64`);
      }
      lines.push(
        `base64 -d /tmp/flaxia-upload.b64 > ${quote(`/tmp/flaxia-work/${file.path}`)}`,
        'rm -f /tmp/flaxia-upload.b64',
      );
    }
    for (const path of this.lastFiles.keys()) {
      if (current.has(path)) continue;
      lines.push(`rm -f ${quote(`/tmp/flaxia-work/${path}`)}`);
    }
    const directory = cwd ? `/tmp/flaxia-work/${cwd}` : '/tmp/flaxia-work';
    lines.push(`cd ${quote(directory)} 2>/dev/null || cd /tmp/flaxia-work`);
    lines.push(command);
    return lines.join('\n');
  }

  private handleMessage(message: SessionMessage): void {
    switch (message.type) {
      case 'session-ready': {
        const ready = this.ready;
        if (!ready) return;
        window.clearTimeout(ready.timer);
        this.ready = null;
        ready.resolve();
        break;
      }
      case 'output':
        this.pending?.onOutput(message.text ?? '');
        break;
      case 'session-files': {
        const pending = this.pending;
        if (!pending) return;
        window.clearTimeout(pending.timer);
        this.pending = null;
        const files = message.files ?? [];
        this.lastFiles = new Map(files.map((file) => [file.path, file]));
        pending.resolve({
          files,
          exitCode: message.exitCode ?? 0,
          durationMs: Math.round(performance.now() - pending.startedAt),
        });
        break;
      }
      case 'session-error':
      case 'session-ended':
        this.fail(
          new Error(
            message.message ??
              `Linux session ended${message.code !== undefined ? ` (code ${message.code})` : ''}.`,
          ),
        );
        break;
      case 'progress':
        break;
    }
  }

  private fail(error: Error): void {
    const ready = this.ready;
    if (ready) {
      window.clearTimeout(ready.timer);
      this.ready = null;
      ready.reject(error);
    }
    const pending = this.pending;
    if (pending) {
      window.clearTimeout(pending.timer);
      this.pending = null;
      pending.reject(error);
    }
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function base64ToBytesSafe(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

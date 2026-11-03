import type { Workspace } from '../fs/workspace';
import { loadManifest, type ResolvedLinuxImage } from './manifest';

export type LinuxState = 'idle' | 'loading' | 'ready' | 'running' | 'error';

export interface LinuxProgress {
  phase: string;
  loaded: number;
  total: number;
}

export interface LinuxStatus {
  state: LinuxState;
  label: string;
  detail: string;
  progress: LinuxProgress | null;
  image: ResolvedLinuxImage | null;
}

export interface LinuxFile {
  path: string;
  content: string;
  binary?: boolean;
}

export interface LinuxRunResult {
  files: LinuxFile[];
  exitCode: number;
  durationMs: number;
}

interface PendingRun {
  resolve: (result: LinuxRunResult) => void;
  reject: (error: Error) => void;
  onOutput: (text: string) => void;
  timer: number;
}

interface WorkerMessage {
  type: 'progress' | 'output' | 'done' | 'error';
  phase?: string;
  loaded?: number;
  total?: number;
  text?: string;
  files?: LinuxFile[];
  exitCode?: number;
  durationMs?: number;
  message?: string;
}

const WORKER_URL = `${import.meta.env.BASE_URL}linux-runtime/worker.js`;
const IMAGE_CACHE = 'flaxia-studio-linux-v1';
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

export class LinuxRuntime {
  private worker: Worker | null = null;
  private pending: PendingRun | null = null;
  private image: ResolvedLinuxImage | null = null;
  private state: LinuxState = 'idle';
  private label = 'Linux';
  private detail = 'Not booted';
  private progress: LinuxProgress | null = null;
  private readonly listeners = new Set<(status: LinuxStatus) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private stackWorker: Worker | null = null;
  private workerNetworkReady = false;
  private networkEnabled = true;
  private networkFailed = false;

  get manifestUrl(): string {
    return this.manifestSource;
  }

  private manifestSource = 'auto';

  setManifestUrl(url: string): void {
    this.manifestSource = url.trim() || 'auto';
    this.image = null;
    this.setState('idle', 'Linux', 'Not booted');
  }

  setNetworkEnabled(enabled: boolean): void {
    this.networkEnabled = enabled;
    this.networkFailed = false;
    if (!enabled) {
      this.stackWorker?.terminate();
      this.stackWorker = null;
      this.workerNetworkReady = false;
    }
  }

  subscribe(listener: (status: LinuxStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status());
    return () => this.listeners.delete(listener);
  }

  status(): LinuxStatus {
    return {
      state: this.state,
      label: this.label,
      detail: this.detail,
      progress: this.progress,
      image: this.image,
    };
  }

  isReady(): boolean {
    return this.state === 'ready' || this.state === 'running';
  }

  async boot(onOutput: (text: string) => void = () => {}): Promise<LinuxRunResult> {
    if (this.state === 'loading' || this.state === 'running') {
      throw new Error('Linux is already starting or running a command.');
    }
    if (this.state === 'ready' && this.image) {
      return this.enqueue('uname -a && echo ready', '', onOutput, []);
    }

    this.setState('loading', 'Linux', 'Loading manifest…');
    try {
      const image = await this.resolveImage();
      this.image = image;
      this.label = image.label ?? 'Linux';
      this.setState('loading', this.label, 'Starting Linux…');
      const result = await this.enqueue('uname -a', '', onOutput);
      if (result.exitCode !== 0) {
        throw new Error(`Linux boot check exited with code ${result.exitCode}.`);
      }
      this.setState('ready', this.label, `Ready · ${image.version}`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState('error', 'Linux', message);
      throw error;
    }
  }

  run(
    command: string,
    cwd: string,
    onOutput: (text: string) => void,
    workspace: Workspace,
    network = false,
  ): Promise<LinuxRunResult> {
    if (!this.image) {
      return Promise.reject(new Error('Boot Linux before running commands.'));
    }
    const files = workspace.filePaths().map((path) => {
      const entry = workspace.get(path);
      return {
        path,
        content: entry?.content ?? '',
        binary: entry?.binary === true,
      };
    });
    return this.enqueue(command, cwd, onOutput, files, network);
  }

  async clearCache(): Promise<void> {
    this.worker?.terminate();
    this.stackWorker?.terminate();
    this.worker = null;
    this.stackWorker = null;
    this.workerNetworkReady = false;
    this.image = null;
    this.progress = null;
    try {
      await caches.delete(IMAGE_CACHE);
    } catch {
      // Cache deletion is best-effort.
    }
    this.setState('idle', 'Linux', 'Image cache cleared');
  }

  dispose(): void {
    this.worker?.terminate();
    this.stackWorker?.terminate();
    this.worker = null;
    this.stackWorker = null;
    this.workerNetworkReady = false;
    if (this.pending) {
      window.clearTimeout(this.pending.timer);
      this.pending.reject(new Error('Linux runtime disposed.'));
      this.pending = null;
    }
  }

  private enqueue(
    command: string,
    cwd: string,
    onOutput: (text: string) => void,
    files?: LinuxFile[],
    network = false,
  ): Promise<LinuxRunResult> {
    const job = this.queue.then(() => this.execute(command, cwd, onOutput, files, network));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async execute(
    command: string,
    cwd: string,
    onOutput: (text: string) => void,
    files?: LinuxFile[],
    network = false,
  ): Promise<LinuxRunResult> {
    if (!this.image) return Promise.reject(new Error('Linux image is not loaded.'));
    const image = this.image;
    const worker = this.ensureWorker();
    if (network) await this.ensureNetwork(worker);
    this.setState('running', this.label, `Running: ${command.slice(0, 48)}`);

    return new Promise<LinuxRunResult>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.failPending(new Error('Linux command timed out.'));
        worker.terminate();
        this.worker = null;
        this.setState('error', this.label, 'Command timed out');
      }, RUN_TIMEOUT_MS);

      this.pending = { resolve, reject, onOutput, timer };
      worker.postMessage({
        type: 'run',
        imageUrl: image.imageUrl,
        chunks: image.chunks,
        chunkUrlTemplate: image.chunkUrlTemplate,
        compression: image.compression ?? 'none',
        totalBytes: image.totalBytes,
        digest: image.digest,
        version: image.version,
        cwd,
        command,
        files: files ?? [],
        network: network && this.networkEnabled && this.workerNetworkReady,
      });
    });
  }

  private async resolveImage(): Promise<ResolvedLinuxImage> {
    const legacyProductionPath =
      this.manifestSource === '/linux/manifest.json' || this.manifestSource === 'linux/manifest.json';
    if (this.manifestSource !== 'auto' && !legacyProductionPath) {
      return loadManifest(this.manifestSource);
    }
    const candidates = ['linux/manifest.json', 'linux/manifest-lite.json', 'linux/manifest-full.json'];
    let lastError: Error | null = null;
    for (const candidate of candidates) {
      try {
        return await loadManifest(candidate);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error('No Linux image manifest was found.');
  }

  private async ensureNetwork(worker: Worker): Promise<void> {
    if (!this.networkEnabled || this.networkFailed || this.workerNetworkReady || !this.image) return;
    const stackWorker = new Worker(`${import.meta.env.BASE_URL}linux-runtime/stack-worker.js`);
    stackWorker.onerror = (event) => {
      console.warn('[flaxia] network proxy worker failed:', event.message);
    };
    try {
      const stackUrl = `${import.meta.env.BASE_URL}linux-runtime/stack.js`;
      const module = (await import(/* @vite-ignore */ stackUrl)) as {
        newStack: (
          worker: Worker,
          imagePrefix: string,
          chunks: number,
          stackWorker: Worker,
          proxyImage: string,
        ) => unknown;
      };
      const netHandler = module.newStack(
        worker,
        this.image.imageUrl,
        this.image.chunks,
        stackWorker,
        `${import.meta.env.BASE_URL}linux-runtime/c2w-net-proxy.wasm`,
      ) as (event: MessageEvent) => void;
      worker.onmessage = netHandler;
      this.stackWorker = stackWorker;
      this.workerNetworkReady = true;
    } catch (error) {
      stackWorker.terminate();
      this.workerNetworkReady = false;
      this.networkFailed = true;
      console.warn('[flaxia] browser Fetch networking unavailable:', error);
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(WORKER_URL, { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) =>
      this.handleMessage(event.data),
    );
    worker.onerror = (event) => {
      this.failPending(new Error(event.message || 'Linux worker crashed.'));
      worker.terminate();
      if (this.worker === worker) this.worker = null;
      this.stackWorker?.terminate();
      this.stackWorker = null;
      this.workerNetworkReady = false;
      this.setState('error', this.label, 'Worker crashed');
    };
    this.worker = worker;
    return worker;
  }

  private handleMessage(message: WorkerMessage): void {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'progress': {
        this.progress = {
          phase: message.phase ?? 'loading',
          loaded: message.loaded ?? 0,
          total: message.total ?? 0,
        };
        const phaseLabel =
          message.phase === 'download'
            ? 'Downloading image'
            : message.phase === 'cache'
              ? 'Loading from cache'
              : message.phase === 'decompress'
                ? 'Decompressing image'
                : message.phase === 'verify'
                  ? 'Verifying image'
                  : message.phase === 'compile'
                    ? 'Compiling Linux'
                    : 'Starting Linux';
        this.setState(this.pending ? 'running' : 'loading', this.label, phaseLabel);
        break;
      }
      case 'output':
        this.pending?.onOutput(message.text ?? '');
        break;
      case 'done': {
        const pending = this.pending;
        if (!pending) return;
        window.clearTimeout(pending.timer);
        this.pending = null;
        this.progress = null;
        this.setState('ready', this.label, `Ready · ${this.image?.version ?? ''}`);
        pending.resolve({
          files: message.files ?? [],
          exitCode: message.exitCode ?? 0,
          durationMs: message.durationMs ?? 0,
        });
        break;
      }
      case 'error': {
        this.failPending(new Error(message.message ?? 'Linux runtime error.'));
        this.setState('error', this.label, message.message ?? 'Linux runtime error');
        break;
      }
    }
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    this.pending = null;
    this.progress = null;
    pending.reject(error);
  }

  private setState(state: LinuxState, label: string, detail: string): void {
    this.state = state;
    this.label = label;
    this.detail = detail;
    const status = this.status();
    for (const listener of this.listeners) listener(status);
    window.dispatchEvent(new CustomEvent<LinuxStatus>('flaxia:linux-status', { detail: status }));
  }
}

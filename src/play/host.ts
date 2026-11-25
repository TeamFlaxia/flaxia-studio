/**
 * Host side of the Test Play bridge.
 *
 * The studio owns an iframe pointing at the same-origin trusted shell
 * (`/play/shell.html`). The shell owns the sandboxed game iframe, so the
 * strict production CSP on the studio page never needs `blob:` frame sources:
 * only the shell document (served under the relaxed `/play/*` headers) embeds
 * untrusted content. `allow-same-origin` is never granted.
 */

import {
  PLAY_FRAME_ALLOW,
  PLAY_HANDSHAKE_TIMEOUT_MS,
  PLAY_LOAD_TIMEOUT_MS,
  type PlayPayload,
} from './policy.ts';
import {
  isPlayShellMessage,
  type PlayConsoleEntry,
  type PlayHostMessage,
  type PlayShellMessage,
} from './protocol.ts';
import { readPreviewStorage, writePreviewStorage } from './storage.ts';

export type PlayStatus = 'idle' | 'loading' | 'running' | 'error';

/** Thrown when a run is stopped (or the pane is torn down) before it fails. */
export class PlayStopped extends Error {}

interface Waiter {
  match: (message: PlayShellMessage) => boolean;
  resolve: (message: PlayShellMessage) => void;
  reject: (error: Error) => void;
  timer: number;
}

export class PlayHost {
  private iframe: HTMLIFrameElement | null = null;
  private shellReady = false;
  private requestId: string | null = null;
  private seq = 0;
  private waiters: Waiter[] = [];
  private status: PlayStatus = 'idle';
  private executing = false;
  private disposed = false;

  constructor(
    private readonly onStatusChange: (status: PlayStatus, detail?: string) => void,
    /** Storage namespace — one preview save per workspace. */
    private readonly storageNamespace: string,
    /** Receives console output and uncaught errors from the sandboxed game. */
    private readonly onConsoleEntry?: (entry: PlayConsoleEntry) => void,
  ) {
    window.addEventListener('message', this.handleMessage);
  }

  get currentStatus(): PlayStatus {
    return this.status;
  }

  get busy(): boolean {
    return this.executing;
  }

  mount(container: HTMLElement): void {
    if (this.disposed) return;
    if (this.iframe && this.iframe.parentElement === container) return;
    this.removeFrame();
    const iframe = document.createElement('iframe');
    iframe.className = 'play-frame';
    iframe.title = 'Test Play preview';
    // The shell is trusted same-origin code and must stay same-origin for the
    // postMessage handshake. The untrusted game is sandboxed one level down,
    // inside the shell.
    iframe.setAttribute('allow', PLAY_FRAME_ALLOW);
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.src = `${import.meta.env.BASE_URL}play/shell.html`;
    container.appendChild(iframe);
    this.iframe = iframe;
    this.shellReady = false;
  }

  async execute(payload: PlayPayload): Promise<void> {
    if (this.disposed) throw new Error('Test Play is unavailable.');
    if (!this.iframe?.contentWindow) throw new Error('Test Play pane is not mounted.');
    if (this.executing) await this.stopInternal();

    this.executing = true;
    try {
      this.setStatus('loading');
      if (!this.shellReady) {
        await this.waitFor((message) => message.type === 'play:ready', PLAY_HANDSHAKE_TIMEOUT_MS);
      }

      this.seq += 1;
      const requestId = `r${this.seq}_${Date.now().toString(36)}`;
      this.requestId = requestId;

      const acked = this.waitFor(
        (message) => message.type === 'play:init-ack' && message.requestId === requestId,
        PLAY_HANDSHAKE_TIMEOUT_MS,
      );
      this.post({ type: 'play:init', requestId });
      await acked;

      const finished = this.waitFor(
        (message) =>
          (message.type === 'play:result' || message.type === 'play:stopped') &&
          message.requestId === requestId,
        PLAY_LOAD_TIMEOUT_MS,
      );
      this.post({
        type: 'play:execute',
        requestId,
        entry: payload.entry,
        files: payload.files,
        totalBytes: payload.totalBytes,
        storage: readPreviewStorage(this.storageNamespace),
      });
      this.setStatus('running');

      const result = await finished;
      if (result.type === 'play:stopped') throw new PlayStopped('Test Play stopped.');
      if (result.type !== 'play:result') throw new Error('Test Play handshake failed.');
      if (!result.ok) throw new Error(result.error ?? 'Test Play failed to start.');
      this.setStatus('running');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(error instanceof PlayStopped ? 'idle' : 'error', message);
      throw error;
    } finally {
      this.executing = false;
    }
  }

  stop(): void {
    if (!this.requestId || !this.iframe?.contentWindow) {
      this.setStatus('idle');
      return;
    }
    this.post({ type: 'play:stop', requestId: this.requestId });
    if (!this.executing) this.setStatus('idle');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('message', this.handleMessage);
    for (const waiter of this.waiters.splice(0)) {
      window.clearTimeout(waiter.timer);
      waiter.reject(new PlayStopped('Test Play pane closed.'));
    }
    this.removeFrame();
    this.setStatus('idle');
  }

  private removeFrame(): void {
    this.iframe?.remove();
    this.iframe = null;
    this.shellReady = false;
    this.requestId = null;
  }

  private post(message: PlayHostMessage): void {
    this.iframe?.contentWindow?.postMessage(message, location.origin);
  }

  private setStatus(status: PlayStatus, detail?: string): void {
    this.status = status;
    this.onStatusChange(status, detail);
  }

  private waitFor(
    match: (message: PlayShellMessage) => boolean,
    timeoutMs: number,
  ): Promise<PlayShellMessage> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { match, resolve, reject, timer: 0 };
      waiter.timer = window.setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('Test Play timed out waiting for the preview shell.'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Settles an in-flight run so a new one can start. */
  private async stopInternal(): Promise<void> {
    if (!this.executing || !this.requestId) return;
    const requestId = this.requestId;
    const settled = this.waitFor(
      (message) =>
        (message.type === 'play:stopped' || message.type === 'play:result') &&
        message.requestId === requestId,
      2_000,
    ).catch(() => undefined);
    this.post({ type: 'play:stop', requestId });
    await settled;
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    if (this.disposed || event.origin !== location.origin) return;
    if (!this.iframe || event.source !== this.iframe.contentWindow) return;
    if (!isPlayShellMessage(event.data)) return;
    const message = event.data;
    if (message.type === 'play:ready') this.shellReady = true;
    if (message.type === 'play:storage-write') {
      writePreviewStorage(this.storageNamespace, message.operation, message.key, message.value);
    }
    if (message.type === 'play:console') this.onConsoleEntry?.(message.entry);
    for (const waiter of [...this.waiters]) {
      if (!waiter.match(message)) continue;
      const index = this.waiters.indexOf(waiter);
      if (index >= 0) this.waiters.splice(index, 1);
      window.clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  };
}

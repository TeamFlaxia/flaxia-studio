/**
 * Trusted Test Play shell (`/play/shell.html`).
 *
 * Runs at the same origin as the studio but under the relaxed `/play/*`
 * headers, so it may embed the untrusted game in a sandboxed iframe. The
 * payload is re-validated here — the shell does not trust the host message
 * shape alone.
 *
 * The game frame runs `/play/runtime.html` with an opaque origin (sandbox
 * without `allow-same-origin`). Chromium refuses to load blob URLs that were
 * created by another origin, so the shell rewrites local references to
 * placeholders and the runtime materialises the blobs inside the frame.
 */

import '../styles/tokens.css';
import './shell.css';
import { isRewrittenAsset, placeholderResolver } from './placeholder.ts';
import {
  mimeForPath,
  PLAY_FRAME_ALLOW,
  PLAY_LOAD_TIMEOUT_MS,
  PLAY_SANDBOX_FLAGS,
  type PlayPayload,
  validatePlayFiles,
} from './policy.ts';
import {
  isPlayHostMessage,
  isPlayRuntimeMessage,
  PLAY_FULLSCREEN_REQUEST,
  type PlayHostMessage,
  type PlayRuntimeMessage,
  type PlayShellMessage,
} from './protocol.ts';
import { rewriteCssUrls, rewriteHtmlString } from './rewrite.ts';

function mustGet(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Test Play shell is missing #${id}.`);
  return node;
}

const stage = mustGet('play-stage');
const loading = mustGet('play-loading');
const errorEl = mustGet('play-error');

const RUNTIME_URL = `${import.meta.env.BASE_URL}play/runtime.html`;
const RUNTIME_READY_TIMEOUT_MS = 10_000;

let initializedFor: string | null = null;
let currentFrame: HTMLIFrameElement | null = null;
const runtimeWaiters: Array<{
  match: (message: PlayRuntimeMessage) => boolean;
  resolve: (message: PlayRuntimeMessage) => void;
  reject: (error: Error) => void;
  timer: number;
}> = [];

function post(message: PlayShellMessage): void {
  if (window.parent === window) return;
  window.parent.postMessage(message, location.origin);
}

function teardown(): void {
  currentFrame?.remove();
  currentFrame = null;
}

function showLoading(): void {
  errorEl.classList.add('hidden');
  loading.classList.remove('hidden');
}

function hideLoading(): void {
  loading.classList.add('hidden');
}

function showError(message: string): void {
  hideLoading();
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}

/** Rewrites HTML and CSS so local references point at runtime placeholders. */
function buildTexts(payload: PlayPayload): Record<string, string> {
  const paths = new Set(payload.files.map((file) => file.path));
  const resolve = placeholderResolver(paths);
  const texts: Record<string, string> = {};
  const decoder = new TextDecoder();
  for (const file of payload.files) {
    if (!isRewrittenAsset(file.path)) continue;
    const source = decoder.decode(file.bytes);
    texts[file.path] = file.path.toLowerCase().endsWith('.css')
      ? rewriteCssUrls(source, resolve, file.path)
      : rewriteHtmlString(source, resolve, file.path);
  }
  return texts;
}

function waitForRuntime(
  match: (message: PlayRuntimeMessage) => boolean,
  timeoutMs: number,
): Promise<PlayRuntimeMessage> {
  return new Promise((resolve, reject) => {
    const waiter = {
      match,
      resolve,
      reject,
      timer: window.setTimeout(() => {
        const index = runtimeWaiters.indexOf(waiter);
        if (index >= 0) runtimeWaiters.splice(index, 1);
        reject(new Error('Test Play runtime did not respond.'));
      }, timeoutMs),
    };
    runtimeWaiters.push(waiter);
  });
}

async function run(message: Extract<PlayHostMessage, { type: 'play:execute' }>): Promise<void> {
  showLoading();
  try {
    const payload = validatePlayFiles(message.files);
    const texts = buildTexts(payload);

    teardown();
    const frame = document.createElement('iframe');
    frame.className = 'game-frame';
    frame.title = 'Test Play game';
    frame.setAttribute('sandbox', PLAY_SANDBOX_FLAGS);
    frame.setAttribute('allow', PLAY_FRAME_ALLOW);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.src = RUNTIME_URL;
    stage.replaceChildren(frame);
    currentFrame = frame;

    await waitForRuntime((message2) => message2.type === 'play:runtime-ready', RUNTIME_READY_TIMEOUT_MS);

    frame.contentWindow?.postMessage(
      {
        type: 'play:runtime-run',
        payload: {
          entry: payload.entry,
          files: payload.files.map((file) => ({
            path: file.path,
            mime: mimeForPath(file.path) ?? 'application/octet-stream',
            bytes: file.bytes,
          })),
          texts,
        },
      },
      '*',
    );

    const started = await waitForRuntime(
      (runtime) => runtime.type === 'play:runtime-started' || runtime.type === 'play:runtime-error',
      PLAY_LOAD_TIMEOUT_MS,
    );
    if (started.type === 'play:runtime-error') throw new Error(started.error);

    hideLoading();
    post({ type: 'play:result', requestId: message.requestId, ok: true });
  } catch (error) {
    const text = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    showError(text);
    post({ type: 'play:result', requestId: message.requestId, ok: false, error: text });
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  // Studio → shell (same origin).
  if (event.source === window.parent && event.origin === location.origin) {
    if (!isPlayHostMessage(event.data)) return;
    const message = event.data;
    if (message.type === 'play:init') {
      teardown();
      initializedFor = message.requestId;
      hideLoading();
      post({ type: 'play:init-ack', requestId: message.requestId });
      return;
    }
    if (message.type === 'play:stop') {
      if (message.requestId !== initializedFor) return;
      teardown();
      initializedFor = null;
      post({ type: 'play:stopped', requestId: message.requestId });
      return;
    }
    if (message.requestId !== initializedFor) return;
    void run(message);
    return;
  }

  // Runtime → shell (the runtime frame has an opaque origin).
  if (!currentFrame || event.source !== currentFrame.contentWindow || event.origin !== 'null') return;
  if (!isPlayRuntimeMessage(event.data)) return;
  for (const waiter of [...runtimeWaiters]) {
    if (!waiter.match(event.data)) continue;
    const index = runtimeWaiters.indexOf(waiter);
    if (index >= 0) runtimeWaiters.splice(index, 1);
    window.clearTimeout(waiter.timer);
    waiter.resolve(event.data);
  }
});

// The sandboxed game (opaque origin) may ask the shell to go fullscreen.
window.addEventListener('message', (event: MessageEvent) => {
  if (!currentFrame || event.source !== currentFrame.contentWindow || event.origin !== 'null') return;
  if (event.data?.type !== PLAY_FULLSCREEN_REQUEST) return;
  void currentFrame.requestFullscreen().catch(() => {});
});

window.addEventListener('pagehide', () => teardown());

post({ type: 'play:ready' });
window.addEventListener('load', () => post({ type: 'play:ready' }));

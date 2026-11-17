/**
 * Timeline preview monitor (the "program" side of the editor).
 *
 * Test Play runs a web project inside a sandboxed frame; this pane is different:
 * it composites the timeline itself onto a canvas, so the picture matches what
 * the arrangement will look like without leaving the studio.
 *
 * The monitor owns its transport. While it plays it reports the position to the
 * app, which keeps the timeline playhead in sync; scrubbing the timeline moves
 * the monitor the other way.
 */

import type { Workspace } from '../fs/workspace.ts';
import { el, iconButton } from '../lib/dom';
import { icon } from '../lib/icons';
import { DEFAULT_MEDIA_ADJUSTMENTS, type MediaAdjustments, mediaKind } from '../lib/media';
import { type Clip, clipEnd, formatTimecode, type TimelineDoc, timelineDuration } from '../lib/timeline';

export interface PreviewViewOptions {
  workspace: Workspace;
  /** Moves the timeline playhead to the monitor position. */
  onSeek: (ms: number) => void;
  /** Called when the monitor starts playing, so the timeline can stop. */
  onPlay?: () => void;
}

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;

export class PreviewView {
  readonly host: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly timecode: HTMLElement;
  private readonly total: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly loopButton: HTMLButtonElement;
  private readonly empty: HTMLElement;
  private readonly mediaHost: HTMLElement;

  private doc: TimelineDoc | null = null;
  private playheadMs = 0;
  private playing = false;
  private active = false;
  private loop = false;
  private frame = 0;
  private lastTick = 0;
  private disposed = false;

  private readonly images = new Map<string, HTMLImageElement>();
  private readonly elements = new Map<string, HTMLMediaElement>();
  private readonly blobUrls = new Map<string, string>();
  private readonly pending = new Set<string>();
  private readonly missing = new Set<string>();

  constructor(private readonly options: PreviewViewOptions) {
    this.canvas = el('canvas', {
      class: 'preview-canvas',
      attrs: { width: String(CANVAS_WIDTH), height: String(CANVAS_HEIGHT) },
    }) as HTMLCanvasElement;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable.');
    this.ctx = context;

    this.timecode = el('span', { class: 'preview-timecode mono', text: '00:00:00:00' });
    this.total = el('span', { class: 'preview-total mono', text: '/ 00:00:00:00' });
    this.playButton = iconButton('play', 'Play', () => this.togglePlay(), { size: 14 });
    this.loopButton = iconButton('refresh', 'Loop playback', () => this.toggleLoop(), {
      size: 14,
      pressed: false,
    });

    this.empty = el('div', { class: 'preview-empty' }, [
      el('span', { class: 'preview-empty-icon' }, [icon('monitor', 18)]),
      el('span', { class: 'preview-empty-title', text: 'Nothing to preview' }),
      el('span', {
        class: 'preview-empty-hint',
        text: 'Add media to the timeline, then press play to review the arrangement.',
      }),
    ]);
    this.mediaHost = el('div', { class: 'preview-media', attrs: { 'aria-hidden': 'true' } });

    const stage = el('div', { class: 'preview-stage' }, [this.canvas, this.empty]);
    const transport = el('div', { class: 'preview-transport' }, [
      this.playButton,
      el(
        'button',
        {
          class: 'preview-step',
          type: 'button',
          title: 'Go to start',
          attrs: { 'aria-label': 'Go to start' },
          on: { click: () => this.goToStart() },
        },
        ['⏮'],
      ),
      el(
        'button',
        {
          class: 'preview-step',
          type: 'button',
          title: 'Previous frame',
          attrs: { 'aria-label': 'Previous frame' },
          on: { click: () => this.stepFrame(-1) },
        },
        ['‹'],
      ),
      el(
        'button',
        {
          class: 'preview-step',
          type: 'button',
          title: 'Next frame',
          attrs: { 'aria-label': 'Next frame' },
          on: { click: () => this.stepFrame(1) },
        },
        ['›'],
      ),
      this.timecode,
      this.total,
      el('div', { class: 'preview-transport-spacer' }),
      this.loopButton,
      iconButton('maximize', 'Fullscreen', () => void this.toggleFullscreen(), { size: 14 }),
    ]);

    this.host = el(
      'div',
      { class: 'preview-view', attrs: { tabindex: '0', 'aria-label': 'Timeline preview' } },
      [
        el('div', { class: 'preview-head' }, [
          el('span', { class: 'preview-title' }, [icon('monitor', 13), el('span', { text: 'Preview' })]),
          el('span', { class: 'preview-badge', text: 'Timeline' }),
        ]),
        stage,
        transport,
        this.mediaHost,
      ],
    );

    this.host.addEventListener('keydown', (event) => this.handleKey(event));
    this.updateTransport();
  }

  /** Replaces the document the monitor composites. */
  setDoc(doc: TimelineDoc | null): void {
    this.doc = doc;
    if (!doc) {
      this.pause();
      this.clearMedia();
      this.playheadMs = 0;
      this.renderFrame();
      return;
    }
    const duration = timelineDuration(doc);
    if (this.playheadMs > duration) this.playheadMs = duration;
    this.missing.clear();
    if (this.active || this.playing) {
      this.renderFrame();
      this.syncPlayback(this.playing);
    }
    this.updateTransport();
  }

  /** The monitor only loads media while it is on screen or playing. */
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (active) {
      this.renderFrame();
      this.syncPlayback(this.playing);
    } else {
      this.pause();
    }
  }

  /** Moves the monitor, e.g. when the timeline playhead is scrubbed. */
  setPlayhead(ms: number): void {
    const duration = this.doc ? timelineDuration(this.doc) : 0;
    const next = Math.max(0, Math.min(duration, Math.round(ms)));
    if (Math.abs(this.playheadMs - next) < 1.5) return;
    this.playheadMs = next;
    if (this.active || this.playing) {
      this.renderFrame();
      this.syncPlayback(this.playing);
    }
    this.updateTransport();
  }

  /** Re-composites after adjustments change. */
  refresh(): void {
    if (!this.active && !this.playing) return;
    this.renderFrame();
    this.syncPlayback(this.playing);
  }

  play(): void {
    if (!this.doc) return;
    const duration = timelineDuration(this.doc);
    if (duration <= 0) return;
    if (this.playheadMs >= duration) this.setPlayhead(0);
    this.playing = true;
    this.options.onPlay?.();
    this.lastTick = performance.now();
    this.syncPlayback(true);
    this.updateTransport();
    this.frame = requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.frame);
    for (const element of this.elements.values()) element.pause();
    this.updateTransport();
    this.syncPlayback(false);
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
    this.clearMedia();
    for (const url of this.blobUrls.values()) URL.revokeObjectURL(url);
    this.blobUrls.clear();
    this.images.clear();
  }

  private togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  private toggleLoop(): void {
    this.loop = !this.loop;
    this.loopButton.setAttribute('aria-pressed', String(this.loop));
    this.loopButton.title = this.loop ? 'Loop on' : 'Loop off';
  }

  private goToStart(): void {
    this.pause();
    this.playheadMs = 0;
    this.renderFrame();
    this.syncPlayback(false);
    this.updateTransport();
    this.options.onSeek(0);
  }

  private stepFrame(direction: -1 | 1): void {
    this.pause();
    const fps = this.doc?.fps ?? 30;
    const duration = this.doc ? timelineDuration(this.doc) : 0;
    const next = Math.max(0, Math.min(duration, this.playheadMs + (direction * 1000) / fps));
    this.playheadMs = next;
    this.renderFrame();
    this.syncPlayback(false);
    this.updateTransport();
    this.options.onSeek(next);
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await this.host.requestFullscreen();
    } catch {
      // Fullscreen is a convenience; ignore rejections.
    }
  }

  private handleKey(event: KeyboardEvent): void {
    if (event.key === ' ') {
      event.preventDefault();
      this.togglePlay();
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.stepFrame(-1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.stepFrame(1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      this.goToStart();
      return;
    }
    if (event.key === 'l' || event.key === 'L') {
      event.preventDefault();
      this.toggleLoop();
    }
  }

  private tick = (now: number): void => {
    if (!this.playing) return;
    const doc = this.doc;
    if (!doc) {
      this.pause();
      return;
    }
    const duration = timelineDuration(doc);
    const delta = now - this.lastTick;
    this.lastTick = now;
    const next = this.playheadMs + delta;
    if (next >= duration) {
      if (this.loop && duration > 0) {
        this.playheadMs = 0;
      } else {
        this.playheadMs = duration;
        this.renderFrame();
        this.pause();
        this.options.onSeek(this.playheadMs);
        return;
      }
    } else {
      this.playheadMs = next;
    }
    this.renderFrame();
    this.syncPlayback(true);
    this.updateTransport();
    this.options.onSeek(this.playheadMs);
    this.frame = requestAnimationFrame(this.tick);
  };

  // ------------------------------------------------------------
  // Compositing
  // ------------------------------------------------------------
  private renderFrame(): void {
    if (this.disposed || (!this.active && !this.playing)) return;
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;
    ctx.save();
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);
    const doc = this.doc;
    if (!doc) {
      this.empty.classList.remove('hidden');
      ctx.restore();
      this.updateTransport();
      return;
    }
    const duration = timelineDuration(doc);
    this.empty.classList.toggle('hidden', duration > 0);
    if (duration <= 0) {
      ctx.restore();
      this.updateTransport();
      return;
    }
    for (const track of doc.tracks) {
      if (track.kind !== 'video') continue;
      const clip = activeClip(track.clips, this.playheadMs);
      if (!clip) continue;
      const node = this.nodeForClip(clip);
      if (!node) continue;
      if (!isReady(node)) {
        if (node instanceof HTMLVideoElement) this.seekNode(node, clip);
        continue;
      }
      this.drawClip(node, clip);
    }
    ctx.restore();
    this.updateTransport();
  }

  private drawClip(node: HTMLImageElement | HTMLVideoElement, clip: Clip): void {
    const adjustments = this.doc?.adjustments[clip.path] ?? DEFAULT_MEDIA_ADJUSTMENTS;
    const sourceWidth = node instanceof HTMLVideoElement ? node.videoWidth : node.naturalWidth;
    const sourceHeight = node instanceof HTMLVideoElement ? node.videoHeight : node.naturalHeight;
    if (!sourceWidth || !sourceHeight) return;

    const width = this.canvas.width;
    const height = this.canvas.height;
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    const dx = (width - drawWidth) / 2;
    const dy = (height - drawHeight) / 2;
    const ctx = this.ctx;
    const rotated = adjustments.rotate === 90 || adjustments.rotate === 270;
    const fit = rotated ? Math.min(width / drawHeight, height / drawWidth) : 1;

    ctx.save();
    ctx.filter = filterFor(adjustments);
    ctx.translate(width / 2, height / 2);
    ctx.rotate((adjustments.rotate * Math.PI) / 180);
    ctx.scale(adjustments.flip ? -fit : fit, fit);
    ctx.translate(-width / 2, -height / 2);
    ctx.drawImage(node, dx, dy, drawWidth, drawHeight);
    ctx.restore();
  }

  private nodeForClip(clip: Clip): HTMLImageElement | HTMLVideoElement | null {
    const kind = mediaKind(clip.path);
    if (kind === 'image') {
      const image = this.images.get(clip.path);
      if (image) return image;
      void this.prepareImage(clip.path);
      return null;
    }
    if (kind === 'video') return this.ensureMedia(clip, 'video') as HTMLVideoElement | null;
    return null;
  }

  private prepareImage(path: string): void {
    if (this.images.has(path) || this.missing.has(path)) return;
    const url = this.blobUrls.get(path);
    if (!url) {
      void this.loadUrl(path);
      return;
    }
    const image = new Image();
    image.decoding = 'async';
    image.addEventListener('load', () => this.renderFrame(), { once: true });
    image.src = url;
    this.images.set(path, image);
  }

  private ensureMedia(clip: Clip, kind: 'video' | 'audio'): HTMLMediaElement | null {
    const existing = this.elements.get(clip.id);
    if (existing) return existing;
    const url = this.blobUrls.get(clip.path);
    if (!url) {
      void this.loadUrl(clip.path);
      return null;
    }
    const element = document.createElement(kind);
    element.src = url;
    element.preload = 'auto';
    element.className = 'preview-media-element';
    element.addEventListener('seeked', () => this.renderFrame());
    element.addEventListener('loadeddata', () => this.renderFrame());
    this.mediaHost.appendChild(element);
    this.elements.set(clip.id, element);
    this.applyElementPosition(element, clip);
    return element;
  }

  private applyElementPosition(element: HTMLMediaElement, clip: Clip): void {
    const target = clipTarget(clip, this.playheadMs);
    const apply = () => {
      try {
        element.currentTime = target;
      } catch {
        // Metadata is not ready yet; the loadedmetadata handler retries.
      }
      if (this.playing) void element.play().catch(() => undefined);
    };
    if (element.readyState >= 1) apply();
    else element.addEventListener('loadedmetadata', apply, { once: true });
  }

  private seekNode(node: HTMLVideoElement, clip: Clip): void {
    const target = clipTarget(clip, this.playheadMs);
    if (Math.abs(node.currentTime - target) > 0.05) {
      try {
        node.currentTime = target;
      } catch {
        // Ignore seeks before the media is ready.
      }
    }
  }

  /** Keeps video/audio elements aligned with the playhead. */
  private syncPlayback(playing: boolean): void {
    if (!this.active && !playing) return;
    const doc = this.doc;
    if (!doc) return;
    const active = new Map<string, { clip: Clip; kind: 'video' | 'audio' }>();
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        if (clip.startMs <= this.playheadMs && this.playheadMs < clipEnd(clip)) {
          const kind = mediaKind(clip.path);
          if (kind === 'video' || kind === 'audio') active.set(clip.id, { clip, kind });
        }
      }
    }
    for (const [id, element] of this.elements) {
      if (active.has(id)) continue;
      element.pause();
      element.remove();
      this.elements.delete(id);
    }
    for (const [id, { clip, kind }] of active) {
      const element = this.elements.get(id) ?? this.ensureMedia(clip, kind);
      if (!element) continue;
      const target = clipTarget(clip, this.playheadMs);
      const drift = Math.abs(element.currentTime - target);
      if (drift > (playing ? 0.3 : 0.05)) {
        try {
          element.currentTime = target;
        } catch {
          // Ignore seeks before the media is ready.
        }
      }
      if (playing) {
        if (element.paused) void element.play().catch(() => undefined);
      } else if (!element.paused) {
        element.pause();
      }
    }
  }

  private async loadUrl(path: string): Promise<string | null> {
    const cached = this.blobUrls.get(path);
    if (cached) return cached;
    if (this.pending.has(path) || this.missing.has(path)) return null;
    this.pending.add(path);
    try {
      const blob = await this.options.workspace.readBlob(path);
      if (!blob) {
        this.missing.add(path);
        return null;
      }
      const url = URL.createObjectURL(blob);
      this.blobUrls.set(path, url);
      return url;
    } finally {
      this.pending.delete(path);
      if (!this.disposed) this.renderFrame();
    }
  }

  private clearMedia(): void {
    for (const element of this.elements.values()) {
      element.pause();
      element.remove();
    }
    this.elements.clear();
  }

  private updateTransport(): void {
    const doc = this.doc;
    const duration = doc ? timelineDuration(doc) : 0;
    this.timecode.textContent = formatTimecode(this.playheadMs, doc?.fps ?? 30);
    this.total.textContent = `/ ${formatTimecode(duration, doc?.fps ?? 30)}`;
    this.playButton.replaceChildren(icon(this.playing ? 'stop' : 'play', 14));
    this.playButton.title = this.playing ? 'Pause' : 'Play';
    this.playButton.setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
    this.host.classList.toggle('is-playing', this.playing);
  }
}

function activeClip(clips: readonly Clip[], ms: number): Clip | null {
  for (const clip of clips) {
    if (clip.startMs <= ms && ms < clipEnd(clip)) return clip;
  }
  return null;
}

function clipTarget(clip: Clip, ms: number): number {
  return Math.max(0, clip.inMs + (ms - clip.startMs)) / 1000;
}

function isReady(node: HTMLImageElement | HTMLVideoElement): boolean {
  return node instanceof HTMLVideoElement ? node.readyState >= 2 : node.complete && node.naturalWidth > 0;
}

function filterFor(adjustments: MediaAdjustments): string {
  return `brightness(${adjustments.brightness}%) contrast(${adjustments.contrast}%) saturate(${adjustments.saturation}%)`;
}

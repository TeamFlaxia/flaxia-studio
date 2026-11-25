/**
 * Media preview pane for the editor area.
 *
 * Opens images, video and audio from the workspace (blobs, never Monaco).
 * Image/video adjustments are non-destructive view parameters that live in the
 * timeline document, so the preview and the timeline agree on them.
 */

import { el, formatBytes } from '../lib/dom';
import { fileIcon, icon } from '../lib/icons';
import {
  DEFAULT_MEDIA_ADJUSTMENTS,
  type MediaAdjustments,
  type MediaKind,
  mediaKind,
  probeMedia,
} from '../lib/media';
import { PeakCache, peaksFromBlob } from '../lib/peaks';
import { WaveformView } from './waveform';

export interface MediaSource {
  path: string;
  blob: Blob;
  size: number;
  adjustments?: Partial<MediaAdjustments>;
}

export interface MediaViewOptions {
  /** Adds the current source to the timeline at the playhead. */
  onAddToTimeline: (path: string) => void;
}

export class MediaView {
  readonly host: HTMLElement;
  private readonly title: HTMLElement;
  private readonly headIcon: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly addButton: HTMLButtonElement;

  private currentPath: string | null = null;
  private currentKind: MediaKind | null = null;
  private adjustments: MediaAdjustments = { ...DEFAULT_MEDIA_ADJUSTMENTS };
  private media: HTMLImageElement | HTMLVideoElement | null = null;
  private waveform: WaveformView | null = null;
  private readonly peakCache = new PeakCache();
  private url: string | null = null;
  private probe: { durationMs: number; width: number; height: number } | null = null;
  private sequence = 0;

  constructor(private readonly options: MediaViewOptions) {
    this.title = el('span', { class: 'media-title', text: 'Media' });
    this.headIcon = el('span', { class: 'media-head-icon' }, [icon('file-image', 13)]);
    this.badge = el('span', { class: 'media-badge hidden' });
    this.meta = el('span', { class: 'media-meta' });
    this.stage = el('div', { class: 'media-stage' });
    this.empty = el('div', { class: 'media-empty' }, [
      el('span', { class: 'media-empty-icon' }, [icon('file-image', 20)]),
      el('span', { class: 'media-empty-title', text: 'No media selected' }),
      el('span', {
        class: 'media-empty-hint',
        text: 'Open an image, video or audio file, or import media from the explorer.',
      }),
    ]);
    this.addButton = el(
      'button',
      { class: 'btn btn-primary media-add', type: 'button', on: { click: () => this.addToTimeline() } },
      [icon('plus', 13), 'Add to timeline'],
    ) as HTMLButtonElement;
    const head = el('div', { class: 'media-head' }, [
      this.headIcon,
      this.title,
      this.badge,
      el('div', { class: 'media-head-spacer' }),
      this.addButton,
    ]);

    this.host = el('div', { class: 'media-view', attrs: { 'aria-label': 'Media preview' } }, [
      head,
      el('div', { class: 'media-body' }, [this.stage, this.empty]),
      el('div', { class: 'media-foot' }, [this.meta]),
    ]);
    this.addButton.disabled = true;
  }

  /** Path currently on screen, or null after `clear()`. */
  get currentSourcePath(): string | null {
    return this.currentPath;
  }

  /** Shows a source, reusing the blob URL when it is already on screen. */
  async show(source: MediaSource): Promise<void> {
    const kind = mediaKind(source.path);
    if (!kind) {
      this.clear();
      return;
    }
    const sameSource = this.currentPath === source.path && this.url !== null;
    this.currentPath = source.path;
    this.currentKind = kind;
    this.adjustments = { ...DEFAULT_MEDIA_ADJUSTMENTS, ...source.adjustments };
    this.title.textContent = source.path.split('/').pop() ?? source.path;
    this.title.title = source.path;
    this.badge.textContent = kind;
    this.badge.dataset.kind = kind;
    this.badge.classList.remove('hidden');
    this.empty.classList.add('hidden');
    this.host.dataset.kind = kind;
    this.headIcon.replaceChildren(icon(fileIcon(source.path), 13));
    this.addButton.disabled = false;

    const ticket = ++this.sequence;
    if (!sameSource) {
      this.releaseUrl();
      this.url = URL.createObjectURL(source.blob);
      this.stage.replaceChildren();
      this.media = this.buildMedia(kind, this.url);
      if (this.media) this.stage.appendChild(this.media);
      if (kind === 'audio') this.mountWaveform(source, ticket);
      this.probe = null;
      void probeMedia(source.blob, kind).then((probe) => {
        if (ticket !== this.sequence) return;
        this.probe = probe;
        this.renderMeta(source.size, source.blob.type);
      });
    }
    this.applyAdjustments();
    this.renderMeta(source.size, source.blob.type);
  }

  /** Drops the current source and revokes its blob URL. */
  clear(): void {
    this.sequence += 1;
    this.releaseUrl();
    this.media = null;
    this.waveform = null;
    this.currentPath = null;
    this.currentKind = null;
    this.probe = null;
    this.stage.replaceChildren();
    this.empty.classList.remove('hidden');
    this.badge.classList.add('hidden');
    this.title.textContent = 'Media';
    this.title.title = '';
    this.meta.textContent = '';
    this.host.dataset.kind = '';
    this.headIcon.replaceChildren(icon('file-image', 13));
    this.addButton.disabled = true;
  }

  private buildMedia(kind: MediaKind, url: string): HTMLImageElement | HTMLVideoElement | null {
    if (kind === 'image') {
      return el('img', {
        class: 'media-image',
        attrs: { src: url, alt: '', draggable: 'false' },
      }) as HTMLImageElement;
    }
    if (kind === 'video') {
      const video = el('video', {
        class: 'media-video',
        attrs: { src: url, controls: 'true', playsinline: 'true', preload: 'metadata' },
      }) as HTMLVideoElement;
      return video;
    }
    this.stage.appendChild(
      el('audio', {
        class: 'media-audio-controls',
        attrs: { src: url, controls: 'true', preload: 'metadata' },
      }),
    );
    return null;
  }

  private mountWaveform(source: MediaSource, ticket: number): void {
    this.waveform = new WaveformView();
    this.stage.appendChild(this.waveform.host);
    const width = Math.max(320, this.stage.clientWidth || 640);
    this.waveform.resize(width, 48);
    void this.peakCache
      .load(source.path, () => peaksFromBlob(source.blob, 1024))
      .then((data) => {
        if (ticket !== this.sequence || !this.waveform) return;
        this.waveform.setPeaks(data.samples);
        const audio = this.stage.querySelector('audio');
        audio?.addEventListener('timeupdate', () => {
          const duration = audio.duration || data.durationMs / 1000;
          this.waveform?.setProgress(duration > 0 ? audio.currentTime / duration : 0);
        });
      })
      .catch(() => {
        // A missing decoder leaves the audio controls usable.
      });
  }

  private renderMeta(size: number, mime: string): void {
    const parts = [formatBytes(size)];
    if (mime) parts.push(mime);
    if (this.probe) {
      if (this.probe.width && this.probe.height) parts.push(`${this.probe.width}×${this.probe.height}`);
      if (this.currentKind !== 'image' && this.probe.durationMs) {
        parts.push(formatClock(this.probe.durationMs));
      }
    }
    this.meta.textContent = parts.join(' · ');
  }

  private applyAdjustments(): void {
    const { brightness, contrast, saturation, rotate, flip } = this.adjustments;
    const filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
    const transform = `rotate(${rotate}deg) scaleX(${flip ? -1 : 1})`;
    const style = `filter:${filter};transform:${transform}`;
    this.host.style.setProperty('--media-filter', filter);
    this.host.style.setProperty('--media-transform', transform);
    if (this.media) this.media.setAttribute('style', style);
  }

  /** Mirrors adjustments changed in the inspector. */
  setAdjustments(adjustments: Partial<MediaAdjustments>): void {
    this.adjustments = { ...DEFAULT_MEDIA_ADJUSTMENTS, ...adjustments };
    this.applyAdjustments();
  }

  private addToTimeline(): void {
    if (this.currentPath) this.options.onAddToTimeline(this.currentPath);
  }

  private releaseUrl(): void {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    if (this.currentKind === 'audio') {
      this.stage.replaceChildren();
      this.waveform = null;
    }
  }
}

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

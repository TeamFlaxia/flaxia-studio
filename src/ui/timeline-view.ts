/**
 * Premiere-style timeline for the bottom panel.
 *
 * Track lanes with clips positioned by time, a ruler, a draggable playhead and
 * the usual NLE gestures: click to scrub, drag to move, drag an edge to trim,
 * `S` to split at the playhead, `Delete` to remove. Every change goes through
 * the pure model in `lib/timeline.ts` and is persisted by `TimelineStore`.
 *
 * Audio from the clips plays during the rAF playback; video frames stay in the
 * media preview (Phase 2 adds a frame-accurate monitor).
 */

import type { Workspace } from '../fs/workspace.ts';
import { el, iconButton } from '../lib/dom';
import { icon } from '../lib/icons';
import { mediaKind } from '../lib/media';
import {
  addClip,
  addTrack,
  type Clip,
  clipEnd,
  findClip,
  formatTimecode,
  MIN_CLIP_MS,
  moveClip,
  removeClip,
  snapCandidates,
  snapMs,
  splitClip,
  type TimelineDoc,
  timelineDuration,
  trimClip,
} from '../lib/timeline';
import { showContextMenu } from './context-menu';
import type { TimelineStore } from './timeline-store';

export interface TimelineViewOptions {
  store: TimelineStore;
  workspace: Workspace;
  /** Reports playhead movement (ms) to the app. */
  onPlayheadChange: (ms: number) => void;
  /** Opens a clip's source in the media preview. */
  onOpenSource: (path: string) => void;
}

const ZOOM_STEPS = [20, 40, 80, 140, 240, 400];
const LANE_HEIGHT = 34;
const MIN_CLIP_PX = 18;
/** Width of the sticky track-label column; lanes start after it. */
const LABEL_WIDTH = 58;

interface DragState {
  mode: 'move' | 'trim-start' | 'trim-end';
  clipId: string;
  startX: number;
  pointerId: number;
  element: HTMLElement;
  original: Clip;
  leftPx: number;
  widthPx: number;
}

export class TimelineView {
  readonly host: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly timecode: HTMLElement;
  private readonly total: HTMLElement;
  private readonly snapButton: HTMLButtonElement;
  private readonly zoomButton: HTMLButtonElement;
  private readonly deleteButton: HTMLButtonElement;
  private readonly ruler: HTMLElement;
  private readonly lanes: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly playheadEl: HTMLElement;
  private readonly mediaHost: HTMLElement;

  private doc: TimelineDoc | null = null;
  private pxPerSecond = 80;
  private playheadMs = 0;
  private selectedClipId: string | null = null;
  private snap = true;
  private drag: DragState | null = null;
  private playing = false;
  private frame = 0;
  private lastTick = 0;
  private audio = new Map<string, HTMLMediaElement>();
  private blobUrls = new Map<string, string>();
  private disposed = false;

  constructor(private readonly options: TimelineViewOptions) {
    this.timecode = el('span', { class: 'timeline-timecode mono', text: '00:00:00:00' });
    this.total = el('span', { class: 'timeline-total mono', text: '/ 00:00:00:00' });
    this.playButton = iconButton('play', 'Play', () => this.togglePlay(), { size: 14 });
    this.snapButton = iconButton('maximize', 'Snap', () => this.toggleSnap(), { size: 14, pressed: true });
    this.zoomButton = iconButton('search', 'Zoom', () => this.cycleZoom(), { size: 14 });
    this.deleteButton = iconButton('trash', 'Delete clip', () => this.deleteSelected(), { size: 14 });

    this.ruler = el('div', { class: 'timeline-ruler' });
    this.lanes = el('div', { class: 'timeline-lanes' });
    this.empty = el('div', { class: 'timeline-empty' }, [
      el('span', { class: 'timeline-empty-icon' }, [icon('play', 16)]),
      el('span', { text: 'Add media to the timeline to start arranging.' }),
    ]);
    this.playheadEl = el('div', { class: 'timeline-playhead' });
    this.mediaHost = el('div', { class: 'timeline-media', attrs: { 'aria-hidden': 'true' } });

    const scroller = el('div', { class: 'timeline-scroll' }, [
      el('div', { class: 'timeline-grid' }, [this.ruler, this.lanes, this.playheadEl, this.empty]),
    ]);

    const toolbar = el('div', { class: 'timeline-toolbar' }, [
      this.playButton,
      this.timecode,
      this.total,
      el('div', { class: 'timeline-toolbar-spacer' }),
      this.snapButton,
      this.zoomButton,
      iconButton('file-video', 'Add video track', () => this.addTrack('video'), { size: 14 }),
      iconButton('file-audio', 'Add audio track', () => this.addTrack('audio'), { size: 14 }),
      this.deleteButton,
    ]);

    this.host = el('div', { class: 'timeline', attrs: { tabindex: '0', 'aria-label': 'Timeline' } }, [
      toolbar,
      scroller,
      this.mediaHost,
    ]);

    this.host.addEventListener('keydown', (event) => this.handleKey(event));
    this.ruler.addEventListener('pointerdown', (event) => this.startScrub(event));
    this.lanes.addEventListener('pointerdown', (event) => this.handleLanePointerDown(event));
    this.lanes.addEventListener('contextmenu', (event) => this.handleContextMenu(event));
    this.ruler.addEventListener('contextmenu', (event) => this.handleContextMenu(event));
    this.host.addEventListener('pointerdown', () => this.host.focus({ preventScroll: true }));
    this.render();
  }

  async init(): Promise<void> {
    this.doc = await this.options.store.load();
    this.render();
  }

  get playhead(): number {
    return this.playheadMs;
  }

  /** Rebuilds the lanes, ruler and toolbar from the store document. */
  render(): void {
    if (this.disposed) return;
    if (this.doc !== null) {
      // The store hands over a new document on every edit.
      this.doc = this.options.store.current ?? this.doc;
    }
    this.renderToolbar();
    this.renderRuler();
    this.renderLanes();
    this.renderPlayhead();
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
    for (const url of this.blobUrls.values()) URL.revokeObjectURL(url);
    this.blobUrls.clear();
  }

  // ------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------
  private renderToolbar(): void {
    const doc = this.doc;
    const duration = doc ? timelineDuration(doc) : 0;
    this.timecode.textContent = formatTimecode(this.playheadMs, doc?.fps ?? 30);
    this.total.textContent = `/ ${formatTimecode(duration, doc?.fps ?? 30)}`;
    this.playButton.replaceChildren(icon(this.playing ? 'stop' : 'play', 14));
    this.playButton.title = this.playing ? 'Pause' : 'Play';
    this.snapButton.setAttribute('aria-pressed', String(this.snap));
    this.deleteButton.disabled = this.selectedClipId === null;
    this.host.classList.toggle('is-playing', this.playing);
  }

  private renderRuler(): void {
    const doc = this.doc;
    this.ruler.replaceChildren();
    if (!doc) return;
    const step = this.rulerStepSeconds();
    const durationMs = Math.max(timelineDuration(doc), step * 1000 * 4);
    const endSeconds = Math.ceil(durationMs / 1000 / step) * step;
    for (let seconds = 0; seconds <= endSeconds; seconds += step) {
      const left = (seconds / 1000) * this.pxPerSecond * 1000;
      const tick = el('span', { class: 'timeline-tick' }, [
        el('span', { class: 'timeline-tick-label mono', text: formatRulerLabel(seconds) }),
      ]);
      tick.style.left = `${left}px`;
      this.ruler.appendChild(tick);
    }
    this.ruler.style.width = `${Math.max(0, this.contentWidth() - LABEL_WIDTH)}px`;
  }

  private renderLanes(): void {
    const doc = this.doc;
    this.lanes.replaceChildren();
    this.lanes.style.width = `${this.contentWidth()}px`;
    const hasClips = doc ? doc.tracks.some((track) => track.clips.length > 0) : false;
    this.empty.classList.toggle('hidden', hasClips);
    if (!doc) return;

    const counters: Record<'video' | 'audio', number> = { video: 0, audio: 0 };
    doc.tracks.forEach((track) => {
      counters[track.kind] += 1;
      const lane = el('div', { class: 'timeline-lane', dataset: { track: track.id } });
      lane.style.height = `${LANE_HEIGHT}px`;
      for (const clip of track.clips) lane.appendChild(this.buildClip(clip, track.kind));
      const label = el('div', { class: 'timeline-track-label', dataset: { kind: track.kind } }, [
        el('span', {
          class: 'timeline-track-name',
          text: `${track.kind === 'video' ? 'V' : 'A'}${counters[track.kind]}`,
        }),
        iconButton('x', `Remove ${track.kind} track`, () => this.removeTrackById(track.id), { size: 12 }),
      ]);
      label.style.height = `${LANE_HEIGHT}px`;
      this.lanes.appendChild(
        el('div', { class: 'timeline-track', dataset: { kind: track.kind } }, [label, lane]),
      );
    });
  }

  private buildClip(clip: Clip, kind: 'video' | 'audio'): HTMLElement {
    const node = el('div', {
      class: `timeline-clip ${this.selectedClipId === clip.id ? 'is-selected' : ''}`.trim(),
      dataset: { clip: clip.id, kind },
      attrs: { title: `${clip.path} · ${formatTimecode(clip.durationMs, this.doc?.fps ?? 30)}` },
    });
    node.style.left = `${this.msToPx(clip.startMs)}px`;
    node.style.width = `${Math.max(MIN_CLIP_PX, this.msToPx(clip.durationMs))}px`;
    node.append(
      el('span', { class: 'timeline-clip-name', text: clip.path.split('/').pop() ?? clip.path }),
      el('span', { class: 'timeline-clip-handle is-start' }),
      el('span', { class: 'timeline-clip-handle is-end' }),
    );
    node.addEventListener('dblclick', (event) => {
      event.preventDefault();
      this.options.onOpenSource(clip.path);
    });
    node.addEventListener('pointerdown', (event) => this.startClipDrag(event, clip, node));
    return node;
  }

  private renderPlayhead(): void {
    this.playheadEl.style.left = `${LABEL_WIDTH + this.msToPx(this.playheadMs)}px`;
    this.timecode.textContent = formatTimecode(this.playheadMs, this.doc?.fps ?? 30);
  }

  // ------------------------------------------------------------
  // Editing
  // ------------------------------------------------------------
  private handleLanePointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('.timeline-clip')) return;
    this.select(null);
    this.startScrub(event);
  }

  private startScrub(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const origin = this.ruler.getBoundingClientRect().left;
    const update = (clientX: number) => {
      const ms = Math.max(0, this.pxToMs(clientX - origin));
      this.setPlayhead(ms);
    };
    update(event.clientX);
    const pointerId = event.pointerId;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(pointerId);
    const onMove = (moveEvent: PointerEvent) => update(moveEvent.clientX);
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }

  private startClipDrag(event: PointerEvent, clip: Clip, node: HTMLElement): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.select(clip.id);
    this.host.focus({ preventScroll: true });

    const handle = (event.target as HTMLElement).closest('.timeline-clip-handle');
    const mode: DragState['mode'] = handle
      ? handle.classList.contains('is-start')
        ? 'trim-start'
        : 'trim-end'
      : 'move';

    this.drag = {
      mode,
      clipId: clip.id,
      startX: event.clientX,
      pointerId: event.pointerId,
      element: node,
      original: { ...clip },
      leftPx: this.msToPx(clip.startMs),
      widthPx: this.msToPx(clip.durationMs),
    };
    node.setPointerCapture(event.pointerId);
    node.classList.add('is-dragging');

    const onMove = (moveEvent: PointerEvent) => this.updateDrag(moveEvent);
    const onUp = (upEvent: PointerEvent) => {
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onUp);
      this.finishDrag(upEvent);
    };
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp);
    node.addEventListener('pointercancel', onUp);
  }

  private updateDrag(event: PointerEvent): void {
    const drag = this.drag;
    const doc = this.doc;
    if (!drag || !doc) return;
    const deltaMs = this.pxToMs(event.clientX - drag.startX);
    const candidates = this.snapCandidatesFor(
      drag.clipId,
      'move' === drag.mode ? [this.playheadMs] : [this.playheadMs],
    );

    if (drag.mode === 'move') {
      let nextStart = Math.max(0, drag.original.startMs + deltaMs);
      if (this.snap) {
        const startSnap = snapMs(nextStart, candidates);
        const endSnap = snapMs(nextStart + drag.original.durationMs, candidates) - drag.original.durationMs;
        if (Math.abs(startSnap - nextStart) <= Math.abs(endSnap - nextStart)) nextStart = startSnap;
        else nextStart = endSnap;
        nextStart = Math.max(0, nextStart);
      }
      drag.element.style.left = `${this.msToPx(nextStart)}px`;
      return;
    }

    if (drag.mode === 'trim-start') {
      const raw = drag.original.startMs + deltaMs;
      const snapped = this.snap ? snapMs(raw, candidates) : raw;
      const start = Math.min(Math.max(snapped, 0), drag.original.startMs + drag.original.durationMs - 100);
      drag.element.style.left = `${this.msToPx(start)}px`;
      drag.element.style.width = `${Math.max(MIN_CLIP_PX, this.msToPx(drag.original.durationMs - (start - drag.original.startMs)))}px`;
      return;
    }

    const rawEnd = drag.original.startMs + drag.original.durationMs + deltaMs;
    const snapped = this.snap ? snapMs(rawEnd, candidates) : rawEnd;
    const end = Math.max(snapped, drag.original.startMs + 100);
    drag.element.style.width = `${Math.max(MIN_CLIP_PX, this.msToPx(end - drag.original.startMs))}px`;
  }

  private finishDrag(event: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    drag.element.classList.remove('is-dragging');
    const doc = this.doc;
    if (!doc) return;

    const deltaMs = this.pxToMs(event.clientX - drag.startX);
    if (Math.round(deltaMs) === 0) {
      this.render();
      return;
    }

    let next = doc;
    if (drag.mode === 'move') {
      let start = Math.max(0, drag.original.startMs + deltaMs);
      if (this.snap) {
        const candidates = this.snapCandidatesFor(drag.clipId, [this.playheadMs]);
        const startSnap = snapMs(start, candidates);
        const endSnap = snapMs(start + drag.original.durationMs, candidates) - drag.original.durationMs;
        start = Math.max(0, Math.abs(startSnap - start) <= Math.abs(endSnap - start) ? startSnap : endSnap);
      }
      const target = this.trackAt(event.clientY) ?? this.trackOfClip(doc, drag.clipId);
      if (target) next = moveClip(doc, drag.clipId, target.id, start);
    } else if (drag.mode === 'trim-start') {
      const raw = drag.original.startMs + deltaMs;
      const snapped = this.snap ? snapMs(raw, this.snapCandidatesFor(drag.clipId, [this.playheadMs])) : raw;
      next = trimClip(doc, drag.clipId, 'start', snapped);
    } else {
      const raw = drag.original.startMs + drag.original.durationMs + deltaMs;
      const snapped = this.snap ? snapMs(raw, this.snapCandidatesFor(drag.clipId, [this.playheadMs])) : raw;
      next = trimClip(doc, drag.clipId, 'end', snapped);
    }
    this.doc = next;
    this.options.store.update(next);
    this.render();
  }

  /** Right click: clip actions on a clip, track actions on empty lanes. */
  private handleContextMenu(event: MouseEvent): void {
    event.preventDefault();
    const doc = this.doc;
    if (!doc) return;
    const target = event.target as HTMLElement;
    const clipNode = target.closest<HTMLElement>('.timeline-clip');
    const clipId = clipNode?.dataset.clip ?? null;
    if (!clipId) {
      this.showLaneMenu(event.clientX, event.clientY);
      return;
    }
    this.select(clipId);
    this.showClipMenu(event.clientX, event.clientY, clipId);
  }

  private showClipMenu(x: number, y: number, clipId: string): void {
    const doc = this.doc;
    if (!doc) return;
    const found = findClip(doc, clipId);
    if (!found) return;
    const { clip, track } = found;
    const offset = this.playheadMs - clip.startMs;
    const canSplit = offset >= MIN_CLIP_MS && clip.durationMs - offset >= MIN_CLIP_MS;

    showContextMenu(x, y, [
      {
        label: 'Split at playhead',
        icon: 'scissors',
        disabled: !canSplit,
        run: () => this.splitAt(clipId),
      },
      {
        label: 'Duplicate',
        icon: 'copy',
        run: () => this.duplicateClip(clipId),
      },
      {
        label: 'Open source',
        icon: 'external',
        run: () => this.options.onOpenSource(clip.path),
      },
      {
        label: 'Delete clip',
        icon: 'trash',
        danger: true,
        run: () => this.deleteClip(clipId),
      },
      {
        label: 'Remove track',
        icon: 'x',
        run: () => this.removeTrackById(track.id),
      },
    ]);
  }

  private showLaneMenu(x: number, y: number): void {
    showContextMenu(x, y, [
      { label: 'Add video track', icon: 'file-video', run: () => this.addTrack('video') },
      { label: 'Add audio track', icon: 'file-audio', run: () => this.addTrack('audio') },
      {
        label: this.snap ? 'Disable snapping' : 'Enable snapping',
        icon: 'maximize',
        run: () => this.toggleSnap(),
      },
      { label: 'Zoom to fit', icon: 'search', run: () => this.zoomToFit() },
    ]);
  }

  private splitAt(clipId: string): void {
    const doc = this.doc;
    if (!doc) return;
    const next = splitClip(doc, clipId, this.playheadMs);
    if (next === doc) return;
    this.doc = next;
    this.options.store.update(next);
    this.render();
  }

  private duplicateClip(clipId: string): void {
    const doc = this.doc;
    if (!doc) return;
    const found = findClip(doc, clipId);
    if (!found) return;
    const next = addClip(doc, found.track.id, found.clip.path, clipEnd(found.clip), {
      inMs: found.clip.inMs,
      durationMs: found.clip.durationMs,
    });
    this.doc = next;
    this.options.store.update(next);
    this.render();
  }

  private deleteClip(clipId: string): void {
    const doc = this.doc;
    if (!doc) return;
    this.doc = removeClip(doc, clipId);
    if (this.selectedClipId === clipId) this.selectedClipId = null;
    this.options.store.update(this.doc);
    this.render();
  }

  private zoomToFit(): void {
    const duration = this.doc ? timelineDuration(this.doc) : 0;
    const width = this.host.querySelector<HTMLElement>('.timeline-scroll')?.clientWidth ?? 0;
    const seconds = Math.max(1, duration / 1000 + 1);
    const available = Math.max(120, width - LABEL_WIDTH - 16);
    this.pxPerSecond = Math.round(Math.min(400, Math.max(20, available / seconds)));
    this.zoomButton.title = `Zoom ${this.pxPerSecond}px/s`;
    this.render();
  }

  private handleKey(event: KeyboardEvent): void {
    if (event.key === ' ') {
      event.preventDefault();
      this.togglePlay();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!this.selectedClipId) return;
      event.preventDefault();
      this.deleteSelected();
      return;
    }
    if (event.key === 's' || event.key === 'S') {
      if (!this.selectedClipId) return;
      event.preventDefault();
      const doc = this.doc;
      if (!doc) return;
      const next = splitClip(doc, this.selectedClipId, this.playheadMs);
      if (next !== doc) {
        this.doc = next;
        this.options.store.update(next);
        this.render();
      }
    }
  }

  private deleteSelected(): void {
    const doc = this.doc;
    if (!doc || !this.selectedClipId) return;
    this.doc = removeClip(doc, this.selectedClipId);
    this.selectedClipId = null;
    this.options.store.update(this.doc);
    this.render();
  }

  private addTrack(kind: 'video' | 'audio'): void {
    const doc = this.doc;
    if (!doc) return;
    this.doc = addTrack(doc, kind);
    this.options.store.update(this.doc);
    this.render();
  }

  private removeTrackById(trackId: string): void {
    const doc = this.doc;
    if (!doc) return;
    const next: TimelineDoc = { ...doc, tracks: doc.tracks.filter((track) => track.id !== trackId) };
    this.doc = next;
    this.options.store.update(next);
    this.render();
  }

  private select(clipId: string | null): void {
    this.selectedClipId = clipId;
    for (const node of this.lanes.querySelectorAll<HTMLElement>('.timeline-clip')) {
      node.classList.toggle('is-selected', node.dataset.clip === clipId);
    }
    this.renderToolbar();
  }

  private toggleSnap(): void {
    this.snap = !this.snap;
    this.renderToolbar();
  }

  private cycleZoom(): void {
    this.pxPerSecond = ZOOM_STEPS.find((step) => step > this.pxPerSecond) ?? ZOOM_STEPS[0] ?? 80;
    this.zoomButton.title = `Zoom ${this.pxPerSecond}px/s`;
    this.render();
  }

  // ------------------------------------------------------------
  // Playback
  // ------------------------------------------------------------
  private togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  private play(): void {
    if (!this.doc || timelineDuration(this.doc) <= 0) return;
    if (this.playheadMs >= timelineDuration(this.doc)) this.setPlayhead(0);
    this.playing = true;
    this.lastTick = performance.now();
    this.syncAudio();
    this.renderToolbar();
    this.frame = requestAnimationFrame(this.tick);
  }

  private pause(): void {
    if (!this.playing && this.audio.size === 0) return;
    this.playing = false;
    cancelAnimationFrame(this.frame);
    for (const element of this.audio.values()) {
      element.pause();
      element.remove();
    }
    this.audio.clear();
    this.renderToolbar();
  }

  private tick = (now: number): void => {
    if (!this.playing) return;
    const doc = this.doc;
    if (!doc) return;
    const delta = now - this.lastTick;
    this.lastTick = now;
    const duration = timelineDuration(doc);
    const next = this.playheadMs + delta;
    if (next >= duration) {
      this.setPlayhead(duration);
      this.pause();
      return;
    }
    this.setPlayhead(next);
    this.syncAudio();
    this.frame = requestAnimationFrame(this.tick);
  };

  /** Plays the audio of every clip under the playhead; stops the rest. */
  private syncAudio(): void {
    const doc = this.doc;
    if (!doc) return;
    const active = new Map<string, Clip>();
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        if (clip.startMs <= this.playheadMs && this.playheadMs < clipEnd(clip)) active.set(clip.id, clip);
      }
    }
    for (const [id, element] of this.audio) {
      if (active.has(id)) continue;
      element.pause();
      element.remove();
      this.audio.delete(id);
    }
    for (const [id, clip] of active) {
      const element = this.audio.get(id) ?? this.createElement(clip.path);
      if (!element) continue;
      this.audio.set(id, element);
      const target = (clip.inMs + (this.playheadMs - clip.startMs)) / 1000;
      if (Math.abs(element.currentTime - target) > 0.3) element.currentTime = target;
      if (element.paused) void element.play().catch(() => undefined);
    }
  }

  private createElement(path: string): HTMLMediaElement | null {
    const url = this.blobUrls.get(path);
    if (!url) {
      void this.prepareBlob(path).then(() => {
        if (this.playing) this.syncAudio();
      });
      return null;
    }
    const kind = mediaKind(path);
    if (!kind) return null;
    const element = document.createElement(kind === 'audio' ? 'audio' : 'video');
    element.src = url;
    element.preload = 'auto';
    element.className = 'timeline-media-element';
    this.mediaHost.appendChild(element);
    return element;
  }

  private async prepareBlob(path: string): Promise<string | null> {
    const cached = this.blobUrls.get(path);
    if (cached) return cached;
    const blob = await this.options.workspace.readBlob(path);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.blobUrls.set(path, url);
    return url;
  }

  // ------------------------------------------------------------
  // Geometry
  // ------------------------------------------------------------
  private setPlayhead(ms: number): void {
    this.playheadMs = Math.max(0, Math.round(ms));
    this.renderPlayhead();
    this.options.onPlayheadChange(this.playheadMs);
  }

  private msToPx(ms: number): number {
    return (ms / 1000) * this.pxPerSecond;
  }

  private pxToMs(px: number): number {
    return Math.round((px / this.pxPerSecond) * 1000);
  }

  private contentWidth(): number {
    const duration = this.doc ? timelineDuration(this.doc) : 0;
    return Math.max(1600, this.msToPx(duration) + 400);
  }

  private rulerStepSeconds(): number {
    if (this.pxPerSecond >= 240) return 1;
    if (this.pxPerSecond >= 140) return 1;
    if (this.pxPerSecond >= 80) return 2;
    if (this.pxPerSecond >= 40) return 5;
    return 10;
  }

  private snapCandidatesFor(clipId: string, extras: number[]): number[] {
    const doc = this.doc;
    if (!doc) return extras;
    return snapCandidates(doc, clipId, extras);
  }

  private trackAt(clientY: number): { id: string } | null {
    for (const lane of this.lanes.querySelectorAll<HTMLElement>('.timeline-lane')) {
      const rect = lane.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) {
        const trackId = lane.dataset.track;
        return trackId ? { id: trackId } : null;
      }
    }
    return null;
  }

  private trackOfClip(doc: TimelineDoc, clipId: string): { id: string } | null {
    for (const track of doc.tracks) {
      if (track.clips.some((clip) => clip.id === clipId)) return { id: track.id };
    }
    return null;
  }
}

function formatRulerLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return minutes > 0 ? `${minutes}:${String(rest).padStart(2, '0')}` : `${rest}s`;
}

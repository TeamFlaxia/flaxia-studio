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
  barDurationMs,
  beatDurationMs,
  type Clip,
  clipEnd,
  DEFAULT_TEMPO,
  findClip,
  formatTimecode,
  isAudibleTrack,
  isTrackLocked,
  MIN_CLIP_MS,
  moveClip,
  quantizeClip,
  removeClip,
  setTrackFlag,
  snapCandidates,
  snapMs,
  splitClip,
  type TimelineDoc,
  type Track,
  type TrackFlag,
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
  /** Reports the source path of the selected clip, or null. */
  onSelectedClipChange?: (path: string | null) => void;
  /** Reports timeline playback so other monitors can pause. */
  onPlaybackChange?: (playing: boolean) => void;
  /** Opens the workspace media picker for the given drop position. */
  onAddFile?: (startMs: number, trackId: string | null) => void;
  /** Places a workspace file dropped from the explorer. */
  onDropFile?: (path: string, startMs: number, trackId: string | null) => void;
  /** Places media files dropped from the operating system. */
  onDropFiles?: (files: File[], startMs: number, trackId: string | null) => void;
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
  private readonly dropLine: HTMLElement;
  private readonly mediaHost: HTMLElement;
  private readonly options: TimelineViewOptions;

  private doc: TimelineDoc | null = null;
  private pxPerSecond = 80;
  private playheadMs = 0;
  private selectedClipId: string | null = null;
  private snap = true;
  private drag: DragState | null = null;
  private dropLane: HTMLElement | null = null;
  private playing = false;
  private frame = 0;
  private lastTick = 0;
  private audio = new Map<string, HTMLMediaElement>();
  private blobUrls = new Map<string, string>();
  private disposed = false;

  constructor(options: TimelineViewOptions) {
    this.options = options;
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
    this.dropLine = el('div', { class: 'timeline-drop-line hidden' });
    this.mediaHost = el('div', { class: 'timeline-media', attrs: { 'aria-hidden': 'true' } });

    const grid = el('div', { class: 'timeline-grid' }, [
      this.ruler,
      this.lanes,
      this.playheadEl,
      this.dropLine,
      this.empty,
    ]);
    const scroller = el('div', { class: 'timeline-scroll' }, [grid]);

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
    this.host.addEventListener('dragover', (event) => this.handleDragOver(event));
    this.host.addEventListener('dragleave', (event) => this.handleDragLeave(event));
    this.host.addEventListener('drop', (event) => this.handleDrop(event));
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

  /** Moves the playhead from another surface (e.g. the preview monitor). */
  seekTo(ms: number): void {
    if (Math.abs(this.playheadMs - ms) < 1) return;
    this.setPlayhead(ms);
  }

  /** Stops timeline playback without touching the playhead. */
  pausePlayback(): void {
    this.pause();
  }

  /** Rebuilds the lanes, ruler and toolbar from the store document. */
  render(): void {
    if (this.disposed) return;
    if (this.doc !== null) {
      // The store hands over a new document on every edit.
      this.doc = this.options.store.current ?? this.doc;
    }
    if (this.selectedClipId && this.doc && !findClip(this.doc, this.selectedClipId)) {
      this.selectedClipId = null;
      this.options.onSelectedClipChange?.(null);
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
    this.timecode.textContent = this.formatPosition(this.playheadMs);
    this.total.textContent = `/ ${this.formatPosition(duration)}`;
    this.playButton.replaceChildren(icon(this.playing ? 'stop' : 'play', 14));
    this.playButton.title = this.playing ? 'Pause' : 'Play';
    this.snapButton.setAttribute('aria-pressed', String(this.snap));
    const selected = this.selectedClipId && doc ? findClip(doc, this.selectedClipId) : null;
    this.deleteButton.disabled = !selected || (doc !== null && isTrackLocked(doc, selected.track.id));
    this.host.classList.toggle('is-playing', this.playing);
  }

  private renderRuler(): void {
    const doc = this.doc;
    this.ruler.replaceChildren();
    if (!doc) return;
    if (doc.mode === 'music') this.renderMusicRuler(doc);
    else this.renderSecondsRuler(doc);
    this.ruler.style.width = `${Math.max(0, this.contentWidth() - LABEL_WIDTH)}px`;
  }

  private renderSecondsRuler(doc: TimelineDoc): void {
    const step = this.rulerStepSeconds();
    const durationMs = Math.max(timelineDuration(doc), step * 1000 * 4);
    const endSeconds = Math.ceil(durationMs / 1000 / step) * step;
    for (let seconds = 0; seconds <= endSeconds; seconds += step) {
      const tick = el('span', { class: 'timeline-tick' }, [
        el('span', { class: 'timeline-tick-label mono', text: formatRulerLabel(seconds) }),
      ]);
      tick.style.left = `${this.msToPx(seconds * 1000)}px`;
      this.ruler.appendChild(tick);
    }
  }

  /** Music mode: bar ticks (labeled) and beat/subdivision ticks. */
  private renderMusicRuler(doc: TimelineDoc): void {
    const beat = beatDurationMs(doc.tempo);
    const bar = barDurationMs(doc.tempo);
    const tempo = doc.tempo ?? DEFAULT_TEMPO;
    const beatsPerBar = Math.max(1, Math.round((tempo.numerator * 4) / tempo.denominator));
    const durationMs = Math.max(timelineDuration(doc), bar * 4);
    const endMs = Math.ceil(durationMs / bar) * bar;
    let count = 0;
    for (let index = 0; index * beat <= endMs && count < 2000; index += 1, count += 1) {
      const isBar = index % beatsPerBar === 0;
      const label = isBar ? `${Math.floor(index / beatsPerBar) + 1}.1` : `${(index % beatsPerBar) + 1}`;
      const tick = el('span', { class: `timeline-tick ${isBar ? 'is-bar' : 'is-beat'}` }, [
        el('span', { class: 'timeline-tick-label mono', text: label }),
      ]);
      tick.style.left = `${this.msToPx(index * beat)}px`;
      this.ruler.appendChild(tick);
    }
  }

  private renderLanes(): void {
    const doc = this.doc;
    this.lanes.replaceChildren();
    this.lanes.style.width = `${this.contentWidth()}px`;
    const hasClips = doc ? doc.tracks.some((track) => track.clips.length > 0) : false;
    this.empty.classList.toggle('hidden', hasClips);
    if (!doc) return;

    const counters: Record<Track['kind'], number> = { video: 0, audio: 0, note: 0 };
    doc.tracks.forEach((track) => {
      counters[track.kind] += 1;
      const lane = el('div', {
        class: `timeline-lane ${track.locked === true ? 'is-locked' : ''}`.trim(),
        dataset: { track: track.id },
      });
      lane.style.height = `${LANE_HEIGHT}px`;
      for (const clip of track.clips) lane.appendChild(this.buildClip(clip, track));
      const prefix = track.kind === 'video' ? 'V' : track.kind === 'audio' ? 'A' : 'N';
      const label = el('div', { class: 'timeline-track-label', dataset: { kind: track.kind } }, [
        el('span', { class: 'timeline-track-name', text: `${prefix}${counters[track.kind]}` }),
        el('div', { class: 'track-controls' }, [
          this.buildTrackToggle(track, 'muted', 'track-mute', 'M', 'Mute track'),
          this.buildTrackToggle(track, 'soloed', 'track-solo', 'S', 'Solo track'),
          this.buildTrackToggle(track, 'locked', 'track-lock', 'L', 'Lock track'),
        ]),
        iconButton('x', `Remove ${track.kind} track`, () => this.removeTrackById(track.id), { size: 12 }),
      ]);
      label.style.height = `${LANE_HEIGHT}px`;
      this.lanes.appendChild(
        el('div', { class: 'timeline-track', dataset: { kind: track.kind } }, [label, lane]),
      );
    });
  }

  private buildTrackToggle(
    track: Track,
    flag: TrackFlag,
    className: string,
    text: string,
    title: string,
  ): HTMLButtonElement {
    const active = track[flag] === true;
    return el(
      'button',
      {
        class: `track-toggle ${className} ${active ? 'is-active' : ''}`.trim(),
        type: 'button',
        title,
        text,
        attrs: { 'aria-label': `${title} (${track.id})`, 'aria-pressed': String(active) },
        on: {
          click: (event) => {
            event.stopPropagation();
            this.toggleTrackFlag(track.id, flag);
          },
          pointerdown: (event) => event.stopPropagation(),
        },
      },
      [],
    );
  }

  private buildClip(clip: Clip, track: Track): HTMLElement {
    const locked = track.locked === true;
    const node = el('div', {
      class: `timeline-clip ${this.selectedClipId === clip.id ? 'is-selected' : ''} ${
        locked ? 'is-locked' : ''
      }`.trim(),
      dataset: { clip: clip.id, kind: track.kind },
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
    this.timecode.textContent = this.formatPosition(this.playheadMs);
  }

  // ------------------------------------------------------------
  // Editing
  // ------------------------------------------------------------
  /** Applies a model result through the store with a history label. */
  private commit(next: TimelineDoc, label: string): void {
    const doc = this.doc;
    if (!doc || next === doc) return;
    this.doc = next;
    this.options.store.update(next, label);
    this.render();
  }

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
    // A locked lane is read-only: the pure model guards moves/trims too.
    if (this.doc && isTrackLocked(this.doc, findClip(this.doc, clip.id)?.track.id ?? '')) return;

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
    this.commit(next, drag.mode === 'move' ? 'Move clip' : 'Trim clip');
  }

  // ------------------------------------------------------------
  // Drag and drop from the explorer or the operating system
  // ------------------------------------------------------------
  private acceptsDrag(event: DragEvent): boolean {
    const types = [...(event.dataTransfer?.types ?? [])];
    return types.includes('application/x-flaxia-file') || types.includes('Files');
  }

  private handleDragOver(event: DragEvent): void {
    if (!this.acceptsDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    const ms = this.dropTime(event.clientX);
    this.dropLine.classList.remove('hidden');
    this.dropLine.style.left = `${LABEL_WIDTH + this.msToPx(ms)}px`;
    const lane = (event.target as HTMLElement | null)?.closest<HTMLElement>('.timeline-lane') ?? null;
    if (this.dropLane !== lane) {
      this.dropLane?.classList.remove('is-drop-target');
      this.dropLane = lane;
      lane?.classList.add('is-drop-target');
    }
  }

  private handleDragLeave(event: DragEvent): void {
    if (!this.acceptsDrag(event)) return;
    const related = event.relatedTarget as Node | null;
    if (related && this.host.contains(related)) return;
    this.hideDropTarget();
  }

  private handleDrop(event: DragEvent): void {
    if (!this.acceptsDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const ms = this.dropTime(event.clientX);
    const candidates = this.snapCandidatesFor(null, [this.playheadMs]);
    const start = this.snap && candidates.length > 0 ? snapMs(ms, candidates) : ms;
    const trackId = this.trackAt(event.clientY)?.id ?? null;
    this.hideDropTarget();
    const transfer = event.dataTransfer;
    const path = transfer?.getData('application/x-flaxia-file') || transfer?.getData('text/plain') || '';
    const files = [...(transfer?.files ?? [])];
    if (path) {
      this.options.onDropFile?.(path, start, trackId);
      return;
    }
    if (files.length > 0) this.options.onDropFiles?.(files, start, trackId);
  }

  private dropTime(clientX: number): number {
    const rect = this.lanes.getBoundingClientRect();
    return Math.max(0, this.pxToMs(clientX - rect.left - LABEL_WIDTH));
  }

  private hideDropTarget(): void {
    this.dropLine.classList.add('hidden');
    this.dropLane?.classList.remove('is-drop-target');
    this.dropLane = null;
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
      this.showLaneMenu(event.clientX, event.clientY, this.dropTime(event.clientX));
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
    const locked = track.locked === true;

    showContextMenu(x, y, [
      {
        label: 'Split at playhead',
        icon: 'scissors',
        disabled: locked || !canSplit,
        run: () => this.splitAt(clipId),
      },
      {
        label: 'Quantize',
        icon: 'check',
        disabled: locked,
        run: () => this.quantizeClipById(clipId),
      },
      {
        label: 'Duplicate',
        icon: 'copy',
        disabled: locked,
        run: () => this.duplicateClip(clipId),
      },
      {
        label: 'Add File…',
        icon: 'plus',
        run: () => this.options.onAddFile?.(clipEnd(clip), track.id),
      },
      {
        label: 'Open source',
        icon: 'external',
        run: () => this.options.onOpenSource(clip.path),
      },
      {
        label: 'Toggle mute',
        icon: 'x',
        run: () => this.toggleTrackFlag(track.id, 'muted'),
      },
      {
        label: 'Toggle solo',
        icon: 'play',
        run: () => this.toggleTrackFlag(track.id, 'soloed'),
      },
      {
        label: 'Delete clip',
        icon: 'trash',
        danger: true,
        disabled: locked,
        run: () => this.deleteClip(clipId),
      },
      {
        label: 'Remove track',
        icon: 'x',
        run: () => this.removeTrackById(track.id),
      },
    ]);
  }

  private showLaneMenu(x: number, y: number, addAtMs: number): void {
    const trackId = this.trackAt(y)?.id ?? null;
    showContextMenu(x, y, [
      {
        label: 'Add File…',
        icon: 'plus',
        run: () => this.options.onAddFile?.(addAtMs, trackId),
      },
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
    this.commit(splitClip(doc, clipId, this.playheadMs), 'Split clip');
  }

  private duplicateClip(clipId: string): void {
    const doc = this.doc;
    if (!doc) return;
    const found = findClip(doc, clipId);
    if (!found) return;
    this.commit(
      addClip(doc, found.track.id, found.clip.path, clipEnd(found.clip), {
        inMs: found.clip.inMs,
        durationMs: found.clip.durationMs,
      }),
      'Duplicate clip',
    );
  }

  private deleteClip(clipId: string): void {
    const doc = this.doc;
    if (!doc) return;
    const next = removeClip(doc, clipId);
    if (next === doc) return;
    if (this.selectedClipId === clipId) this.selectedClipId = null;
    this.commit(next, 'Delete clip');
  }

  private toggleTrackFlag(trackId: string, flag: TrackFlag): void {
    const doc = this.doc;
    if (!doc) return;
    const track = doc.tracks.find((entry) => entry.id === trackId);
    if (!track) return;
    const label = flag === 'muted' ? 'Toggle mute' : flag === 'soloed' ? 'Toggle solo' : 'Toggle lock';
    this.commit(setTrackFlag(doc, trackId, flag, track[flag] !== true), label);
  }

  private quantizeClipById(clipId: string): void {
    const doc = this.doc;
    if (!doc) return;
    this.commit(quantizeClip(doc, clipId, 4), 'Quantize clip');
  }

  /** `Q`: quantize the clip under the playhead (or the selected clip). */
  private quantizeAtPlayhead(): void {
    const doc = this.doc;
    if (!doc) return;
    const underHead = doc.tracks
      .filter((track) => !isTrackLocked(doc, track.id))
      .flatMap((track) => track.clips)
      .find((clip) => clip.startMs <= this.playheadMs && this.playheadMs < clipEnd(clip));
    const clipId = underHead?.id ?? this.selectedClipId;
    if (clipId) this.quantizeClipById(clipId);
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
      this.commit(splitClip(doc, this.selectedClipId, this.playheadMs), 'Split clip');
      return;
    }
    if (event.key === 'q' || event.key === 'Q') {
      event.preventDefault();
      this.quantizeAtPlayhead();
    }
  }

  private deleteSelected(): void {
    const doc = this.doc;
    if (!doc || !this.selectedClipId) return;
    const next = removeClip(doc, this.selectedClipId);
    if (next === doc) return;
    this.selectedClipId = null;
    this.commit(next, 'Delete clip');
  }

  private addTrack(kind: Track['kind']): void {
    const doc = this.doc;
    if (!doc) return;
    this.commit(addTrack(doc, kind), 'Add track');
  }

  private removeTrackById(trackId: string): void {
    const doc = this.doc;
    if (!doc) return;
    const next: TimelineDoc = { ...doc, tracks: doc.tracks.filter((track) => track.id !== trackId) };
    this.commit(next, 'Remove track');
  }

  private select(clipId: string | null): void {
    this.selectedClipId = clipId;
    for (const node of this.lanes.querySelectorAll<HTMLElement>('.timeline-clip')) {
      node.classList.toggle('is-selected', node.dataset.clip === clipId);
    }
    this.renderToolbar();
    const found = clipId && this.doc ? findClip(this.doc, clipId) : null;
    this.options.onSelectedClipChange?.(found?.clip.path ?? null);
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
    this.options.onPlaybackChange?.(true);
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
    this.options.onPlaybackChange?.(false);
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
      if (!isAudibleTrack(doc, track.id)) continue;
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
      element.volume = this.clipVolume(clip);
      if (element.paused) void element.play().catch(() => undefined);
    }
  }

  /** Gain plus linear fades, evaluated at the current playhead. */
  private clipVolume(clip: Clip): number {
    let volume = Math.min(1, Math.max(0, clip.gain ?? 1));
    if (clip.fadeInMs && clip.fadeInMs > 0) {
      volume *= Math.min(1, Math.max(0, (this.playheadMs - clip.startMs) / clip.fadeInMs));
    }
    if (clip.fadeOutMs && clip.fadeOutMs > 0) {
      volume *= Math.min(1, Math.max(0, (clipEnd(clip) - this.playheadMs) / clip.fadeOutMs));
    }
    return Math.min(1, Math.max(0, volume));
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

  /** Bar/beat/subdivision display in music mode, timecode in video mode. */
  private formatPosition(ms: number): string {
    const doc = this.doc;
    if (doc?.mode !== 'music') return formatTimecode(ms, doc?.fps ?? 30);
    const beat = beatDurationMs(doc.tempo);
    const bar = barDurationMs(doc.tempo);
    const position = Math.max(0, ms);
    const barNumber = Math.floor(position / bar) + 1;
    const beatNumber = Math.floor((position % bar) / beat) + 1;
    const subdivision = Math.floor(((position % beat) / beat) * 4) + 1;
    return `${barNumber}.${beatNumber}.${subdivision}`;
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

  private snapCandidatesFor(clipId: string | null, extras: number[]): number[] {
    const doc = this.doc;
    if (!doc) return extras;
    // `snapCandidates` adds the beat grid itself when doc.mode === 'music'.
    return snapCandidates(doc, clipId ?? undefined, extras);
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

/**
 * Enlarged piano-roll view for a note clip.
 *
 * The canvas owns the grid (pitch rows, beat lines, playhead and the notes
 * themselves). Transparent `.piano-roll-note` elements sit on top as pointer
 * targets so the parent app can style selection/hover with plain CSS without
 * having to repaint the canvas. The left rail holds one `.piano-roll-key`
 * element per visible pitch and previews a pitch when clicked.
 *
 * Nothing touches `document` at module scope, so importing this file is safe
 * in a DOM-less environment (Node tests, SSR); only the constructor needs a
 * document.
 */

import {
  addNote,
  isBlackKey,
  MIN_NOTE_TICKS,
  type Note,
  type NoteClip,
  noteName,
  quantizeTick,
  removeNote,
  TICKS_PER_BEAT,
} from '../lib/music.ts';

export interface PianoRollOptions {
  onNoteChange?: (clip: NoteClip) => void;
  onPlayNote?: (pitch: number) => void;
}

type DragMode = 'move' | 'resize-start' | 'resize-end';

interface DragState {
  mode: DragMode;
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  original: Note;
}

const ROW_HEIGHT = 22;
const RULER_HEIGHT = 22;
const EDGE_PX = 6;
const SNAP_SUBDIVISION = 16;
const SNAP_TICKS = (TICKS_PER_BEAT * 4) / SNAP_SUBDIVISION;
const DEFAULT_PX_PER_TICK = 0.25;
const DEFAULT_FROM_PITCH = 60;
const DEFAULT_TO_PITCH = 84;
const MIN_BARS = 8;
const MAX_TICKS = 1_000_000;

const FALLBACK = {
  bg: '#ffffff',
  ruler: '#f1f5f9',
  blackRow: '#e2e8f0',
  grid: '#e2e8f0',
  beatLine: '#cbd5e1',
  barLine: '#94a3b8',
  muted: '#64748b',
  accent: '#10b981',
  accentDark: '#047857',
  onAccent: '#022c22',
  playhead: '#f43f5e',
};

export class PianoRollView {
  readonly host: HTMLElement;
  private readonly options: PianoRollOptions;
  private readonly scroll: HTMLElement;
  private readonly surface: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly notesLayer: HTMLElement;
  private readonly keys: HTMLElement;
  private readonly keysInner: HTMLElement;
  private readonly range: HTMLElement;

  private clip: NoteClip = { id: 'clip-1', notes: [] };
  private fromPitch = DEFAULT_FROM_PITCH;
  private toPitch = DEFAULT_TO_PITCH;
  private pxPerTick = DEFAULT_PX_PER_TICK;
  private playheadTick = 0;
  private selectedId: string | null = null;
  private drag: DragState | null = null;
  private noteSeq = 0;
  private disposed = false;

  constructor(options: PianoRollOptions = {}) {
    this.options = options;

    this.keysInner = element('div', 'piano-roll-keys-inner');
    this.keysInner.style.position = 'relative';
    this.keys = element('div', 'piano-roll-keys', [this.keysInner]);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'piano-roll-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.position = 'absolute';
    this.canvas.style.left = '0';
    this.canvas.style.top = '0';
    this.notesLayer = element('div', 'piano-roll-notes');
    this.notesLayer.style.position = 'absolute';
    this.notesLayer.style.left = '0';
    this.notesLayer.style.top = '0';
    // Empty areas fall through to the canvas; only note hits take pointer input.
    this.notesLayer.style.pointerEvents = 'none';
    this.surface = element('div', 'piano-roll-surface', [this.canvas, this.notesLayer]);
    this.surface.style.position = 'relative';
    this.scroll = element('div', 'piano-roll-scroll', [this.surface]);
    this.scroll.style.overflow = 'auto';
    this.keys.style.overflow = 'hidden';
    this.keys.style.flex = '0 0 48px';
    this.scroll.style.flex = '1 1 auto';

    const body = element('div', 'piano-roll-body', [this.keys, this.scroll]);
    body.style.display = 'flex';
    body.style.minHeight = '0';
    this.range = element('span', 'piano-roll-range');
    const head = element('div', 'piano-roll-head', [
      element('span', 'piano-roll-title', [document.createTextNode('Piano roll')]),
      this.range,
    ]);
    this.host = element('div', 'piano-roll', [head, body]);
    this.host.style.display = 'flex';
    this.host.style.flexDirection = 'column';
    this.host.tabIndex = 0;
    this.host.setAttribute('aria-label', 'Piano roll');

    this.canvas.addEventListener('pointerdown', (event) => this.onCanvasPointerDown(event));
    this.notesLayer.addEventListener('pointerdown', (event) => this.onNotePointerDown(event));
    this.notesLayer.addEventListener('dblclick', (event) => this.onDoubleClick(event));
    this.surface.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.surface.addEventListener('pointerup', (event) => this.endDrag(event));
    this.surface.addEventListener('pointercancel', (event) => this.endDrag(event));
    this.keys.addEventListener('pointerdown', (event) => this.onKeyPointerDown(event));
    this.scroll.addEventListener('scroll', () => this.syncKeyScroll());
    this.host.addEventListener('keydown', (event) => this.onKeyDown(event));

    this.buildKeys();
    this.render();
  }

  /** Replaces the clip shown by the view without emitting `onNoteChange`. */
  setClip(clip: NoteClip): void {
    this.clip = { id: clip.id, notes: [...clip.notes] };
    if (this.selectedId && !this.clip.notes.some((note) => note.id === this.selectedId)) {
      this.selectedId = null;
    }
    this.render();
  }

  /** The clip currently on screen. */
  getClip(): NoteClip {
    return this.clip;
  }

  /** Moves the playhead marker (ticks). */
  setPlayheadTick(tick: number): void {
    this.playheadTick = Number.isFinite(tick) ? Math.max(0, Math.round(tick)) : 0;
    this.draw();
  }

  /** Sets the visible pitch window (inclusive). Reversed bounds are swapped. */
  setRange(fromPitch: number, toPitch: number): void {
    const low = finitePitch(fromPitch, DEFAULT_FROM_PITCH);
    const high = finitePitch(toPitch, DEFAULT_TO_PITCH);
    this.fromPitch = Math.min(low, high);
    this.toPitch = Math.max(low, high);
    if (this.toPitch <= this.fromPitch) this.toPitch = Math.min(127, this.fromPitch + 1);
    this.buildKeys();
    this.render();
  }

  /** Horizontal zoom, in CSS pixels per tick. */
  setPxPerTick(pxPerTick: number): void {
    this.pxPerTick = Number.isFinite(pxPerTick)
      ? Math.min(4, Math.max(0.05, pxPerTick))
      : DEFAULT_PX_PER_TICK;
    this.render();
  }

  /** Releases gesture state. Safe to call more than once. */
  dispose(): void {
    this.disposed = true;
    this.drag = null;
  }

  private commit(next: NoteClip, playPitch?: number): void {
    this.clip = next;
    this.render();
    this.options.onNoteChange?.(next);
    if (playPitch !== undefined) this.options.onPlayNote?.(playPitch);
  }

  private render(): void {
    if (this.disposed) return;
    const width = `${this.surfaceWidth()}px`;
    const height = `${this.surfaceHeight()}px`;
    this.surface.style.width = width;
    this.surface.style.height = height;
    this.notesLayer.style.width = width;
    this.notesLayer.style.height = height;
    this.keysInner.style.height = height;
    this.range.textContent = `${noteName(this.fromPitch)} – ${noteName(this.toPitch)}`;
    this.renderNotes();
    this.draw();
  }

  /** Updates selection classes in place so dblclick targets stay alive. */
  private updateSelection(): void {
    for (const child of this.notesLayer.children) {
      const hit = child as HTMLElement;
      const selected = hit.dataset.id === this.selectedId;
      hit.dataset.selected = String(selected);
      hit.classList.toggle('selected', selected);
    }
    this.draw();
  }

  private renderNotes(): void {
    this.notesLayer.replaceChildren();
    for (const note of this.clip.notes) {
      if (note.pitch < this.fromPitch || note.pitch > this.toPitch) continue;
      const hit = element('div', 'piano-roll-note');
      hit.dataset.id = note.id;
      hit.dataset.pitch = String(note.pitch);
      hit.dataset.selected = String(note.id === this.selectedId);
      if (note.id === this.selectedId) hit.classList.add('selected');
      hit.title = `${noteName(note.pitch)} · ${note.startTick}–${note.startTick + note.durationTick} ticks`;
      hit.style.position = 'absolute';
      hit.style.left = `${note.startTick * this.pxPerTick}px`;
      hit.style.top = `${this.rowY(note.pitch) + 1}px`;
      hit.style.width = `${Math.max(4, note.durationTick * this.pxPerTick)}px`;
      hit.style.height = `${ROW_HEIGHT - 2}px`;
      hit.style.background = 'transparent';
      hit.style.borderRadius = '4px';
      hit.style.cursor = 'grab';
      hit.style.pointerEvents = 'auto';
      this.notesLayer.append(hit);
    }
  }

  private draw(): void {
    if (this.disposed) return;
    const width = this.surfaceWidth();
    const height = this.surfaceHeight();
    const ratio = typeof window === 'undefined' ? 1 : Math.max(1, window.devicePixelRatio || 1);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.max(1, Math.round(width * ratio));
    this.canvas.height = Math.max(1, Math.round(height * ratio));
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const colors = {
      bg: token('--bg-primary', FALLBACK.bg),
      ruler: token('--bg-tertiary', FALLBACK.ruler),
      blackRow: token('--bg-tertiary', FALLBACK.blackRow),
      grid: token('--border', FALLBACK.grid),
      beatLine: token('--border-strong', FALLBACK.beatLine),
      barLine: token('--text-muted', FALLBACK.barLine),
      muted: token('--text-muted', FALLBACK.muted),
      accent: token('--accent', FALLBACK.accent),
      accentDark: token('--accent-dark', FALLBACK.accentDark),
      onAccent: token('--on-accent', FALLBACK.onAccent),
      playhead: token('--coral', FALLBACK.playhead),
    };

    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, width, height);
    for (let pitch = this.fromPitch; pitch <= this.toPitch; pitch += 1) {
      const y = this.rowY(pitch);
      if (isBlackKey(pitch)) {
        ctx.fillStyle = colors.blackRow;
        ctx.fillRect(0, y, width, ROW_HEIGHT);
      }
      ctx.fillStyle = pitch % 12 === 0 ? colors.beatLine : colors.grid;
      ctx.fillRect(0, y, width, 1);
    }

    const total = this.totalTicks();
    for (let tick = 0; tick <= total; tick += TICKS_PER_BEAT) {
      const x = Math.round(tick * this.pxPerTick) + 0.5;
      const isBar = tick % (TICKS_PER_BEAT * 4) === 0;
      ctx.fillStyle = isBar ? colors.barLine : colors.grid;
      ctx.fillRect(x, RULER_HEIGHT, 1, height - RULER_HEIGHT);
    }

    ctx.fillStyle = colors.ruler;
    ctx.fillRect(0, 0, width, RULER_HEIGHT);
    ctx.fillStyle = colors.beatLine;
    ctx.fillRect(0, RULER_HEIGHT - 1, width, 1);
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colors.muted;
    for (let bar = 0; bar * TICKS_PER_BEAT * 4 <= total; bar += 1) {
      const x = bar * TICKS_PER_BEAT * 4 * this.pxPerTick;
      if (x > width) break;
      ctx.fillText(String(bar + 1), x + 4, RULER_HEIGHT / 2);
    }

    const noteHeight = ROW_HEIGHT - 4;
    for (const note of this.clip.notes) {
      if (note.pitch < this.fromPitch || note.pitch > this.toPitch) continue;
      const x = note.startTick * this.pxPerTick;
      const y = this.rowY(note.pitch) + 2;
      const noteWidth = Math.max(4, note.durationTick * this.pxPerTick);
      const selected = note.id === this.selectedId;
      ctx.fillStyle = colors.accent;
      roundedPath(ctx, x, y, noteWidth, noteHeight, 4);
      ctx.fill();
      ctx.strokeStyle = selected ? colors.playhead : colors.accentDark;
      ctx.lineWidth = selected ? 2 : 1;
      ctx.stroke();
      if (noteWidth >= 30) {
        ctx.fillStyle = colors.onAccent;
        ctx.fillText(noteName(note.pitch), x + 5, y + noteHeight / 2);
      }
    }

    const playheadX = this.playheadTick * this.pxPerTick;
    if (playheadX >= 0 && playheadX <= width) {
      ctx.fillStyle = colors.playhead;
      ctx.fillRect(playheadX - 1, 0, 2, height);
      ctx.beginPath();
      ctx.moveTo(playheadX - 4, 0);
      ctx.lineTo(playheadX + 4, 0);
      ctx.lineTo(playheadX, 6);
      ctx.closePath();
      ctx.fill();
    }
  }

  private buildKeys(): void {
    this.keysInner.replaceChildren();
    const spacer = element('div', 'piano-roll-key-spacer');
    spacer.style.height = `${RULER_HEIGHT}px`;
    this.keysInner.append(spacer);
    for (let pitch = this.toPitch; pitch >= this.fromPitch; pitch -= 1) {
      const key = element('div', 'piano-roll-key');
      key.dataset.pitch = String(pitch);
      key.dataset.black = String(isBlackKey(pitch));
      key.style.position = 'absolute';
      key.style.left = '0';
      key.style.right = '0';
      key.style.height = `${ROW_HEIGHT}px`;
      key.style.top = `${this.rowY(pitch)}px`;
      const label = element('span', 'piano-roll-key-label');
      label.textContent = pitch % 12 === 0 ? noteName(pitch) : '';
      key.append(label);
      this.keysInner.append(key);
    }
  }

  private syncKeyScroll(): void {
    this.keys.scrollTop = this.scroll.scrollTop;
  }

  private onCanvasPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.disposed) return;
    this.host.focus({ preventScroll: true });
    const point = this.pointOf(event);
    if (point.y < RULER_HEIGHT) return;
    const pitch = this.pitchAt(point.y);
    const startTick = quantizeTick(point.x / this.pxPerTick, SNAP_SUBDIVISION);
    const note: Note = {
      id: this.nextId(),
      pitch,
      startTick,
      durationTick: TICKS_PER_BEAT,
      velocity: 100,
    };
    this.selectedId = note.id;
    this.commit(addNote(this.clip, note), pitch);
  }

  private onNotePointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.disposed) return;
    const hit = (event.target as HTMLElement | null)?.closest<HTMLElement>('.piano-roll-note');
    const id = hit?.dataset.id;
    const note = this.clip.notes.find((entry) => entry.id === id);
    if (!note || !id) return;
    event.stopPropagation();
    this.host.focus({ preventScroll: true });
    this.selectedId = id;
    this.updateSelection();

    const x = this.pointOf(event).x;
    const left = note.startTick * this.pxPerTick;
    const right = left + note.durationTick * this.pxPerTick;
    let mode: DragMode = 'move';
    if (x <= left + EDGE_PX) mode = 'resize-start';
    else if (x >= right - EDGE_PX) mode = 'resize-end';
    this.drag = {
      mode,
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      original: note,
    };
    try {
      this.surface.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is an optimisation; dragging still works without it.
    }
    this.options.onPlayNote?.(note.pitch);
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId || this.disposed) return;
    const deltaTick = Math.round((event.clientX - drag.startX) / this.pxPerTick / SNAP_TICKS) * SNAP_TICKS;
    const deltaRow = Math.round((event.clientY - drag.startY) / ROW_HEIGHT);
    const original = drag.original;
    let next: Note;
    if (drag.mode === 'resize-end') {
      next = { ...original, durationTick: Math.max(MIN_NOTE_TICKS, original.durationTick + deltaTick) };
    } else if (drag.mode === 'resize-start') {
      const end = original.startTick + original.durationTick;
      const start = Math.min(Math.max(0, original.startTick + deltaTick), end - MIN_NOTE_TICKS);
      next = { ...original, startTick: start, durationTick: end - start };
    } else {
      next = {
        ...original,
        startTick: Math.max(0, original.startTick + deltaTick),
        pitch: Math.min(this.toPitch, Math.max(this.fromPitch, original.pitch - deltaRow)),
      };
    }
    this.commit({
      ...this.clip,
      notes: this.clip.notes.map((note) => (note.id === drag.id ? next : note)),
    });
  }

  private endDrag(event: PointerEvent): void {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    this.drag = null;
    if (this.surface.hasPointerCapture(event.pointerId)) {
      this.surface.releasePointerCapture(event.pointerId);
    }
  }

  private onDoubleClick(event: MouseEvent): void {
    const id = (event.target as HTMLElement | null)?.closest<HTMLElement>('.piano-roll-note')?.dataset.id;
    if (!id) return;
    this.selectedId = null;
    this.commit(removeNote(this.clip, id));
  }

  private onKeyPointerDown(event: PointerEvent): void {
    const key = (event.target as HTMLElement | null)?.closest<HTMLElement>('.piano-roll-key');
    const pitch = Number(key?.dataset.pitch);
    if (!key || !Number.isFinite(pitch)) return;
    this.options.onPlayNote?.(pitch);
  }

  private onKeyDown(event: KeyboardEvent): void {
    const id = this.selectedId;
    const note = this.clip.notes.find((entry) => entry.id === id);
    if (!note || !id) return;
    const step = event.shiftKey ? TICKS_PER_BEAT : SNAP_TICKS;
    let next: Note | null = null;
    switch (event.key) {
      case 'ArrowLeft':
        next = { ...note, startTick: Math.max(0, note.startTick - step) };
        break;
      case 'ArrowRight':
        next = { ...note, startTick: note.startTick + step };
        break;
      case 'ArrowUp':
        next = { ...note, pitch: Math.min(this.toPitch, note.pitch + 1) };
        break;
      case 'ArrowDown':
        next = { ...note, pitch: Math.max(this.fromPitch, note.pitch - 1) };
        break;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        this.selectedId = null;
        this.commit(removeNote(this.clip, id));
        return;
      case 'Escape':
        event.preventDefault();
        this.selectedId = null;
        this.updateSelection();
        return;
      default:
        return;
    }
    event.preventDefault();
    if (next) {
      this.commit({ ...this.clip, notes: this.clip.notes.map((entry) => (entry.id === id ? next : entry)) });
    }
  }

  private pointOf(event: MouseEvent | PointerEvent): { x: number; y: number } {
    const rect = this.surface.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private pitchAt(y: number): number {
    const row = Math.floor((y - RULER_HEIGHT) / ROW_HEIGHT);
    return Math.min(this.toPitch, Math.max(this.fromPitch, this.toPitch - row));
  }

  private rowY(pitch: number): number {
    return RULER_HEIGHT + (this.toPitch - pitch) * ROW_HEIGHT;
  }

  private totalTicks(): number {
    let end = MIN_BARS * 4 * TICKS_PER_BEAT;
    for (const note of this.clip.notes) {
      end = Math.max(end, note.startTick + note.durationTick + TICKS_PER_BEAT);
    }
    const bar = TICKS_PER_BEAT * 4;
    return Math.min(MAX_TICKS, Math.ceil(end / bar) * bar);
  }

  private surfaceWidth(): number {
    return Math.max(1, Math.ceil(this.totalTicks() * this.pxPerTick));
  }

  private surfaceHeight(): number {
    return RULER_HEIGHT + (this.toPitch - this.fromPitch + 1) * ROW_HEIGHT;
  }

  private nextId(): string {
    this.noteSeq += 1;
    return `note-${Date.now().toString(36)}-${this.noteSeq.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  }
}

function element(tag: string, className: string, children: Node[] = []): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...children);
  return node;
}

function token(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function finitePitch(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(127, Math.max(0, Math.round(value)));
}

function roundedPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

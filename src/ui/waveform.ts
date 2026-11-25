/**
 * Minimal waveform display for audio clips.
 *
 * The view owns a single `<canvas>`; callers mount `host` wherever the waveform
 * belongs and drive it with `setPeaks` / `setProgress`. Drawing is intentionally
 * flat: a centre line, symmetric bars and a playhead, with no gradients or
 * glow, matching the Flaxia design language.
 */

const CANVAS_CLASS = 'waveform-canvas';
const FALLBACK_COLOR = '#10b981';

function accentColor(): string {
  try {
    if (typeof document === 'undefined') return FALLBACK_COLOR;
    let computed: CSSStyleDeclaration | null = null;
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      computed = window.getComputedStyle(document.documentElement);
    } else if (typeof globalThis.getComputedStyle === 'function') {
      computed = globalThis.getComputedStyle(document.documentElement);
    }
    const value = computed?.getPropertyValue('--accent').trim();
    return value || FALLBACK_COLOR;
  } catch {
    return FALLBACK_COLOR;
  }
}

function pixelRatio(): number {
  if (typeof window === 'undefined') return 1;
  const ratio = window.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

export class WaveformView {
  /** The `<canvas class="waveform-canvas">` to append to the DOM. */
  readonly host: HTMLCanvasElement;

  private readonly canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D | null = null;
  private peaks: Float32Array = new Float32Array(0);
  private color: string | null = null;
  private progress = 0;
  private width = 0;
  private height = 0;

  constructor() {
    // DOM access stays in the constructor so importing this module in Node is safe.
    this.canvas = document.createElement('canvas');
    this.canvas.className = CANVAS_CLASS;
    this.host = this.canvas;
  }

  /** Replaces the displayed peaks with a defensive copy. */
  setPeaks(peaks: Float32Array): void {
    this.peaks = new Float32Array(peaks);
    this.render();
  }

  /** Overrides the bar colour; an empty value restores the `--accent` default. */
  setColor(color: string): void {
    this.color = color.trim() || null;
    this.render();
  }

  /** Sets the playhead position as a ratio in 0..1. */
  setProgress(ratio: number): void {
    this.progress = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
    this.render();
  }

  /** Sets the CSS size in pixels; the backing store is scaled by DPR in render. */
  resize(width: number, height: number): void {
    this.width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    this.height = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.render();
  }

  /** Redraws the centre line, symmetric bars and the 1px playhead. */
  render(): void {
    const context = this.context2d();
    if (!context) return;

    const ratio = pixelRatio();
    const pixelWidth = Math.max(1, Math.round(this.width * ratio));
    const pixelHeight = Math.max(1, Math.round(this.height * ratio));
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    if (typeof context.setTransform === 'function') context.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (typeof context.clearRect === 'function') context.clearRect(0, 0, this.width, this.height);

    const color = this.color ?? accentColor();
    const center = Math.round(this.height / 2);
    context.fillStyle = color;
    context.globalAlpha = 0.35;
    context.fillRect(0, center, this.width, 1);
    context.globalAlpha = 1;

    const bars = Math.min(Math.max(1, Math.floor(this.width)), this.peaks.length);
    const maxHalf = Math.max(0, this.height / 2 - 1);
    for (let index = 0; index < bars; index += 1) {
      const source = Math.floor((index * this.peaks.length) / bars);
      const amplitude = Math.min(1, Math.max(0, this.peaks[source] ?? 0));
      const half = Math.max(1, Math.round(amplitude * maxHalf));
      const x = Math.floor((index * this.width) / bars);
      context.fillRect(x, center + 0.5 - half, 1, half * 2);
    }

    context.globalAlpha = 0.85;
    context.fillRect(Math.round(this.progress * this.width), 0, 1, this.height);
    context.globalAlpha = 1;
  }

  private context2d(): CanvasRenderingContext2D | null {
    if (this.context) return this.context;
    try {
      this.context = this.canvas.getContext('2d');
    } catch {
      this.context = null;
    }
    return this.context;
  }
}

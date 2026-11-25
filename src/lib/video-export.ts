/**
 * Minimal frame-sequence export pipeline.
 *
 * Everything here is pure: no DOM, no canvas. The App is responsible for
 * rendering each requested time to a canvas and handing the PNG bytes to
 * `buildFrameZip` together with a deterministic file name from
 * `frameFileName`. Times are milliseconds, frames are 0-based.
 */

import { zipSync } from 'fflate';

/** One frame to render at `timeMs` using `fps`. */
export interface FrameRequest {
  timeMs: number;
  fps: number;
}

/** Default cap: two minutes at 30 fps. */
export const DEFAULT_MAX_FRAMES = 3600;

const MANIFEST_VERSION = 1;
/** Guards against floating-point noise at exact frame boundaries. */
const FRAME_EPSILON = 1e-9;

/** Returns a usable fps, or 0 when the value is missing/invalid. */
function usableFps(fps: number): number {
  return Number.isFinite(fps) && fps > 0 ? fps : 0;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** 0-based frame number for a time (rounded to the nearest frame). */
export function frameIndexAt(timeMs: number, fps: number): number {
  const rate = usableFps(fps);
  if (!Number.isFinite(timeMs) || rate === 0) return 0;
  return Math.round((timeMs * rate) / 1000);
}

/**
 * `HH:MM:SS_FFF` timecode. FFF is the 0-based frame within the current second
 * (for 30 fps it therefore ranges from 000 to 029).
 */
export function frameTimecode(index: number, fps: number): string {
  const rate = usableFps(fps);
  if (!Number.isFinite(index) || rate === 0) return '00:00:00_000';
  const frame = Math.max(0, Math.floor(index));
  const seconds = Math.floor(frame / rate);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const remainder = seconds % 60;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(remainder, 2)}_${pad(frame % rate, 3)}`;
}

/**
 * Deterministic, filesystem-safe frame name, e.g.
 * `frame_000001_T00-00-00_F001.png`.
 */
export function frameFileName(index: number, fps: number): string {
  const frame = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  const timecode = frameTimecode(frame, fps).replace(/:/g, '-').replace('_', '_F');
  return `frame_${pad(frame, 6)}_T${timecode}.png`;
}

/** A half-open time range after clamping to the requested export bounds. */
interface TimeRange {
  start: number;
  end: number;
}

/**
 * Builds the frame list covering the union of all clip ranges (gaps are
 * skipped), optionally clipped to `[startMs, endMs)` and capped at
 * `maxFrames`. Each frame time is the exact frame boundary `index / fps`.
 */
export function frameSequence(
  doc: { fps: number; tracks: Array<{ clips: Array<{ startMs: number; durationMs: number }> }> },
  options?: { startMs?: number; endMs?: number; maxFrames?: number },
): FrameRequest[] {
  const fps = usableFps(doc.fps);
  if (fps === 0) return [];

  const requestedMax = options?.maxFrames ?? DEFAULT_MAX_FRAMES;
  const maxFrames = Number.isFinite(requestedMax)
    ? Math.max(0, Math.floor(requestedMax))
    : DEFAULT_MAX_FRAMES;
  if (maxFrames === 0) return [];

  const rawStart = options?.startMs;
  const rawEnd = options?.endMs;
  const lower = Number.isFinite(rawStart) ? Math.max(0, rawStart ?? 0) : 0;
  const upper = Number.isFinite(rawEnd) ? (rawEnd ?? 0) : Infinity;
  if (!(upper > lower)) return [];

  const ranges: TimeRange[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (!Number.isFinite(clip.startMs) || !Number.isFinite(clip.durationMs)) continue;
      if (clip.durationMs <= 0) continue;
      const start = Math.max(0, clip.startMs, lower);
      const end = Math.min(clip.startMs + clip.durationMs, upper);
      if (end > start) ranges.push({ start, end });
    }
  }
  if (ranges.length === 0) return [];

  ranges.sort((a, b) => a.start - b.start);
  const merged: TimeRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }

  const frames: FrameRequest[] = [];
  const seen = new Set<number>();
  for (const range of merged) {
    const first = Math.max(0, Math.ceil((range.start * fps) / 1000 - FRAME_EPSILON));
    const lastExclusive = Math.ceil((range.end * fps) / 1000 - FRAME_EPSILON);
    for (let index = first; index < lastExclusive && frames.length < maxFrames; index += 1) {
      if (index < 0 || seen.has(index)) continue;
      seen.add(index);
      frames.push({ timeMs: (index * 1000) / fps, fps });
    }
    if (frames.length >= maxFrames) break;
  }
  return frames;
}

/** Pretty-printed JSON manifest describing an already-built frame list. */
export function manifestForFrames(frames: readonly FrameRequest[], fps: number): string {
  return JSON.stringify(
    {
      version: MANIFEST_VERSION,
      fps,
      frames: frames.map((frame) => {
        const index = frameIndexAt(frame.timeMs, fps);
        return {
          index,
          timecode: frameTimecode(index, fps),
          file: frameFileName(index, fps),
        };
      }),
    },
    null,
    2,
  );
}

/** Zips named byte blobs (frames and optionally a manifest). Last name wins. */
export async function buildFrameZip(frames: Array<{ name: string; bytes: Uint8Array }>): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  for (const frame of frames) entries[frame.name] = frame.bytes;
  return zipSync(entries);
}

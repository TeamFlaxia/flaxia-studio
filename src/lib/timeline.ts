/**
 * Timeline document for the media editor.
 *
 * Pure data + pure operations so the model can be unit tested without a DOM.
 * Times are milliseconds; the UI converts to frames with `fps` when it needs to
 * snap or display a timecode.
 *
 * Editing follows NLE overwrite semantics: placing a clip on top of others
 * cuts the covered range out of them (splitting a covered clip in two).
 */

import { randomId } from './id.ts';
import {
  DEFAULT_MEDIA_ADJUSTMENTS,
  type MediaAdjustments,
  type MediaKind,
  sanitizeAdjustments,
  trackKindFor,
} from './media.ts';

export const TIMELINE_VERSION = 2;
export const DEFAULT_FPS = 30;
/** A clip can never be shorter than this. */
export const MIN_CLIP_MS = 100;
/** Default magnet distance when snapping a drag. */
export const SNAP_THRESHOLD_MS = 80;

/** Default 4/4 at 120 BPM: one beat is 500ms, one bar is 2000ms. */
export interface Tempo {
  bpm: number;
  numerator: number;
  denominator: number;
}

export const DEFAULT_TEMPO: Tempo = { bpm: 120, numerator: 4, denominator: 4 };

export type TimelineMode = 'video' | 'music';
export type TrackKind = 'video' | 'audio' | 'note';
export type TrackFlag = 'muted' | 'soloed' | 'locked';

export interface MediaAsset {
  path: string;
  kind: MediaKind;
  durationMs: number;
  width?: number;
  height?: number;
  mime?: string;
}

/** Per-clip overrides for audio playback. */
export interface ClipAudio {
  gain?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
}

export interface Clip {
  id: string;
  /** Source media path. */
  path: string;
  /** Position on the timeline (ms). */
  startMs: number;
  /** In point inside the source (ms). */
  inMs: number;
  /** Length on the timeline (ms). */
  durationMs: number;
  /** Non-destructive adjustments for this clip (overrides the path defaults). */
  adjustments?: MediaAdjustments;
  /** Audio playback parameters, independent of the source path. */
  gain?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
}

export interface Track {
  id: string;
  kind: TrackKind;
  clips: Clip[];
  muted?: boolean;
  soloed?: boolean;
  locked?: boolean;
}

export interface TimelineDoc {
  version: number;
  fps: number;
  tracks: Track[];
  assets: Record<string, MediaAsset>;
  /** Non-destructive adjustments per source path (shared with the preview). */
  adjustments: Record<string, MediaAdjustments>;
  /** Musical grid used by the ruler, snapping and quantizing (v2). */
  tempo?: Tempo;
  /** `music` renders bars/beats; `video` renders seconds (v2). */
  mode?: TimelineMode;
}

export function createTimeline(): TimelineDoc {
  return {
    version: TIMELINE_VERSION,
    fps: DEFAULT_FPS,
    tracks: [],
    assets: {},
    adjustments: {},
    tempo: { ...DEFAULT_TEMPO },
    mode: 'video',
  };
}

export function createTrack(kind: TrackKind): Track {
  return { id: `track-${randomId().slice(0, 8)}`, kind, clips: [] };
}

export function clipEnd(clip: Clip): number {
  return clip.startMs + clip.durationMs;
}

export function trackEnd(track: Track): number {
  let end = 0;
  for (const clip of track.clips) end = Math.max(end, clipEnd(clip));
  return end;
}

export function timelineDuration(doc: TimelineDoc): number {
  let end = 0;
  for (const track of doc.tracks) end = Math.max(end, trackEnd(track));
  return end;
}

export function findClip(doc: TimelineDoc, clipId: string): { track: Track; clip: Clip } | null {
  for (const track of doc.tracks) {
    const clip = track.clips.find((entry) => entry.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

export function registerAsset(doc: TimelineDoc, asset: MediaAsset): TimelineDoc {
  return { ...doc, assets: { ...doc.assets, [asset.path]: asset } };
}

export function addTrack(doc: TimelineDoc, kind: TrackKind): TimelineDoc {
  return { ...doc, tracks: [...doc.tracks, createTrack(kind)] };
}

export function removeTrack(doc: TimelineDoc, trackId: string): TimelineDoc {
  if (isTrackLocked(doc, trackId)) return doc;
  return { ...doc, tracks: doc.tracks.filter((track) => track.id !== trackId) };
}

export interface AddClipOptions {
  inMs?: number;
  durationMs?: number;
}

/** Inserts a clip and cuts whatever it covers out of the target track. */
export function addClip(
  doc: TimelineDoc,
  trackId: string,
  path: string,
  startMs: number,
  options: AddClipOptions = {},
): TimelineDoc {
  const asset = doc.assets[path];
  if (!asset) throw new Error(`Unknown media asset: ${path}`);
  const track = doc.tracks.find((entry) => entry.id === trackId);
  if (!track || track.kind !== trackKindFor(asset.kind) || isTrackLocked(doc, track.id)) return doc;

  const start = Math.max(0, Math.round(startMs));
  const inMs = Math.max(0, Math.round(options.inMs ?? 0));
  const limit = sourceLimit(asset);
  const duration = Math.max(
    MIN_CLIP_MS,
    Math.min(Math.round(options.durationMs ?? asset.durationMs), limit - inMs),
  );
  const clip: Clip = {
    id: `clip-${randomId().slice(0, 10)}`,
    path,
    startMs: start,
    inMs,
    durationMs: duration,
  };
  const clips = overwriteRange(track.clips, start, start + duration);
  clips.push(clip);
  return replaceClips(doc, track.id, clips);
}

/** Moves a clip, overwriting the destination range. */
export function moveClip(doc: TimelineDoc, clipId: string, toTrackId: string, startMs: number): TimelineDoc {
  const found = findClip(doc, clipId);
  if (!found) return doc;
  const target = doc.tracks.find((track) => track.id === toTrackId);
  if (!target) return doc;
  if (isTrackLocked(doc, found.track.id) || isTrackLocked(doc, target.id)) return doc;
  const asset = doc.assets[found.clip.path];
  if (!asset || target.kind !== trackKindFor(asset.kind)) return doc;

  const start = Math.max(0, Math.round(startMs));
  const withoutSource = doc.tracks.map((track) =>
    track.id === found.track.id
      ? { ...track, clips: track.clips.filter((clip) => clip.id !== clipId) }
      : track,
  );
  const clips = overwriteRange(
    target.clips.filter((clip) => clip.id !== clipId),
    start,
    start + found.clip.durationMs,
  );
  clips.push({ ...found.clip, startMs: start });
  return {
    ...doc,
    tracks: withoutSource.map((track) => (track.id === target.id ? { ...track, clips } : track)),
  };
}

/**
 * Trims one edge of a clip.
 *
 * The start edge shifts the source in point; both edges are clamped by the
 * source length, the neighbours on the track and `MIN_CLIP_MS`.
 */
export function trimClip(doc: TimelineDoc, clipId: string, edge: 'start' | 'end', toMs: number): TimelineDoc {
  const found = findClip(doc, clipId);
  if (!found || isTrackLocked(doc, found.track.id)) return doc;
  const { track, clip } = found;
  const asset = doc.assets[clip.path];
  if (!asset) return doc;
  const others = track.clips.filter((entry) => entry.id !== clipId);

  if (edge === 'start') {
    const leftLimit = Math.max(
      0,
      ...others.filter((entry) => clipEnd(entry) <= clip.startMs).map((entry) => clipEnd(entry)),
    );
    const sourceLimit = clip.startMs - clip.inMs;
    const lowest = Math.max(leftLimit, sourceLimit);
    const highest = clipEnd(clip) - MIN_CLIP_MS;
    const next = Math.min(Math.max(Math.round(toMs), lowest), highest);
    const delta = next - clip.startMs;
    if (delta === 0) return doc;
    const trimmed: Clip = {
      ...clip,
      startMs: next,
      inMs: clip.inMs + delta,
      durationMs: clip.durationMs - delta,
    };
    return replaceClip(doc, track.id, trimmed);
  }

  const rightLimit = Math.min(
    ...others.filter((entry) => entry.startMs >= clip.startMs).map((entry) => entry.startMs),
  );
  const sourceRoom = sourceLimit(asset) - clip.inMs;
  const highest = Math.min(
    Number.isFinite(rightLimit) ? rightLimit : Number.POSITIVE_INFINITY,
    clip.startMs + sourceRoom,
  );
  const next = Math.min(Math.max(Math.round(toMs), clip.startMs + MIN_CLIP_MS), highest);
  const duration = next - clip.startMs;
  if (duration === clip.durationMs) return doc;
  return replaceClip(doc, track.id, { ...clip, durationMs: duration });
}

/** Splits a clip at an absolute timeline position. */
export function splitClip(doc: TimelineDoc, clipId: string, atMs: number): TimelineDoc {
  const found = findClip(doc, clipId);
  if (!found || isTrackLocked(doc, found.track.id)) return doc;
  const { track, clip } = found;
  const offset = Math.round(atMs) - clip.startMs;
  if (offset < MIN_CLIP_MS || clip.durationMs - offset < MIN_CLIP_MS) return doc;

  const left: Clip = { ...clip, durationMs: offset };
  const right: Clip = {
    ...clip,
    id: `clip-${randomId().slice(0, 10)}`,
    startMs: clip.startMs + offset,
    inMs: clip.inMs + offset,
    durationMs: clip.durationMs - offset,
  };
  return replaceClips(
    doc,
    track.id,
    track.clips.flatMap((entry) => (entry.id === clipId ? [left, right] : [entry])),
  );
}

export function removeClip(doc: TimelineDoc, clipId: string): TimelineDoc {
  const found = findClip(doc, clipId);
  if (found && isTrackLocked(doc, found.track.id)) return doc;
  return {
    ...doc,
    tracks: doc.tracks.map((track) => ({
      ...track,
      clips: track.clips.filter((clip) => clip.id !== clipId),
    })),
  };
}

/** Snaps a value to the closest candidate within `thresholdMs`. */
export function snapMs(
  value: number,
  candidates: readonly number[],
  thresholdMs = SNAP_THRESHOLD_MS,
): number {
  let best = value;
  let bestDistance = thresholdMs;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - value);
    if (distance <= bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Positions a drag can snap to: clip edges, extras and (in music mode) beats. */
export function snapCandidates(
  doc: TimelineDoc,
  excludeClipId?: string,
  extras: readonly number[] = [],
): number[] {
  const values = new Set<number>([0, ...extras]);
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.id === excludeClipId) continue;
      values.add(clip.startMs);
      values.add(clipEnd(clip));
    }
  }
  if (doc.mode === 'music') {
    const endMs =
      Math.max(timelineDuration(doc), 0, ...extras.filter((value) => Number.isFinite(value))) + 2000;
    for (const candidate of beatCandidates(doc, 0, endMs, 4)) values.add(candidate);
  }
  return [...values];
}

export function formatTimecode(ms: number, fps: number): string {
  const safeFps = fps > 0 ? fps : DEFAULT_FPS;
  const totalFrames = Math.max(0, Math.round((ms / 1000) * safeFps));
  const frames = totalFrames % safeFps;
  const totalSeconds = Math.floor(totalFrames / safeFps);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}

/** Parses a stored document, dropping anything malformed. */
export function parseTimeline(value: unknown): TimelineDoc {
  const empty = createTimeline();
  if (!isRecord(value)) return empty;

  const assets: Record<string, MediaAsset> = {};
  if (isRecord(value.assets)) {
    for (const [path, asset] of Object.entries(value.assets)) {
      if (!path || !isRecord(asset)) continue;
      if (asset.kind !== 'image' && asset.kind !== 'audio' && asset.kind !== 'video') continue;
      assets[path] = {
        path,
        kind: asset.kind,
        durationMs: finiteNumber(asset.durationMs, 0),
        width: optionalNumber(asset.width),
        height: optionalNumber(asset.height),
        mime: typeof asset.mime === 'string' ? asset.mime : undefined,
      };
    }
  }

  const tracks: Track[] = [];
  if (Array.isArray(value.tracks)) {
    value.tracks.forEach((track, index) => {
      if (!isRecord(track)) return;
      const kind: TrackKind = track.kind === 'audio' ? 'audio' : track.kind === 'note' ? 'note' : 'video';
      const clips: Clip[] = [];
      if (Array.isArray(track.clips)) {
        for (const raw of track.clips) {
          if (!isRecord(raw)) continue;
          if (typeof raw.path !== 'string' || !raw.path) continue;
          const durationMs = finiteNumber(raw.durationMs, 0);
          if (durationMs < MIN_CLIP_MS) continue;
          const clip: Clip = {
            id: typeof raw.id === 'string' && raw.id ? raw.id : `clip-${randomId().slice(0, 10)}`,
            path: raw.path,
            startMs: Math.max(0, finiteNumber(raw.startMs, 0)),
            inMs: Math.max(0, finiteNumber(raw.inMs, 0)),
            durationMs,
          };
          if (isRecord(raw.adjustments)) clip.adjustments = sanitizeAdjustments(raw.adjustments);
          const gain = optionalNumber(raw.gain);
          if (gain !== undefined && gain >= 0) clip.gain = Math.min(2, gain);
          const fadeInMs = optionalNumber(raw.fadeInMs);
          if (fadeInMs !== undefined && fadeInMs >= 0) clip.fadeInMs = fadeInMs;
          const fadeOutMs = optionalNumber(raw.fadeOutMs);
          if (fadeOutMs !== undefined && fadeOutMs >= 0) clip.fadeOutMs = fadeOutMs;
          clips.push(clip);
        }
      }
      tracks.push({
        id: typeof track.id === 'string' && track.id ? track.id : `track-${index}`,
        kind,
        clips,
        muted: track.muted === true,
        soloed: track.soloed === true,
        locked: track.locked === true,
      });
    });
  }

  const adjustments: Record<string, MediaAdjustments> = {};
  if (isRecord(value.adjustments)) {
    for (const [path, entry] of Object.entries(value.adjustments)) {
      if (!path || !isRecord(entry)) continue;
      adjustments[path] = sanitizeAdjustments(entry);
    }
  }

  const fps = finiteNumber(value.fps, DEFAULT_FPS);
  return {
    version: TIMELINE_VERSION,
    fps: fps >= 1 && fps <= 240 ? Math.round(fps) : DEFAULT_FPS,
    tracks,
    assets,
    adjustments,
    // v1 documents have neither field; both get explicit v2 defaults.
    tempo: sanitizeTempo(value.tempo),
    mode: value.mode === 'music' ? 'music' : 'video',
  };
}

// ------------------------------------------------------------
// v2 tempo/mode helpers (all pure)
// ------------------------------------------------------------

/** Length of one beat in milliseconds. */
export function beatDurationMs(tempo?: Tempo): number {
  return 60_000 / sanitizeTempo(tempo).bpm;
}

/** Length of one bar in milliseconds (`numerator * 4 / denominator` beats). */
export function barDurationMs(tempo?: Tempo): number {
  const value = sanitizeTempo(tempo);
  return beatDurationMs(value) * value.numerator * (4 / value.denominator);
}

/** Grid positions on the beat/subdivision lattice within `[fromMs, toMs]`. */
export function beatCandidates(doc: TimelineDoc, fromMs: number, toMs: number, subdivision = 4): number[] {
  const step = beatDurationMs(doc.tempo) / subdivisionSteps(subdivision);
  const start = Math.max(0, finiteNumber(fromMs, 0));
  const end = Math.max(start, finiteNumber(toMs, start));
  const first = Math.ceil(start / step);
  const last = Math.floor(end / step);
  const values: number[] = [];
  for (let index = first; index <= last && values.length < 20_000; index += 1) {
    values.push(Math.round(index * step));
  }
  return values;
}

/** Rounds a timeline position to the nearest beat subdivision (4 = 16ths). */
export function quantizeMs(doc: TimelineDoc, ms: number, subdivision = 4): number {
  const step = beatDurationMs(doc.tempo) / subdivisionSteps(subdivision);
  const position = Math.max(0, finiteNumber(ms, 0));
  return Math.max(0, Math.round(position / step) * step);
}

/** Moves a clip (including notes) onto the nearest beat subdivision. */
export function quantizeClip(doc: TimelineDoc, clipId: string, subdivision = 4): TimelineDoc {
  const found = findClip(doc, clipId);
  if (!found || isTrackLocked(doc, found.track.id)) return doc;
  const start = quantizeMs(doc, found.clip.startMs, subdivision);
  if (start === found.clip.startMs) return doc;
  return replaceClip(doc, found.track.id, { ...found.clip, startMs: start });
}

export function setTempo(doc: TimelineDoc, tempo: Tempo): TimelineDoc {
  return { ...doc, tempo: sanitizeTempo(tempo) };
}

export function setMode(doc: TimelineDoc, mode: TimelineMode): TimelineDoc {
  return { ...doc, mode: mode === 'music' ? 'music' : 'video' };
}

/** Sets a track flag (`false` is stored explicitly so toggles round-trip). */
export function setTrackFlag(
  doc: TimelineDoc,
  trackId: string,
  flag: TrackFlag,
  value: boolean,
): TimelineDoc {
  if (!doc.tracks.some((track) => track.id === trackId)) return doc;
  return {
    ...doc,
    tracks: doc.tracks.map((track) => {
      if (track.id !== trackId) return track;
      const next = { ...track };
      next[flag] = value;
      return next;
    }),
  };
}

/** Locked tracks cannot be moved, trimmed, split or removed by the pure model. */
export function isTrackLocked(doc: TimelineDoc, trackId: string): boolean {
  return doc.tracks.some((track) => track.id === trackId && track.locked === true);
}

/**
 * Whether a track's audio should play: muted tracks are always silent, and a
 * solo anywhere makes non-soloed tracks silent as well.
 */
export function isAudibleTrack(doc: TimelineDoc, trackId: string): boolean {
  const track = doc.tracks.find((entry) => entry.id === trackId);
  if (!track || track.muted === true) return false;
  const hasSolo = doc.tracks.some((entry) => entry.soloed === true);
  return hasSolo ? track.soloed === true : true;
}

/** Stores non-destructive adjustments on one clip, leaving path defaults alone. */
export function setClipAdjustments(doc: TimelineDoc, clipId: string, adj: MediaAdjustments): TimelineDoc {
  const found = findClip(doc, clipId);
  if (!found) return doc;
  const clip = { ...found.clip };
  const sanitized = sanitizeAdjustments(adj);
  if (isDefaultAdjustments(sanitized)) delete clip.adjustments;
  else clip.adjustments = sanitized;
  return replaceClip(doc, found.track.id, clip);
}

/** Updates one or more per-clip audio parameters without touching the others. */
export function setClipAudio(doc: TimelineDoc, clipId: string, patch: ClipAudio): TimelineDoc {
  const found = findClip(doc, clipId);
  if (!found) return doc;
  const clip = { ...found.clip };
  if (patch.gain !== undefined && Number.isFinite(patch.gain)) {
    clip.gain = Math.min(2, Math.max(0, patch.gain));
  }
  if (patch.fadeInMs !== undefined && Number.isFinite(patch.fadeInMs)) {
    clip.fadeInMs = Math.max(0, patch.fadeInMs);
  }
  if (patch.fadeOutMs !== undefined && Number.isFinite(patch.fadeOutMs)) {
    clip.fadeOutMs = Math.max(0, patch.fadeOutMs);
  }
  return replaceClip(doc, found.track.id, clip);
}

/** Stores the preview adjustments for a source, dropping no-op defaults. */
export function setAdjustments(doc: TimelineDoc, path: string, adjustments: MediaAdjustments): TimelineDoc {
  const next = { ...doc.adjustments };
  if (isDefaultAdjustments(adjustments)) delete next[path];
  else next[path] = adjustments;
  return { ...doc, adjustments: next };
}

export function serializeTimeline(doc: TimelineDoc): string {
  return JSON.stringify(doc, null, 2);
}

/** Video/audio clips are bounded by the source; images can be stretched. */
function sourceLimit(asset: MediaAsset): number {
  return asset.kind === 'image' ? Number.POSITIVE_INFINITY : Math.max(asset.durationMs, MIN_CLIP_MS);
}

function replaceClip(doc: TimelineDoc, trackId: string, clip: Clip): TimelineDoc {
  return replaceClips(
    doc,
    trackId,
    (doc.tracks.find((track) => track.id === trackId)?.clips ?? []).map((entry) =>
      entry.id === clip.id ? clip : entry,
    ),
  );
}

function replaceClips(doc: TimelineDoc, trackId: string, clips: Clip[]): TimelineDoc {
  return {
    ...doc,
    tracks: doc.tracks.map((track) => (track.id === trackId ? { ...track, clips } : track)),
  };
}

/** Cuts `[start, end)` out of every clip, splitting clips that straddle it. */
function overwriteRange(clips: Clip[], start: number, end: number): Clip[] {
  const result: Clip[] = [];
  for (const clip of clips) {
    const from = clip.startMs;
    const to = clipEnd(clip);
    if (to <= start || from >= end) {
      result.push(clip);
      continue;
    }
    if (from < start) {
      result.push({ ...clip, id: `${clip.id}~l${start}`, durationMs: start - from });
    }
    if (to > end) {
      const skipped = Math.max(0, end - from);
      result.push({
        ...clip,
        id: `${clip.id}~r${end}`,
        startMs: end,
        inMs: clip.inMs + skipped,
        durationMs: to - end,
      });
    }
  }
  return result;
}

function subdivisionSteps(subdivision: number): number {
  return Math.max(1, Math.round(finiteNumber(subdivision, 4)));
}

function sanitizeTempo(value: unknown): Tempo {
  const record = isRecord(value) ? value : {};
  const clamp = (input: unknown, fallback: number, min: number, max: number) => {
    const number = finiteNumber(input, fallback);
    if (number < min || number > max) return fallback;
    return number;
  };
  return {
    bpm: clamp(record.bpm, DEFAULT_TEMPO.bpm, 1, 1000),
    numerator: Math.round(clamp(record.numerator, DEFAULT_TEMPO.numerator, 1, 32)),
    denominator: Math.round(clamp(record.denominator, DEFAULT_TEMPO.denominator, 1, 32)),
  };
}

function isDefaultAdjustments(adjustments: MediaAdjustments): boolean {
  return (
    adjustments.brightness === DEFAULT_MEDIA_ADJUSTMENTS.brightness &&
    adjustments.contrast === DEFAULT_MEDIA_ADJUSTMENTS.contrast &&
    adjustments.saturation === DEFAULT_MEDIA_ADJUSTMENTS.saturation &&
    adjustments.rotate === 0 &&
    !adjustments.flip
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

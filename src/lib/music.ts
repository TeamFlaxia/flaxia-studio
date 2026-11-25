/**
 * Note data model for the music track.
 *
 * Deliberately independent of `lib/timeline.ts`: the timeline stores a note
 * track as a clip, while this module owns the notes inside that clip and the
 * musical helpers used by the piano roll. All operations are pure and return a
 * new clip; invalid input is clamped or ignored rather than throwing.
 *
 * Time is measured in integer ticks (480 ticks = one quarter note). Pitch is a
 * MIDI note number (0..127, C4 = 60) and velocity is 0..127.
 */

export const TICKS_PER_BEAT = 480;
/** A note can never be shorter than this (a 1/8 beat at 480 ticks/beat). */
export const MIN_NOTE_TICKS = 60;

export interface Note {
  id: string;
  /** MIDI note number, 0..127. */
  pitch: number;
  startTick: number;
  durationTick: number;
  velocity: number;
}

export interface NoteClip {
  id: string;
  notes: Note[];
}

/** Semitone offsets from the root note. */
export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  pentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  blues: [0, 3, 5, 6, 7, 10],
} as const;

export type ScaleName = keyof typeof SCALES;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
const DEFAULT_VELOCITY = 100;

/** Scientific pitch name with sharps; C4 is MIDI 60. */
export function noteName(pitch: number): string {
  const safe = clampPitch(pitch);
  return `${NOTE_NAMES[safe % 12]}${Math.floor(safe / 12) - 1}`;
}

/** Whether the pitch class is a black key on a piano. */
export function isBlackKey(pitch: number): boolean {
  return BLACK_KEYS.has(clampPitch(pitch) % 12);
}

/**
 * Rounds a tick to the nearest grid position. `subdivision` is the note value
 * denominator: 4 = quarter note (480 ticks), 8 = eighth (240), 16 = sixteenth
 * (120). Out-of-range values fall back to a quarter note.
 */
export function quantizeTick(tick: number, subdivision = 4): number {
  const value = normalizedTick(tick);
  const denominator = Number.isFinite(subdivision) ? Math.min(64, Math.max(1, Math.round(subdivision))) : 4;
  const step = (TICKS_PER_BEAT * 4) / denominator;
  return Math.round(Math.round(value / step) * step);
}

/** Notes whose sounding range intersects `[fromTick, toTick)`. Reversed bounds are swapped. */
export function notesInRange(notes: readonly Note[], fromTick: number, toTick: number): Note[] {
  const from = normalizedTick(fromTick);
  const to = normalizedTick(toTick);
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  return notes.filter((note) => note.startTick < high && note.startTick + note.durationTick > low);
}

/** An empty note clip. */
export function createNoteClip(id = 'clip-1'): NoteClip {
  return { id, notes: [] };
}

/**
 * Appends a note. Overlaps are allowed (polyphony), but a duplicate id is a
 * no-op so an edit never silently replaces a different note.
 */
export function addNote(clip: NoteClip, note: Note): NoteClip {
  if (!note || typeof note.id !== 'string' || !note.id) return clip;
  if (clip.notes.some((entry) => entry.id === note.id)) return clip;
  return { ...clip, notes: [...clip.notes, clampNote(note)] };
}

/** Removes a note by id. Missing ids are a no-op. */
export function removeNote(clip: NoteClip, id: string): NoteClip {
  if (!clip.notes.some((note) => note.id === id)) return clip;
  return { ...clip, notes: clip.notes.filter((note) => note.id !== id) };
}

/** Moves a note in time and, optionally, to another pitch. */
export function moveNote(clip: NoteClip, id: string, startTick: number, pitch?: number): NoteClip {
  const nextStart = normalizedTick(startTick);
  const nextPitch = pitch === undefined ? undefined : clampPitch(pitch);
  let found = false;
  const notes = clip.notes.map((note) => {
    if (note.id !== id) return note;
    found = true;
    if (note.startTick === nextStart && (nextPitch === undefined || note.pitch === nextPitch)) return note;
    return { ...note, startTick: nextStart, pitch: nextPitch ?? note.pitch };
  });
  return found ? { ...clip, notes } : clip;
}

/** Changes a note's length, keeping its start position. */
export function resizeNote(clip: NoteClip, id: string, durationTick: number): NoteClip {
  const duration = Math.max(MIN_NOTE_TICKS, normalizedTick(durationTick));
  let found = false;
  const notes = clip.notes.map((note) => {
    if (note.id !== id) return note;
    found = true;
    return note.durationTick === duration ? note : { ...note, durationTick: duration };
  });
  return found ? { ...clip, notes } : clip;
}

/** Orders notes by start tick, then pitch, then id (never mutates the input array). */
export function sortNotes(clip: NoteClip): NoteClip {
  const notes = [...clip.notes].sort(
    (left, right) =>
      left.startTick - right.startTick || left.pitch - right.pitch || left.id.localeCompare(right.id),
  );
  return { ...clip, notes };
}

/**
 * Snaps every pitch to the closest degree of `scale`, relative to `rootPitch`.
 * Ties prefer the lower degree; results stay inside 0..127. Degrees are
 * interpreted as semitone offsets from the root and wrapped into one octave.
 */
export function scaleNotes(clip: NoteClip, rootPitch: number, scale: readonly number[]): NoteClip {
  const root = clampPitch(rootPitch);
  const degrees = [
    ...new Set(
      scale.filter((value) => Number.isFinite(value)).map((value) => ((Math.round(value) % 12) + 12) % 12),
    ),
  ].sort((left, right) => left - right);
  if (degrees.length === 0) return clip;

  const candidates: number[] = [];
  for (let octave = -12; octave <= 12; octave += 1) {
    for (const degree of degrees) {
      const pitch = root + octave * 12 + degree;
      if (pitch >= 0 && pitch <= 127) candidates.push(pitch);
    }
  }

  let changed = false;
  const notes = clip.notes.map((note) => {
    const pitch = clampPitch(note.pitch);
    let best = pitch;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const distance = Math.abs(candidate - pitch);
      if (distance < bestDistance || (distance === bestDistance && candidate < best)) {
        best = candidate;
        bestDistance = distance;
      }
    }
    if (best === note.pitch) return note;
    changed = true;
    return { ...note, pitch: best };
  });
  return changed ? { ...clip, notes } : clip;
}

/** Equal-temperament frequency in Hz; A4 (MIDI 69) is exactly 440 Hz. */
export function noteToFrequency(pitch: number): number {
  return 440 * 2 ** ((clampPitch(pitch) - 69) / 12);
}

function normalizedTick(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function clampPitch(value: number): number {
  if (!Number.isFinite(value)) return 60;
  return Math.min(127, Math.max(0, Math.round(value)));
}

function clampVelocity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VELOCITY;
  return Math.min(127, Math.max(0, Math.round(value)));
}

function clampNote(note: Note): Note {
  return {
    id: note.id,
    pitch: clampPitch(note.pitch),
    startTick: normalizedTick(note.startTick),
    durationTick: Math.max(MIN_NOTE_TICKS, normalizedTick(note.durationTick)),
    velocity: clampVelocity(note.velocity),
  };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addNote,
  createNoteClip,
  isBlackKey,
  MIN_NOTE_TICKS,
  moveNote,
  type Note,
  noteName,
  notesInRange,
  noteToFrequency,
  quantizeTick,
  removeNote,
  resizeNote,
  SCALES,
  scaleNotes,
  sortNotes,
  TICKS_PER_BEAT,
} from '../src/lib/music.ts';

function note(
  id: string,
  pitch: number,
  startTick: number,
  durationTick = TICKS_PER_BEAT,
  velocity = 100,
): Note {
  return { id, pitch, startTick, durationTick, velocity };
}

test('noteName uses scientific pitch names with C4 = 60', () => {
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(61), 'C#4');
  assert.equal(noteName(69), 'A4');
  assert.equal(noteName(72), 'C5');
  assert.equal(noteName(0), 'C-1');
  assert.equal(noteName(127), 'G9');
});

test('isBlackKey follows the piano key pattern', () => {
  assert.equal(isBlackKey(60), false);
  assert.equal(isBlackKey(61), true);
  assert.equal(isBlackKey(63), true);
  assert.equal(isBlackKey(64), false);
  assert.equal(isBlackKey(69), false);
  assert.equal(isBlackKey(70), true);
});

test('quantizeTick snaps to quarter, eighth and sixteenth grids', () => {
  assert.equal(TICKS_PER_BEAT, 480);
  assert.equal(quantizeTick(100, 4), 0);
  assert.equal(quantizeTick(300, 4), 480);
  assert.equal(quantizeTick(1000), 960);
  assert.equal(quantizeTick(300, 8), 240);
  assert.equal(quantizeTick(100, 16), 120);
  assert.equal(quantizeTick(280, 16), 240);
  assert.equal(quantizeTick(300, 16), 360);
  assert.equal(quantizeTick(-50, 16), 0);
});

test('noteToFrequency is 440 Hz for A4 and clamps out-of-range pitches', () => {
  assert.equal(noteToFrequency(69), 440);
  assert.equal(noteToFrequency(81), 880);
  assert.ok(Math.abs(noteToFrequency(60) - 261.6255653) < 1e-6);
  assert.equal(noteToFrequency(200), noteToFrequency(127));
});

test('addNote appends a clamped note and keeps the original clip untouched', () => {
  const clip = createNoteClip('c1');
  const added = addNote(clip, note('n1', 61, 480, 240, 90));
  assert.notEqual(added, clip);
  assert.deepEqual(clip.notes, []);
  assert.deepEqual(added.notes, [note('n1', 61, 480, 240, 90)]);

  const bad = addNote(clip, { id: 'bad', pitch: 999, startTick: -100, durationTick: 0, velocity: 999 });
  assert.deepEqual(bad.notes, [note('bad', 127, 0, MIN_NOTE_TICKS, 127)]);
  const nan = addNote(clip, {
    id: 'nan',
    pitch: Number.NaN,
    startTick: Number.NaN,
    durationTick: Number.NaN,
    velocity: Number.NaN,
  });
  assert.deepEqual(nan.notes, [note('nan', 60, 0, MIN_NOTE_TICKS, 100)]);

  // Duplicate ids and missing ids are safe no-ops.
  assert.equal(addNote(added, note('n1', 64, 0)), added);
  assert.equal(addNote(added, { ...note('n2', 64, 0), id: '' }), added);
  // Polyphony: overlapping notes are kept.
  assert.equal(addNote(added, note('n2', 62, 500, 240)).notes.length, 2);
});

test('removeNote removes by id without mutating the source', () => {
  const clip = addNote(createNoteClip(), note('n1', 60, 0));
  const removed = removeNote(clip, 'n1');
  assert.notEqual(removed, clip);
  assert.equal(removed.notes.length, 0);
  assert.equal(clip.notes.length, 1);
  assert.equal(removeNote(clip, 'missing'), clip);
});

test('moveNote moves in time and optionally retunes, clamping invalid input', () => {
  const clip = addNote(createNoteClip(), note('n1', 61, 480, 240));
  const moved = moveNote(clip, 'n1', 960, 64);
  assert.deepEqual(moved.notes, [note('n1', 64, 960, 240)]);
  assert.deepEqual(clip.notes, [note('n1', 61, 480, 240)]);

  const clamped = moveNote(clip, 'n1', -40, 500);
  assert.deepEqual(clamped.notes, [note('n1', 127, 0, 240)]);
  assert.equal(moveNote(clip, 'missing', 0), clip);
});

test('resizeNote enforces the minimum length and stays immutable', () => {
  const clip = addNote(createNoteClip(), note('n1', 60, 480, 240));
  const resized = resizeNote(clip, 'n1', 120);
  assert.equal(resized.notes[0]?.durationTick, 120);
  assert.equal(clip.notes[0]?.durationTick, 240);
  assert.equal(resizeNote(clip, 'n1', 1).notes[0]?.durationTick, MIN_NOTE_TICKS);
  assert.equal(resizeNote(clip, 'missing', 120), clip);
});

test('sortNotes orders by start, then pitch, then id', () => {
  const clip = {
    id: 'c',
    notes: [note('d', 60, 960), note('c', 72, 480), note('b', 60, 480), note('a', 60, 480)],
  };
  const sorted = sortNotes(clip);
  assert.deepEqual(
    sorted.notes.map((entry) => entry.id),
    ['a', 'b', 'c', 'd'],
  );
  assert.deepEqual(
    clip.notes.map((entry) => entry.id),
    ['d', 'c', 'b', 'a'],
  );
  assert.equal(sorted.notes.length, clip.notes.length);
});

test('notesInRange uses half-open bounds, handles overlaps and reversed ranges', () => {
  const clip = {
    id: 'c',
    notes: [note('a', 60, 0, 480), note('b', 64, 480, 480), note('c', 67, 960, 240)],
  };
  assert.deepEqual(
    notesInRange(clip.notes, 480, 960).map((entry) => entry.id),
    ['b'],
  );
  assert.deepEqual(
    notesInRange(clip.notes, 479, 481).map((entry) => entry.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    notesInRange(clip.notes, 960, 480).map((entry) => entry.id),
    ['b'],
  );
  assert.deepEqual(notesInRange(clip.notes, 5000, 6000), []);
});

test('scaleNotes snaps out-of-scale pitches to the nearest scale degree', () => {
  let clip = createNoteClip();
  for (const [index, pitch] of [60, 62, 63, 61, 64, 68, 200, -10].entries()) {
    clip = addNote(clip, note(`n${index}`, pitch, index * TICKS_PER_BEAT));
  }
  const scaled = scaleNotes(clip, 60, SCALES.major);
  assert.deepEqual(
    scaled.notes.map((entry) => entry.pitch),
    [60, 62, 62, 60, 64, 67, 127, 0],
  );
  // addNote clamps pitches first, so the source clip holds 0..127 values.
  assert.deepEqual(
    clip.notes.map((entry) => entry.pitch),
    [60, 62, 63, 61, 64, 68, 127, 0],
  );
  assert.equal(scaled.notes[0]?.startTick, clip.notes[0]?.startTick);
  assert.equal(scaled.notes[0]?.velocity, clip.notes[0]?.velocity);
});

test('scaleNotes supports other scale shapes and is a no-op for an empty scale', () => {
  const clip = addNote(addNote(createNoteClip(), note('a', 61, 0)), note('b', 64, 480));
  const scaled = scaleNotes(clip, 60, SCALES.minorPentatonic);
  assert.deepEqual(
    scaled.notes.map((entry) => entry.pitch),
    [60, 63],
  );
  assert.equal(scaleNotes(clip, 60, []), clip);
  assert.deepEqual(SCALES.major, [0, 2, 4, 5, 7, 9, 11]);
  assert.equal(SCALES.dorian.length, 7);
  assert.equal(SCALES.pentatonic.length, 5);
});

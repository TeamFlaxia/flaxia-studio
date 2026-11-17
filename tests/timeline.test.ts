import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addClip,
  addTrack,
  clipEnd,
  createTimeline,
  DEFAULT_FPS,
  findClip,
  formatTimecode,
  MIN_CLIP_MS,
  moveClip,
  parseTimeline,
  registerAsset,
  removeClip,
  serializeTimeline,
  snapMs,
  splitClip,
  timelineDuration,
  trackEnd,
  trimClip,
} from '../src/lib/timeline.ts';

function docWithTracks() {
  let doc = createTimeline();
  doc = registerAsset(doc, { path: 'a.mp4', kind: 'video', durationMs: 10_000, width: 1920, height: 1080 });
  doc = registerAsset(doc, { path: 'b.mp3', kind: 'audio', durationMs: 8_000 });
  doc = registerAsset(doc, { path: 'c.png', kind: 'image', durationMs: 5_000 });
  doc = addTrack(doc, 'video');
  doc = addTrack(doc, 'audio');
  return doc;
}

function videoTrack(doc: ReturnType<typeof docWithTracks>) {
  const track = doc.tracks.find((entry) => entry.kind === 'video');
  assert.ok(track);
  return track;
}

function audioTrack(doc: ReturnType<typeof docWithTracks>) {
  const track = doc.tracks.find((entry) => entry.kind === 'audio');
  assert.ok(track);
  return track;
}

test('a fresh timeline is empty', () => {
  const doc = createTimeline();
  assert.equal(doc.fps, DEFAULT_FPS);
  assert.deepEqual(doc.tracks, []);
  assert.equal(timelineDuration(doc), 0);
});

test('adding a clip uses the asset length and rejects a mismatched track', () => {
  let doc = docWithTracks();
  doc = addClip(doc, videoTrack(doc).id, 'a.mp4', 1200);
  const clip = videoTrack(doc).clips[0];
  assert.ok(clip);
  assert.equal(clip.startMs, 1200);
  assert.equal(clip.durationMs, 10_000);
  assert.equal(trackEnd(videoTrack(doc)), 11_200);

  const unchanged = addClip(doc, audioTrack(doc).id, 'a.mp4', 0);
  assert.equal(audioTrack(unchanged).clips.length, 0);

  assert.throws(() => addClip(doc, videoTrack(doc).id, 'missing.mp4', 0), /Unknown media asset/);
});

test('clips never start before zero', () => {
  let doc = docWithTracks();
  doc = addClip(doc, videoTrack(doc).id, 'a.mp4', -5000, { durationMs: 4000 });
  const clip = videoTrack(doc).clips[0];
  assert.ok(clip);
  assert.equal(clip.startMs, 0);
});

test('adding over a clip overwrites it and splits it in two', () => {
  let doc = docWithTracks();
  const track = videoTrack(doc).id;
  doc = addClip(doc, track, 'a.mp4', 0, { durationMs: 10_000 });
  doc = addClip(doc, track, 'c.png', 3000, { durationMs: 2000 });

  const clips = [...videoTrack(doc).clips].sort((left, right) => left.startMs - right.startMs);
  assert.equal(clips.length, 3);
  assert.deepEqual(
    clips.map((clip) => [clip.startMs, clip.durationMs, clip.path]),
    [
      [0, 3000, 'a.mp4'],
      [3000, 2000, 'c.png'],
      [5000, 5000, 'a.mp4'],
    ],
  );
  // The right remainder keeps the source in point in sync.
  assert.equal(clips[2]?.inMs, 5000);
});

test('moving a clip keeps its length and overwrites the destination', () => {
  let doc = docWithTracks();
  const track = videoTrack(doc).id;
  doc = addClip(doc, track, 'a.mp4', 0, { durationMs: 4000 });
  doc = addClip(doc, track, 'c.png', 6000, { durationMs: 3000 });
  const moving = videoTrack(doc).clips.find((clip) => clip.path === 'c.png');
  assert.ok(moving);

  doc = moveClip(doc, moving.id, track, 2000);
  const clips = videoTrack(doc).clips;
  const moved = clips.find((clip) => clip.id === moving.id);
  assert.ok(moved);
  assert.equal(moved.startMs, 2000);
  assert.equal(moved.durationMs, 3000);
  // The video clip was cut where the image now sits.
  const video = clips.find((clip) => clip.path === 'a.mp4');
  assert.ok(video);
  assert.equal(clipEnd(video), 2000);

  // Wrong track kind: no-op.
  const before = doc;
  doc = moveClip(doc, moving.id, audioTrack(doc).id, 0);
  assert.equal(doc, before);
});

test('trim clamps to the source, neighbours and the minimum length', () => {
  let doc = docWithTracks();
  const track = videoTrack(doc).id;
  doc = addClip(doc, track, 'a.mp4', 1000, { durationMs: 5000, inMs: 2000 });
  doc = addClip(doc, track, 'c.png', 8000, { durationMs: 2000 });
  const first = videoTrack(doc).clips.find((clip) => clip.path === 'a.mp4');
  assert.ok(first);

  // Extending the start consumes the 2s of headroom before the in point.
  doc = trimClip(doc, first.id, 'start', 0);
  let clip = findClip(doc, first.id)?.clip;
  assert.ok(clip);
  assert.equal(clip.startMs, 0);
  assert.equal(clip.inMs, 1000);
  assert.equal(clip.durationMs, 6000);

  // The right edge stops at the neighbour (the image starts at 8000ms).
  doc = trimClip(doc, first.id, 'end', 20_000);
  clip = findClip(doc, first.id)?.clip;
  assert.ok(clip);
  assert.equal(clipEnd(clip), 8000);

  // Shrinking keeps at least MIN_CLIP_MS.
  doc = trimClip(doc, first.id, 'end', clip.startMs);
  clip = findClip(doc, first.id)?.clip;
  assert.ok(clip);
  assert.equal(clip.durationMs, MIN_CLIP_MS);
});

test('the start edge stops where the source begins', () => {
  let doc = docWithTracks();
  const track = videoTrack(doc).id;
  doc = addClip(doc, track, 'a.mp4', 5000, { durationMs: 2000, inMs: 1000 });
  const clip = videoTrack(doc).clips[0];
  assert.ok(clip);

  // 1000ms of in point means the clip can only move back to 4000ms.
  doc = trimClip(doc, clip.id, 'start', 0);
  const trimmed = findClip(doc, clip.id)?.clip;
  assert.ok(trimmed);
  assert.equal(trimmed.startMs, 4000);
  assert.equal(trimmed.inMs, 0);
  assert.equal(trimmed.durationMs, 3000);
});

test('images can be stretched past their default still length', () => {
  let doc = docWithTracks();
  const track = videoTrack(doc).id;
  doc = addClip(doc, track, 'c.png', 0, { durationMs: 5000 });
  const clip = videoTrack(doc).clips[0];
  assert.ok(clip);
  doc = trimClip(doc, clip.id, 'end', 40_000);
  const stretched = findClip(doc, clip.id)?.clip;
  assert.ok(stretched);
  assert.equal(stretched.durationMs, 40_000);
});

test('splitting needs room on both sides', () => {
  let doc = docWithTracks();
  const track = videoTrack(doc).id;
  doc = addClip(doc, track, 'a.mp4', 0, { durationMs: 8000 });
  const clip = videoTrack(doc).clips[0];
  assert.ok(clip);

  doc = splitClip(doc, clip.id, 3000);
  const clips = [...videoTrack(doc).clips].sort((left, right) => left.startMs - right.startMs);
  assert.equal(clips.length, 2);
  assert.deepEqual(
    clips.map((entry) => [entry.startMs, entry.inMs, entry.durationMs]),
    [
      [0, 0, 3000],
      [3000, 3000, 5000],
    ],
  );

  const before = doc;
  doc = splitClip(doc, clip.id, 9000);
  assert.equal(doc, before);
});

test('removing a clip leaves the rest intact', () => {
  let doc = docWithTracks();
  const track = videoTrack(doc).id;
  doc = addClip(doc, track, 'a.mp4', 0, { durationMs: 3000 });
  doc = addClip(doc, track, 'c.png', 4000, { durationMs: 2000 });
  const target = videoTrack(doc).clips.find((clip) => clip.path === 'c.png');
  assert.ok(target);
  doc = removeClip(doc, target.id);
  assert.equal(videoTrack(doc).clips.length, 1);
  assert.equal(timelineDuration(doc), 3000);
});

test('snapping picks the closest candidate inside the threshold', () => {
  assert.equal(snapMs(1030, [0, 1000, 2000]), 1000);
  assert.equal(snapMs(1300, [0, 1000], 80), 1300);
  assert.equal(snapMs(5, [0], 10), 0);
});

test('timecodes render as hh:mm:ss:ff', () => {
  assert.equal(formatTimecode(0, 30), '00:00:00:00');
  assert.equal(formatTimecode(1000, 30), '00:00:01:00');
  assert.equal(formatTimecode(1500, 30), '00:00:01:15');
  assert.equal(formatTimecode(3_600_000, 30), '01:00:00:00');
});

test('the document round-trips through JSON and drops garbage', () => {
  let doc = docWithTracks();
  doc = addClip(doc, videoTrack(doc).id, 'a.mp4', 500, { durationMs: 4000 });
  doc = addClip(doc, audioTrack(doc).id, 'b.mp3', 0, { durationMs: 8000 });

  const restored = parseTimeline(JSON.parse(serializeTimeline(doc)));
  assert.equal(restored.version, doc.version);
  assert.equal(restored.fps, doc.fps);
  assert.equal(restored.tracks.length, 2);
  assert.equal(restored.assets['a.mp4']?.durationMs, 10_000);
  assert.deepEqual(
    restored.tracks.map((track) => [track.kind, track.clips.length]),
    [
      ['video', 1],
      ['audio', 1],
    ],
  );

  assert.deepEqual(parseTimeline(null).tracks, []);
  assert.deepEqual(parseTimeline('nope').tracks, []);
  const messy = parseTimeline({
    fps: 999,
    tracks: [
      {
        kind: 'video',
        clips: [
          { path: '', durationMs: 5000 },
          { path: 'x.mp4', durationMs: 1 },
        ],
      },
    ],
    assets: { 'x.mp4': { kind: 'video', durationMs: 5000 }, bad: { kind: 'nope' } },
  });
  assert.equal(messy.fps, DEFAULT_FPS);
  assert.equal(messy.tracks.length, 1);
  assert.equal(messy.tracks[0]?.clips.length, 0);
  assert.equal(Object.keys(messy.assets).length, 1);
});

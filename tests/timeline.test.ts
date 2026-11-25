import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MEDIA_ADJUSTMENTS, type MediaAdjustments } from '../src/lib/media.ts';
import {
  addClip,
  addTrack,
  barDurationMs,
  beatCandidates,
  beatDurationMs,
  type Clip,
  clipEnd,
  createTimeline,
  DEFAULT_FPS,
  DEFAULT_TEMPO,
  findClip,
  formatTimecode,
  isAudibleTrack,
  isTrackLocked,
  MIN_CLIP_MS,
  moveClip,
  parseTimeline,
  quantizeClip,
  quantizeMs,
  registerAsset,
  removeClip,
  serializeTimeline,
  setAdjustments,
  setClipAdjustments,
  setClipAudio,
  setMode,
  setTempo,
  setTrackFlag,
  snapCandidates,
  snapMs,
  splitClip,
  type TimelineDoc,
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

test('adjustments round-trip through JSON and default values are dropped', () => {
  let doc = docWithTracks();
  doc = setAdjustments(doc, 'a.mp4', {
    brightness: 120,
    contrast: 90,
    saturation: 140,
    rotate: 90,
    flip: true,
  });
  assert.deepEqual(doc.adjustments['a.mp4'], {
    brightness: 120,
    contrast: 90,
    saturation: 140,
    rotate: 90,
    flip: true,
  });

  const restored = parseTimeline(JSON.parse(serializeTimeline(doc)));
  assert.deepEqual(restored.adjustments['a.mp4'], doc.adjustments['a.mp4']);

  doc = setAdjustments(doc, 'a.mp4', {
    brightness: 100,
    contrast: 100,
    saturation: 100,
    rotate: 0,
    flip: false,
  });
  assert.equal(doc.adjustments['a.mp4'], undefined);
});

test('parseTimeline sanitizes out-of-range adjustments', () => {
  const restored = parseTimeline({
    adjustments: {
      'a.mp4': { brightness: 900, contrast: -10, saturation: 50, rotate: 45, flip: true },
    },
  });
  const adjustments = restored.adjustments['a.mp4'];
  assert.ok(adjustments);
  assert.equal(adjustments.brightness, 200);
  assert.equal(adjustments.contrast, 0);
  assert.equal(adjustments.saturation, 50);
  assert.equal(adjustments.rotate, 0);
  assert.equal(adjustments.flip, true);
});

function clipById(doc: TimelineDoc, id: string): Clip {
  const clip = findClip(doc, id)?.clip;
  assert.ok(clip);
  return clip;
}

test('v1 documents migrate to v2 with default tempo and mode', () => {
  const legacy = {
    version: 1,
    fps: 25,
    tracks: [
      {
        id: 'track-a',
        kind: 'video',
        clips: [{ id: 'clip-a', path: 'a.mp4', startMs: 500, inMs: 0, durationMs: 4000 }],
      },
    ],
    assets: { 'a.mp4': { kind: 'video', durationMs: 10_000 } },
    adjustments: {},
  };
  const doc = parseTimeline(legacy);
  assert.equal(doc.version, 2);
  assert.equal(doc.fps, 25);
  assert.equal(doc.mode, 'video');
  assert.deepEqual(doc.tempo, DEFAULT_TEMPO);
  assert.equal(doc.tracks[0]?.clips[0]?.startMs, 500);
  assert.equal(JSON.parse(serializeTimeline(doc)).version, 2);

  const noteDoc = parseTimeline({ tracks: [{ kind: 'note', clips: [] }], mode: 'music' });
  assert.equal(noteDoc.version, 2);
  assert.equal(noteDoc.mode, 'music');
  assert.equal(noteDoc.tracks[0]?.kind, 'note');
});

test('beat/bar math, beat candidates and quantize use the document tempo', () => {
  const doc = createTimeline();
  assert.equal(beatDurationMs(doc.tempo), 500);
  assert.equal(barDurationMs(doc.tempo), 2000);

  assert.deepEqual(beatCandidates(doc, 400, 1100, 1), [500, 1000]);
  assert.deepEqual(beatCandidates(doc, 400, 1100, 4), [500, 625, 750, 875, 1000]);
  assert.deepEqual(beatCandidates(doc, 0, 0, 4), [0]);
  assert.equal(quantizeMs(doc, 1120, 1), 1000);
  assert.equal(quantizeMs(doc, 1300, 1), 1500);
  assert.equal(quantizeMs(doc, 1120), 1125);

  const waltz = setTempo(doc, { bpm: 120, numerator: 3, denominator: 4 });
  assert.equal(beatDurationMs(waltz.tempo), 500);
  assert.equal(barDurationMs(waltz.tempo), 1500);
  assert.deepEqual(beatCandidates(waltz, 0, 1500, 1), [0, 500, 1000, 1500]);

  const music = setMode(doc, 'music');
  const snapTargets = snapCandidates(music);
  assert.ok(snapTargets.includes(0));
  assert.ok(snapTargets.includes(500));
  assert.ok(snapTargets.includes(1000));
  assert.ok(snapTargets.includes(125));
  assert.deepEqual(snapCandidates(doc), [0]);

  // Bad values fall back to safe musical defaults.
  const broken = setTempo(doc, { bpm: 0, numerator: 0, denominator: 0 });
  assert.equal(beatDurationMs(broken.tempo), beatDurationMs(DEFAULT_TEMPO));
});

test('clip adjustments coexist with adjustments stored per source path', () => {
  const pathAdjustments: MediaAdjustments = { ...DEFAULT_MEDIA_ADJUSTMENTS, brightness: 150 };
  const clipAdjustments: MediaAdjustments = {
    brightness: 130,
    contrast: 110,
    saturation: 90,
    rotate: 90,
    flip: true,
  };
  let doc = setAdjustments(docWithTracks(), 'a.mp4', pathAdjustments);
  doc = addClip(doc, videoTrack(doc).id, 'a.mp4', 500, { durationMs: 4000 });
  const id = videoTrack(doc).clips[0]?.id;
  assert.ok(id);
  doc = setClipAdjustments(doc, id, clipAdjustments);

  assert.deepEqual(doc.adjustments['a.mp4'], pathAdjustments);
  assert.deepEqual(clipById(doc, id).adjustments, clipAdjustments);

  const restored = parseTimeline(JSON.parse(serializeTimeline(doc)));
  assert.deepEqual(restored.adjustments['a.mp4'], pathAdjustments);
  assert.deepEqual(clipById(restored, id).adjustments, clipAdjustments);

  doc = setClipAdjustments(doc, id, DEFAULT_MEDIA_ADJUSTMENTS);
  assert.equal(clipById(doc, id).adjustments, undefined);
  assert.deepEqual(doc.adjustments['a.mp4'], pathAdjustments);
});

test('track flags control audibility and a solo makes other tracks silent', () => {
  let doc = docWithTracks();
  const videoId = videoTrack(doc).id;
  const audioId = audioTrack(doc).id;
  assert.equal(isAudibleTrack(doc, videoId), true);
  assert.equal(isAudibleTrack(doc, 'missing'), false);

  doc = setTrackFlag(doc, videoId, 'muted', true);
  assert.equal(videoTrack(doc).muted, true);
  assert.equal(isAudibleTrack(doc, videoId), false);
  doc = setTrackFlag(doc, videoId, 'muted', false);
  assert.equal(videoTrack(doc).muted, false);
  assert.equal(isAudibleTrack(doc, videoId), true);

  doc = setTrackFlag(doc, audioId, 'soloed', true);
  assert.equal(isAudibleTrack(doc, videoId), false);
  assert.equal(isAudibleTrack(doc, audioId), true);
  doc = setTrackFlag(doc, videoId, 'soloed', true);
  assert.equal(isAudibleTrack(doc, videoId), true);
  doc = setTrackFlag(doc, audioId, 'muted', true);
  assert.equal(isAudibleTrack(doc, audioId), false);
  doc = setTrackFlag(doc, audioId, 'soloed', false);
  doc = setTrackFlag(doc, audioId, 'muted', false);
  assert.equal(isAudibleTrack(doc, videoId), true);

  const restored = parseTimeline(JSON.parse(serializeTimeline(doc)));
  assert.equal(videoTrack(restored).soloed, true);
  assert.equal(audioTrack(restored).muted, false);
});

test('per-clip gain and fades round-trip through JSON', () => {
  let doc = docWithTracks();
  doc = addClip(doc, videoTrack(doc).id, 'a.mp4', 0, { durationMs: 4000 });
  const id = videoTrack(doc).clips[0]?.id;
  assert.ok(id);
  doc = setClipAudio(doc, id, { gain: 0.5, fadeInMs: 200, fadeOutMs: 300 });
  const clip = clipById(doc, id);
  assert.equal(clip.gain, 0.5);
  assert.equal(clip.fadeInMs, 200);
  assert.equal(clip.fadeOutMs, 300);

  doc = setClipAudio(doc, id, { gain: -3 });
  assert.equal(clipById(doc, id).gain, 0);
  assert.equal(clipById(doc, id).fadeInMs, 200);

  const restored = parseTimeline(JSON.parse(serializeTimeline(doc)));
  assert.deepEqual(clipById(restored, id).gain, 0);
  assert.equal(clipById(restored, id).fadeInMs, 200);
  assert.equal(clipById(restored, id).fadeOutMs, 300);
});

test('locked tracks reject move, trim, split, add and remove', () => {
  let doc = docWithTracks();
  const trackId = videoTrack(doc).id;
  doc = addClip(doc, trackId, 'a.mp4', 1000, { durationMs: 4000 });
  const id = videoTrack(doc).clips[0]?.id;
  assert.ok(id);

  doc = setTrackFlag(doc, trackId, 'locked', true);
  assert.equal(isTrackLocked(doc, trackId), true);
  assert.equal(moveClip(doc, id, trackId, 3000), doc);
  assert.equal(trimClip(doc, id, 'end', 6000), doc);
  assert.equal(splitClip(doc, id, 3000), doc);
  assert.equal(removeClip(doc, id), doc);
  assert.equal(addClip(doc, trackId, 'a.mp4', 8000), doc);
  assert.equal(clipById(doc, id).startMs, 1000);
  assert.equal(clipById(doc, id).durationMs, 4000);

  const unlocked = setTrackFlag(doc, trackId, 'locked', false);
  assert.equal(isTrackLocked(unlocked, trackId), false);
  const moved = moveClip(unlocked, id, trackId, 3000);
  assert.equal(clipById(moved, id).startMs, 3000);
  assert.equal(clipById(trimClip(moved, id, 'end', 6000), id).durationMs, 3000);
  assert.equal(removeClip(moved, id).tracks[0]?.clips.length, 0);
});

test('quantizeClip snaps a clip start to the grid and skips locked tracks', () => {
  let doc = docWithTracks();
  const trackId = videoTrack(doc).id;
  doc = addClip(doc, trackId, 'a.mp4', 1120, { durationMs: 4000 });
  const id = videoTrack(doc).clips[0]?.id;
  assert.ok(id);

  const quantized = quantizeClip(doc, id);
  assert.equal(clipById(quantized, id).startMs, 1125);
  assert.equal(clipById(quantized, id).durationMs, 4000);

  const locked = setTrackFlag(doc, trackId, 'locked', true);
  assert.equal(quantizeClip(locked, id), locked);
});

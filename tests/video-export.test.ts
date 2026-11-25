import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, unzipSync } from 'fflate';
import {
  buildFrameZip,
  DEFAULT_MAX_FRAMES,
  frameFileName,
  frameIndexAt,
  frameSequence,
  frameTimecode,
  manifestForFrames,
} from '../src/lib/video-export.ts';

test('frameIndexAt rounds time to the nearest frame', () => {
  assert.equal(frameIndexAt(0, 30), 0);
  assert.equal(frameIndexAt(16, 30), 0);
  assert.equal(frameIndexAt(17, 30), 1);
  assert.equal(frameIndexAt(50, 30), 2);
  assert.equal(frameIndexAt(1000, 30), 30);
  assert.equal(frameIndexAt(100, 25), 3);
});

test('frameTimecode and frameFileName are deterministic and filesystem-safe', () => {
  assert.equal(frameTimecode(0, 30), '00:00:00_000');
  assert.equal(frameTimecode(75, 30), '00:00:02_015');
  assert.equal(frameTimecode(109845, 30), '01:01:01_015');
  assert.equal(frameFileName(1, 30), 'frame_000001_T00-00-00_F001.png');
  assert.equal(frameFileName(75, 30), 'frame_000075_T00-00-02_F015.png');
  assert.ok(!frameFileName(109845, 30).includes(':'));
});

test('frameSequence emits only clip ranges and honours maxFrames', () => {
  const doc = {
    fps: 30,
    tracks: [
      {
        clips: [
          { startMs: 0, durationMs: 1000 },
          { startMs: 2000, durationMs: 1000 },
        ],
      },
    ],
  };
  const frames = frameSequence(doc);
  assert.equal(frames.length, 60);
  const indices = frames.map((frame) => frameIndexAt(frame.timeMs, frame.fps));
  assert.deepEqual(indices, [
    ...Array.from({ length: 30 }, (_, i) => i),
    ...Array.from({ length: 30 }, (_, i) => 60 + i),
  ]);
  assert.ok(frames.every((frame) => frame.fps === 30));
  assert.ok(frames.every((frame) => !(frame.timeMs >= 1000 && frame.timeMs < 2000)));

  assert.equal(frameSequence(doc, { maxFrames: 10 }).length, 10);
  assert.equal(frameSequence(doc, { maxFrames: 0 }).length, 0);
  const long = { fps: 30, tracks: [{ clips: [{ startMs: 0, durationMs: 200_000 }] }] };
  assert.equal(frameSequence(long).length, DEFAULT_MAX_FRAMES);
});

test('frameSequence intersects the requested bounds', () => {
  const doc = { fps: 30, tracks: [{ clips: [{ startMs: 0, durationMs: 3000 }] }] };
  const frames = frameSequence(doc, { startMs: 1000, endMs: 2000 });
  assert.deepEqual(
    frames.map((frame) => frameIndexAt(frame.timeMs, frame.fps)),
    Array.from({ length: 30 }, (_, i) => 30 + i),
  );
  assert.deepEqual(frameSequence(doc, { startMs: 2000, endMs: 1000 }), []);
  assert.deepEqual(frameSequence({ fps: 0, tracks: doc.tracks }), []);
  assert.deepEqual(frameSequence({ fps: 30, tracks: [] }), []);
});

test('frameSequence merges overlapping and touching clips into one union', () => {
  const doc = {
    fps: 30,
    tracks: [
      {
        clips: [
          { startMs: 0, durationMs: 1000 },
          { startMs: 500, durationMs: 1000 },
        ],
      },
      {
        clips: [
          { startMs: 1000, durationMs: 1000 },
          { startMs: 2500, durationMs: 100 },
        ],
      },
    ],
  };
  const frames = frameSequence(doc);
  const indices = frames.map((frame) => frameIndexAt(frame.timeMs, frame.fps));
  assert.deepEqual(indices, [...Array.from({ length: 60 }, (_, i) => i), 75, 76, 77]);
  assert.equal(new Set(indices).size, indices.length);
  assert.ok(frames.every((frame) => frame.timeMs < 2000 || (frame.timeMs >= 2500 && frame.timeMs < 2600)));
});

test('manifestForFrames produces parseable JSON with one entry per frame', () => {
  const frames = frameSequence({ fps: 30, tracks: [{ clips: [{ startMs: 0, durationMs: 100 }] }] });
  const manifest = JSON.parse(manifestForFrames(frames, 30));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.fps, 30);
  assert.equal(manifest.frames.length, frames.length);
  assert.deepEqual(manifest.frames[1], {
    index: 1,
    timecode: '00:00:00_001',
    file: 'frame_000001_T00-00-00_F001.png',
  });
  const last = frames[frames.length - 1];
  assert.ok(last);
  assert.deepEqual(
    manifest.frames[manifest.frames.length - 1].file,
    frameFileName(frameIndexAt(last.timeMs, 30), 30),
  );
});

test('buildFrameZip round-trips frame bytes and lets the last duplicate win', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const archive = await buildFrameZip([
    { name: 'frame_000001_T00-00-00_F001.png', bytes: png },
    { name: 'manifest.json', bytes: strToU8('{"version":1}') },
  ]);
  const entries = unzipSync(archive);
  assert.deepEqual(Object.keys(entries).sort(), ['frame_000001_T00-00-00_F001.png', 'manifest.json']);
  assert.deepEqual([...(entries['frame_000001_T00-00-00_F001.png'] ?? [])], [...png]);

  const duplicate = await buildFrameZip([
    { name: 'a.png', bytes: new Uint8Array([1]) },
    { name: 'a.png', bytes: new Uint8Array([2, 3]) },
  ]);
  assert.deepEqual([...(unzipSync(duplicate)['a.png'] ?? [])], [2, 3]);
});

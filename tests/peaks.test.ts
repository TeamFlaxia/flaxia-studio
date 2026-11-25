import assert from 'node:assert/strict';
import test from 'node:test';
import { computePeaks, computePeaksFromAudioBuffer, PeakCache, type PeakData } from '../src/lib/peaks.ts';

function peaks(...values: number[]): PeakData {
  return { samples: new Float32Array(values), durationMs: 1000 };
}

function setGlobal(name: string, value: unknown): () => void {
  const scope = globalThis as unknown as Record<string, unknown>;
  const existed = Object.hasOwn(scope, name);
  const previous = scope[name];
  Object.defineProperty(scope, name, { configurable: true, writable: true, value });
  return () => {
    if (existed) {
      Object.defineProperty(scope, name, { configurable: true, writable: true, value: previous });
    } else {
      Reflect.deleteProperty(scope, name);
    }
  };
}

test('computePeaks buckets by maximum absolute value and normalises to 0..1', () => {
  const result = computePeaks([0, 1, -0.5, 0.25, 0, -1], 3);
  assert.equal(result.length, 3);
  assert.deepEqual([...result], [1, 0.5, 1]);

  const quieter = computePeaks(new Float32Array([0.5, 0, 0.25, 0]), 2);
  assert.deepEqual([...quieter], [1, 0.5]);

  // More buckets than samples keeps the requested length and pads with zeros.
  assert.deepEqual([...computePeaks([0.5], 4)], [1, 0, 0, 0]);
});

test('computePeaks handles empty input and invalid bucket counts safely', () => {
  assert.equal(computePeaks([], 8).length, 0);
  assert.equal(computePeaks(new Float32Array(4), 0).length, 0);
  assert.equal(computePeaks([1, 2], -3).length, 0);
  assert.equal(computePeaks([1, 2], Number.NaN).length, 0);
});

test('computePeaksFromAudioBuffer combines stereo channels with a maximum', () => {
  const left = new Float32Array([0.2, 0.4, 0, -0.8]);
  const right = new Float32Array([-0.6, 0.1, 0.5, 0.2]);
  const buffer = {
    length: 4,
    duration: 2,
    numberOfChannels: 2,
    getChannelData(index: number): Float32Array {
      return index === 0 ? left : right;
    },
  };

  const result = computePeaksFromAudioBuffer(buffer, 2);
  assert.equal(result.durationMs, 2000);
  assert.equal(result.samples.length, 2);
  // Bucket 0 peaks at 0.6, bucket 1 at 0.8; both are scaled by 0.8.
  assert.ok(Math.abs((result.samples[0] ?? 0) - 0.75) < 1e-6);
  assert.ok(Math.abs((result.samples[1] ?? 0) - 1) < 1e-6);
});

test('computePeaksFromAudioBuffer probes channels when numberOfChannels is absent', () => {
  const mono = new Float32Array([0.25, -0.5, 0.25, 0]);
  const buffer = {
    length: 4,
    duration: 0.5,
    getChannelData(index: number): Float32Array {
      if (index === 0) return mono;
      throw new RangeError('no such channel');
    },
  };
  const result = computePeaksFromAudioBuffer(buffer, 2);
  assert.equal(result.durationMs, 500);
  assert.deepEqual([...result.samples], [1, 0.5]);
});

test('computePeaksFromAudioBuffer returns zeros for an empty buffer', () => {
  const buffer = { length: 0, duration: 0, getChannelData: () => new Float32Array(0) };
  const result = computePeaksFromAudioBuffer(buffer, 4);
  assert.equal(result.durationMs, 0);
  assert.deepEqual([...result.samples], [0, 0, 0, 0]);
});

test('PeakCache evicts the least recently used entry', () => {
  const cache = new PeakCache(2);
  const first = peaks(1);
  const second = peaks(2);
  const third = peaks(3);

  cache.set('a', first);
  cache.set('b', second);
  assert.equal(cache.get('a'), first); // reading 'a' makes 'b' the oldest
  cache.set('c', third);

  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), first);
  assert.equal(cache.get('c'), third);

  cache.clear();
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('c'), undefined);
});

test('PeakCache.load shares one promise and keeps the resolved value', async () => {
  const cache = new PeakCache();
  const data = peaks(0.5, 1);
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await Promise.resolve();
    return data;
  };

  const first = cache.load('song.mp3', loader);
  const second = cache.load('song.mp3', loader);
  assert.equal(first, second);
  assert.equal(calls, 1); // the loader starts once, synchronously

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, data);
  assert.equal(b, data);
  assert.equal(calls, 1);
  assert.equal(cache.get('song.mp3'), data);
  assert.equal(await cache.load('song.mp3', loader), data);
  assert.equal(calls, 1);
});

test('PeakCache.load drops failed promises so a later retry can run', async () => {
  const cache = new PeakCache();
  await assert.rejects(
    cache.load('broken.mp3', () => Promise.reject(new Error('decode failed'))),
    /decode failed/,
  );
  assert.equal(cache.get('broken.mp3'), undefined);

  const data = peaks(1);
  assert.equal(await cache.load('broken.mp3', () => data), data);
});

test('the waveform module imports without a DOM and empty waveforms are safe', async () => {
  const { WaveformView } = await import('../src/ui/waveform.ts');
  assert.equal(typeof WaveformView, 'function');

  const draws: Array<[number, number, number, number]> = [];
  const context = {
    fillStyle: '',
    globalAlpha: 1,
    fillRect(x: number, y: number, width: number, height: number) {
      draws.push([x, y, width, height]);
    },
    clearRect() {},
    setTransform() {},
  };
  const canvas = {
    className: '',
    width: 0,
    height: 0,
    style: { width: '', height: '' },
    getContext: () => context,
  };
  const restoreDocument = setGlobal('document', {
    createElement: () => canvas,
    documentElement: {},
  });
  const restoreWindow = setGlobal('window', {
    devicePixelRatio: 2,
    getComputedStyle: () => ({ getPropertyValue: () => '#123456' }),
  });

  try {
    const view = new WaveformView();
    assert.equal(view.host, canvas);
    assert.equal(view.host.className, 'waveform-canvas');

    // No peaks, zero size and a non-finite progress must not throw.
    view.render();
    view.resize(0, 0);
    view.setPeaks(new Float32Array(0));
    view.setProgress(Number.NaN);
    view.setColor('');
    assert.equal(canvas.width, 1);
    assert.equal(canvas.height, 1);

    // With peaks, drawing uses DPR-scaled backing pixels and the CSS accent.
    draws.length = 0;
    view.resize(100, 40);
    view.setPeaks(new Float32Array([0, 0.5, 1]));
    view.setProgress(0.5);
    assert.equal(canvas.style.width, '100px');
    assert.equal(canvas.style.height, '40px');
    assert.equal(canvas.width, 200);
    assert.equal(canvas.height, 80);
    assert.equal(context.fillStyle, '#123456');
    assert.ok(draws.length > 3);

    view.setColor('#ff0000');
    assert.equal(context.fillStyle, '#ff0000');
  } finally {
    restoreWindow();
    restoreDocument();
  }
});

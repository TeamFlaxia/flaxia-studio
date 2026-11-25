/**
 * Audio peak extraction and caching.
 *
 * Peak data is a small, serialisable summary of an audio buffer: one amplitude
 * per bucket, normalised to 0..1. The helpers here stay independent of the DOM
 * and of the concrete `AudioBuffer` type so they can be exercised in Node with
 * plain mocks.
 */

export interface PeakData {
  /** One normalised amplitude (0..1) per bucket. */
  samples: Float32Array;
  durationMs: number;
}

/**
 * The subset of `AudioBuffer` used here. `numberOfChannels` is optional so
 * simple mocks only need `length`, `duration` and `getChannelData`.
 */
export interface PeakAudioBuffer {
  length: number;
  duration: number;
  numberOfChannels?: number;
  getChannelData(index: number): Float32Array;
}

interface PeaksAudioContext {
  decodeAudioData(data: ArrayBuffer): Promise<PeakAudioBuffer>;
  close?(): Promise<void>;
}

const FALLBACK_DURATION = 0;
const MAX_PROBED_CHANNELS = 32;
const DEFAULT_CACHE_LIMIT = 24;

function bucketCount(buckets: number): number {
  if (!Number.isFinite(buckets)) return 0;
  return Math.max(0, Math.floor(buckets));
}

/** Scales peak values in place so the loudest bucket becomes 1. */
function normalize(peaks: Float32Array): void {
  let max = 0;
  for (let index = 0; index < peaks.length; index += 1) {
    const value = peaks[index] ?? 0;
    if (value > max) max = value;
  }
  if (max <= 0) return;
  for (let index = 0; index < peaks.length; index += 1) {
    peaks[index] = Math.min(1, (peaks[index] ?? 0) / max);
  }
}

/**
 * Reduces samples to `buckets` amplitudes, keeping the largest absolute value
 * in each bucket and normalising the result to 0..1. Empty input or a non
 * positive bucket count returns an empty array.
 */
export function computePeaks(samples: Float32Array | number[], buckets: number): Float32Array {
  const count = bucketCount(buckets);
  if (count === 0 || samples.length === 0) return new Float32Array(0);

  const peaks = new Float32Array(count);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.abs(samples[index] ?? 0);
    const bucket = Math.min(count - 1, Math.floor((index * count) / samples.length));
    if (value > (peaks[bucket] ?? 0)) peaks[bucket] = value;
  }
  normalize(peaks);
  return peaks;
}

function channelDataOf(buffer: PeakAudioBuffer): Float32Array[] {
  const channels: Float32Array[] = [];
  const declared = buffer.numberOfChannels;
  const limit =
    typeof declared === 'number' && Number.isFinite(declared) && declared > 0
      ? Math.min(MAX_PROBED_CHANNELS, Math.floor(declared))
      : MAX_PROBED_CHANNELS;
  for (let index = 0; index < limit; index += 1) {
    let data: Float32Array | undefined;
    try {
      data = buffer.getChannelData(index);
    } catch {
      break;
    }
    if (!data || data.length === 0) break;
    channels.push(data);
  }
  return channels;
}

/**
 * Builds peaks from an `AudioBuffer`-shaped object. All channels are combined
 * with a per-sample maximum, so a quiet channel never hides a loud one.
 */
export function computePeaksFromAudioBuffer(buffer: PeakAudioBuffer, buckets: number): PeakData {
  const count = bucketCount(buckets);
  const peaks = new Float32Array(count);
  const durationMs =
    Number.isFinite(buffer.duration) && buffer.duration > 0
      ? Math.max(0, Math.round(buffer.duration * 1000))
      : FALLBACK_DURATION;
  if (count === 0 || buffer.length <= 0) return { samples: peaks, durationMs };

  const channels = channelDataOf(buffer);
  if (channels.length === 0) return { samples: peaks, durationMs };

  for (let index = 0; index < buffer.length; index += 1) {
    let amplitude = 0;
    for (const channel of channels) {
      const value = Math.abs(channel[index] ?? 0);
      if (value > amplitude) amplitude = value;
    }
    const bucket = Math.min(count - 1, Math.floor((index * count) / buffer.length));
    if (amplitude > (peaks[bucket] ?? 0)) peaks[bucket] = amplitude;
  }
  normalize(peaks);
  return { samples: peaks, durationMs };
}

function audioContextConstructor(): (new () => PeaksAudioContext) | null {
  const scope = globalThis as typeof globalThis & {
    AudioContext?: new () => PeaksAudioContext;
    webkitAudioContext?: new () => PeaksAudioContext;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * Reads a Blob's bytes without any network request. The slow path uses a
 * locally created, same-origin `blob:` URL; remote URLs are never fetched.
 */
async function bytesOf(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  if (typeof URL.createObjectURL !== 'function') {
    throw new Error('Cannot read this blob: no arrayBuffer() and no blob URL support');
  }
  const url = URL.createObjectURL(blob);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to read blob URL: ${response.status}`);
    return response.arrayBuffer();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decodes a blob with `AudioContext.decodeAudioData` and computes its peaks. */
export async function peaksFromBlob(blob: Blob, buckets = 1024): Promise<PeakData> {
  const Context = audioContextConstructor();
  if (!Context) {
    throw new Error('AudioContext is not available in this environment; cannot decode audio peaks');
  }

  let context: PeaksAudioContext;
  try {
    context = new Context();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create AudioContext: ${reason}`);
  }

  try {
    const buffer = await context.decodeAudioData(await bytesOf(blob));
    if (!buffer) throw new Error('AudioContext.decodeAudioData returned no audio buffer');
    return computePeaksFromAudioBuffer(buffer, buckets);
  } finally {
    if (typeof context.close === 'function') {
      try {
        await context.close();
      } catch {
        // Closing is best effort; peaks are already computed.
      }
    }
  }
}

type CacheEntry = PeakData | Promise<PeakData>;

/**
 * Least-recently-used cache keyed by workspace path. Both resolved peaks and
 * in-flight promises are stored, so concurrent `load()` calls for one path
 * decode the audio only once.
 */
export class PeakCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly limit: number;

  constructor(limit = DEFAULT_CACHE_LIMIT) {
    this.limit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_CACHE_LIMIT;
  }

  private touch(path: string, entry: CacheEntry): void {
    this.entries.delete(path);
    this.entries.set(path, entry);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Returns already decoded peaks; in-flight loads are not exposed. */
  get(path: string): PeakData | undefined {
    const entry = this.entries.get(path);
    if (!entry || entry instanceof Promise) return undefined;
    this.touch(path, entry);
    return entry;
  }

  /** Stores decoded peaks and evicts the least recently used entry if needed. */
  set(path: string, data: PeakData): void {
    this.touch(path, data);
  }

  /** Drops all entries, including in-flight promises. */
  clear(): void {
    this.entries.clear();
  }

  /** Returns cached peaks, or runs `loader` once and caches its promise. */
  load(path: string, loader: () => Promise<PeakData> | PeakData): Promise<PeakData> {
    const cached = this.entries.get(path);
    if (cached) {
      this.touch(path, cached);
      return cached instanceof Promise ? cached : Promise.resolve(cached);
    }

    const pending = (async () => loader())();
    this.touch(path, pending);
    void pending.then(
      (data) => {
        if (this.entries.get(path) === pending) this.touch(path, data);
      },
      () => {
        if (this.entries.get(path) === pending) this.entries.delete(path);
      },
    );
    return pending;
  }
}

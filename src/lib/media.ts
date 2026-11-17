/**
 * Media classification and probing for the preview pane and the timeline.
 *
 * The workspace stores binaries as blobs, so a media file is just a path plus a
 * blob. Duration and dimensions come from the browser once the blob is loaded.
 */

export type MediaKind = 'image' | 'audio' | 'video';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv']);

/** Still images get this length when they are dropped on the timeline. */
export const DEFAULT_IMAGE_DURATION_MS = 5000;

const MIME_BY_KIND: Record<MediaKind, string> = {
  image: 'image/png',
  audio: 'audio/mpeg',
  video: 'video/mp4',
};

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  ogv: 'video/ogg',
  mkv: 'video/x-matroska',
};

/**
 * Non-destructive view parameters for an image or video. The editor preview
 * and the timeline share them, so they live with the media model.
 */
export interface MediaAdjustments {
  brightness: number;
  contrast: number;
  saturation: number;
  rotate: 0 | 90 | 180 | 270;
  flip: boolean;
}

export const DEFAULT_MEDIA_ADJUSTMENTS: MediaAdjustments = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  rotate: 0,
  flip: false,
};

/** Clamps stored adjustment values into the ranges the UI exposes. */
export function sanitizeAdjustments(value: unknown): MediaAdjustments {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const clamp = (input: unknown) =>
    typeof input === 'number' && Number.isFinite(input) ? Math.min(200, Math.max(0, Math.round(input))) : 100;
  const rotate = record.rotate === 90 || record.rotate === 180 || record.rotate === 270 ? record.rotate : 0;
  return {
    brightness: clamp(record.brightness),
    contrast: clamp(record.contrast),
    saturation: clamp(record.saturation),
    rotate,
    flip: record.flip === true,
  };
}

export interface MediaProbe {
  /** Images report `DEFAULT_IMAGE_DURATION_MS`; media report the real length. */
  durationMs: number;
  width: number;
  height: number;
}

function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? path;
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index + 1).toLowerCase();
}

export function mediaKind(path: string): MediaKind | null {
  const extension = extensionOf(path);
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return null;
}

export function isMediaPath(path: string): boolean {
  return mediaKind(path) !== null;
}

export function mimeForMedia(path: string): string {
  return MIME_BY_EXTENSION[extensionOf(path)] ?? 'application/octet-stream';
}

/** Which timeline track a source belongs on. */
export function trackKindFor(kind: MediaKind): 'video' | 'audio' {
  return kind === 'audio' ? 'audio' : 'video';
}

/** Reads duration and dimensions from the browser for a stored blob. */
export async function probeMedia(blob: Blob, kind: MediaKind): Promise<MediaProbe> {
  if (kind === 'image') {
    const url = URL.createObjectURL(blob);
    try {
      const size = await new Promise<{ width: number; height: number }>((resolve) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => resolve({ width: 0, height: 0 });
        image.src = url;
      });
      return { durationMs: DEFAULT_IMAGE_DURATION_MS, ...size };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const element = document.createElement(kind === 'video' ? 'video' : 'audio');
  element.preload = 'metadata';
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<MediaProbe>((resolve) => {
      const done = (probe: MediaProbe) => resolve(probe);
      element.onloadedmetadata = () => {
        const video = element as HTMLVideoElement;
        done({
          durationMs: Number.isFinite(element.duration) ? Math.round(element.duration * 1000) : 0,
          width: video.videoWidth || 0,
          height: video.videoHeight || 0,
        });
      };
      element.onerror = () => done({ durationMs: 0, width: 0, height: 0 });
      element.src = url;
    });
  } finally {
    element.removeAttribute('src');
    element.load();
    URL.revokeObjectURL(url);
  }
}

export function defaultMimeFor(kind: MediaKind): string {
  return MIME_BY_KIND[kind];
}

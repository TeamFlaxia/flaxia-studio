/**
 * Asset placeholders for Test Play.
 *
 * The game runs inside a sandboxed frame with an opaque origin. Chromium
 * refuses to load a blob URL created by another origin, so the studio can
 * not hand blob URLs to the game. Instead the shell rewrites every local
 * reference to a placeholder (`blob:flaxia-play/<encoded path>`) and the
 * runtime — which runs inside the game frame and owns the blob registry —
 * replaces the placeholders with the blob URLs it creates itself.
 */

import { resolveArchiveUrl, type UrlResolver } from './rewrite.ts';

export const PLAY_ASSET_SCHEME = 'blob:flaxia-play/';

/** Placeholder URL for a payload path plus an optional query/hash suffix. */
export function assetPlaceholder(path: string, suffix = ''): string {
  return `${PLAY_ASSET_SCHEME}${encodeURIComponent(path)}${suffix}`;
}

/**
 * Resolver that points local references at runtime placeholders. References
 * that do not resolve to a payload file are left untouched.
 */
export function placeholderResolver(paths: ReadonlySet<string>): UrlResolver {
  return (reference, basePath) => {
    const resolved = resolveArchiveUrl(reference, basePath);
    if (!resolved) return null;
    if (!paths.has(resolved.path)) return null;
    return assetPlaceholder(resolved.path, resolved.suffix);
  };
}

/** Documents the shell rewrites before handing them to the runtime. */
export function isRewrittenAsset(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.css') || lower.endsWith('.html') || lower.endsWith('.htm');
}

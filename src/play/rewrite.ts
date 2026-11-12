/**
 * URL rewriting for Test Play, ported from Arcade's trusted ZIP preview shell
 * (`flaxia/sandbox/zip-preview.js`).
 *
 * Relative `src` / `href` references in the entry document, `url(...)` in
 * inline and linked stylesheets, and `@import` targets are resolved against
 * the archive and swapped for blob URLs. External `http(s)`, `data:` and
 * `blob:` references are left untouched.
 */

const ARCHIVE_BASE = 'https://zip.invalid/';

export interface ResolvedArchiveUrl {
  path: string;
  suffix: string;
}

/** Resolves a document-relative reference to a payload path, or null. */
export type UrlResolver = (path: string, basePath: string) => string | null;

export function shouldRewritePath(path: string): boolean {
  return (
    !path.startsWith('https://') &&
    !path.startsWith('http://') &&
    !path.startsWith('data:') &&
    !path.startsWith('blob:')
  );
}

/**
 * Resolves `path` against `basePath` (a payload file path such as
 * `index.html` or `game/main.css`) inside the virtual archive.
 *
 * Returns the payload path plus the query/hash suffix to re-append to the
 * blob URL, or null for external, empty, fragment-only or unknown references.
 */
export function resolveArchiveUrl(path: string, basePath: string): ResolvedArchiveUrl | null {
  if (!path || !shouldRewritePath(path) || path.startsWith('#') || path.startsWith('?')) return null;
  try {
    const baseUrl = new URL(basePath, ARCHIVE_BASE);
    const resolved = new URL(path, baseUrl);
    if (resolved.origin !== ARCHIVE_BASE.replace(/\/$/, '')) return null;
    return {
      path: decodeURIComponent(resolved.pathname.slice(1)),
      suffix: resolved.search + resolved.hash,
    };
  } catch {
    return null;
  }
}

/** Resolver backed by a payload path → blob URL map. */
export function mapResolver(map: ReadonlyMap<string, string>): UrlResolver {
  return (path, basePath) => {
    const resolved = resolveArchiveUrl(path, basePath);
    if (!resolved) return null;
    const url = map.get(resolved.path);
    return url === undefined ? null : url + resolved.suffix;
  };
}

export function rewriteCssUrls(cssText: string, resolve: UrlResolver, basePath: string): string {
  const withUrls = cssText.replace(/url\s*\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, _quote, path: string) => {
    const blobUrl = resolve(path, basePath);
    return blobUrl ? `url("${blobUrl}")` : match;
  });
  return withUrls.replace(/@import\s+(['"])([^'"]+)\1/gi, (match, _quote, path: string) => {
    const blobUrl = resolve(path, basePath);
    return blobUrl ? `@import url("${blobUrl}")` : match;
  });
}

export function rewriteHtmlString(html: string, resolve: UrlResolver, basePath: string): string {
  const withSrc = html.replace(
    /<([^>]+)\s+src\s*=\s*['"]([^'"]+)['"]/gi,
    (match, tagAttrs: string, src: string) => {
      const blobUrl = resolve(src, basePath);
      return blobUrl ? `<${tagAttrs} src="${blobUrl}"` : match;
    },
  );
  const withHref = withSrc.replace(
    /<([^>]+)\s+href\s*=\s*['"]([^'"]+)['"]/gi,
    (match, tagAttrs: string, href: string) => {
      const blobUrl = resolve(href, basePath);
      return blobUrl ? `<${tagAttrs} href="${blobUrl}"` : match;
    },
  );
  const withStyleBlocks = withHref.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (match, cssContent: string) =>
    match.replace(cssContent, rewriteCssUrls(cssContent, resolve, basePath)),
  );
  return withStyleBlocks.replace(/style\s*=\s*['"]([^'"]+)['"]/gi, (match, styleContent: string) => {
    const rewritten = rewriteCssUrls(styleContent, resolve, basePath);
    return rewritten === styleContent ? match : `style="${rewritten}"`;
  });
}

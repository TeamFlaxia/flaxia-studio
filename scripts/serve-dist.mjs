import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist');
const port = Number(process.env.PORT ?? 4174);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};
const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
// SYNC: relaxed CSP for the Test Play shell — keep identical to
// public/_headers (`/play/*`) and vite.config.ts (PLAY_CSP).
const gameCsp = [
  "default-src 'self' * data: blob:",
  "script-src 'self' * data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "worker-src 'self' * data: blob:",
  "style-src 'self' * data: blob: 'unsafe-inline'",
  "img-src 'self' * data: blob:",
  "font-src 'self' * data: blob:",
  "media-src 'self' * data: blob:",
  "connect-src 'self' * data: blob:",
  "frame-src 'self' * data: blob:",
  "child-src 'self' * data: blob:",
  "object-src 'none'",
  'base-uri *',
  'form-action *',
  "frame-ancestors 'self'",
].join('; ');

createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = join(root, normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, ''));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  const isPlay = urlPath.startsWith('/play/');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (isPlay) {
    // The studio page is cross-origin isolated (COEP: require-corp), so a
    // nested frame must opt in: `credentialless` keeps the shell embeddable
    // while still allowing the sandboxed blob: game document. The game frame
    // has an opaque origin, so /play assets are readable cross-origin.
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Security-Policy', gameCsp);
  } else {
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Content-Security-Policy', csp);
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
  res.writeHead(200);
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));

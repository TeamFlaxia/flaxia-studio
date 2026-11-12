import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// SYNC: relaxed CSP for the Test Play shell — keep this string identical to
// public/_headers (`/play/*`) and scripts/serve-dist.mjs. The shell is the
// only document that embeds untrusted game content (sandboxed, no
// allow-same-origin), so COEP and the strict studio CSP stay off under /play/.
// The strict main CSP is production-only (_headers / serve-dist): dev must
// keep an open connect-src for the HMR websocket.
const PLAY_CSP = [
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

// All response headers are applied here (not via `server.headers`) so the
// /play/* branch cannot be overwritten by a later middleware.
function studioHeaders(): Plugin {
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (path.startsWith('/play/')) {
      // The studio page is cross-origin isolated (COEP: require-corp), so a
      // nested frame must opt in: `credentialless` keeps the shell embeddable
      // while still allowing the sandboxed blob: game document. The game frame
      // has an opaque origin, so /play assets are readable cross-origin.
      res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Security-Policy', PLAY_CSP);
    } else {
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    next();
  };
  return {
    name: 'flaxia-studio-headers',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [studioHeaders()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        play: fileURLToPath(new URL('./play/shell.html', import.meta.url)),
      },
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return;
          if (id.includes('/monaco-editor/')) return 'monaco';
          if (id.includes('/@xterm/')) return 'xterm';
          if (id.includes('/fflate/')) return 'fflate';
        },
      },
    },
  },
  server: {
    port: 4173,
  },
  preview: {
    port: 4173,
  },
  worker: {
    format: 'es',
  },
});

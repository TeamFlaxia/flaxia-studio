# Flaxia Studio

A Monaco-based browser IDE that keeps the Flaxia design language and runs a
Debian Linux workspace through [container2wasm](https://github.com/container2wasm/container2wasm).

Flaxia Studio is an independent app (`studio.flaxia.app`) that inherits the
quiet-craft surface language of Flaxia: emerald accents, 1px hairlines,
8/12px radii, calm 150ms motion, dense sidebars, and a command palette.

## What works today

- Monaco editor with local workers (no CDN, no remote code)
- IndexedDB workspace with tabs, quick open, search, rename/delete, ZIP import/export
- Light / dark / system themes with FOUC-free boot
- container2wasm Debian Linux in a Web Worker
- A terminal that routes commands to Linux once it is booted
- `/workspace` sync between Monaco and the guest, including `gcc file.c && ./a.out`

## Quick start

```bash
npm install
npm run dev
```

Open <http://localhost:4173>.

The editor works immediately. The Linux panel needs an image:

```bash
# Option A: lightweight Alpine Python image for fast local boots (~145 MB)
npm run fetch:linux-lite

# Optional: the full Debian + gcc image (~440 MB)
npm run fetch:linux-full

# Option B: build the Flaxia image (Docker + buildx + c2w required)
npm run build:linux
```

Then click **Boot Linux** in the top bar, or run `boot` in the terminal.

## Scripts

```bash
npm run dev            # Vite dev server with COOP/COEP headers
npm run build          # typecheck + production build
npm run preview        # preview dist with COOP/COEP headers
npm run lint           # Biome
npm run typecheck      # tsc --noEmit
npm test               # node:test (path, zip, workspace)
npm run test:e2e       # Playwright workspace smoke test against the preview server
npm run test:linux     # Boot the full Debian image and run gcc in the browser
npm run test:csp       # Strict CSP smoke test against scripts/serve-dist.mjs (port 4174)
npm run fetch:linux-lite
npm run fetch:linux-full
npm run build:linux
npm run verify:linux
```

`test:e2e` expects `npm run preview -- --port 4173` to be running.

## Architecture

```
Main thread
  Flaxia Studio shell (vanilla TS)
  Monaco + language workers
  xterm.js terminal
  command palette / explorer / settings
        │ MessagePort (worker messages)
Dedicated module worker
  container2wasm WASI image
  browser_wasi_shim (vendored)
  /workspace preopen (text files)
        │
R2 / static assets
  manifest.json + chunk-*.wasm.gz (<25 MB each)
```

- Linux runs in a module worker so the editor stays responsive.
- The workspace is a preopened directory at `/workspace` (virtio-9p in the
  guest). Commands run in a writable `/tmp/flaxia-work` copy so compiled
  binaries can execute, then the result is mirrored back.
- Only UTF-8 text files ≤ 2 MiB are mirrored. Binary build products stay inside
  the VM. Empty directories are not preserved by command-mode sync.
- Networking is disabled in the MVP. The browser `c2w-net-proxy` path is the
  next integration step; the offline image still runs `gcc`, `make`, `git`,
  and local tests.

See [`docs/architecture.md`](docs/architecture.md),
[`docs/linux-image.md`](docs/linux-image.md), and
[`docs/design-language.md`](docs/design-language.md).

## Security notes

Production headers are in [`public/_headers`](public/_headers): COOP
`same-origin`, COEP `require-corp`, and a CSP without `unsafe-inline` scripts.
The Linux image is verified against the SHA-256 digest in its manifest before
compilation. Use same-origin image chunks (or a CORS/CORP-enabled host) so COEP
does not block them.

## Limitations

- Desktop Chromium is the primary target. Firefox may work without the Linux
  panel; Safari's COEP/worker behavior is not validated.
- The MVP uses command-scoped workspace sync, not a live shared filesystem.
  Long-running interactive TUI programs are not supported.
- The terminal panel is hidden on narrow mobile layouts; the editor and mobile
  sidebar drawer remain available.
- container2wasm is experimental and CPU emulation is slow. The demo image boots
  in a few seconds from cache; large compiles take noticeably longer.

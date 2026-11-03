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
- A **persistent Linux session**: boot once, then commands run in the same guest
  (~0.7 s instead of ~3 s per command; gcc itself remains CPU-bound)
- `/workspace` sync between Monaco and the guest, including `gcc file.c && ./a.out`
- Compiled binaries are saved as binary workspace files (visible in the explorer,
  downloadable, and included in Export ZIP)

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

## Performance

The runtime uses two paths:

| Path               | Use                                   | Cost                              |
| ------------------ | ------------------------------------- | --------------------------------- |
| Persistent session | Normal commands                       | ~0.7 s per command after one boot |
| One-shot WASI      | Network commands and session fallback | ~3 s boot per command             |

JIT (container2wasm's `--to-js` QEMU/Wasm path) is not enabled yet: the current
prebuilt images are WASI/Bochs images, and a QEMU image needs a separate
`c2w --to-js` artifact plus an Emscripten runtime. The session path removes the
per-command boot cost, which is the largest fixed overhead today.

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
npm run test:exec      # Compile and run a.out as two separate commands
npm run test:session   # Verify the persistent session (gcc → a.out)
npm run test:menu      # Verify Monaco context menu surfaces in light/dark
npm run test:net       # Boot Lite, run `fetch`, and verify the Fetch proxy
npm run test:manifest  # Legacy '/linux/manifest.json' settings fall back to auto
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
- UTF-8 text files and binary artifacts (≤ 20 MiB each) are mirrored. Binaries
  are stored base64-encoded in IndexedDB, shown with a binary icon, and can be
  downloaded or exported in the ZIP. Empty directories are not preserved by
  command-mode sync.
- The browser Fetch proxy (`c2w-net-proxy`) is available for commands that need
  the network (`fetch`, `curl`, `apk`, `pip`, URLs, …). It restarts Linux with
  DHCP, so a network command takes roughly 20–30 s on the current WASI image.
  Third-party servers must send CORS headers; Alpine's package CDN does not, so
  `apk add` is blocked by the browser. Use the Full image or build packages into
  the image instead.
  Normal offline commands stay fast. Disable it in Settings for a pure offline
  session.

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
  The guest preopen does not persist POSIX mode bits, so each command copies the
  workspace to `/tmp/flaxia-work` and restores execute bits there. Long-running
  interactive TUI programs are not supported.
- The terminal panel is hidden on narrow mobile layouts; the editor and mobile
  sidebar drawer remain available.
- container2wasm is experimental and CPU emulation is slow. The demo image boots
  in a few seconds from cache; large compiles take noticeably longer.

# Flaxia Studio

A Monaco-based browser IDE that keeps the Flaxia design language, previews web
projects in a sandboxed **Test Play** pane, and runs a Debian Linux workspace
through [container2wasm](https://github.com/container2wasm/container2wasm).

Flaxia Studio is an independent app (`studio.flaxia.app`) that inherits the
quiet-craft surface language of Flaxia: emerald accents, 1px hairlines,
8/12px radii, calm 150ms motion, dense sidebars, and a command palette.

## What works today

- Monaco editor with local workers (no CDN, no remote code)
- IndexedDB workspace with tabs, quick open, search, rename/delete, ZIP import/export
- Explorer sidebar with a draggable (and keyboard-operable) width
- **Timeline-first bottom panel** (switch back to Terminal in Settings)
- **Right-hand inspector** with paired sliders and numeric fields for picture
  adjustments (brightness, contrast, saturation, rotate, flip)
- **Media editor**: image/video/audio preview tabs, non-destructive adjustments,
  and a Premiere-style **timeline** in the bottom panel (trim, split, move, snap)
- **Preview monitor**: composites the timeline on a canvas with a transport,
  frame stepping, timecode and fullscreen
- **Connections**: sign in with a Flaxia account and link OpenCode through the
  OAuth device flow. The token is sealed by Flaxia Auth and stored as an
  encrypted `oauth_connection` item in the Personal Vault. Run
  _Connections: Flaxia Account & OpenCode…_ from the command palette
- Light / dark / system themes with FOUC-free boot
- **Test Play**: run the workspace `index.html` in a sandboxed preview **tab**,
  with a ~450 ms auto reload after every save
- container2wasm Debian Linux in a Web Worker (a sub-feature, not the focus)
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

The Connections dialog talks to `https://auth.flaxia.app` by default. To use a
local `flaxia-auth` Worker, set `VITE_AUTH_ORIGIN=http://localhost:8787` (see
`.env.example`). `flaxia-auth` allows the Studio dev origins, so the Auth
session cookie works without a proxy.

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

## Test Play

Test Play previews the workspace in the browser — no container, no build step.

1. Press <kbd>Ctrl/Cmd</kbd> + <kbd>Shift</kbd> + <kbd>Enter</kbd>, click the
   **Test Play** pill, or run `play` in the terminal.
2. The shell picks the shallowest `index.html` in the workspace and runs it in a
   sandboxed frame. The preview is a tab in the editor area: edit, then switch
   to the **Test Play** tab to look at it.
3. Every save re-runs the preview ~450 ms later (toggle with **Settings → Test
   Play → Auto reload**). Auto reload keeps the current tab, so saving never
   pulls you away from the editor.

## Media editor

The workspace also edits media. Binary files are stored as Blobs in IndexedDB
(no base64, up to 2 GB per file), so video does not inflate.

1. **Import media** from the explorer (or _Workspace: Import Media…_ in the
   command palette) to add images, video and audio.
2. Opening one shows a preview tab with the picture/video and transport controls.
   The **right-hand inspector** owns the non-destructive adjustments
   (brightness, contrast, saturation, rotate, flip): each row pairs a slider with
   a numeric field, so a value can be dragged or typed. The adjustments live in
   the timeline document.
3. **Add to timeline** places the source on its track at the playhead. The
   **Timeline** tab in the bottom panel is a Premiere-style editor: click the
   ruler to scrub, drag clips to move, drag an edge to trim, `S` to split at the
   playhead, `Delete` to remove. **Right-click** a clip for split/duplicate/open
   source/delete/track actions, or empty space for track, snapping and zoom
   commands. `Space` plays; audio clips play in sync and the playhead follows the
   frame clock.
4. The timeline is saved in `.flaxia/timeline.json`, so it survives reloads and
   is included in Export ZIP. Test Play and the Linux guest never see it.

Phase 1 is arrangement + preview. Encoding/export, a frame-accurate video
monitor, waveforms, transitions and image cropping are follow-ups.

## Preview monitor

The **Preview** tab is the program monitor for the timeline. It is deliberately
separate from Test Play:

| Tab       | What it shows                                                 |
| --------- | ------------------------------------------------------------- |
| Test Play | The workspace web project (`index.html`) in a sandboxed frame |
| Preview   | The timeline arrangement, composited on a canvas              |

Preview draws the clip under the playhead with the same adjustments as the
inspector, plays video/audio clips, and keeps the timeline playhead in sync.
The transport supports play/pause, frame stepping, go-to-start, loop and
fullscreen. It never loads media while the tab is hidden.

Test Play remains the right tool for a web project; Preview is the right tool
for reviewing a timeline edit.

## Test Play

Test Play previews the workspace in the browser — no container, no build step.

1. Press <kbd>Ctrl/Cmd</kbd> + <kbd>Shift</kbd> + <kbd>Enter</kbd>, click the
   **Test Play** pill, or run `play` in the terminal.
2. The shell picks the shallowest `index.html` in the workspace and runs it in a
   sandboxed frame. The preview is a tab in the editor area: edit, then switch
   to the **Test Play** tab to look at it.
3. Every save re-runs the preview ~450 ms later (toggle with **Settings → Test
   Play → Auto reload**). Auto reload keeps the current tab, so saving never
   pulls you away from the editor.

The preview follows the Flaxia Arcade execution policy (`src/play/policy.ts`
mirrors `flaxia/src/lib/file-extensions.ts`, `flaxia/src/lib/zip-constants.ts`
and `flaxia/sandbox/zip-preview.js`):

- Allowlist of web assets (no `.svg`, no nested ZIP), 1024 files, 100 MB
  extracted, 25 MB per run, path length 255, depth 10.
- Path rules from the Arcade validators: no traversal, no absolute paths, no
  dotfiles, no control characters, no duplicate entries.
- `allow-same-origin` is never granted, so the game frame keeps an opaque
  origin: `localStorage` and `document.cookie` throw there. The runtime bridges
  them — `localStorage` is seeded from a workspace-scoped save and every write
  is relayed back to the studio (`flaxia:studio:<workspace>`), and
  `document.cookie` degrades to an empty string instead of throwing.
- `<base>` and `<meta http-equiv>` elements are stripped from the game
  document, and archive assets answer only `GET`/`HEAD`.
- The strict production CSP stays on the studio page. The trusted shell keeps a
  minimal policy and the game document runs under the Arcade sandbox policy
  (including the `sandbox` directive that forces the opaque origin).

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
- UTF-8 text files and binary artifacts (≤ 20 MiB each) are mirrored. Workspace
  binaries are stored as Blobs (so media is not base64); files above 20 MiB are
  not mirrored into the Linux guest. They are shown with a type icon and can be
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

Test Play keeps the strict CSP on the studio page. The `/play/*` rule swaps in a
relaxed policy (`unsafe-inline`/`unsafe-eval`, `blob:`) and
`Cross-Origin-Embedder-Policy: credentialless`, because the studio page is
cross-origin isolated and a nested frame must opt in. The untrusted game only
ever runs in a sandboxed frame with an opaque origin — `allow-same-origin` is
never granted — and the studio page itself never embeds a `blob:` frame.

## Limitations

- Desktop Chromium is the primary target. Firefox may work without the Linux
  panel; Safari's COEP/worker behavior is not validated.
- The Test Play frame has an opaque origin, so `localStorage` and `document.cookie`
  are unavailable to the previewed code. Use `fetch()` for data instead.
- The MVP uses command-scoped workspace sync, not a live shared filesystem.
  The guest preopen does not persist POSIX mode bits, so each command copies the
  workspace to `/tmp/flaxia-work` and restores execute bits there. Long-running
  interactive TUI programs are not supported.
- The terminal panel is hidden on narrow mobile layouts; the editor and mobile
  sidebar drawer remain available.
- container2wasm is experimental and CPU emulation is slow. The demo image boots
  in a few seconds from cache; large compiles take noticeably longer.

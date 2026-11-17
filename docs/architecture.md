# Architecture

## Layout

```
┌─────────────────────────────────────────────────────────────┐
│ studio.flaxia.app (Cloudflare Pages)                        │
│                                                             │
│  Main thread                                                │
│  ├─ Flaxia Studio shell (vanilla TypeScript)                │
│  ├─ Monaco Editor + language workers                         │
│  ├─ xterm.js terminal                                        │
│  └─ command palette / explorer / settings                    │
│            │ postMessage                                    │
│  Dedicated module worker                                    │
│  ├─ container2wasm WASI image                               │
│  ├─ browser_wasi_shim (MIT/Apache, vendored)                │
│  ├─ PreopenDirectory "/workspace"                           │
│  └─ text file collect / apply                               │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTPS manifest + chunks
┌───────────────▼─────────────────────────────────────────────┐
│ R2 / static origin                                          │
│  manifest.json                                              │
│  chunk-00.wasm.gz … chunk-NN.wasm.gz (each < 25 MB)         │
└─────────────────────────────────────────────────────────────┘
```

## Modules

| Path                             | Responsibility                                                   |
| -------------------------------- | ---------------------------------------------------------------- |
| `src/app.ts`                     | Shell, commands, state, keyboard, workspace/Linux orchestration  |
| `src/editor/monaco.ts`           | Monaco setup, workers, themes, models, dirty state               |
| `src/fs/`                        | Path rules, IndexedDB persistence, ZIP import/export             |
| `src/play/`                      | Test Play policy, URL rewriting, host/shell bridge               |
| `src/lib/media.ts`               | Media classification, MIME map, duration/size probing            |
| `src/lib/timeline.ts`            | Timeline document and pure editing operations (trim/split/move)  |
| `src/ui/media-view.ts`           | Image/video/audio preview pane and adjustments                   |
| `src/ui/timeline-view.ts`        | Timeline panel: ruler, tracks, playhead, playback                |
| `src/ui/timeline-store.ts`       | `.flaxia/timeline.json` persistence with debounced saves         |
| `src/linux/manifest.ts`          | Manifest validation and chunk URL resolution                     |
| `src/linux/runtime.ts`           | Worker lifecycle, boot, progress, command queue, cache           |
| `src/terminal/shell.ts`          | xterm shell, local commands, Linux routing                       |
| `public/linux-runtime/worker.js` | WASI boot, `/workspace` preopen, sync                            |
| `public/play/runtime.js`         | In-frame runtime: blob registry, asset placeholders, entry write |
| `src/ui/`                        | Palette, dialogs, toasts, context menu                           |

## Persistent session

`LinuxRuntime.boot()` starts a long-lived WASI container running
`/workspace/.flaxia/session.sh`. The shell reads base64-encoded run scripts from
a SharedArrayBuffer stdin, executes them in `/tmp/flaxia-work`, and emits a file
dump marker after each command. `LinuxSession` diffs host changes into the
session and applies guest changes back to IndexedDB. Network commands still use
a one-shot container because the guest must boot with DHCP.

JIT is a separate future path: container2wasm's `--to-js` output is a
QEMU/Emscripten image, not interchangeable with the WASI/Bochs image used here.

## Workspace sync

1. `LinuxRuntime.run()` snapshots every text file into `{path, content}`.
2. The worker builds a nested `Map` and exposes it as a
   `PreopenDirectory('/workspace', …)`.
3. container2wasm's guest init mounts it over virtio-9p at `/workspace`.
4. The command wrapper copies `/workspace` into `/tmp/flaxia-work`, applies
   `chmod -R u+rwx` (the virtio-9p preopen does not carry POSIX mode bits), runs
   the command there, then copies the result back.
5. The worker walks the preopen directory. UTF-8 files are returned as text;
   everything else is base64-encoded **on the worker boundary** with
   `binary: true` (≤ 20 MiB each), and the studio stores it as a Blob.
6. `App.syncGuestFiles()` applies creates/updates/deletes to IndexedDB, stores
   binaries with `writeBinaryFile()` (a Blob, not base64), prunes empty
   directories, and refreshes Monaco models. Media opens in the preview; other
   binaries open a metadata/download dialog instead of Monaco.

The sync is last-write-wins. A dirty editor is saved before a Linux command, and
the guest is authoritative for the command that just ran.

## Boot sequence

1. `loadManifest()` fetches `/linux/manifest.json`.
2. Chunks are downloaded with progress and optionally decompressed with
   `DecompressionStream('gzip')`.
3. The SHA-256 digest is checked against the compressed bytes.
4. `WebAssembly.compile()` produces a module.
5. The worker instantiates with `wasi_snapshot_preview1` and runs
   `uname -a` as a readiness check.
6. The compiled image is cached in the Cache API keyed by version/digest.

## Test Play

Test Play previews the workspace in the browser. The studio page keeps its
strict CSP and never embeds untrusted content directly; the preview runs
through two same-origin documents:

```
studio page (strict CSP, COEP: require-corp)
└─ /play/shell.html            trusted, same origin, relaxed CSP
   └─ /play/runtime.html       sandboxed frame, opaque origin
      └─ entry document        written by the runtime
```

1. The studio builds a payload from the workspace (`src/play/policy.ts`
   applies the Arcade allowlist and limits), then talks to the shell with a
   typed handshake: `ready → init → init-ack → execute → result`.
2. The shell re-validates the payload, rewrites local references in HTML and
   CSS to `blob:flaxia-play/<path>` placeholders (`src/play/rewrite.ts`,
   `src/play/placeholder.ts`) and forwards the bytes to the runtime.
3. The runtime runs **inside** the sandboxed frame, so it owns the blob
   registry: it replaces the placeholders with blob URLs it creates itself and
   writes the entry document. Chromium refuses to load a blob URL that was
   created by another origin, which is why the blobs can not live in the shell.
4. The shell relays the result to the studio, which marks the run as running
   or failed.

`allow-same-origin` is never granted, so the game frame has an opaque origin:
`localStorage` and cookies are unavailable to previewed code. `fetch()` for
workspace files is bridged by the runtime.

The preview is a **tab in the editor area**, not a split view: `App.setActiveView`
swaps the editor column for the preview pane, so editing and previewing never
share the space. Auto reload re-runs the preview in the background and keeps the
current tab — saving never pulls the user away from the editor.

### Rules (mirrored from Flaxia Arcade)

The studio runs the workspace under the same policy as a published game, so a
preview can not do anything Arcade would not allow.

| Rule                                                                                   | Where                                                                                               |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Allowlist, 1024 files, 100 MB extracted, 25 MB transfer, 255-char paths, depth 10      | `src/play/policy.ts`                                                                                |
| No traversal, absolute paths, dotfiles, control characters or duplicates               | `src/play/policy.ts` (`playPathProblem`)                                                            |
| `allow-scripts allow-pointer-lock allow-forms allow-popups`, never `allow-same-origin` | `src/play/policy.ts`, `src/play/shell.ts`                                                           |
| Shell policy (trusted wrapper) + game policy (CSP `sandbox` directive)                 | `vite.config.ts`, `scripts/serve-dist.mjs`, `public/_headers` — guarded by `tests/play-csp.test.ts` |
| `localStorage` seeded from `flaxia:studio:<workspace>` and writes relayed              | `src/play/storage.ts`, `public/play/runtime.js`                                                     |
| `document.cookie` degrades to an empty string                                          | `public/play/runtime.js`                                                                            |
| `<base>` / `<meta http-equiv>` stripped, `GET`/`HEAD` only for assets                  | `public/play/runtime.js`                                                                            |

The runtime frame has an opaque origin, so `src/play/runtime.js` creates the blob
URLs inside the frame (Chromium refuses a blob URL made by another origin). The
seed travels with the execute payload; writes travel back through the shell.

## Headers

The app needs cross-origin isolation only for the worker/SAB-friendly runtime:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Content-Security-Policy: …
  script-src 'self' 'wasm-unsafe-eval';
  worker-src 'self' blob:;
  style-src 'self' 'unsafe-inline';
```

`style-src 'unsafe-inline'` is required by Monaco and xterm. Scripts stay strict:
the theme boot lives in `public/theme-boot.js` rather than an inline script.

The `/play/*` rule replaces the CSP with the relaxed game policy and swaps
COEP for `credentialless`, because a cross-origin isolated page may only embed
frames that opt in. The same CSP string is kept in `public/_headers`,
`scripts/serve-dist.mjs` and `vite.config.ts` — change all three together.

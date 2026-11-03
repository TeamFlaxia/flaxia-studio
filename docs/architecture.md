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

| Path                             | Responsibility                                                  |
| -------------------------------- | --------------------------------------------------------------- |
| `src/app.ts`                     | Shell, commands, state, keyboard, workspace/Linux orchestration |
| `src/editor/monaco.ts`           | Monaco setup, workers, themes, models, dirty state              |
| `src/fs/`                        | Path rules, IndexedDB persistence, ZIP import/export            |
| `src/linux/manifest.ts`          | Manifest validation and chunk URL resolution                    |
| `src/linux/runtime.ts`           | Worker lifecycle, boot, progress, command queue, cache          |
| `src/terminal/shell.ts`          | xterm shell, local commands, Linux routing                      |
| `public/linux-runtime/worker.js` | WASI boot, `/workspace` preopen, sync                           |
| `src/ui/`                        | Palette, dialogs, toasts, context menu                          |

## Workspace sync

1. `LinuxRuntime.run()` snapshots every text file into `{path, content}`.
2. The worker builds a nested `Map` and exposes it as a
   `PreopenDirectory('/workspace', …)`.
3. container2wasm's guest init mounts it over virtio-9p at `/workspace`.
4. The command wrapper copies `/workspace` into `/tmp/flaxia-work`, runs the
   command there (so executable bits work), then copies the result back.
5. The worker walks the preopen directory. UTF-8 files are returned as text;
   everything else is base64-encoded with `binary: true` (≤ 20 MiB each).
6. `App.syncGuestFiles()` applies creates/updates/deletes to IndexedDB, stores
   binaries with `writeBinaryFile()`, prunes empty directories, and refreshes
   Monaco models. Binaries open a metadata/download dialog instead of Monaco.

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

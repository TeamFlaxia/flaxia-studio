# Linux image

The IDE loads a container2wasm **WASI** image (the default `c2w` output, not
`--to-js`). The browser worker feeds it to `browser_wasi_shim` and mounts the
workspace as a preopen directory.

## Build

Requirements:

- Docker with buildx
- `c2w` v0.8.x on `PATH`
- ~10 GB free disk for the first BuildKit run

```bash
npm run build:linux
```

The script runs:

1. `docker build -f docker/studio-linux.Dockerfile -t flaxia-studio-linux:dev .`
2. `c2w flaxia-studio-linux:dev .tmp/studio-linux.wasm`
3. gzip level 9
4. split into 24 MiB chunks (`chunk-NN.wasm.gz`)
5. write `manifest.json` with the SHA-256 of the gzipped stream

The output directory defaults to `public/linux`. Artifacts are intentionally
gitignored.

## Image contents

`docker/studio-linux.Dockerfile` starts from `debian:bookworm-slim` and installs
`build-essential`, `python3`, `git`, `curl`, `less`, `vim-tiny`, and `procps`.
The entrypoint is `/bin/sh`; the worker supplies `-entrypoint /bin/sh -- -c …`.

## Hosting

For Cloudflare Pages, keep each file below 25 MiB. The build script uses 24 MiB
chunks. For production, prefer R2 or another static host with:

- `Cache-Control: public, max-age=31536000, immutable` on chunks
- `Cache-Control: no-cache` on the manifest
- CORS and `Cross-Origin-Resource-Policy: cross-origin` if the image host is not
  same-origin with the app

Point **Settings → Linux image manifest** at the manifest URL.

## Local demo

`npm run fetch:linux-lite` downloads the Alpine Python image (~145 MB) and
writes `manifest-lite.json`. `npm run fetch:linux-full` downloads the Debian+gcc
example (~440 MB) and writes `manifest-full.json`. Both are for local validation;
do not use them as production images. The default image setting is `auto`,
which prefers a production build, then lite, then full.

## Licenses

Generated WASM bundles third-party code (Bochs, Linux, GRUB, runc, and others).
Check `/usr/share/doc/*/copyright` in the image and the container2wasm
acknowledgements before redistributing. See `THIRD_PARTY.md`.

If you use a host other than `linux.studio.flaxia.app`, add it to `connect-src` in `public/_headers`.

## Networking

The browser Fetch proxy (`c2w-net-proxy.wasm` + `stack-worker.js`) is wired into
`public/linux-runtime/worker.js`. It is enabled by **Settings → Linux network**
and is used for commands containing a URL or `curl`/`wget`/`apk`/`pip`/`npm`.
The guest is configured with `http_proxy`/`https_proxy` pointing at
`192.168.127.253:80` and `SSL_CERT_FILE=/.wasmenv/proxy.crt`.

Because each command is a fresh container boot, a network command performs DHCP
again and takes roughly 20–30 s. Offline commands (`gcc`, `make`, `git status`)
stay fast. Use the built-in `fetch <url>` command to exercise the proxy.

Limitations:

- Browser CORS applies. A site must allow the browser origin.
- The proxy certificate is issued for the proxy address, so HTTPS clients must
  skip hostname verification (`curl -k`, Python `ssl._create_unverified_context()`).
  The built-in `fetch` command does this.
- The Fetch proxy is terminated in the browser; forbidden headers cannot be set.
- `connect-src` in `public/_headers` allows `https:` for this feature. Tighten
  it if you only need specific hosts.

Compiled outputs are mirrored back to the workspace as binary files (base64 in
IndexedDB, ≤ 20 MiB each). Use the explorer context menu or the binary dialog to
download them; Export ZIP includes them.

### CORS and package managers

The Fetch proxy still goes through the browser's Fetch API, so the **target**
server must send `Access-Control-Allow-Origin`. That is not something Flaxia
Studio can grant: `dl-cdn.alpinelinux.org` (and most package repositories) do not
send it, and their 301 redirects are blocked before APK can proceed.

- Use the **Full** image (Debian + gcc/build tools) for compiling.
- Build additional tools into `docker/studio-linux.Dockerfile` rather than
  running `apk`/`apt` inside the browser VM.
- If you really need an external package registry, put an **allowlisted
  same-origin proxy** in front of it. Do not create an open "allow everything"
  proxy: it becomes an SSRF/abuse endpoint and still cannot change third-party
  CORS behavior by itself.

## Session vs JIT

Normal commands run in one persistent session (`/workspace/.flaxia/session.sh`)
and cost roughly 0.5–1 s after boot. gcc is still limited by CPU emulation.
container2wasm's JIT backend (`c2w --to-js`, QEMU Wasm) would need a different
prebuilt artifact and Emscripten loader; it is not mixed into this WASI image.

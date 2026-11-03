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

`npm run fetch:linux-demo` downloads the prebuilt Debian+gcc example
(~440 MB) from `ktock.github.io` and writes a manifest. This is useful for
validating compile/run without Docker. Do not use it as a production image.

## Licenses

Generated WASM bundles third-party code (Bochs, Linux, GRUB, runc, and others).
Check `/usr/share/doc/*/copyright` in the image and the container2wasm
acknowledgements before redistributing. See `THIRD_PARTY.md`.

If you use a host other than `linux.studio.flaxia.app`, add it to `connect-src` in `public/_headers`.

## Networking

The MVP runs the image offline. container2wasm's browser Fetch proxy
(`c2w-net-proxy.wasm`) and socket fds are not wired into the worker yet. This
keeps the workspace mount and command sync deterministic. When enabling it,
expect browser CORS and forbidden-header limits, and add the proxy host to the
CSP `connect-src` list.

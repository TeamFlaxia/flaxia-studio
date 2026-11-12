# Flaxia Studio — agent notes

## Commands

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run preview -- --port 4173
npm run test:e2e
```

## Rules

- Keep the Flaxia design language: tokens in `src/styles/tokens.css` are the
  single source of truth. Do not introduce gradients, glass, or glow.
- Scripts stay strict. `public/theme-boot.js` exists because inline scripts are
  blocked by the production CSP.
- Do not add CDN dependencies for Monaco, workers, fonts, or images. The Linux
  image must be same-origin or CORS/CORP-enabled and digest-verified.
- Fetch networking is opt-in per command (URL/curl/wget/apk/pip/npm) because it
  re-boots the guest with DHCP. Keep normal edit/build commands offline.
- Monaco workers are bundled with Vite `?worker` imports. Do not switch to the
  AMD loader.
- `/workspace` sync handles UTF-8 text and binary artifacts (≤ 20 MiB each).
  Binaries are base64-encoded in IndexedDB and must not be opened in Monaco.
- Test Play has two CSPs. The studio page keeps the strict policy; `/play/*`
  uses the relaxed game policy. The relaxed CSP string lives in three places —
  `public/_headers`, `scripts/serve-dist.mjs`, and `vite.config.ts` — and all
  three must stay identical.
- The game frame is sandboxed without `allow-same-origin`, so it has an opaque
  origin. Chromium refuses to load blob URLs created by another origin, which
  is why `public/play/runtime.js` creates the blobs inside the frame and the
  shell hands over `blob:flaxia-play/…` placeholders instead.
- Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`
  before handing work back.

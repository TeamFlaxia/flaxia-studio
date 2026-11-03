#!/usr/bin/env node
/**
 * Download the prebuilt container2wasm Debian+gcc example for local evaluation.
 * This is NOT the production image; use `npm run build:linux` for that.
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BASE = process.env.LINUX_DEMO_BASE ?? 'https://ktock.github.io/image-example/amd64-gcc-debian-wasi';
const CHUNKS = Number(process.env.LINUX_DEMO_CHUNKS ?? 9);
const outDir = resolve(process.env.OUT_DIR ?? 'public/linux');
const version = 'demo-gcc-2024.12';
mkdirSync(outDir, { recursive: true });

for (let index = 0; index < CHUNKS; index += 1) {
  const name = `gcc-raw-${String(index).padStart(2, '0')}.wasm`;
  const target = join(outDir, name);
  if (existsSync(target) && statSync(target).size > 0) {
    console.log(`skip ${name} (${statSync(target).size} bytes)`);
    continue;
  }
  const url = `${BASE}${String(index).padStart(2, '0')}.wasm`;
  console.log(`fetch ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  console.log(`wrote ${name} (${statSync(target).size} bytes)`);
}

// Re-split into <25 MiB chunks so the local demo is also Cloudflare Pages safe.
const downloaded = [];
for (let index = 0; index < CHUNKS; index += 1) {
  downloaded.push(readFileSync(join(outDir, `gcc-raw-${String(index).padStart(2, '0')}.wasm`)));
}
const all = Buffer.concat(downloaded);
for (const file of readdirSync(outDir)) {
  if (/^gcc-(?:raw|debian)-\d+\.wasm$/.test(file)) rmSync(join(outDir, file), { force: true });
}
const chunkSize = 24 * 1024 * 1024;
const chunks = Math.ceil(all.length / chunkSize);
for (let index = 0; index < chunks; index += 1) {
  const name = `gcc-debian-${String(index).padStart(2, '0')}.wasm`;
  writeFileSync(
    join(outDir, name),
    all.subarray(index * chunkSize, Math.min(all.length, (index + 1) * chunkSize)),
  );
}

const manifest = {
  version,
  label: 'Debian gcc (prebuilt demo image)',
  description:
    'Prebuilt container2wasm gcc example for local evaluation. Build your own image for production.',
  chunks,
  chunkUrlTemplate: './gcc-debian-{index}.wasm',
  compression: 'none',
  totalBytes: all.length,
  builtAt: new Date().toISOString(),
  c2wVersion: 'prebuilt',
};
writeFileSync(join(outDir, 'manifest-full.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote manifest-full.json (${chunks} chunks, ${all.length} bytes).`);

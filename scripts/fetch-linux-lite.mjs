#!/usr/bin/env node
/**
 * Download the smaller Alpine Python container2wasm demo image, then re-split
 * it into <25 MiB chunks so it is also Cloudflare Pages safe.
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

const BASE =
  process.env.LINUX_LITE_BASE ??
  'https://ktock.github.io/container2wasm-demo/containers/amd64-python-wasi-container';
const CHUNKS = Number(process.env.LINUX_LITE_CHUNKS ?? 3);
const outDir = resolve(process.env.OUT_DIR ?? 'public/linux');
mkdirSync(outDir, { recursive: true });

const raw = [];
for (let index = 0; index < CHUNKS; index += 1) {
  const name = `python-raw-${String(index).padStart(2, '0')}.wasm`;
  const target = join(outDir, name);
  if (!existsSync(target) || statSync(target).size === 0) {
    const url = `${BASE}${String(index).padStart(2, '0')}.wasm`;
    console.log(`fetch ${url}`);
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  }
  raw.push(readFileSync(target));
}
const all = Buffer.concat(raw);
for (const file of readdirSync(outDir)) {
  if (/^python-(?:raw|alpine)-\d+\.wasm$/.test(file)) rmSync(join(outDir, file), { force: true });
}
const chunkSize = 24 * 1024 * 1024;
const chunks = Math.ceil(all.length / chunkSize);
for (let index = 0; index < chunks; index += 1) {
  const name = `python-alpine-${String(index).padStart(2, '0')}.wasm`;
  writeFileSync(
    join(outDir, name),
    all.subarray(index * chunkSize, Math.min(all.length, (index + 1) * chunkSize)),
  );
}
const manifest = {
  version: 'python-alpine-demo',
  label: 'Alpine Python (light demo)',
  description: 'Smaller container2wasm Alpine Python image for faster boots.',
  chunks,
  chunkUrlTemplate: './python-alpine-{index}.wasm',
  compression: 'none',
  totalBytes: all.length,
  builtAt: new Date().toISOString(),
  c2wVersion: 'prebuilt',
};
writeFileSync(join(outDir, 'manifest-lite.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote manifest-lite.json (${chunks} chunks, ${all.length} bytes).`);

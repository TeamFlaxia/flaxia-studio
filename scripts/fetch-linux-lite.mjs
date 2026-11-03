#!/usr/bin/env node
/**
 * Download the smaller Alpine Python container2wasm demo image.
 * The result is written as manifest-lite.json for the "Auto" image setting.
 */
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BASE =
  process.env.LINUX_LITE_BASE ??
  'https://ktock.github.io/container2wasm-demo/containers/amd64-python-wasi-container';
const CHUNKS = Number(process.env.LINUX_LITE_CHUNKS ?? 3);
const outDir = resolve(process.env.OUT_DIR ?? 'public/linux');
mkdirSync(outDir, { recursive: true });
const files = [];
for (let index = 0; index < CHUNKS; index += 1) {
  const name = `python-alpine-${String(index).padStart(2, '0')}.wasm`;
  const target = join(outDir, name);
  if (!existsSync(target) || statSync(target).size === 0) {
    const url = `${BASE}${String(index).padStart(2, '0')}.wasm`;
    console.log(`fetch ${url}`);
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  }
  files.push(name);
}
const total = files.reduce((sum, name) => sum + statSync(join(outDir, name)).size, 0);
const manifest = {
  version: 'python-alpine-demo',
  label: 'Alpine Python (light demo)',
  description: 'Smaller container2wasm Alpine Python image for faster boots.',
  chunks: CHUNKS,
  chunkUrlTemplate: './python-alpine-{index}.wasm',
  compression: 'none',
  totalBytes: total,
  builtAt: new Date().toISOString(),
  c2wVersion: 'prebuilt',
};
const { writeFileSync } = await import('node:fs');
writeFileSync(join(outDir, 'manifest-lite.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote manifest-lite.json (${total} bytes).`);

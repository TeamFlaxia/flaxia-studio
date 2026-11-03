#!/usr/bin/env node
/**
 * Verify a built Flaxia Studio Linux image: chunk count, total size, gzip
 * decompression, and digest from the manifest.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const dir = resolve(process.argv[2] ?? 'public/linux');
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const chunks = [];
for (let index = 0; index < manifest.chunks; index += 1) {
  const name = manifest.chunkUrlTemplate.replace('{index}', String(index).padStart(2, '0'));
  chunks.push(readFileSync(join(dir, name)));
}
const joined = Buffer.concat(chunks);
const digest = createHash('sha256').update(joined).digest('hex');
if (manifest.digest && digest !== manifest.digest) {
  throw new Error(`Digest mismatch: expected ${manifest.digest}, got ${digest}`);
}
if (joined.length !== manifest.totalBytes) {
  throw new Error(`Size mismatch: expected ${manifest.totalBytes}, got ${joined.length}`);
}
const raw = manifest.compression === 'gzip' ? gunzipSync(joined) : joined;
console.log(
  `OK: ${manifest.chunks} chunks, ${joined.length} bytes, wasm ${raw.length} bytes, digest ${digest}`,
);

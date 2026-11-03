#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
/**
 * Build the Flaxia Studio container2wasm Linux image, gzip it, split it into
 * <25 MB chunks, and write a manifest that the browser worker can consume.
 *
 * Requirements:
 *   - docker with buildx
 *   - c2w (container2wasm) >= 0.8.x on PATH (or C2W=/path/to/c2w)
 *
 * Usage:
 *   npm run build:linux
 *   C2W=./bin/c2w OUT_DIR=public/linux npm run build:linux
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, process.env.OUT_DIR ?? 'public/linux');
const imageTag = process.env.IMAGE_TAG ?? 'flaxia-studio-linux:dev';
const dockerfile = resolve(root, 'docker/studio-linux.Dockerfile');
const c2w = process.env.C2W ?? 'c2w';
const chunkSize = Number(process.env.CHUNK_SIZE ?? 24 * 1024 * 1024);
const version = process.env.LINUX_VERSION ?? new Date().toISOString().slice(0, 10).replaceAll('-', '.');
const keepRaw = process.env.KEEP_RAW === '1';

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  return execFileSync(command, args, { stdio: 'inherit', ...options });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireBinary(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!requireBinary('docker')) {
  console.error('docker is required to build the Linux image (buildx).');
  process.exit(1);
}
if (!requireBinary(c2w)) {
  console.error(`container2wasm (c2w) was not found. Install it or set C2W=... .`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const rawPath = resolve(root, '.tmp/studio-linux.wasm');
mkdirSync(resolve(root, '.tmp'), { recursive: true });
rmSync(rawPath, { force: true });

run('docker', ['build', '-f', dockerfile, '-t', imageTag, root]);
run(c2w, [imageTag, rawPath]);

if (!existsSync(rawPath)) {
  console.error('c2w did not create the expected wasm file.');
  process.exit(1);
}

const raw = readFileSync(rawPath);
console.log(`Raw wasm: ${raw.byteLength} bytes`);
const compressed = gzipSync(raw, { level: 9 });
console.log(`Gzipped:  ${compressed.byteLength} bytes`);

// Remove stale chunks from a previous build.
for (const file of readdirSafe(outDir)) {
  if (/^chunk-\d+\.wasm(\.gz)?$/.test(file) || file === 'manifest.json') {
    rmSync(join(outDir, file), { force: true });
  }
}

const chunks = Math.ceil(compressed.byteLength / chunkSize);
for (let index = 0; index < chunks; index += 1) {
  const start = index * chunkSize;
  const end = Math.min(compressed.byteLength, start + chunkSize);
  const name = `chunk-${String(index).padStart(2, '0')}.wasm.gz`;
  writeFileSync(join(outDir, name), compressed.subarray(start, end));
  console.log(`Wrote ${name} (${end - start} bytes)`);
}

const manifest = {
  version,
  label: process.env.LINUX_LABEL ?? 'Debian bookworm + build-essential',
  description: 'Flaxia Studio Linux workspace image. Built from docker/studio-linux.Dockerfile.',
  chunks,
  chunkUrlTemplate: './chunk-{index}.wasm.gz',
  compression: 'gzip',
  totalBytes: compressed.byteLength,
  digest: sha256(compressed),
  builtAt: new Date().toISOString(),
  c2wVersion: process.env.C2W_VERSION ?? '0.8.x',
  source: basename(dockerfile),
};
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote manifest.json (${chunks} chunks, digest ${manifest.digest})`);

if (!keepRaw) rmSync(rawPath, { force: true });
console.log(`\nNext: upload ${outDir} to R2 or deploy with the app.`);

function readdirSafe(path) {
  try {
    execFileSync('sh', ['-c', `test -d ${JSON.stringify(path)}`], { stdio: 'ignore' });
    return execFileSync('sh', ['-c', `ls -1 ${JSON.stringify(path)}`], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

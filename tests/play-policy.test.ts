import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extensionOf,
  isPlayPayloadPath,
  mimeForPath,
  PLAY_MAX_TRANSFER_BYTES,
  type PlayFile,
  pickEntryPoint,
  validatePlayFiles,
} from '../src/play/policy.ts';

function file(path: string, size = 4): PlayFile {
  return { path, bytes: new Uint8Array(size) };
}

test('extension and mime resolution', () => {
  assert.equal(extensionOf('src/main.js'), '.js');
  assert.equal(extensionOf('a/b.WASM'), '.wasm');
  assert.equal(extensionOf('noext'), '');
  assert.equal(extensionOf('.gitignore'), '');
  assert.equal(mimeForPath('index.html'), 'text/html');
  assert.equal(mimeForPath('icon.svg'), null);
  assert.equal(mimeForPath('notes.md'), null);
});

test('payload allowlist skips sources and nested archives', () => {
  assert.equal(isPlayPayloadPath('index.html'), true);
  assert.equal(isPlayPayloadPath('src/main.js'), true);
  assert.equal(isPlayPayloadPath('README.md'), false);
  assert.equal(isPlayPayloadPath('src/main.ts'), false);
  assert.equal(isPlayPayloadPath('lib.zip'), false);
  assert.equal(isPlayPayloadPath('sprite.svg'), false);
});

test('pickEntryPoint prefers the shallowest index, ties broken lexicographically', () => {
  assert.equal(pickEntryPoint(['a/index.html', 'index.html']), 'index.html');
  assert.equal(pickEntryPoint(['b/index.htm', 'a/index.html']), 'a/index.html');
  assert.equal(pickEntryPoint(['x/app.html', 'README.md']), null);
  assert.equal(pickEntryPoint([]), null);
});

test('validatePlayFiles accepts a small web workspace', () => {
  const payload = validatePlayFiles([
    file('index.html', 40),
    file('src/style.css', 20),
    file('src/main.js', 10),
    file('assets/logo.png', 64),
  ]);
  assert.equal(payload.entry, 'index.html');
  assert.equal(payload.totalBytes, 134);
  assert.equal(payload.files.length, 4);
});

test('validatePlayFiles rejects unsafe or unsupported paths', () => {
  assert.throws(() => validatePlayFiles([file('../escape.html')]), /traversal/);
  assert.throws(() => validatePlayFiles([file('/abs.html')]), /Absolute/);
  assert.throws(() => validatePlayFiles([file('a/b/c/d/e/f/g/h/i/j/k/index.html')]), /too deep/);
  assert.throws(() => validatePlayFiles([file('a\\b.html')]), /traversal/);
  assert.throws(() => validatePlayFiles([file('notes.md')]), /not allowed/);
  assert.throws(() => validatePlayFiles([file('bundle.zip')]), /Nested ZIP/);
  assert.throws(() => validatePlayFiles([file('index.htm'.padEnd(300, 'x'))]), /Path too long/);
});

test('validatePlayFiles enforces count and transfer limits', () => {
  const many = Array.from({ length: 1025 }, (_, index) => file(`f${index}.txt`));
  assert.throws(() => validatePlayFiles(many), /Too many files/);

  const oversized = file('big.png', PLAY_MAX_TRANSFER_BYTES + 1);
  assert.throws(() => validatePlayFiles([file('index.html'), oversized]), /Payload too large/);
});

test('validatePlayFiles requires an entry document', () => {
  assert.throws(() => validatePlayFiles([file('src/main.js')]), /index.html not found/);
});

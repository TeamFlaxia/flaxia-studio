import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { exportZip, importZip } from '../src/fs/zip.ts';

test('round-trips text files and skips traversal entries', () => {
  const traversal = exportZip([{ path: '../escape.txt', type: 'text', text: 'no' }]);
  const blocked = importZip(traversal);
  assert.equal(blocked.files.length, 0);
  const zip = zipSync({
    'README.md': strToU8('# hi'),
    'src/main.ts': strToU8('export const x = 1;'),
  });
  const result = importZip(zip);
  assert.deepEqual(result.files.map((file) => file.path).sort(), ['README.md', 'src/main.ts']);
  const exported = exportZip(result.files);
  const again = importZip(exported);
  assert.equal(again.files.length, 2);
});

test('preserves binary ZIP entries', () => {
  const binary = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0xff, 0x10]);
  const zip = zipSync({ 'a.out': binary });
  const result = importZip(zip);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]?.type, 'binary');
  const first = result.files[0];
  assert.ok(first && first.type === 'binary');
  assert.deepEqual([...first.bytes], [...binary]);
  const roundTrip = importZip(exportZip(result.files));
  const again = roundTrip.files[0];
  assert.ok(again && again.type === 'binary');
  assert.deepEqual([...again.bytes], [...binary]);
});

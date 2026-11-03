import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { exportZip, importZip } from '../src/fs/zip.ts';

test('round-trips text files and skips traversal entries', () => {
  const traversal = exportZip([{ path: '../escape.txt', content: 'no' }]);
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

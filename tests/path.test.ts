import assert from 'node:assert/strict';
import test from 'node:test';
import {
  basename,
  dirname,
  extname,
  isPathInside,
  joinPath,
  languageForPath,
  normalizePath,
  uniquePath,
} from '../src/fs/path.ts';

test('normalizes workspace paths and rejects escapes', () => {
  assert.equal(normalizePath('./src//main.ts'), 'src/main.ts');
  assert.equal(normalizePath('src/../README.md'), 'README.md');
  assert.throws(() => normalizePath('../secret'), /escapes/);
  assert.throws(() => normalizePath('/etc/passwd'), /Absolute/);
  assert.throws(() => normalizePath('bad\nname'), /Invalid/);
  assert.throws(() => normalizePath('bad\u0000name'), /Invalid/);
});

test('path helpers', () => {
  assert.equal(joinPath('src', 'nested', 'a.ts'), 'src/nested/a.ts');
  assert.equal(dirname('src/nested/a.ts'), 'src/nested');
  assert.equal(basename('src/nested/a.ts'), 'a.ts');
  assert.equal(extname('src/nested/a.ts'), '.ts');
  assert.equal(isPathInside('src/a/b.ts', 'src'), true);
  assert.equal(isPathInside('src2/a.ts', 'src'), false);
});

test('language mapping and unique names', () => {
  assert.equal(languageForPath('a.ts'), 'typescript');
  assert.equal(languageForPath('a.json'), 'json');
  assert.equal(uniquePath(new Set(['a.ts', 'a 2.ts']), 'a.ts'), 'a 3.ts');
});

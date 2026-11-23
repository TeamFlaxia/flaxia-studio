import assert from 'node:assert/strict';
import test from 'node:test';
import type { ZipFile } from '../src/fs/zip.ts';
import { importZip } from '../src/fs/zip.ts';
import { arcadeExclusionReason, buildArcadeZip, selectArcadeFiles } from '../src/game/export.ts';

function text(path: string, content = ''): ZipFile {
  return { path, type: 'text', text: content };
}

const SAMPLE: ZipFile[] = [
  text('index.html', '<html></html>'),
  text('src/main.js', 'console.log(1)'),
  text('src/style.css', 'body{}'),
  { path: 'img.png', type: 'binary', bytes: new Uint8Array([1, 2, 3]) },
  text('README.md', 'project notes'),
  text('.flaxia/timeline.json', '{}'),
];

test('selectArcadeFiles keeps game assets and excludes project files', () => {
  const { included, excluded } = selectArcadeFiles(SAMPLE);
  assert.deepEqual(
    included.map((file) => file.path),
    ['index.html', 'src/main.js', 'src/style.css', 'img.png'],
  );
  assert.deepEqual(
    excluded.map((file) => file.path),
    ['README.md', '.flaxia/timeline.json'],
  );
});

test('dotfiles and disallowed extensions have clear reasons', () => {
  assert.match(arcadeExclusionReason('.flaxia/timeline.json') ?? '', /Dotfiles/);
  assert.match(arcadeExclusionReason('README.md') ?? '', /allowlist/);
  assert.equal(arcadeExclusionReason('index.html'), null);
});

test('buildArcadeZip produces a ZIP importable without project files', () => {
  const result = buildArcadeZip(SAMPLE);
  assert.equal(result.entry, 'index.html');
  assert.equal(result.excluded.length, 2);

  const imported = importZip(result.bytes);
  const paths = imported.files.map((file) => file.path);
  assert.ok(paths.includes('index.html'));
  assert.ok(paths.includes('img.png'));
  assert.ok(!paths.includes('README.md'));
  assert.ok(!paths.includes('.flaxia/timeline.json'));
});

test('a workspace without an entry document cannot be exported', () => {
  assert.throws(() => buildArcadeZip([text('README.md')]), /No index.html/);
});

test('duplicate publishable paths are reported as excluded', () => {
  const { excluded } = selectArcadeFiles([text('index.html'), text('index.html')]);
  assert.equal(excluded.length, 1);
  assert.match(excluded[0]?.reason ?? '', /Duplicate/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { assetPlaceholder, isRewrittenAsset, placeholderResolver } from '../src/play/placeholder.ts';

test('assetPlaceholder encodes the payload path and keeps the suffix', () => {
  assert.equal(assetPlaceholder('src/main.js'), 'blob:flaxia-play/src%2Fmain.js');
  assert.equal(assetPlaceholder('a b.png', '?v=2#top'), 'blob:flaxia-play/a%20b.png?v=2#top');
});

test('placeholderResolver only rewrites references that exist in the payload', () => {
  const resolve = placeholderResolver(new Set(['src/main.js', 'src/style.css']));
  assert.equal(resolve('src/main.js', 'index.html'), 'blob:flaxia-play/src%2Fmain.js');
  assert.equal(resolve('./src/main.js?v=1', 'index.html'), 'blob:flaxia-play/src%2Fmain.js?v=1');
  assert.equal(resolve('missing.js', 'index.html'), null);
  assert.equal(resolve('https://cdn.example/x.js', 'index.html'), null);
  assert.equal(resolve('#anchor', 'index.html'), null);
});

test('isRewrittenAsset marks the documents the shell rewrites', () => {
  assert.equal(isRewrittenAsset('index.html'), true);
  assert.equal(isRewrittenAsset('about.HTM'), true);
  assert.equal(isRewrittenAsset('src/style.css'), true);
  assert.equal(isRewrittenAsset('src/main.js'), false);
  assert.equal(isRewrittenAsset('img/logo.png'), false);
});

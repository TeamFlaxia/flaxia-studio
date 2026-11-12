import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mapResolver,
  resolveArchiveUrl,
  rewriteCssUrls,
  rewriteHtmlString,
  shouldRewritePath,
} from '../src/play/rewrite.ts';

test('shouldRewritePath skips external and generated references', () => {
  assert.equal(shouldRewritePath('./main.js'), true);
  assert.equal(shouldRewritePath('https://cdn.example/x.js'), false);
  assert.equal(shouldRewritePath('http://localhost/x.js'), false);
  assert.equal(shouldRewritePath('data:text/css,body{}'), false);
  assert.equal(shouldRewritePath('blob:https://example/uuid'), false);
});

test('resolveArchiveUrl resolves against the payload path', () => {
  assert.deepEqual(resolveArchiveUrl('main.js', 'index.html'), { path: 'main.js', suffix: '' });
  assert.deepEqual(resolveArchiveUrl('../img/a.png', 'src/css/site.css'), {
    path: 'src/img/a.png',
    suffix: '',
  });
  assert.deepEqual(resolveArchiveUrl('main.js?v=2#top', 'index.html'), {
    path: 'main.js',
    suffix: '?v=2#top',
  });
  assert.equal(resolveArchiveUrl('https://ext.example/a.png', 'index.html'), null);
  assert.equal(resolveArchiveUrl('#section', 'index.html'), null);
  assert.equal(resolveArchiveUrl('', 'index.html'), null);
  // Escaping the virtual archive still stays on the archive origin, so the
  // reference can never point at a real URL — it simply has no payload file.
  assert.deepEqual(resolveArchiveUrl('../../etc/passwd', 'index.html'), {
    path: 'etc/passwd',
    suffix: '',
  });
});

test('mapResolver maps payload paths and keeps suffixes', () => {
  const resolve = mapResolver(
    new Map([
      ['main.js', 'blob:one'],
      ['img/a.png', 'blob:two'],
    ]),
  );
  assert.equal(resolve('main.js', 'index.html'), 'blob:one');
  assert.equal(resolve('main.js?v=1', 'index.html'), 'blob:one?v=1');
  assert.equal(resolve('missing.js', 'index.html'), null);
  assert.equal(resolve('https://ext.example/a.js', 'index.html'), null);
});

test('rewriteCssUrls rewrites url() and @import, leaving externals alone', () => {
  const resolve = mapResolver(
    new Map([
      ['fonts/x.woff2', 'blob:font'],
      ['a.css', 'blob:a'],
    ]),
  );
  const css = [
    '@font-face { src: url("fonts/x.woff2") format("woff2"); }',
    'body { background: url(../img/bg.png); }',
    '@import "a.css";',
    'div { background: url("https://cdn.example/p.png"); }',
  ].join('\n');
  const out = rewriteCssUrls(css, resolve, 'site.css');
  assert.match(out, /url\("blob:font"\)/);
  assert.match(out, /@import url\("blob:a"\)/);
  assert.match(out, /https:\/\/cdn\.example\/p\.png/);
  assert.match(out, /url\(\.\.\/img\/bg\.png\)/);
});

test('rewriteHtmlString rewrites src, href, style blocks and attributes', () => {
  const resolve = mapResolver(
    new Map([
      ['src/main.js', 'blob:js'],
      ['src/style.css', 'blob:css'],
      ['img/logo.png', 'blob:img'],
    ]),
  );
  const html = [
    '<html><head>',
    '<link rel="stylesheet" href="src/style.css" />',
    '<style>body { background: url(img/logo.png); }</style>',
    '</head><body>',
    '<script type="module" src="src/main.js"></script>',
    '<img src="img/logo.png" style="border: url(img/logo.png)" />',
    '<a href="https://example.com/">external</a>',
    '</body></html>',
  ].join('\n');
  const out = rewriteHtmlString(html, resolve, 'index.html');
  assert.match(out, /href="blob:css"/);
  assert.match(out, /src="blob:js"/);
  assert.match(out, /url\("blob:img"\)/);
  assert.match(out, /href="https:\/\/example\.com\/"/);
});

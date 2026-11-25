import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type CompatibilityFile,
  type CompatibilityIssue,
  checkArcadeCompatibility,
  PLAY_MAX_FILE_COUNT,
  PLAY_MAX_PATH_LENGTH,
  PLAY_MAX_TOTAL_BYTES,
  PLAY_MAX_TRANSFER_BYTES,
} from '../src/play/policy.ts';

function text(path: string, content = ''): CompatibilityFile {
  return { path, content };
}

function summary(issues: readonly CompatibilityIssue[]) {
  return issues.map(({ code, scope, severity, path }) => ({ code, scope, severity, path }));
}

test('a normal web project has no compatibility issues', () => {
  const issues = checkArcadeCompatibility([
    text('index.html', '<!doctype html><html><body>Hello</body></html>'),
    text('main.js', 'document.body.textContent = "Hello";'),
    text('style.css', 'body { color: #222; }'),
    { path: 'assets/logo.png', binary: true, size: 2048 },
  ]);
  assert.deepEqual(issues, []);
});

test('dotfiles are Arcade errors', () => {
  const issues = checkArcadeCompatibility([text('index.html'), text('.flaxia/timeline.json', '{}')]);
  assert.deepEqual(summary(issues), [
    { code: 'dotfile', scope: 'arcade', severity: 'error', path: '.flaxia/timeline.json' },
  ]);
});

test('README.md is outside the allowlist and must be excluded from a published ZIP', () => {
  const issues = checkArcadeCompatibility([text('index.html'), text('README.md', '# Game')]);
  assert.deepEqual(summary(issues), [
    { code: 'disallowed-extension', scope: 'arcade', severity: 'error', path: 'README.md' },
  ]);
});

test('a missing entry document is an Arcade error', () => {
  const issues = checkArcadeCompatibility([text('main.js', 'console.log(1);')]);
  assert.deepEqual(summary(issues), [
    { code: 'missing-entry', scope: 'arcade', severity: 'error', path: null },
  ]);
});

test('a large payload is a Test Play-only transfer warning', () => {
  const issues = checkArcadeCompatibility([text('index.html', 'x'.repeat(PLAY_MAX_TRANSFER_BYTES + 1))]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.code, 'transfer-too-large');
  assert.equal(issues[0]?.scope, 'test-play');
  assert.equal(issues[0]?.severity, 'warning');
  assert.equal(issues[0]?.path, null);
  assert.match(issues[0]?.message ?? '', /25MB/);
  assert.match(issues[0]?.message ?? '', /specific to Test Play/);
  assert.match(issues[0]?.message ?? '', /Arcade has no transfer cap/);
});

test('localStorage in a script is an Arcade static warning', () => {
  const issues = checkArcadeCompatibility([
    text('index.html'),
    text('main.js', 'const saved = localStorage.getItem("save");'),
  ]);
  assert.deepEqual(summary(issues), [
    { code: 'local-storage', scope: 'arcade', severity: 'warning', path: 'main.js' },
  ]);
  assert.match(issues[0]?.message ?? '', /opaque origin/);
  assert.match(issues[0]?.message ?? '', /CDN dependencies/);
});

test('nested ZIP files are Arcade errors', () => {
  const issues = checkArcadeCompatibility([
    text('index.html'),
    { path: 'bundle.zip', binary: true, size: 8 },
  ]);
  assert.deepEqual(summary(issues), [
    { code: 'nested-zip', scope: 'arcade', severity: 'error', path: 'bundle.zip' },
  ]);
});

test('results are deduplicated and stably sorted by code, scope and path', () => {
  const issues = checkArcadeCompatibility([
    text('index.html'),
    text('z.js', 'localStorage.setItem("a", "1");\nlocalStorage.setItem("b", "2");'),
    text('a.js', 'localStorage.setItem("c", "3");'),
    text('.flaxia/timeline.json', '{}'),
    text('README.md', '# docs'),
  ]);
  const keys = issues.map((issue) => `${issue.code}|${issue.scope}|${issue.path ?? ''}`);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(issues.filter((issue) => issue.code === 'local-storage' && issue.path === 'z.js').length, 1);
  assert.deepEqual(keys.slice(0, 3), [
    'disallowed-extension|arcade|README.md',
    'dotfile|arcade|.flaxia/timeline.json',
    'local-storage|arcade|a.js',
  ]);
});

test('path rule violations map to Arcade error codes', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['../escape.html', 'path-traversal'],
    ['/abs.html', 'absolute-path'],
    ['bad?name.html', 'invalid-path'],
    [`${'x'.repeat(PLAY_MAX_PATH_LENGTH)}.html`, 'path-too-long'],
    ['a/b/c/d/e/f/g/h/i/j/k/index.html', 'path-too-deep'],
    ['bad\u0001name.html', 'control-character'],
  ];
  for (const [path, code] of cases) {
    const issues = checkArcadeCompatibility([{ path, binary: true, size: 1 }]);
    const issue = issues.find((item) => item.code === code);
    assert.ok(issue, `${path} should produce ${code}`);
    assert.equal(issue.scope, 'arcade', path);
    assert.equal(issue.severity, 'error', path);
  }
});

test('commented-out risky APIs do not produce warnings', () => {
  const issues = checkArcadeCompatibility([
    text('index.html'),
    text(
      'main.js',
      '// localStorage.setItem("x", "1")\n/*\ndocument.cookie = "x";\nnew Worker("w.js");\n*/\nconst ok = 1;',
    ),
  ]);
  assert.deepEqual(issues, []);
});

test('static hints cover cookies, workers and unresolved imports', () => {
  const issues = checkArcadeCompatibility([
    text('index.html'),
    text(
      'main.js',
      [
        "document.cookie = 'x';",
        "new Worker('worker.js');",
        "import('./chunk.js');",
        "import { Scene } from 'three';",
        "import 'side-effect-pkg';",
        "import './local.js';",
        'import scripts from "https://cdn.example.com/lib.js";',
      ].join('\n'),
    ),
  ]);
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['bare-import', 'bare-import', 'document-cookie', 'dynamic-import', 'worker'],
  );
  assert.deepEqual(
    issues
      .filter((issue) => issue.code === 'bare-import')
      .map((issue) => issue.message.match(/"([^"]+)"/)?.[1]),
    ['side-effect-pkg', 'three'],
  );
});

test('file count and extracted size limits are Arcade errors', () => {
  const many = Array.from({ length: PLAY_MAX_FILE_COUNT + 1 }, (_, index) => text(`f${index}.txt`, 'a'));
  const countIssues = checkArcadeCompatibility(many);
  assert.ok(countIssues.some((issue) => issue.code === 'too-many-files'));
  assert.ok(countIssues.some((issue) => issue.code === 'missing-entry'));

  const sizeIssues = checkArcadeCompatibility([
    text('index.html'),
    { path: 'huge.data', binary: true, size: PLAY_MAX_TOTAL_BYTES + 1 },
  ]);
  assert.deepEqual(summary(sizeIssues), [
    { code: 'extracted-too-large', scope: 'arcade', severity: 'error', path: null },
    { code: 'transfer-too-large', scope: 'test-play', severity: 'warning', path: null },
  ]);
});

test('an index.htm entry is flagged and warned about', () => {
  const issues = checkArcadeCompatibility([text('index.htm', '<html></html>')]);
  assert.deepEqual(summary(issues), [
    { code: 'disallowed-extension', scope: 'arcade', severity: 'error', path: 'index.htm' },
    { code: 'entry-not-html', scope: 'arcade', severity: 'warning', path: 'index.htm' },
  ]);
});

test('binary files are not scanned as text even when content is present', () => {
  const issues = checkArcadeCompatibility([
    text('index.html'),
    { path: 'bundle.js', binary: true, size: 40, content: 'localStorage.getItem("x")' },
  ]);
  assert.deepEqual(issues, []);
});

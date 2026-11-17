import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * The Test Play policies live in three places: the Cloudflare header file and
 * the two servers that emulate it. They must not drift apart — a stricter
 * policy on one origin and a looser one on another is exactly the kind of
 * difference that turns into a hole.
 */

const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
const serveDist = readFileSync(new URL('../scripts/serve-dist.mjs', import.meta.url), 'utf8');

function headerPolicy(rule: string): string {
  const lines = headers.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === rule);
  assert.ok(start >= 0, `missing ${rule} rule in public/_headers`);
  const line = lines.slice(start + 1).find((entry) => entry.trim().startsWith('Content-Security-Policy:'));
  assert.ok(line, `missing Content-Security-Policy in the ${rule} rule`);
  return line.slice(line.indexOf(':') + 1).trim();
}

function sourcePolicy(source: string, name: string): string {
  const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]\\.join`));
  assert.ok(match, `missing ${name} in the source`);
  const items = [...(match[1] ?? '').matchAll(/"([^"]*)"|'([^']*)'/g)].map(
    (entry) => entry[1] ?? entry[2] ?? '',
  );
  return items.join('; ');
}

test('the shell policy is identical in all three places', () => {
  const expected = headerPolicy('/play/*');
  assert.equal(sourcePolicy(viteConfig, 'PLAY_SHELL_CSP'), expected);
  assert.equal(sourcePolicy(serveDist, 'playShellCsp'), expected);
});

test('the game document policy is identical in all three places', () => {
  const expected = headerPolicy('/play/runtime.html');
  assert.equal(sourcePolicy(viteConfig, 'PLAY_RUNTIME_CSP'), expected);
  assert.equal(sourcePolicy(serveDist, 'playRuntimeCsp'), expected);
});

test('the game document keeps an opaque origin and never allow-same-origin', () => {
  const policy = headerPolicy('/play/runtime.html');
  assert.match(policy, /^sandbox allow-scripts allow-pointer-lock allow-forms allow-popups;/);
  assert.ok(!policy.includes('allow-same-origin'), 'the game document must stay opaque');
  assert.ok(!headerPolicy('/play/*').includes('allow-same-origin'));
});

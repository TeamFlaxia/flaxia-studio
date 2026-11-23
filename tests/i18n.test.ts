import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { getLocale, locales, type ResourceKey, setLocale, t } from '../src/i18n/index.ts';

beforeEach(() => {
  setLocale('en');
});

test('representative keys resolve to English strings', () => {
  assert.equal(t('common.ok'), 'OK');
  assert.equal(t('publish.title'), 'Publish project');
  assert.equal(t('command.checkCompatibility'), 'Check compatibility');
  assert.equal(t('play.noProblems'), 'No problems detected');
  assert.equal(t('workspace.otherTabChanged'), 'This workspace was changed in another tab.');
});

test('placeholders are replaced from params', () => {
  assert.equal(
    t('workspace.deleteConfirm', { name: 'foo' }),
    'Delete workspace "foo"? This cannot be undone.',
  );
  assert.equal(t('play.problemsFound', { count: 3 }), '3 problem(s) found');
  // Unknown placeholder names are left untouched.
  assert.equal(t('common.save', {}), 'Save');
});

test('an unknown locale falls back to en', () => {
  assert.equal(setLocale('xx-not-a-locale'), 'en');
  assert.equal(getLocale(), 'en');
  assert.equal(t('common.save'), 'Save');
});

test('the ja scaffold falls back to English for missing keys', () => {
  setLocale('ja');
  try {
    assert.equal(getLocale(), 'ja');
    assert.equal(t('common.ok'), 'OK');
  } finally {
    setLocale('en');
  }
});

test('a missing key returns the key string itself', () => {
  assert.equal(t('not.a.real.key' as ResourceKey), 'not.a.real.key');
});

test('the English registry is flat, frozen and free of duplicate keys', () => {
  const keys = Object.keys(locales.en);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(Object.isFrozen(locales.en));
  assert.deepEqual([...new Set(keys.map((key) => key.split('.', 1)[0] ?? ''))].sort(), [
    'command',
    'common',
    'play',
    'publish',
    'template',
    'workspace',
  ]);
});

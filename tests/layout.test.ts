import assert from 'node:assert/strict';
import test from 'node:test';
import { clampSidebarWidth, EMPTY_LAYOUT, SIDEBAR_MAX, SIDEBAR_MIN } from '../src/lib/layout.ts';

test('the explorer width stays inside the usable range', () => {
  assert.equal(clampSidebarWidth(10, 1600), SIDEBAR_MIN);
  assert.equal(clampSidebarWidth(10_000, 1600), SIDEBAR_MAX);
  assert.equal(clampSidebarWidth(320, 1600), 320);
});

test('the explorer width never eats more than half of the viewport', () => {
  assert.equal(clampSidebarWidth(400, 800), 360);
  assert.equal(clampSidebarWidth(400, 400), SIDEBAR_MIN);
});

test('an empty layout keeps the CSS defaults', () => {
  assert.deepEqual(EMPTY_LAYOUT, { sidebarWidth: null });
});

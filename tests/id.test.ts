import assert from 'node:assert/strict';
import test from 'node:test';
import { randomId } from '../src/lib/id.ts';

test('random ids look like UUIDs', () => {
  const id = randomId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('random ids do not repeat', () => {
  const ids = new Set(Array.from({ length: 200 }, () => randomId()));
  assert.equal(ids.size, 200);
});

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { Workspace } from '../src/fs/workspace.ts';

test('workspace persists, renames, imports nested paths, and deletes', async () => {
  const workspace = await Workspace.openDefault();
  const path = await workspace.createFile('nested/hello.ts', 'export const x = 1;');
  assert.equal(workspace.readFile(path), 'export const x = 1;');

  await workspace.writeFile(path, 'export const x = 2;');
  await workspace.rename('nested', 'moved');
  assert.equal(workspace.readFile('nested/hello.ts'), null);
  assert.equal(workspace.readFile('moved/hello.ts'), 'export const x = 2;');

  const reopened = await Workspace.open(workspace.id);
  assert.ok(reopened);
  assert.equal(reopened.readFile('moved/hello.ts'), 'export const x = 2;');

  const zip = zipSync({
    'deep/nested/file.txt': strToU8('nested'),
    'top.txt': strToU8('top'),
  });
  await workspace.importZipBytes(zip);
  assert.ok(workspace.get('deep'));
  assert.equal(workspace.readFile('deep/nested/file.txt'), 'nested');

  await workspace.remove('moved');
  assert.equal(workspace.readFile('moved/hello.ts'), null);
  assert.equal(workspace.readFile('top.txt'), 'top');

  const exported = workspace.exportZip();
  assert.ok(exported.byteLength > 0);
});

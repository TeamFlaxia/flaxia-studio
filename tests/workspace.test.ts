import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, unzipSync, zipSync } from 'fflate';
import {
  getActiveWorkspaceId,
  getWorkspace,
  listFiles,
  putWorkspace,
  setActiveWorkspaceId,
  type WorkspaceRecord,
} from '../src/fs/indexeddb.ts';
import { ConflictError, Workspace } from '../src/fs/workspace.ts';
import { randomId } from '../src/lib/id.ts';

async function storedVersion(workspaceId: string, path: string): Promise<number | undefined> {
  const records = await listFiles(workspaceId);
  return records.find((record) => record.path === path)?.version;
}

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

  const exported = await workspace.exportZip();
  assert.ok(exported.byteLength > 0);

  const binary = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0xff]);
  await workspace.writeBinaryFile('bin/hello', binary);
  assert.equal(workspace.isBinary('bin/hello'), true);
  assert.equal(workspace.readFile('bin/hello'), null);
  assert.equal(workspace.sizeOf('bin/hello'), binary.byteLength);
  assert.deepEqual([...((await workspace.readBinary('bin/hello')) ?? [])], [...binary]);
  const blob = await workspace.readBlob('bin/hello');
  assert.equal(blob?.size, binary.byteLength);

  const reopenedBinary = await Workspace.open(workspace.id);
  assert.deepEqual([...((await reopenedBinary?.readBinary('bin/hello')) ?? [])], [...binary]);

  const zipWithBinary = unzipSync(await workspace.exportZip());
  assert.deepEqual([...(zipWithBinary['bin/hello'] ?? [])], [...binary]);

  // Removing a file drops its blob payload too.
  await workspace.remove('bin');
  assert.equal(await workspace.readBlob('bin/hello'), null);
});

test('new files start at version 1 and writeFile persists version 2', async () => {
  const workspace = await Workspace.create();
  const path = await workspace.createFile('versioned.txt', 'v1');
  assert.equal(workspace.versionOf(path), 1);
  assert.equal(await storedVersion(workspace.id, path), 1);

  const rev = workspace.rev;
  await workspace.writeFile(path, 'v2');
  assert.equal(workspace.versionOf(path), 2);
  assert.equal(workspace.readFile(path), 'v2');
  assert.equal(await storedVersion(workspace.id, path), 2);
  assert.equal(workspace.rev, rev + 1);

  const reopened = await Workspace.open(workspace.id);
  assert.equal(reopened?.versionOf(path), 2);
  assert.equal(reopened?.readFile(path), 'v2');
});

test('a stale expected version raises ConflictError without changing anything', async () => {
  const workspace = await Workspace.create();
  const path = await workspace.createFile('locked.txt', 'original');
  const rev = workspace.rev;

  await assert.rejects(workspace.writeFile(path, 'overwritten', 99), (error: unknown) => {
    assert.ok(error instanceof ConflictError);
    assert.equal(error.name, 'ConflictError');
    assert.equal(error.path, path);
    assert.equal(error.expected, 99);
    assert.equal(error.actual, 1);
    return true;
  });
  assert.equal(workspace.readFile(path), 'original');
  assert.equal(workspace.versionOf(path), 1);
  assert.equal(workspace.rev, rev);
  assert.equal(await storedVersion(workspace.id, path), 1);
  const reopened = await Workspace.open(workspace.id);
  assert.equal(reopened?.readFile(path), 'original');

  // A matching version is accepted and advances the counter.
  await workspace.writeFile(path, 'updated', 1);
  assert.equal(workspace.versionOf(path), 2);
  assert.equal(workspace.readFile(path), 'updated');
});

test('a second tab with a stale copy cannot overwrite a newer persisted version', async () => {
  const firstTab = await Workspace.create();
  const path = 'shared.txt';
  await firstTab.writeFile(path, 'from first tab');
  const secondTab = await Workspace.open(firstTab.id);
  assert.ok(secondTab);
  assert.equal(secondTab.versionOf(path), 1);

  await firstTab.writeFile(path, 'first tab wins');
  await assert.rejects(secondTab.writeFile(path, 'stale overwrite', 1), (error: unknown) => {
    assert.ok(error instanceof ConflictError);
    assert.equal(error.actual, 2);
    return true;
  });
  assert.equal((await Workspace.open(firstTab.id))?.readFile(path), 'first tab wins');
});

test('binary writes honour the expected version and keep the mime argument', async () => {
  const workspace = await Workspace.create();
  const bytes = new Uint8Array([1, 2, 3]);
  const path = await workspace.writeBinaryFile('assets/blob.bin', bytes, 'application/octet-stream');
  assert.equal(workspace.versionOf(path), 1);
  assert.equal(workspace.mimeOf(path), 'application/octet-stream');

  await assert.rejects(
    workspace.writeBinaryFile(path, bytes, 'application/octet-stream', 7),
    (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.actual, 1);
      assert.equal(error.expected, 7);
      return true;
    },
  );
  assert.equal(workspace.versionOf(path), 1);

  await workspace.writeBinaryFile(path, bytes, 'application/octet-stream', 1);
  assert.equal(workspace.versionOf(path), 2);
});

test('openDefault respects the active workspace id', async () => {
  const other = await Workspace.create();
  const active = await Workspace.create();
  // Make `other` the most recently updated record; the active id must still win.
  await other.writeFile('newer.txt', 'newer');
  await setActiveWorkspaceId(active.id);
  assert.equal(await getActiveWorkspaceId(), active.id);

  const opened = await Workspace.openDefault();
  assert.equal(opened.id, active.id);
});

test('openDefault falls back to the newest record when the active id is stale', async () => {
  const newer = await Workspace.create();
  await Workspace.create();
  // Force a strictly newer timestamp so the assertion is not millisecond-flaky.
  const record = await getWorkspace(newer.id);
  assert.ok(record);
  await putWorkspace({ ...record, updatedAt: record.updatedAt + 60_000 });
  await setActiveWorkspaceId('missing-workspace-id');

  const opened = await Workspace.openDefault();
  assert.equal(opened.id, newer.id);
});

test('openDefault does not re-seed an existing record with no files', async () => {
  const now = Date.now();
  const record: WorkspaceRecord = {
    id: randomId(),
    name: 'empty-workspace',
    createdAt: now,
    updatedAt: now,
    rev: 1,
  };
  await putWorkspace(record);
  await setActiveWorkspaceId(record.id);

  const opened = await Workspace.openDefault();
  assert.equal(opened.id, record.id);
  assert.deepEqual(opened.list(), []);
  assert.deepEqual(opened.filePaths(), []);
});

test('open(id) switches to another workspace record', async () => {
  const first = await Workspace.create();
  const second = await Workspace.create();
  await first.writeFile('only-first.txt', 'first');
  await second.writeFile('only-second.txt', 'second');

  const switched = await Workspace.open(first.id);
  assert.ok(switched);
  assert.equal(switched.readFile('only-first.txt'), 'first');
  assert.equal(switched.readFile('only-second.txt'), null);
  assert.equal(await getActiveWorkspaceId(), first.id);
  assert.equal((await Workspace.openDefault()).id, first.id);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeB64,
  decryptVaultItem,
  deriveVaultKe,
  encodeB64,
  encryptVaultItem,
  unlockVaultWithPassword,
  type VaultKdfParams,
  wrapSecret,
} from '../src/lib/vault.ts';

// A low iteration count keeps the test fast. The production floor is applied
// by the server and by `unlockVault`'s envelope shape check; the derivation
// itself is the same PBKDF2 primitive.
const TEST_KDF: VaultKdfParams = { alg: 'PBKDF2-SHA256', iterations: 100_000 };

const random = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length));

test('a password envelope unlocks to the same vault key', async () => {
  const password = 'correct horse battery staple';
  const salt = random(16);
  const vk = random(32);
  const kek = await deriveVaultKe(password, salt, TEST_KDF);
  const wrapped = await wrapSecret(kek, vk, 'flaxia.vault.vk.v1');

  const opened = await unlockVaultWithPassword(password, {
    salt: encodeB64(salt),
    kdf_params: TEST_KDF,
    wrapped_vk: wrapped,
  });
  assert.deepEqual(opened, vk);

  await assert.rejects(
    unlockVaultWithPassword('wrong password', {
      salt: encodeB64(salt),
      kdf_params: TEST_KDF,
      wrapped_vk: wrapped,
    }),
    /unable to decrypt/,
  );
});

test('an OAuth item round-trips and is bound to its id', async () => {
  const vk = random(32);
  const itemId = `item_${encodeB64(random(24))
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 32)}`;
  const payload = new TextEncoder().encode(
    JSON.stringify({ provider: 'opencode', access_token: 'oc_test', org: { id: 'org_1' } }),
  );

  const encrypted = await encryptVaultItem(vk, itemId, payload);
  const opened = await decryptVaultItem(vk, itemId, encrypted.item_key_wrapped, encrypted.payload);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(opened)), {
    provider: 'opencode',
    access_token: 'oc_test',
    org: { id: 'org_1' },
  });

  // The item id is the AAD, so a ciphertext moved to another row must fail.
  await assert.rejects(
    decryptVaultItem(vk, `${itemId}_other`, encrypted.item_key_wrapped, encrypted.payload),
    /unable to decrypt/,
  );
});

test('the KDF window rejects absurd iteration counts', async () => {
  const salt = random(16);
  // c = 1 stays legal for published KDF test vectors; the envelope layer
  // applies the production floor.
  for (const iterations of [0, 10_000_000_001, 1.5, Number.POSITIVE_INFINITY]) {
    await assert.rejects(deriveVaultKe('password', salt, { alg: 'PBKDF2-SHA256', iterations }), /iterations/);
  }
});

test('base64 helpers round-trip arbitrary bytes', () => {
  const bytes = random(64);
  assert.deepEqual(decodeB64(encodeB64(bytes)), bytes);
});

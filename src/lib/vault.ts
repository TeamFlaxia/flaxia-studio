// Studio's minimal Personal Vault client.
//
// The key hierarchy and wire formats mirror `flaxia/src/lib/vault/primitives.ts`
// exactly: an item encrypted here must open in Flaxia, and vice versa. Only
// the password path is implemented because Studio starts by reading and
// writing `oauth_connection` items; recovery phrases and QR pairing stay in
// Flaxia until Studio needs them.
//
//   password ──PBKDF2(600k, salt)──► KEK ──unwrap──► VK
//                                                    │
//                                                    └──wrap──► item_key ──AES-GCM──► payload
//
// VK exists in memory only, for the lifetime of the page.

import { authFetch } from './auth.ts';

const subtle = globalThis.crypto.subtle;

export const VAULT_KEY_BYTES = 32;
export const VAULT_SALT_BYTES = 16;
export const VAULT_IV_BYTES = 12;
export const VAULT_KDF_ITERATIONS = 600_000;
export const VAULT_KDF_MIN_ITERATIONS = 100_000;
export const VAULT_KDF_MAX_ITERATIONS = 10_000_000;

const CONTEXT_VK_PASSWORD = 'flaxia.vault.vk.v1';
const CONTEXT_ITEM_KEY = 'flaxia.vault.itemkey.v1';
const CONTEXT_PAYLOAD = 'flaxia.vault.payload.v1';

export interface VaultKdfParams {
  readonly alg: 'PBKDF2-SHA256';
  readonly iterations: number;
}

export const DEFAULT_VAULT_KDF_PARAMS: VaultKdfParams = {
  alg: 'PBKDF2-SHA256',
  iterations: VAULT_KDF_ITERATIONS,
};

export interface VaultKeys {
  enabled: boolean;
  salt?: string;
  kdf_params?: VaultKdfParams;
  wrapped_vk?: string;
  vk_version?: number;
  devices?: Array<{ id: string; label: string; state: string; created_at: string }>;
}

export class VaultUnlockError extends Error {
  readonly reason: 'wrong' | 'malformed' | 'network';

  constructor(reason: 'wrong' | 'malformed' | 'network') {
    super(
      reason === 'wrong'
        ? 'Wrong password'
        : reason === 'malformed'
          ? 'Vault envelope is unreadable'
          : 'Vault is unavailable',
    );
    this.name = 'VaultUnlockError';
    this.reason = reason;
  }
}

export function encodeB64(bytes: Uint8Array): string {
  let binary = '';
  for (const x of bytes) binary += String.fromCharCode(x);
  return btoa(binary);
}

export function decodeB64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function encodeWrapped(iv: Uint8Array, ciphertext: Uint8Array): string {
  return `${encodeB64(iv)}.${encodeB64(ciphertext)}`;
}

export function decodeWrapped(value: unknown): { iv: Uint8Array; ciphertext: Uint8Array } | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    iv = decodeB64(parts[0] ?? '');
    ciphertext = decodeB64(parts[1] ?? '');
  } catch {
    return null;
  }
  if (iv.length !== VAULT_IV_BYTES || ciphertext.length < 16) return null;
  return { iv, ciphertext };
}

const itemContext = (base: string, itemId: string): string => `${base}:${itemId}`;

export function isValidB64(value: unknown, bytes?: number): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const decoded = decodeB64(value);
    return bytes === undefined ? decoded.length > 0 : decoded.length === bytes;
  } catch {
    return false;
  }
}

export function isValidVaultKdfParams(value: unknown): value is VaultKdfParams {
  if (typeof value !== 'object' || value === null) return false;
  const params = value as { alg?: unknown; iterations?: unknown };
  if (params.alg !== 'PBKDF2-SHA256') return false;
  const iterations = params.iterations;
  if (typeof iterations !== 'number' || !Number.isInteger(iterations)) return false;
  return iterations >= VAULT_KDF_MIN_ITERATIONS && iterations <= VAULT_KDF_MAX_ITERATIONS;
}

export function isValidWrappedKey(value: unknown): boolean {
  return typeof value === 'string' && decodeWrapped(value) !== null;
}

function envelopeError(message: string): Error {
  const error = new Error(message);
  error.name = 'VaultEnvelopeError';
  return error;
}

export function isEnvelopeShapeError(value: unknown): value is Error {
  return value instanceof Error && value.name === 'VaultEnvelopeError';
}

export async function deriveVaultKeBits(
  secret: string,
  salt: Uint8Array,
  params: VaultKdfParams = DEFAULT_VAULT_KDF_PARAMS,
): Promise<Uint8Array> {
  const iterations: unknown = params?.iterations;
  if (
    typeof iterations !== 'number' ||
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > VAULT_KDF_MAX_ITERATIONS
  ) {
    throw new Error('vault KDF iterations must be an integer in 1..10000000');
  }
  const material = await subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: params.iterations, hash: 'SHA-256' },
    material,
    256,
  );
  return new Uint8Array(bits);
}

export async function deriveVaultKe(
  secret: string,
  salt: Uint8Array,
  params: VaultKdfParams = DEFAULT_VAULT_KDF_PARAMS,
): Promise<CryptoKey> {
  const bits = await deriveVaultKeBits(secret, salt, params);
  return subtle.importKey('raw', bits as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function vaultKeyAsAesKey(vk: Uint8Array): Promise<CryptoKey> {
  if (vk.length !== VAULT_KEY_BYTES) throw new Error('vault key must be 32 bytes');
  return subtle.importKey('raw', vk as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptWith(key: CryptoKey, plaintext: Uint8Array, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(VAULT_IV_BYTES)) as Uint8Array<ArrayBuffer>;
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: new TextEncoder().encode(context) },
    key,
    plaintext as BufferSource,
  );
  return encodeWrapped(iv, new Uint8Array(ciphertext));
}

async function decryptWith(key: CryptoKey, encoded: string, context: string): Promise<Uint8Array> {
  const parsed = decodeWrapped(encoded);
  if (!parsed) throw new Error('malformed wrapped value');
  try {
    const plaintext = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: parsed.iv as BufferSource,
        additionalData: new TextEncoder().encode(context),
      },
      key,
      parsed.ciphertext as BufferSource,
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new Error('unable to decrypt vault value');
  }
}

export async function wrapSecret(kek: CryptoKey, plaintext: Uint8Array, context: string): Promise<string> {
  return encryptWith(kek, plaintext, context);
}

export async function unwrapSecret(kek: CryptoKey, encoded: string, context: string): Promise<Uint8Array> {
  return decryptWith(kek, encoded, context);
}

function assertPasswordEnvelopeShape(envelope: {
  salt?: unknown;
  kdf_params?: unknown;
  wrapped_vk?: unknown;
}): void {
  if (!isValidB64(envelope.salt, VAULT_SALT_BYTES)) throw envelopeError('malformed vault envelope: salt');
  if (!isValidVaultKdfParams(envelope.kdf_params)) {
    throw envelopeError('malformed vault envelope: unsupported KDF parameters');
  }
  if (!isValidWrappedKey(envelope.wrapped_vk)) throw envelopeError('malformed vault envelope: wrapped_vk');
}

function assertVaultKeyBytes(vk: Uint8Array): Uint8Array {
  if (vk.length !== VAULT_KEY_BYTES)
    throw envelopeError('malformed vault envelope: vault key is not 32 bytes');
  return vk;
}

export async function unlockVaultWithPassword(
  password: string,
  envelope: { salt: string; kdf_params: VaultKdfParams; wrapped_vk: string },
): Promise<Uint8Array> {
  assertPasswordEnvelopeShape(envelope);
  const kek = await deriveVaultKe(password, decodeB64(envelope.salt), envelope.kdf_params);
  return assertVaultKeyBytes(await unwrapSecret(kek, envelope.wrapped_vk, CONTEXT_VK_PASSWORD));
}

export interface VaultItemCiphertext {
  item_key_wrapped: string;
  payload: string;
}

export async function encryptVaultItem(
  vk: Uint8Array,
  itemId: string,
  plaintext: Uint8Array,
): Promise<VaultItemCiphertext> {
  const vkKey = await vaultKeyAsAesKey(vk);
  const itemKey = crypto.getRandomValues(new Uint8Array(VAULT_KEY_BYTES));
  const itemKeyAes = await vaultKeyAsAesKey(itemKey);
  return {
    item_key_wrapped: await encryptWith(vkKey, itemKey, itemContext(CONTEXT_ITEM_KEY, itemId)),
    payload: await encryptWith(itemKeyAes, plaintext, itemContext(CONTEXT_PAYLOAD, itemId)),
  };
}

export async function decryptVaultItem(
  vk: Uint8Array,
  itemId: string,
  itemKeyWrapped: string,
  payload: string,
): Promise<Uint8Array> {
  const vkKey = await vaultKeyAsAesKey(vk);
  const itemKey = await unwrapSecret(vkKey, itemKeyWrapped, itemContext(CONTEXT_ITEM_KEY, itemId));
  const itemKeyAes = await vaultKeyAsAesKey(itemKey);
  return decryptWith(itemKeyAes, payload, itemContext(CONTEXT_PAYLOAD, itemId));
}

// ─── Auth API ────────────────────────────────────────────────────────────────

const vaultError = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // Not JSON.
  }
  return `Vault request failed (${response.status})`;
};

export async function fetchVaultKeys(): Promise<VaultKeys | null> {
  const response = await authFetch('/api/vault/keys');
  if (response.status === 401) return null;
  if (!response.ok) throw new VaultUnlockError('network');
  return (await response.json()) as VaultKeys;
}

/** Unlock VK in memory. The password never leaves the page. */
export async function unlockVault(
  password: string,
  keys: VaultKeys,
): Promise<{ vk: Uint8Array; version: number }> {
  if (
    !keys.enabled ||
    !keys.salt ||
    !keys.kdf_params ||
    !keys.wrapped_vk ||
    !Number.isSafeInteger(keys.vk_version) ||
    (keys.vk_version ?? 0) < 1
  ) {
    throw new VaultUnlockError('malformed');
  }
  try {
    const vk = await unlockVaultWithPassword(password, {
      salt: keys.salt,
      kdf_params: keys.kdf_params,
      wrapped_vk: keys.wrapped_vk,
    });
    return { vk, version: keys.vk_version as number };
  } catch (error) {
    throw new VaultUnlockError(isEnvelopeShapeError(error) ? 'malformed' : 'wrong');
  }
}

export interface VaultItemRecord {
  id: string;
  item_key_wrapped: string;
  payload: string;
  kind: string;
  vk_version: number;
  created_at: string;
  updated_at: string;
}

export async function listVaultItems(): Promise<VaultItemRecord[]> {
  const response = await authFetch('/api/vault/items?kind=oauth_connection');
  if (!response.ok) throw new VaultUnlockError('network');
  const body = (await response.json()) as { items?: VaultItemRecord[] };
  return body.items ?? [];
}

export async function saveOAuthItem(
  vk: Uint8Array,
  version: number,
  itemId: string,
  value: unknown,
): Promise<void> {
  const encrypted = await encryptVaultItem(vk, itemId, new TextEncoder().encode(JSON.stringify(value)));
  const response = await authFetch(`/api/vault/items/${encodeURIComponent(itemId)}`, {
    method: 'PUT',
    body: JSON.stringify({
      ...encrypted,
      kind: 'oauth_connection',
      vk_version: version,
    }),
  });
  if (!response.ok) throw new Error(await vaultError(response));
}

export async function loadOAuthItem(vk: Uint8Array, itemId: string): Promise<unknown | null> {
  const items = await listVaultItems();
  const item = items.find((entry) => entry.id === itemId);
  if (!item) return null;
  const plaintext = await decryptVaultItem(vk, item.id, item.item_key_wrapped, item.payload);
  return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
}

export async function deleteVaultItem(itemId: string, version: number): Promise<void> {
  const response = await authFetch(
    `/api/vault/items/${encodeURIComponent(itemId)}?vk_version=${encodeURIComponent(String(version))}`,
    { method: 'DELETE' },
  );
  if (!response.ok && response.status !== 404) throw new Error(await vaultError(response));
}

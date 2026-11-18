// Open a token envelope sealed by Auth (see `flaxia-auth/src/oauth/seal.ts`).
//
// Auth performs the device-code exchange, seals the raw token response to an
// ephemeral ECDH key derived from the Studio public key, and stores nothing.
// Studio holds the private half in memory and opens the envelope exactly once.

import type { SealedEnvelope } from './auth';

const CURVE = 'ECDH';
const NAMED_CURVE = 'P-256';
const IV_LENGTH = 12;
const KEY_LENGTH = 256;
const HKDF_INFO = 'flaxia.oauth.seal.v1';

const encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const decode = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

const isBase64 = (value: unknown, expectedLength?: number): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  let bytes: Uint8Array;
  try {
    bytes = decode(value);
  } catch {
    return false;
  }
  return expectedLength === undefined ? bytes.length > 0 : bytes.length === expectedLength;
};

async function deriveKey(sharedSecret: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', sharedSecret as BufferSource, 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    material,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function sharedSecret(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Uint8Array> {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, KEY_LENGTH);
  return new Uint8Array(bits);
}

export async function openSealed(envelope: SealedEnvelope, privateKey: CryptoKey): Promise<Uint8Array> {
  if (!envelope || typeof envelope !== 'object') throw new Error('Invalid sealed envelope');
  const { ephemeralPublicKey, iv, ciphertext } = envelope;
  if (!isBase64(ephemeralPublicKey) || !isBase64(iv, IV_LENGTH) || !isBase64(ciphertext)) {
    throw new Error('Invalid sealed envelope');
  }
  let ephemeralKey: CryptoKey;
  try {
    ephemeralKey = await crypto.subtle.importKey(
      'spki',
      decode(ephemeralPublicKey) as BufferSource,
      { name: CURVE, namedCurve: NAMED_CURVE },
      false,
      [],
    );
  } catch {
    throw new Error('Invalid sealed envelope');
  }
  const key = await deriveKey(await sharedSecret(privateKey, ephemeralKey));
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode(iv) as BufferSource },
    key,
    decode(ciphertext) as BufferSource,
  );
  return new Uint8Array(plaintext);
}

/** Export the Studio half of the ECDH pair for `client_public_key`. */
export async function createSealKeyPair(): Promise<{ pair: CryptoKeyPair; publicKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: CURVE, namedCurve: NAMED_CURVE }, false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey('spki', pair.publicKey);
  return { pair, publicKey: encode(new Uint8Array(exported as ArrayBuffer)) };
}

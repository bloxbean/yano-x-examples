// Small byte helpers and Ed25519 through WebCrypto. Ed25519 in WebCrypto
// ships in every current browser and in Node 20+, so the game needs no crypto
// library.

export const utf8 = (text) => new TextEncoder().encode(text);

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error('not a hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const equalBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

const subtle = globalThis.crypto.subtle;
const ED25519 = { name: 'Ed25519' };

/** Verify an Ed25519 signature; false (never a throw) for anything malformed. */
export async function ed25519Verify(publicKey, signature, message) {
  try {
    if (publicKey.length !== 32 || signature.length !== 64) return false;
    const key = await subtle.importKey('raw', publicKey, ED25519, false, ['verify']);
    return await subtle.verify(ED25519, key, signature, message);
  } catch {
    return false;
  }
}

export async function ed25519Supported() {
  try {
    await subtle.generateKey(ED25519, false, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

/** A fresh session key: { privateKey (CryptoKey), publicKey (32 bytes), pkcs8 (bytes) }. */
export async function ed25519Generate() {
  const pair = await subtle.generateKey(ED25519, true, ['sign', 'verify']);
  const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  return { privateKey: pair.privateKey, publicKey, pkcs8 };
}

export async function ed25519Import(pkcs8) {
  return subtle.importKey('pkcs8', pkcs8, ED25519, true, ['sign']);
}

export async function ed25519Sign(privateKey, message) {
  return new Uint8Array(await subtle.sign(ED25519, privateKey, message));
}

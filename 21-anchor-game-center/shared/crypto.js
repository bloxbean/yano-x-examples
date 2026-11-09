// Small byte helpers, Ed25519 through WebCrypto, and bech32 for showing
// Cardano addresses. Ed25519 in WebCrypto ships in every current browser and
// in Node 20+, so the game needs no crypto library.

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

/** A private key from PKCS#8 bytes: non-extractable unless asked, so nothing can read it back. */
/** A key that never leaves this browser: { privateKey (non-extractable CryptoKey), publicKey (32 bytes) }. */
export async function ed25519GenerateLocked() {
  const pair = await subtle.generateKey(ED25519, false, ['sign', 'verify']);
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) };
}

export async function ed25519Import(pkcs8, extractable = false) {
  return subtle.importKey('pkcs8', pkcs8, ED25519, extractable, ['sign']);
}

export async function ed25519Sign(privateKey, message) {
  return new Uint8Array(await subtle.sign(ED25519, privateKey, message));
}

// --- bech32 (BIP-173), encode only: Cardano addresses use it without the
// 90-character limit.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function toWords(bytes) {
  const words = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { bits -= 5; words.push((acc >> bits) & 31); }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  return words;
}

export function bech32Encode(prefix, bytes) {
  const words = toWords(bytes);
  const expanded = [...prefix].map((c) => c.charCodeAt(0) >> 5)
    .concat([0], [...prefix].map((c) => c.charCodeAt(0) & 31));
  const mod = polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
  return `${prefix}1${[...words, ...checksum].map((w) => CHARSET[w]).join('')}`;
}

/** A Cardano address (raw bytes) in its bech32 form. */
export function cardanoAddressBech32(addressBytes) {
  const type = addressBytes[0] >> 4;
  const mainnet = (addressBytes[0] & 0x0f) === 1;
  const reward = type === 14 || type === 15;
  const prefix = reward ? (mainnet ? 'stake' : 'stake_test') : (mainnet ? 'addr' : 'addr_test');
  return bech32Encode(prefix, addressBytes);
}

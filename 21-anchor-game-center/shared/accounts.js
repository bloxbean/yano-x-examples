// Commanders: a call sign and a password, with no password anywhere public.
//
// Creating a commander generates a random Ed25519 signing key in the browser
// and locks it with AES-GCM under a key derived from the password
// (PBKDF2-SHA256). The profile stored on the ledger holds the call sign, the
// public key, the KDF salt and the locked key — never the password and never
// the key in the clear. Signing in on a new device fetches the profile,
// re-derives the lock key from the password, and unlocks the signing key.
//
// The profile is self-signed by its key, so it cannot pair a call sign with a
// key the registrant does not hold. The ciphertext is bound to the call sign
// and public key as AES-GCM additional data, so it cannot be moved to another
// profile either.
//
// What this does not hide: the locked key is public, so a weak password can be
// guessed offline, as with any leaked password hash. Hence the minimum length
// and the 600,000 PBKDF2 rounds.

import { ed25519Generate, ed25519Import, ed25519Sign, ed25519Verify, fromHex, randomBytes, toHex, utf8 }
  from './crypto.js';

export const CALLSIGN = /^[a-z0-9][a-z0-9_-]{2,19}$/;
const subtle = globalThis.crypto.subtle;

/** The authenticated-map key for a call sign (at most 64 bytes). */
export const profileKey = (cfg, id) => utf8(`${cfg.app}/commander/${id}`);

const profileStatement = (p) =>
  `${p.app}|profile|${p.id}|${p.pub}|${p.kdf.iterations}|${p.kdf.salt}|${p.cipher.iv}|${p.cipher.data}`;
const aad = (app, id, pub) => utf8(`${app}|${id}|${pub}`);

async function lockKey(password, salt, iterations) {
  const base = await subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export class Commander {
  constructor(id, pub, privateKey, pkcs8) {
    Object.assign(this, { id, pub, privateKey, pkcs8 });
  }

  /** Sign a move statement; returns lowercase hex. */
  async sign(statement) {
    return toHex(await ed25519Sign(this.privateKey, utf8(statement)));
  }
}

/** Create a commander. Returns { commander, profileBytes } — the bytes to register. */
export async function createCommander(cfg, id, password, iterations = cfg.kdfIterations) {
  if (!CALLSIGN.test(id)) throw new Error('Call signs are 3–20 characters: a–z, 0–9, _ or -');
  if (password.length < cfg.minPasswordLength) {
    throw new Error(`Use at least ${cfg.minPasswordLength} characters for your password`);
  }
  const key = await ed25519Generate();
  const pub = toHex(key.publicKey);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const data = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(cfg.app, id, pub) },
    await lockKey(password, salt, iterations), key.pkcs8));

  const profile = {
    v: 1, app: cfg.app, id, pub,
    kdf: { name: 'PBKDF2-SHA256', iterations, salt: toHex(salt) },
    cipher: { name: 'AES-GCM', iv: toHex(iv), data: toHex(data) },
  };
  profile.sig = toHex(await ed25519Sign(key.privateKey, utf8(profileStatement(profile))));
  return {
    commander: new Commander(id, pub, key.privateKey, key.pkcs8),
    profileBytes: utf8(JSON.stringify(profile)),
  };
}

/** Parse and check a stored profile. Returns the profile, or null if it is not a valid one for `id`. */
export async function readProfile(cfg, id, bytes) {
  let p;
  try {
    p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const hex = (v, n) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(v);
  if (p?.v !== 1 || p.app !== cfg.app || p.id !== id || !hex(p.pub, 64) || !hex(p.sig, 128)
      || p.kdf?.name !== 'PBKDF2-SHA256' || !Number.isSafeInteger(p.kdf.iterations) || p.kdf.iterations < 1
      || !hex(p.kdf.salt, 32) || p.cipher?.name !== 'AES-GCM' || !hex(p.cipher.iv, 24)
      || typeof p.cipher.data !== 'string' || !/^([0-9a-f]{2})+$/.test(p.cipher.data)) {
    return null;
  }
  const ok = await ed25519Verify(fromHex(p.pub), fromHex(p.sig), utf8(profileStatement(p)));
  return ok ? p : null;
}

/** Unlock a profile with its password. Throws "Wrong password" on failure. */
export async function unlockCommander(cfg, profile, password) {
  let pkcs8;
  try {
    pkcs8 = new Uint8Array(await subtle.decrypt(
      { name: 'AES-GCM', iv: fromHex(profile.cipher.iv), additionalData: aad(cfg.app, profile.id, profile.pub) },
      await lockKey(password, fromHex(profile.kdf.salt), profile.kdf.iterations),
      fromHex(profile.cipher.data)));
  } catch {
    throw new Error('Wrong password');
  }
  const privateKey = await ed25519Import(pkcs8);
  const commander = new Commander(profile.id, profile.pub, privateKey, pkcs8);
  // The unlocked key must be the profile's key, not merely decryptable.
  const probe = `${cfg.app}|unlock-check`;
  if (!(await ed25519Verify(fromHex(profile.pub), fromHex(await commander.sign(probe)), utf8(probe)))) {
    throw new Error('Wrong password');
  }
  return commander;
}

// ------------------------------------------------------------ this device
// For now the unlocked key is remembered in localStorage, so a returning
// player does not type the password again. The password is only needed on a
// new device or after "Sign out".

const DEVICE = (cfg) => `${cfg.app}:commander`;

export function rememberOnDevice(cfg, commander) {
  try {
    localStorage.setItem(DEVICE(cfg), JSON.stringify({ id: commander.id, pub: commander.pub, pkcs8: toHex(commander.pkcs8) }));
  } catch { /* private mode: the session still works until reload */ }
}

export async function restoreFromDevice(cfg) {
  try {
    const saved = JSON.parse(localStorage.getItem(DEVICE(cfg)) ?? 'null');
    if (!saved) return null;
    const pkcs8 = fromHex(saved.pkcs8);
    return new Commander(saved.id, saved.pub, await ed25519Import(pkcs8), pkcs8);
  } catch {
    return null;
  }
}

export function forgetDevice(cfg) {
  try { localStorage.removeItem(DEVICE(cfg)); } catch { /* nothing stored */ }
}

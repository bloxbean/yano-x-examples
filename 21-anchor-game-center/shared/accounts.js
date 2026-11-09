// Commanders: a call sign and a password, or a call sign and a Cardano wallet.
//
// ---- password commanders (profile v1): no password anywhere public.
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
//
// In the browser the unlocked key is a non-extractable WebCrypto key: the page
// can sign with it but nothing, this page's own code included, can read its
// bytes back. The raw key exists only for a moment, while it is locked for the
// profile or unlocked from it, and those bytes are wiped straight after.
//
// ---- wallet commanders (profile v2): no commander key at all.
//
// The commander's identity key (`pub`) is the wallet's own key, usually its
// stake key, which never leaves the wallet. Each browser makes its own
// non-extractable *device key*, and the wallet signs one CIP-30 signData, a
// device certificate: "this device key plays as <call sign> until <time>". The
// device key then signs everything a commander key signs (delegation requests,
// session passes, Land Rush claims), and the certificate travels with each
// signature, so anyone can check device → wallet → profile. The profile on the
// ledger is the wallet key, its address, and the first browser's certificate,
// whose wallet signature proves the wallet's holder claimed the call sign.
// A new browser asks the wallet for one more certificate; each one expires.

import { verifyCip8 } from './cip8.js';
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
  /**
   * id, pub: the call sign and its identity key (the profile's pub).
   * privateKey: a non-extractable Ed25519 CryptoKey; it signs, it cannot be exported. For a
   *   password commander it is the key of `pub`; for a wallet commander, this device's key.
   * cert, address: a wallet commander's device certificate and wallet address (else null).
   */
  constructor(id, pub, privateKey, { cert = null, address = null } = {}) {
    Object.assign(this, { id, pub, privateKey, cert, address });
  }

  get wallet() { return !!this.cert; }

  /** Sign a statement with this browser's key; returns lowercase hex. */
  async sign(statement) {
    return toHex(await ed25519Sign(this.privateKey, utf8(statement)));
  }

  /** { id, pub, sig, cert? }: everything anyone needs to check that this commander signed `statement`. */
  async signed(statement) {
    return { id: this.id, pub: this.pub, sig: await this.sign(statement), ...(this.cert ? { cert: this.cert } : {}) };
  }
}

// ------------------------------------------------------------ wallet device certificates

/** What the wallet signs to let one device key play as `id` until `until` (ms). Shown in the wallet. */
export const deviceStatement = (cfg, id, device, until) =>
  `Anchor Games: let this browser play as "${id}" until ${new Date(until).toISOString()}.\n`
  + `${cfg.app} | device ${device} | until ${until}`;

const HEX = (v, n) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(v);
const HEXBYTES = (v, max) => typeof v === 'string' && v.length <= max * 2 && /^([0-9a-f]{2})+$/.test(v);
const certShape = (c) => !!c && typeof c === 'object' && HEX(c.device, 64) && Number.isSafeInteger(c.until)
  && c.until > 0 && HEXBYTES(c.cose, 1024) && HEXBYTES(c.key, 128)
  && Object.keys(c).every((k) => ['device', 'until', 'cose', 'key'].includes(k));

const certChecks = new Map(); // a certificate's wallet signature, checked once per page
/**
 * Is `cert` the wallet key `pub` letting `cert.device` play as `id`? With `at` (ms), it must
 * also not have expired by then. Returns { ok, reason?, address (hex) }.
 */
export async function verifyCert(cfg, id, pub, cert, at = null) {
  if (!certShape(cert)) return { ok: false, reason: 'malformed device certificate' };
  const key = `${id}|${pub}|${cert.device}|${cert.until}|${cert.cose}|${cert.key}`;
  if (!certChecks.has(key)) {
    certChecks.set(key, (async () => {
      const r = await verifyCip8(cert.cose, cert.key);
      if (!r.ok) return { ok: false, reason: `the wallet signature: ${r.reason}` };
      if (toHex(r.publicKey) !== pub) return { ok: false, reason: `not signed by ${id}’s wallet` };
      if (new TextDecoder().decode(r.payload) !== deviceStatement(cfg, id, cert.device, cert.until)) {
        return { ok: false, reason: 'the wallet signed something else' };
      }
      return { ok: true, address: toHex(r.address) };
    })());
    if (certChecks.size > 2000) certChecks.delete(certChecks.keys().next().value);
  }
  const result = await certChecks.get(key);
  if (result.ok && at !== null && cert.until < at) return { ok: false, reason: 'the device certificate had expired' };
  return result;
}

/**
 * Did commander `signed.id` (identity key `signed.pub`) sign `statement`? Directly with that key,
 * or, with `signed.cert`, with a device key that its wallet certified (valid at `at`, if given).
 */
export async function verifySigned(cfg, signed, statement, at = null) {
  if (!signed || !HEX(signed.pub, 64) || !HEX(signed.sig, 128)) return false;
  if (signed.cert === undefined) return ed25519Verify(fromHex(signed.pub), fromHex(signed.sig), utf8(statement));
  if (!(await verifyCert(cfg, signed.id, signed.pub, signed.cert, at)).ok) return false;
  return ed25519Verify(fromHex(signed.cert.device), fromHex(signed.sig), utf8(statement));
}

/** The profile bytes that claim `id` for a wallet: its key, its address and the first device's certificate. */
export const walletProfileBytes = (cfg, id, pub, address, cert) =>
  utf8(JSON.stringify({ v: 2, app: cfg.app, id, pub, wallet: { address }, cert }));

/** Create a commander. Returns { commander, profileBytes } — the bytes to register. */
export async function createCommander(cfg, id, password, iterations = cfg.kdfIterations) {
  if (!CALLSIGN.test(id)) throw new Error('Call signs are 3–20 characters: a–z, 0–9, _ or -');
  if (password.length < cfg.minPasswordLength) {
    throw new Error(`Use at least ${cfg.minPasswordLength} characters for your password`);
  }
  // Generated extractable only so it can be locked for the profile; the commander keeps a
  // non-extractable copy and the raw bytes are wiped.
  const key = await ed25519Generate();
  const pub = toHex(key.publicKey);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  let data;
  let privateKey;
  try {
    data = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(cfg.app, id, pub) },
      await lockKey(password, salt, iterations), key.pkcs8));
    privateKey = await ed25519Import(key.pkcs8);
  } finally {
    key.pkcs8.fill(0);
  }

  const profile = {
    v: 1, app: cfg.app, id, pub,
    kdf: { name: 'PBKDF2-SHA256', iterations, salt: toHex(salt) },
    cipher: { name: 'AES-GCM', iv: toHex(iv), data: toHex(data) },
  };
  profile.sig = toHex(await ed25519Sign(privateKey, utf8(profileStatement(profile))));
  return {
    commander: new Commander(id, pub, privateKey),
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
  const hex = HEX;
  if (p?.v === 2) {
    // A wallet commander: its first certificate is the wallet's own signature on the claim.
    if (p.app !== cfg.app || p.id !== id || !hex(p.pub, 64) || !HEXBYTES(p.wallet?.address, 64)
        || Object.keys(p).some((k) => !['v', 'app', 'id', 'pub', 'wallet', 'cert'].includes(k))) return null;
    const cert = await verifyCert(cfg, id, p.pub, p.cert);
    return cert.ok && cert.address === p.wallet.address ? p : null;
  }
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
  if (profile.v !== 1) throw new Error(`${profile.id} signs in with a Cardano wallet, not a password`);
  let pkcs8;
  try {
    pkcs8 = new Uint8Array(await subtle.decrypt(
      { name: 'AES-GCM', iv: fromHex(profile.cipher.iv), additionalData: aad(cfg.app, profile.id, profile.pub) },
      await lockKey(password, fromHex(profile.kdf.salt), profile.kdf.iterations),
      fromHex(profile.cipher.data)));
  } catch {
    throw new Error('Wrong password');
  }
  let privateKey;
  try {
    privateKey = await ed25519Import(pkcs8);
  } finally {
    pkcs8.fill(0);
  }
  const commander = new Commander(profile.id, profile.pub, privateKey);
  // The unlocked key must be the profile's key, not merely decryptable.
  const probe = `${cfg.app}|unlock-check`;
  if (!(await ed25519Verify(fromHex(profile.pub), fromHex(await commander.sign(probe)), utf8(probe)))) {
    throw new Error('Wrong password');
  }
  return commander;
}

// ------------------------------------------------------------ this device
// The unlocked key is remembered in this browser's IndexedDB as the CryptoKey
// object itself (structured clone), still non-extractable, so a returning player
// does not type the password again. The password is only needed on a new device
// or after "Sign out". Every page of the center shares it (same origin).
//
// Earlier versions kept the raw key as hex in localStorage; restoreFromDevice
// moves such an entry here once and deletes it.

// slot: 'commander' for the signed-in player; a game may keep others (Neon Rush's robot rider).
const DEVICE = (cfg, slot = 'commander') => `${cfg.app}:${slot}`;

let database;
function idb(mode, action) {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('no IndexedDB here'));
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('anchor-games-commanders-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('commanders');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = null; reject(new Error('commander storage is unavailable')); };
  });
  return database.then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction('commanders', mode);
    const request = action(transaction.objectStore('commanders'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = transaction.onerror = () => reject(new Error('commander storage failed'));
  }));
}

const legacy = {
  read(name) { try { return JSON.parse(localStorage.getItem(name) ?? 'null'); } catch { return null; } },
  drop(name) { try { localStorage.removeItem(name); } catch { /* nothing stored */ } },
};

/** Keep `commander` on this device: its id, pub and non-extractable key (and certificate), never key bytes. */
export async function rememberOnDevice(cfg, commander, slot) {
  if (commander.privateKey.extractable) throw new Error('refusing to store an extractable commander key');
  const name = DEVICE(cfg, slot);
  try {
    await idb('readwrite', (store) => store.put({ id: commander.id, pub: commander.pub, privateKey: commander.privateKey,
      cert: commander.cert, address: commander.address }, name));
  } catch { /* private mode: the session still works until reload */ }
  legacy.drop(name);
}

/** The commander kept on this device in `slot`, or null. */
export async function restoreFromDevice(cfg, slot) {
  const name = DEVICE(cfg, slot);
  const saved = await idb('readonly', (store) => store.get(name)).catch(() => null);
  if (saved?.privateKey) return new Commander(saved.id, saved.pub, saved.privateKey, saved);
  // A key an earlier version left in localStorage, as hex: move it, then wipe it.
  const old = legacy.read(name);
  if (!old?.pkcs8) return null;
  try {
    const pkcs8 = fromHex(old.pkcs8);
    let privateKey;
    try { privateKey = await ed25519Import(pkcs8); } finally { pkcs8.fill(0); }
    const commander = new Commander(old.id, old.pub, privateKey);
    await rememberOnDevice(cfg, commander, slot);
    return commander;
  } catch {
    return null;
  } finally {
    legacy.drop(name);
  }
}

export async function forgetDevice(cfg, slot) {
  const name = DEVICE(cfg, slot);
  legacy.drop(name);
  await idb('readwrite', (store) => store.delete(name)).catch(() => {});
}

/** Forget every commander this browser keeps, robots included ("Clear browser data"). */
export async function forgetAllDevices() {
  await idb('readwrite', (store) => store.clear()).catch(() => {});
}

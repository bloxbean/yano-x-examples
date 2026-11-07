// Players and their session keys.
//
// A CIP-30 wallet signs once, authorizing a browser-held Ed25519 session key;
// the session key signs every pixel without a popup. A guest skips the wallet
// and paints with the session key alone. Either way the session key never
// leaves this browser, and the wallet's own keys are never touched beyond one
// signData call.

import { joinPayload, pixelStatement } from './game.js';
import {
  cardanoAddressBech32, ed25519Generate, ed25519Import, ed25519Sign, fromHex, toHex, utf8,
} from './crypto.js';

const SESSION_MS = 12 * 60 * 60 * 1000;

/** CIP-30 wallets injected into this page, deduplicated by name. */
export function detectWallets() {
  const found = new Map();
  for (const [id, wallet] of Object.entries(globalThis.cardano ?? {})) {
    if (wallet && typeof wallet.enable === 'function' && wallet.name && !found.has(wallet.name)) {
      found.set(wallet.name, { id, name: wallet.name, icon: wallet.icon });
    }
  }
  return [...found.values()];
}

export class Session {
  constructor(record, privateKey) {
    Object.assign(this, record);
    this.privateKey = privateKey;
  }

  static storageKey(cfg) {
    return `anchor-canvas:${cfg.chainId}:${cfg.topic}:session`;
  }

  /** The stored session, if it has more than a minute left. */
  static async restore(cfg) {
    try {
      const record = JSON.parse(localStorage.getItem(Session.storageKey(cfg)) ?? 'null');
      if (!record || record.expires < Date.now() + 60_000) return null;
      return new Session(record, await ed25519Import(fromHex(record.pkcs8)));
    } catch {
      return null;
    }
  }

  static async guest(cfg) {
    const key = await ed25519Generate();
    return Session.#create(cfg, key, {
      kind: 'guest', expires: Date.now() + SESSION_MS, name: `guest-${toHex(key.publicKey).slice(0, 4)}`,
    });
  }

  /**
   * Ask a CIP-30 wallet to authorize a new session key. Returns the session
   * and the join message body to submit.
   */
  static async withWallet(cfg, walletId, name) {
    const api = await globalThis.cardano[walletId].enable();
    const used = await api.getUsedAddresses();
    const addressHex = used?.[0] ?? (await api.getChangeAddress());
    const address = cardanoAddressBech32(fromHex(addressHex));

    const key = await ed25519Generate();
    const expires = Date.now() + SESSION_MS;
    const payload = joinPayload(cfg, toHex(key.publicKey), name, expires);
    const signed = await api.signData(addressHex, toHex(utf8(payload)));
    const session = Session.#create(cfg, key, { kind: 'wallet', expires, name, address, wallet: walletId });
    return { session, joinBody: JSON.stringify({ t: 'join', cose: signed.signature, key: signed.key }) };
  }

  static #create(cfg, key, fields) {
    const record = { ...fields, pub: toHex(key.publicKey), pkcs8: toHex(key.pkcs8), nonce: 0 };
    const session = new Session(record, key.privateKey);
    session.save(cfg);
    return session;
  }

  get playerId() {
    return this.kind === 'wallet' ? `wallet:${this.address}` : `guest:${this.pub}`;
  }

  save(cfg) {
    const { privateKey, ...record } = this;
    try { localStorage.setItem(Session.storageKey(cfg), JSON.stringify(record)); } catch { /* private mode */ }
  }

  static clear(cfg) {
    try { localStorage.removeItem(Session.storageKey(cfg)); } catch { /* private mode */ }
  }

  /** A signed pixel message body. Nonces only increase, across reloads too. */
  async pixel(cfg, x, y, c) {
    this.nonce = Math.max(Date.now(), this.nonce + 1);
    this.save(cfg);
    const sig = await ed25519Sign(this.privateKey, utf8(pixelStatement(cfg, this.pub, this.nonce, x, y, c)));
    return JSON.stringify({ t: 'px', s: this.pub, n: this.nonce, x, y, c, sig: toHex(sig) });
  }
}

// Cardano wallets (CIP-30) for wallet commanders: find the wallets injected
// into the page, and ask one to certify this browser's device key.
//
// The wallet is asked for exactly one thing, signData over a plain-text device
// statement (shared/accounts.js, deviceStatement), shown to the player in the
// wallet's own popup. No transaction, no funds, no key leaves the wallet. The
// device key it certifies is made here, non-extractable, and signs everything
// after that without another popup, until the certificate expires.

import { cardanoAddressBech32, ed25519GenerateLocked, fromHex, toHex, utf8 } from './crypto.js';
import { deviceStatement, verifyCert } from './accounts.js';
import { decode } from './cbor.js';

/** How long one browser may play on one wallet signature. */
export const DEVICE_MS = 30 * 24 * 3600 * 1000;

/** CIP-30 wallets injected into this page, deduplicated by name: [{ id, name, icon }]. */
export function detectWallets() {
  const found = new Map();
  for (const [id, wallet] of Object.entries(globalThis.cardano ?? {})) {
    if (wallet && typeof wallet.enable === 'function' && typeof wallet.name === 'string' && !found.has(wallet.name)) {
      found.set(wallet.name, { id, name: wallet.name, icon: typeof wallet.icon === 'string' ? wallet.icon : '' });
    }
  }
  return [...found.values()];
}

/** A wallet's refusal or failure as one readable line (CIP-30 errors are { code, info }). */
export const walletError = (error) => {
  const text = error?.info ?? error?.message ?? String(error);
  return error?.code === -3 || error?.code === 2 || /declin|reject|cancel|refus/i.test(text)
    ? 'The wallet request was declined' : `The wallet said: ${text}`;
};

const isHexAddress = (a) => typeof a === 'string' && /^([0-9a-f]{2}){29,57}$/i.test(a);

/** Enable wallet `walletId`; returns { api, addresses } with the stake (reward) address first. */
export async function connectWallet(walletId) {
  const wallet = globalThis.cardano?.[walletId];
  if (!wallet) throw new Error('That wallet is no longer in this page');
  let api;
  try {
    api = await wallet.enable();
  } catch (error) {
    throw new Error(walletError(error));
  }
  const ask = async (fn) => { try { return (await fn()) ?? []; } catch { return []; } };
  const reward = await ask(() => api.getRewardAddresses());
  const used = await ask(() => api.getUsedAddresses());
  const change = await ask(async () => [await api.getChangeAddress()]);
  const addresses = [...new Set([...reward, ...used, ...change].filter(isHexAddress).map((a) => a.toLowerCase()))];
  if (!addresses.length) throw new Error('The wallet shared no address this page can read');
  return { api, addresses };
}

/**
 * Ask the wallet, through `address`, to let a new device key play as `id`.
 * Returns { privateKey, pub (the wallet's key), address, cert }, checked here before use.
 */
export async function certifyDevice(cfg, api, address, id, now = Date.now()) {
  const device = await ed25519GenerateLocked();
  const until = now + DEVICE_MS;
  const cert = { device: toHex(device.publicKey), until };
  let signed;
  try {
    signed = await api.signData(address, toHex(utf8(deviceStatement(cfg, id, cert.device, until))));
  } catch (error) {
    throw new Error(walletError(error));
  }
  Object.assign(cert, { cose: String(signed?.signature ?? '').toLowerCase(), key: String(signed?.key ?? '').toLowerCase() });
  // The wallet's key is whichever key signed: read it from the COSE key, then check it all.
  let pub = '';
  try {
    const x = decode(fromHex(cert.key)).get(-2);
    if (x instanceof Uint8Array && x.length === 32) pub = toHex(x);
  } catch { /* checked below */ }
  const checked = await verifyCert(cfg, id, pub, cert);
  if (!checked.ok) throw new Error(`The wallet’s signature did not check out: ${checked.reason}`);
  if (checked.address !== address) throw new Error('The wallet signed with a different address');
  return { privateKey: device.privateKey, pub, address, cert };
}

/** stake_test1u…x9k2: a short bech32 form of a hex address, for display. */
export function shortAddress(hex) {
  try {
    const text = cardanoAddressBech32(fromHex(hex));
    return `${text.slice(0, text.indexOf('1') + 6)}…${text.slice(-4)}`;
  } catch {
    return `${hex.slice(0, 8)}…`;
  }
}

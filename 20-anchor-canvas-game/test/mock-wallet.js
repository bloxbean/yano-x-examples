// A stand-in CIP-30 wallet for local testing, loaded only on localhost with
// ?mockwallet. It holds a throwaway Ed25519 key, derives a preprod enterprise
// address from it, and answers signData with a real COSE_Sign1 — so the join
// path is exercised byte for byte as with Eternl or Lace, minus the popup.
//
// Never use this for anything but tests: the key sits in localStorage.

import { encode } from '../js/cbor.js';
import { blake2b224 } from '../js/blake2b.js';
import { ed25519Generate, ed25519Import, ed25519Sign, fromHex, toHex } from '../js/crypto.js';

const STORE = 'anchor-canvas:mock-wallet';

export async function createMockWallet(stored) {
  const { pkcs8, publicKey } = stored
    ? { pkcs8: fromHex(stored.pkcs8), publicKey: fromHex(stored.publicKey) }
    : await ed25519Generate();
  const privateKey = await ed25519Import(pkcs8);
  // Header 0x60: enterprise address, key payment credential, network 0 (testnets).
  const address = Uint8Array.of(0x60, ...blake2b224(publicKey));

  const api = {
    getNetworkId: async () => 0,
    getUsedAddresses: async () => [toHex(address)],
    getUnusedAddresses: async () => [],
    getChangeAddress: async () => toHex(address),
    getRewardAddresses: async () => [],
    signData: async (addressHex, payloadHex) => {
      if (addressHex !== toHex(address)) throw { code: 1, info: 'unknown address' };
      const protectedHeader = encode(new Map([[1, -8], ['address', address]]));
      const payload = fromHex(payloadHex);
      const toSign = encode(['Signature1', protectedHeader, new Uint8Array(0), payload]);
      const signature = await ed25519Sign(privateKey, toSign);
      return {
        signature: toHex(encode([protectedHeader, new Map([['hashed', false]]), payload, signature])),
        key: toHex(encode(new Map([[1, 1], [3, -8], [-1, 6], [-2, publicKey]]))),
      };
    },
  };
  return {
    wallet: { name: 'Mock Wallet', icon: '', apiVersion: '0.1.0', enable: async () => api, isEnabled: async () => true },
    api,
    record: { pkcs8: toHex(pkcs8), publicKey: toHex(publicKey) },
  };
}

if (typeof window !== 'undefined') {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(STORE) ?? 'null'); } catch { /* none */ }
  const mock = await createMockWallet(stored);
  try { localStorage.setItem(STORE, JSON.stringify(mock.record)); } catch { /* private mode */ }
  window.cardano = { ...(window.cardano ?? {}), mock: mock.wallet };
}

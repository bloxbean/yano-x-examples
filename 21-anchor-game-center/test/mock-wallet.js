// A stand-in CIP-30 wallet for local testing, loaded only on a loopback host
// with ?mockwallet (adapted from example 20). It holds a throwaway Ed25519 key
// as a stake key, offers its preprod reward address, and answers signData with
// a real COSE_Sign1, so the wallet path runs byte for byte as with Eternl or
// Lace, minus the popup.
//
// Never use this for anything but tests: its key sits in localStorage.

import { encode } from '../shared/cbor.js';
import { blake2b224 } from '../shared/blake2b.js';
import { ed25519Generate, ed25519Import, ed25519Sign, fromHex, toHex } from '../shared/crypto.js';

const STORE = 'anchor-games:mock-wallet';

export async function createMockWallet(stored) {
  const { pkcs8, publicKey } = stored
    ? { pkcs8: fromHex(stored.pkcs8), publicKey: fromHex(stored.publicKey) }
    : await ed25519Generate();
  const privateKey = await ed25519Import(pkcs8);
  // Header 0xe0: a reward address with a key credential, network 0 (testnets).
  const address = Uint8Array.of(0xe0, ...blake2b224(publicKey));
  let declines = 0;

  const api = {
    getNetworkId: async () => 0,
    getRewardAddresses: async () => [toHex(address)],
    getUsedAddresses: async () => [],
    getUnusedAddresses: async () => [],
    getChangeAddress: async () => toHex(address),
    signData: async (addressHex, payloadHex) => {
      if (declines > 0) { declines--; throw { code: 3, info: 'user declined to sign' }; }
      if (addressHex !== toHex(address)) throw { code: 1, info: 'unknown address' };
      mock.signed.push(new TextDecoder().decode(fromHex(payloadHex)));
      const protectedHeader = encode(new Map([[1, -8], ['address', address]]));
      const payload = fromHex(payloadHex);
      const signature = await ed25519Sign(privateKey, encode(['Signature1', protectedHeader, new Uint8Array(0), payload]));
      return {
        signature: toHex(encode([protectedHeader, new Map([['hashed', false]]), payload, signature])),
        key: toHex(encode(new Map([[1, 1], [3, -8], [-1, 6], [-2, publicKey]]))),
      };
    },
  };
  const mock = {
    wallet: { name: 'Mock Wallet', icon: '', apiVersion: '0.1.0', enable: async () => api, isEnabled: async () => true },
    api,
    signed: [], // every statement it signed, for tests
    decline(n = 1) { declines = n; },
    record: { pkcs8: toHex(pkcs8), publicKey: toHex(publicKey) },
  };
  return mock;
}

if (typeof window !== 'undefined') {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(STORE) ?? 'null'); } catch { /* none */ }
  const mock = await createMockWallet(stored);
  try { localStorage.setItem(STORE, JSON.stringify(mock.record)); } catch { /* private mode */ }
  window.cardano = { ...(window.cardano ?? {}), mock: mock.wallet };
  window.mockWallet = mock;
}

// Verify a CIP-30 signData result (CIP-8 / COSE_Sign1) and bind it to the
// Cardano address that signed it. Copied from example 20 (Anchor Canvas).
//
// A wallet answers signData(address, payload) with two CBOR blobs:
//   signature = COSE_Sign1 [protected, unprotected, payload, signature]
//   key       = COSE_Key   {1: 1 (OKP), 3: -8 (EdDSA), -1: 6 (Ed25519), -2: x}
// The protected header carries the address. A signature only proves control of
// that address if BLAKE2b-224(x) is the address's payment (or stake) key hash —
// otherwise anyone could sign with their own key and claim someone else's
// address. That binding is the step most hand-rolled verifiers forget.

import { decode, encode } from './cbor.js';
import { blake2b224 } from './blake2b.js';
import { ed25519Verify, equalBytes, fromHex } from './crypto.js';

const fail = (reason) => ({ ok: false, reason });

/** Returns { ok, reason?, payload, address, publicKey } — never throws. */
export async function verifyCip8(signatureHex, keyHex) {
  let sign1;
  let coseKey;
  try {
    sign1 = decode(fromHex(signatureHex));
    coseKey = decode(fromHex(keyHex));
  } catch (e) {
    return fail(`malformed COSE: ${e.message}`);
  }
  if (!Array.isArray(sign1) || sign1.length !== 4) return fail('COSE_Sign1 must be a 4-element array');
  const [protectedBytes, unprotected, payload, signature] = sign1;
  if (!(protectedBytes instanceof Uint8Array) || !(payload instanceof Uint8Array)
      || !(signature instanceof Uint8Array)) {
    return fail('COSE_Sign1 fields have the wrong types');
  }
  if (unprotected instanceof Map && unprotected.get('hashed') === true) {
    return fail('hashed payloads are not accepted: the game must read the signed text');
  }

  let headers;
  try {
    headers = decode(protectedBytes);
  } catch {
    return fail('malformed protected header');
  }
  if (!(headers instanceof Map) || headers.get(1) !== -8) return fail('algorithm is not EdDSA');
  const address = headers.get('address');
  if (!(address instanceof Uint8Array) || address.length < 29) return fail('no address in protected header');

  if (!(coseKey instanceof Map) || coseKey.get(1) !== 1 || coseKey.get(-1) !== 6) {
    return fail('COSE_Key is not an Ed25519 OKP key');
  }
  const publicKey = coseKey.get(-2);
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) return fail('COSE_Key has no 32-byte x');

  const sigStructure = encode(['Signature1', protectedBytes, new Uint8Array(0), payload]);
  if (!(await ed25519Verify(publicKey, signature, sigStructure))) return fail('signature does not verify');

  // Shelley headers: types 0..7 carry the payment credential first, odd types
  // being scripts; 14 is a key-based reward address. Byron and script
  // credentials cannot sign, so they cannot be bound.
  const type = address[0] >> 4;
  const keyCredential = (type <= 7 && type % 2 === 0) || type === 14;
  if (!keyCredential) return fail(`address type ${type} has no key credential`);
  if (!equalBytes(address.subarray(1, 29), blake2b224(publicKey))) {
    return fail('signing key does not belong to the address');
  }
  return { ok: true, payload, address, publicKey };
}

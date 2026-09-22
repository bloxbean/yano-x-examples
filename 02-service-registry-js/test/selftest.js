// Self-tests for the verification primitives.
//
// The CLI runs these before it verifies anything. A verifier built on a broken
// hash would happily "verify" nonsense, which is worse than not verifying at
// all — so these are a precondition, not an optional test suite.
//
// Run them on their own with: npm test

import { blake2b256 } from '../src/blake2b.js';
import * as cbor from '../src/cbor.js';
import { blockHash, commitDigest, decodeRegistryEntry } from '../src/verify.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');

const checks = [];
const check = (name, actual, expected) => {
  checks.push({ name, ok: actual === expected, actual, expected });
};

// --- BLAKE2b-256, RFC 7693 test vectors ------------------------------------

check('blake2b256("")', hex(blake2b256(Buffer.from(''))),
  '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8');
check('blake2b256("abc")', hex(blake2b256(Buffer.from('abc'))),
  'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319');

// Inputs either side of the 128-byte block boundary, where padding and the
// final-block flag are easy to get wrong.
check('blake2b256(0xab * 127)', hex(blake2b256(Buffer.alloc(127, 0xab))),
  '88039b34756d8378bdfac8da993577257d28b7ddd40aa90f357b5849f6262ba9');
check('blake2b256(0xab * 128)', hex(blake2b256(Buffer.alloc(128, 0xab))),
  'e28dbbbacc7cafa062f8c043bf25ec6043bfa25fb32ab91881e09c0a300290d2');
check('blake2b256(0xab * 129)', hex(blake2b256(Buffer.alloc(129, 0xab))),
  '8641652356f97d49a81ca90d34e6bcc95f226242a8859bc69cfba62f81706747');

// --- Canonical CBOR ---------------------------------------------------------

check('cbor uint 0', hex(cbor.uint(0)), '00');
check('cbor uint 23', hex(cbor.uint(23)), '17');
check('cbor uint 24', hex(cbor.uint(24)), '1818');
check('cbor uint 256', hex(cbor.uint(256)), '190100');
check('cbor uint 65536', hex(cbor.uint(65536)), '1a00010000');
// Block timestamps exceed 2^32, so the 8-byte form must be right.
check('cbor uint 1789983908071', hex(cbor.uint(1789983908071)), '1b000001a0c35ae0e7');
check('cbor empty bytes', hex(cbor.bytes(new Uint8Array(0))), '40');
check('cbor text "abc"', hex(cbor.text('abc')), '63616263');
check('cbor array', hex(cbor.array(cbor.uint(1), cbor.uint(2))), '820102');

// Round trip through the decoder.
const roundTrip = cbor.decodeOne(cbor.array(cbor.uint(7), cbor.text('hi'), cbor.bytes(Uint8Array.of(1, 2))));
check('cbor round trip', JSON.stringify([roundTrip[0], roundTrip[1], hex(roundTrip[2])]),
  JSON.stringify([7, 'hi', '0102']));

// --- Header hashing, against a real block produced by a node ---------------
//
// Captured from a running devnet cluster. If the header encoding ever drifts,
// this fails here rather than silently rejecting every live proof.

const FIXTURE_HEADER = {
  chainId: 'service-registry-chain',
  version: 3,
  height: 1,
  prevHash: '0000000000000000000000000000000000000000000000000000000000000000',
  l1Slot: 0,
  l1BlockHash: '',
  timestamp: 1789983908071,
  messagesRoot: '4e68edd8930e2b244b6fb697c88d4dd026e5f00ce739d951efed6f89ad2a19ea',
  stateRoot: '8625db2a67f88c7b4d35be8780b199edcf3397db29fe64176353fda789086fd2',
  blockHash: 'bfc49084a49d53580e56480fcd35f0a17c17e90ab7279b7cb6ab853fd5018a7b',
  view: 1,
  consensusContextDigest: 'dcc6ae016ff4f3bcb6b72effdb99c5c41c7c65a004987d3f57bbeb4b2a88ef8e',
  proposer: 'ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1',
  justificationDigest: 'ea517743c098e7eddab92fd978ce767659341b7a6bdb8a83ea8d8b0c376c0f19',
};

check('block hash recomputed from a real header',
  hex(blockHash(FIXTURE_HEADER)), FIXTURE_HEADER.blockHash);

// Changing any committed field must change the hash.
check('altered state root changes the block hash',
  hex(blockHash({ ...FIXTURE_HEADER, stateRoot: 'ff'.repeat(32) })) === FIXTURE_HEADER.blockHash,
  false);
// This is the digest the members actually signed for that block. It is not a
// value this code chose: the two real Ed25519 signatures in the captured
// envelope verify over exactly these bytes, which is what pins it.
check('commit digest matches what the members signed',
  hex(commitDigest(FIXTURE_HEADER)),
  '792d03301ae77c6082d672ac8ecc78dcc02c02033092d9c4ea035eaf89bebdf2');

// --- kv-registry value decoding --------------------------------------------

const entry = decodeRegistryEntry(
  '8258208139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394' +
  '582068747470733a2f2f6170692e61636d652d62616e6b2e6578616d706c652f7631');
check('registry entry owner', entry.owner,
  '8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394');
check('registry entry value', entry.value, 'https://api.acme-bank.example/v1');

// --- runner -----------------------------------------------------------------

export function selfTest({ verbose = false } = {}) {
  const failed = checks.filter((c) => !c.ok);
  if (verbose) {
    for (const c of checks) console.log(`  [${c.ok ? 'ok  ' : 'FAIL'}] ${c.name}`);
  }
  if (failed.length > 0) {
    const detail = failed
      .map((c) => `  ${c.name}\n    expected ${c.expected}\n    actual   ${c.actual}`)
      .join('\n');
    throw new Error(`verification primitives are broken — refusing to verify anything:\n${detail}`);
  }
  return checks.length;
}

// `npm test` runs this file directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('Verification self-test\n');
  const count = selfTest({ verbose: true });
  console.log(`\n${count} checks passed.`);
}

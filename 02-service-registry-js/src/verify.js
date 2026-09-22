// Verifying a Yano app-chain answer inside your own application.
//
// The question this file answers is: "a node told me the registry says X —
// why should I believe it?"
//
// A state-proof response carries three things: the value, the block header it
// was committed in, and the finality certificate for that block. Together they
// let an application check, on its own:
//
//   1. the block header really hashes to the block hash it claims;
//   2. a threshold of members SIGNED that exact header — and therefore that
//      exact state root — using member keys the application pinned itself.
//
// Nothing here trusts the node that served the answer. It only trusts the
// member public keys the caller supplies, which must come from somewhere else:
// the consortium agreement, a config file, a genesis ceremony.

import { createPublicKey, verify as edVerify } from 'node:crypto';
import { blake2b256 } from './blake2b.js';
import * as cbor from './cbor.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const unhex = (value) => Uint8Array.from(Buffer.from(value ?? '', 'hex'));

const COMMIT_DOMAIN = new TextEncoder().encode('yano-appchain-commit-v2\0');

/**
 * blake2b256(CBOR([...wire header, proposer, justificationDigest]))
 * The header binds the message ids through messagesRoot and the committed
 * history through prevHash, so this one hash commits to the whole block.
 */
export function blockHash(header) {
  return blake2b256(cbor.array(
    cbor.uint(header.version),
    cbor.text(header.chainId),
    cbor.uint(header.height),
    cbor.bytes(unhex(header.consensusContextDigest)),
    cbor.uint(header.view),
    cbor.bytes(unhex(header.prevHash)),
    cbor.uint(header.l1Slot),
    cbor.bytes(unhex(header.l1BlockHash)),
    cbor.uint(header.timestamp),
    cbor.bytes(unhex(header.messagesRoot)),
    cbor.bytes(unhex(header.stateRoot)),
    cbor.bytes(unhex(header.proposer)),
    cbor.bytes(unhex(header.justificationDigest)),
  ));
}

/**
 * The deterministic application value, excluding view and proposer.
 * Two members that ordered the same messages agree on this even if they
 * disagree about who proposed the block.
 */
export function valueHash(header) {
  return blake2b256(cbor.array(
    cbor.uint(header.version),
    cbor.text(header.chainId),
    cbor.uint(header.height),
    cbor.bytes(unhex(header.consensusContextDigest)),
    cbor.bytes(unhex(header.prevHash)),
    cbor.uint(header.l1Slot),
    cbor.bytes(unhex(header.l1BlockHash)),
    cbor.uint(header.timestamp),
    cbor.bytes(unhex(header.messagesRoot)),
    cbor.bytes(unhex(header.stateRoot)),
  ));
}

/** The domain-separated digest each member signs to commit a block. */
export function commitDigest(header) {
  const int64 = (value) => {
    const out = new Uint8Array(8);
    let big = BigInt(value);
    for (let i = 7; i >= 0; i--) { out[i] = Number(big & 0xffn); big >>= 8n; }
    return out;
  };
  return blake2b256(Buffer.concat([
    COMMIT_DOMAIN,
    int64(header.height),
    int64(header.view),
    unhex(header.consensusContextDigest),
    blockHash(header),
    valueHash(header),
  ].map(Buffer.from)));
}

/** Wrap a raw 32-byte Ed25519 public key so node:crypto will use it. */
function ed25519Key(rawPublicKeyHex) {
  const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(rawPublicKeyHex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Verify a state-proof envelope against member keys the caller pinned.
 *
 * @param envelope  the JSON returned by GET /state/proof/{keyHex}
 * @param trust     { chainId, memberKeys: [hex...], threshold }
 */
export function verifyCertifiedRoot(envelope, trust) {
  const checks = [];
  const fail = (label, detail) => { checks.push({ label, ok: false, detail }); return { ok: false, checks }; };
  const pass = (label, detail) => checks.push({ label, ok: true, detail });

  const certificate = envelope.finalityCertificate;
  if (!envelope.block || !certificate) {
    return fail('envelope carries a certified header', 'missing block or finalityCertificate');
  }

  if (envelope.chainId !== trust.chainId) {
    return fail('chain id matches the one you pinned', `${envelope.chainId} != ${trust.chainId}`);
  }
  pass('chain id matches the one you pinned', trust.chainId);

  // The header commitment includes the chain id, but the envelope carries it
  // once at the top level rather than repeating it inside the block. Bind the
  // pinned chain id here: if it were taken from the node's block object, a node
  // could replay another chain's certificate.
  const header = { ...envelope.block, chainId: trust.chainId };

  // The header must be the one the proof commits to.
  if (header.height !== envelope.committedHeight || header.stateRoot !== envelope.stateRoot) {
    return fail('header matches the proof it came with', 'height or state root disagree');
  }
  pass('header matches the proof it came with', `height ${header.height}`);

  // 1. Recompute the block hash from the header fields.
  const computed = hex(blockHash(header));
  if (computed !== header.blockHash) {
    return fail('block hash recomputed from the header', `${computed} != ${header.blockHash}`);
  }
  pass('block hash recomputed from the header', computed.slice(0, 16) + '…');

  // 2. Verify each signature over the commit digest, against pinned keys only.
  const digest = Buffer.from(commitDigest(header));
  const pinned = new Set(trust.memberKeys.map((key) => key.toLowerCase()));
  const counted = new Set();

  for (const signature of certificate.signatures ?? []) {
    const signer = (signature.signer ?? '').toLowerCase();
    if (!pinned.has(signer)) continue;          // not a member we trust — ignore it
    if (counted.has(signer)) continue;          // one vote per member
    const valid = edVerify(null, digest, ed25519Key(signer), Buffer.from(signature.signature, 'hex'));
    if (valid) counted.add(signer);
  }

  if (counted.size < trust.threshold) {
    return fail(`${trust.threshold} of ${trust.memberKeys.length} pinned members signed this root`,
      `only ${counted.size} valid signature(s)`);
  }
  pass(`${trust.threshold} of ${trust.memberKeys.length} pinned members signed this root`,
    [...counted].map((key) => key.slice(0, 12)).join(', '));

  return { ok: true, checks, signers: [...counted], stateRoot: envelope.stateRoot, height: header.height };
}

/** kv-registry stores canonical CBOR [ownerPublicKey, value] at the key bytes. */
export function decodeRegistryEntry(valueHex) {
  if (!valueHex) return null;
  const [owner, value] = cbor.decodeOne(unhex(valueHex));
  return { owner: hex(owner), value: new TextDecoder().decode(value) };
}

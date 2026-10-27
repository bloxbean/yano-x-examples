// The stock authenticated-map machine, from JavaScript: one write shape and
// one read.
//
// Write: PUT_IF_ABSENT into an `owner` collection. The machine refuses the
// write if the key exists (receipt error 4, ALREADY_EXISTS), which is what
// makes call signs first come, first served without any game code on the
// members. The bytes are pinned by a golden vector from the release CLI
// (`yano.sh appchain authenticated-map action|command`) in test/run.mjs.
//
//   mutation = [op, collection, key, value, expectedRevision, expectedHash, newController]
//   action   = [1, 0 (single), [mutation], [[0, authorizationKind, policy, policyRevision]]]
//   envelope = [1, bstr(action), evidence[]]
//
// Read: the stdlib domain route returns the entry as an authenticated record.
// An absent key still answers, with the height at which absence was committed,
// which the game uses to decide "registered before this join?" identically in
// every browser.

import { decode, encode } from './cbor.js';
import { fromHex } from './crypto.js';

export const AUTHMAP_TOPIC = 'authenticated-map.command.v1';
const OP_PUT_IF_ABSENT = 1;
const AUTH_OWNER = 1;
export const RECEIPT_ALREADY_EXISTS = 4;

export function putIfAbsentEnvelope(collection, key, value) {
  const empty = new Uint8Array(0);
  const mutation = [OP_PUT_IF_ABSENT, collection, key, value, 0, empty, empty];
  const action = encode([1, 0, [mutation], [[0, AUTH_OWNER, '', 0]]]);
  return encode([1, action, []]);
}

/**
 * Decode an entry route response:
 * { present, committedHeight, revision?, status?, value?, createdHeight?, lastMutationHeight? }.
 * The record is [version, status, revision, controller, value, valueHash, createdHeight, lastMutationHeight].
 */
export function decodeEntry(response) {
  const base = { committedHeight: response.committedHeight };
  if (response.record?.presence !== 1 || !response.recordValue) return { ...base, present: false };
  const [, status, revision, controller, value, , createdHeight, lastMutationHeight] =
    decode(fromHex(response.recordValue));
  return { ...base, present: true, status, revision, controller, value, createdHeight, lastMutationHeight };
}

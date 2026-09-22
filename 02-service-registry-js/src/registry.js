// The kv-registry command format and what its state means.
//
// kv-registry is a stock Yano state machine with exactly one authorization
// rule: the member that first writes a key owns it, and only that member can
// change or remove it. Everything below is the wire encoding of that.

import * as cbor from './cbor.js';
import { decodeRegistryEntry } from './verify.js';
import { awaitFinalized } from './client.js';

export const TOPIC = 'registry.command.v1';

const enc = new TextEncoder();
const hex = (bytes) => Buffer.from(bytes).toString('hex');

/** [0, key, value] — create or replace. A PUT by a non-owner is a no-op. */
export const putCommand = (key, value) =>
  hex(cbor.array(cbor.uint(0), cbor.bytes(enc.encode(key)), cbor.bytes(enc.encode(value))));

/** [1, key, empty] — remove. A DELETE by a non-owner is a no-op. */
export const deleteCommand = (key) =>
  hex(cbor.array(cbor.uint(1), cbor.bytes(enc.encode(key)), cbor.bytes(new Uint8Array(0))));

/** The physical state key is exactly the registry key bytes. */
export const stateKey = (key) => hex(enc.encode(key));

/**
 * Submit a command through one member and wait for it to be finalized.
 *
 * The member that receives the submission is the one that signs it, so WHICH
 * member you submit through decides who owns the key.
 */
export async function submitCommand(member, members, bodyHex) {
  const accepted = await member.submit(TOPIC, bodyHex);
  const finalized = await awaitFinalized(members, accepted.messageId);
  return { messageId: accepted.messageId, height: finalized.height, index: finalized.index };
}

/** Read the current entry from one member, with the envelope that proves it. */
export async function readEntry(member, key) {
  const envelope = await member.stateProof(stateKey(key));
  if (!envelope) return { present: false, envelope: null, entry: null };
  return {
    present: envelope.presence === 'PRESENT',
    envelope,
    entry: envelope.presence === 'PRESENT' ? decodeRegistryEntry(envelope.valueHex) : null,
  };
}

/**
 * Every write ATTEMPT, from the finalized blocks.
 *
 * This is the part people find surprising, so it is worth making visible: the
 * log holds every command that was finalized, including ones that changed
 * nothing. Being in the log means the members agreed it was submitted; it does
 * not mean it was applied.
 */
export async function writeAttempts(member, limit = 50) {
  const tip = await member.tip();
  const attempts = [];
  for (let height = tip.height; height >= 1 && attempts.length < limit; height--) {
    const block = await member.block(height);
    if (!block) continue;
    for (let i = (block.messages ?? []).length - 1; i >= 0 && attempts.length < limit; i--) {
      const message = block.messages[i];
      if (message.topic !== TOPIC) continue;
      const decoded = decodeCommand(message.bodyHex);
      if (decoded) attempts.push({ height, sender: message.sender, ...decoded });
    }
  }
  return attempts;
}

function decodeCommand(bodyHex) {
  try {
    const [op, key, value] = cbor.decodeOne(Uint8Array.from(Buffer.from(bodyHex, 'hex')));
    const decoder = new TextDecoder();
    return {
      operation: op === 0 ? 'put' : 'delete',
      key: decoder.decode(key),
      value: op === 0 ? decoder.decode(value) : null,
    };
  } catch {
    return null;
  }
}

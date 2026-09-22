// The `approvals` state machine's wire format, and the webhook payload it carries.

import * as cbor from './cbor.js';
import { stateProof } from './client.js';

export const TOPIC = 'approvals';

const enc = new TextEncoder();
const hex = (bytes) => Buffer.from(bytes).toString('hex');

/**
 * The webhook payload the approval carries.
 *
 * A canonical CBOR map: the body to POST, and its content type. The approvals
 * machine does not interpret this — it only carries it to whichever executor
 * `on-approved-effect.type` names. Swap the type and the same approval drives
 * something else entirely.
 */
export const webhookPayload = (body, contentType = 'application/json') =>
  cbor.map([
    ['body', cbor.bytes(enc.encode(body))],
    ['content-type', cbor.text(contentType)],
  ]);

/** [0, itemId, payload, requiredApprovals, deadlineMillis] */
export const propose = (itemId, payload, required, deadlineMillis) =>
  hex(cbor.array(cbor.uint(0), cbor.text(itemId), cbor.bytes(payload),
    cbor.uint(required), cbor.uint(deadlineMillis)));

/** [1, itemId] */
export const approve = (itemId) => hex(cbor.array(cbor.uint(1), cbor.text(itemId)));

/** [2, itemId] — one rejection is terminal. */
export const reject = (itemId) => hex(cbor.array(cbor.uint(2), cbor.text(itemId)));

/** The approval decision lives at UTF-8 `i/<itemId>`. */
export const itemKey = (itemId) => hex(enc.encode(`i/${itemId}`));

/**
 * The effect's own state lives at `ae/s/<itemId>` — separate from the decision.
 *
 * This separation is the point: the approval is APPROVED the moment the
 * members agree, and stays APPROVED. Whether the outside world acted on it is
 * a different fact, recorded separately, and only after the executor reports
 * back.
 */
export const effectKey = (itemId) => hex(enc.encode(`ae/s/${itemId}`));

const DECISION = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'];
const EFFECT = ['PENDING', 'CONFIRMED', 'FAILED'];

/** Read a committed value, or null when the key is absent. */
async function committed(keyHex, index) {
  const envelope = await stateProof(keyHex, index);
  if (!envelope || envelope.presence !== 'PRESENT' || !envelope.valueHex) return null;
  return { bytes: Uint8Array.from(Buffer.from(envelope.valueHex, 'hex')), envelope };
}

/**
 * The approval decision.
 *
 * The committed record is a fixed 7-field array:
 *
 *   [ status, proposer, payloadHash, requiredApprovals, deadlineMillis,
 *     approvers[], reserved ]
 *
 * Decoded positionally, because guessing by shape gets it wrong — the
 * proposer key and the payload hash are both 32 bytes too.
 */
export async function decision(itemId, index = 0) {
  const found = await committed(itemKey(itemId), index);
  if (!found) return null;
  const [status, proposer, payloadHash, required, deadline, approvers] =
    cbor.decodeOne(found.bytes);
  return {
    state: DECISION[status] ?? `state ${status}`,
    required,
    approvals: Array.isArray(approvers) ? approvers.length : 0,
    approvers: (approvers ?? []).map((key) => hex(key).slice(0, 12)),
    payloadHash: hex(payloadHash),
    proposer: hex(proposer).slice(0, 12),
    deadline,
    height: found.envelope.committedHeight,
  };
}

/**
 * The effect's separately committed outcome.
 *
 *   [ schemaVersion, status, effectId, attempts, resultDetail, error ]
 *
 * Decoded positionally — the record has several small integers and picking
 * "the first number" finds the schema version, not the status.
 */
export async function effectState(itemId, index = 0) {
  const found = await committed(effectKey(itemId), index);
  if (!found) return null;
  const [, status, effectId, attempts, detail, error] = cbor.decodeOne(found.bytes);
  const text = (value) => (value instanceof Uint8Array
    ? new TextDecoder().decode(value) : String(value ?? ''));
  return {
    state: EFFECT[status] ?? `state ${status}`,
    effectId: text(effectId),
    attempts,
    detail: text(detail),
    error: text(error),
    height: found.envelope.committedHeight,
  };
}

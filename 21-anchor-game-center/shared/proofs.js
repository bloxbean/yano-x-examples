// Proving things against the root anchored on Cardano — the parts every game
// shares. Each proof asks a member for a typed proof subject at the view
// `latest-confirmed-anchor`, then checks what it can locally. Games add their
// own move proofs on top (galaxy/js/proofs.js, arcade/js/proofs.js).
//
// Not everything is checked here: the member evaluates the MPF proof itself
// (trust NODE_CONFIRMED_L1_REFERENCE). Example 09 shows how to verify the
// proof and the anchor datum with nothing but Cardano.

import { blake2b } from './blake2b.js';
import { profileKey } from './accounts.js';
import { toHex, utf8 } from './crypto.js';
import { ACCOUNTS } from './config.js';

export const ENTRY_SUBJECT = 'authenticated-map:authenticated-map-entry-v1';
export const MESSAGE_SUBJECT = 'finalized-message-v1';

/** The authenticated-map logical value hash: BLAKE2b-256("yano-authenticated-map-value-v1" ‖ 0 ‖ u32be(len) ‖ value). */
export function logicalValueHash(value) {
  const domain = utf8('yano-authenticated-map-value-v1');
  const bytes = new Uint8Array(domain.length + 5 + value.length);
  bytes.set(domain, 0);
  new DataView(bytes.buffer).setUint32(domain.length + 1, value.length);
  bytes.set(value, domain.length + 5);
  return toHex(blake2b(bytes, 32));
}

export function typedProof(ledger, chain, subject, coordinates, view, claim) {
  return ledger.read(ledger.chainPath(chain, `/proof-subjects/${encodeURIComponent(subject)}/proof`), {
    method: 'POST',
    body: JSON.stringify({ coordinates, view, claim, includeEvidence: false }),
  });
}

const short = (key) => `${key.slice(0, 8)}…`;
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Who wrote a session move, checked here from the message's own bytes (shared/sessions.js,
 * openMove): the session key's signature, the issuer's credential for this game's scope, and
 * the commander's pass for that session key. Returns { checks, body, author }.
 * For a signed game (no sessions) `legacy` checks the commander's signature instead.
 */
export async function authorshipChecks(moves, message, expectId, expectPub, legacy) {
  if (!moves.cfg.sessions) return { checks: [await legacy()], body: null, author: null };
  const opened = await moves.open(message);
  const a = opened.author;
  if (!a) return { checks: [{ ok: false, text: `the move does not open: ${opened.refusal}` }], body: null, author: null };
  return {
    body: opened.body,
    author: a,
    checks: [
      { ok: true, text: `signed by session key ${short(a.session)} — a non-extractable key that never left the player’s browser` },
      { ok: true, text: `the game publisher’s issuer ${short(a.issuer)} delegated that key for ${moves.cfg.scope}, until ${clock(a.until)}; every member checked it before storing the move` },
      { ok: a.id === expectId && a.pub === expectPub, text: a.device
        ? `${a.id}’s device key ${short(a.device)} signed the session pass that binds the key to ${a.id}; `
          + `${a.id}’s Cardano wallet ${short(a.pub)} certified that device until ${new Date(a.certUntil).toLocaleDateString()}`
        : `${a.id}’s commander key ${short(a.pub)} signed the session pass that binds the key to ${a.id}` },
    ],
  };
}

/** Common checks: finality certificate and, when sealed, the anchored root. */
export function rootChecks(proof, anchor, sealed, threshold) {
  const sigs = proof.proof?.finalityCertificate?.signatures?.length ?? 0;
  const checks = [
    { ok: sigs >= threshold, text: `finality certificate: ${sigs} member signatures (threshold ${threshold})` },
    { ok: true, text: `proven under state root ${proof.proof.stateRoot.slice(0, 16)}… at height ${proof.proof.version}` },
  ];
  if (sealed) {
    checks.push({ ok: proof.proof.stateRoot === anchor.stateRoot,
      text: `that root is the one anchored on Cardano in tx ${anchor.transactionHash.slice(0, 16)}…`, tx: anchor.transactionHash });
  }
  return checks;
}

/**
 * Prove a commander's profile. The proof's value digest must equal BLAKE2b of
 * the exact profile bytes this browser verified, so "this call sign is this
 * key" is what was anchored, not just "some entry exists".
 * Returns { sealed, anchor, checks: [{ ok, text, tx? }], trust, pending? }.
 */
export async function proveProfile(ledger, profiles, id, { threshold, expectPub } = {}) {
  const found = await profiles.lookup(id);
  if (!found.present) return { checks: [{ ok: false, text: `no profile for “${id}”` }] };
  const anchor = await ledger.anchor(ACCOUNTS.profilesChain);
  const sealed = !!anchor && found.createdHeight <= anchor.anchoredHeight;
  const proof = await typedProof(ledger, ACCOUNTS.profilesChain, ENTRY_SUBJECT,
    { collection: ACCOUNTS.profilesCollection, key: toHex(profileKey(ACCOUNTS, id)) },
    sealed ? 'latest-confirmed-anchor' : 'latest',
    { claimId: 'revision-exact', operands: { expected: 1 } });
  if (!proof?.proof) return { checks: [{ ok: false, text: 'the member returned no proof' }] };
  const fields = proof.fact?.fields ?? {};
  const checks = [
    { ok: !!found.profile, text: found.profile?.v === 2
      ? `the profile is signed by a Cardano wallet, key ${found.profile.pub.slice(0, 10)}… (CIP-8, bound to its address)`
      : `the profile is self-signed by its key ${found.profile?.pub.slice(0, 10) ?? ''}…` },
    { ok: proof.claimResult?.satisfied === true && fields.status === 'ACTIVE',
      text: `the ledger holds it at revision ${fields.revision}, ${String(fields.status).toLowerCase()} — first come, never replaced` },
    { ok: fields['value-digest'] === logicalValueHash(found.value),
      text: 'the proven value is exactly the profile checked above (value digest matches)' },
  ];
  if (expectPub) {
    checks.push({ ok: found.profile?.pub === expectPub, text: found.profile?.v === 2
      ? 'it is the wallet that certified the device keys this commander signs with'
      : 'it is the key this commander signs moves with' });
  }
  checks.push(...rootChecks(proof, anchor, sealed, threshold));
  return { sealed, anchor, checks, trust: proof.trust,
    pending: sealed ? null : `created at height ${found.createdHeight}; the profile chain is sealed through ${anchor?.anchoredHeight ?? 'nothing yet'}` };
}

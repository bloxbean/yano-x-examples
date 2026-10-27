// Galaxy's own proof: the finalized move that took a planet, and that the
// commander signed it. The message body is fetched and its Ed25519 signature
// checked against the commander's key, so "satya launched this fleet" rests on
// satya's signature, not on the member that relayed it.

import { ed25519Verify, fromHex, utf8 } from '../../shared/crypto.js';
import { MESSAGE_SUBJECT, rootChecks, typedProof } from '../../shared/proofs.js';
import { moveStatement, roundTopic } from './galaxy.js';

/** Prove `planet.taken`; `player` is the galaxy's record of the commander. */
export async function proveMove(cfg, ledger, galaxy, taken, player, { threshold } = {}) {
  const message = await ledger.message(cfg.movesChain, taken.messageId);
  if (!message) return { checks: [{ ok: false, text: 'the move is not visible on this member' }] };
  let body = null;
  try { body = JSON.parse(new TextDecoder().decode(fromHex(message.bodyHex))); } catch { /* checked below */ }
  const fields = body?.t === 'join' ? [body.pub] : [body?.from, body?.to, body?.pct];
  const signed = !!body && await ed25519Verify(fromHex(player.pub), fromHex(body.sig),
    utf8(moveStatement(cfg, galaxy.round, body.t, body.id, body.n, fields)));

  const anchor = await ledger.anchor(cfg.movesChain);
  const sealed = !!anchor && taken.height <= anchor.anchoredHeight;
  const proof = await typedProof(ledger, cfg.movesChain, MESSAGE_SUBJECT, { 'message-id': taken.messageId },
    sealed ? 'latest-confirmed-anchor' : 'latest', { claimId: 'recorded', operands: {} });
  if (!proof?.proof) return { checks: [{ ok: false, text: 'the member returned no proof' }] };
  const f = proof.fact?.fields ?? {};
  const checks = [
    { ok: signed, text: `signed by ${player.id}’s commander key — the relaying member could not have forged it` },
    { ok: proof.claimResult?.satisfied === true, text: proof.claimResult?.explanation ?? 'claim not evaluated' },
    { ok: f.height === taken.height && f.index === taken.index && f.topic === roundTopic(cfg, galaxy.round),
      text: `recorded at block #${f.height}, position ${f.index}, on this round’s topic` },
    ...rootChecks(proof, anchor, sealed, threshold),
  ];
  return { sealed, anchor, checks, trust: proof.trust, body, message,
    pending: sealed ? null : `finalized at block #${taken.height}; the moves chain is sealed through #${anchor?.anchoredHeight ?? '—'}` };
}

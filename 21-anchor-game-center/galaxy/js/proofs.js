// Galaxy's own proof: the finalized move that took a planet, and who made it.
// The message body is fetched and every signature in it is checked here: the
// session key's, the issuer's credential and the commander's session pass — so
// "satya launched this fleet" rests on satya's keys, not on the member that
// relayed it.

import { MESSAGE_SUBJECT, authorshipChecks, rootChecks, typedProof } from '../../shared/proofs.js';
import { roundTopic } from './galaxy.js';

/** Prove `planet.taken`; `player` is the galaxy's record of the commander. */
export async function proveMove(cfg, ledger, moves, galaxy, taken, player, { threshold } = {}) {
  const message = await ledger.message(cfg.movesChain, taken.messageId);
  if (!message) return { checks: [{ ok: false, text: 'the move is not visible on this member' }] };
  const { checks: signed, body } = await authorshipChecks(moves, message, player.id, player.pub);

  const anchor = await ledger.anchor(cfg.movesChain);
  const sealed = !!anchor && taken.height <= anchor.anchoredHeight;
  const proof = await typedProof(ledger, cfg.movesChain, MESSAGE_SUBJECT, { 'message-id': taken.messageId },
    sealed ? 'latest-confirmed-anchor' : 'latest', { claimId: 'recorded', operands: {} });
  if (!proof?.proof) return { checks: [{ ok: false, text: 'the member returned no proof' }] };
  const f = proof.fact?.fields ?? {};
  const checks = [
    ...signed,
    { ok: proof.claimResult?.satisfied === true, text: proof.claimResult?.explanation ?? 'claim not evaluated' },
    { ok: f.height === taken.height && f.index === taken.index && f.topic === roundTopic(cfg, galaxy.round),
      text: `recorded at block #${f.height}, position ${f.index}, on this round’s topic ${roundTopic(cfg, galaxy.round)}` },
    ...rootChecks(proof, anchor, sealed, threshold),
  ];
  return { sealed, anchor, checks, trust: proof.trust, body, message,
    pending: sealed ? null : `finalized at block #${taken.height}; the moves chain is sealed through #${anchor?.anchoredHeight ?? '—'}` };
}

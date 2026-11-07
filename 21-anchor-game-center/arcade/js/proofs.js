// Proving a run: it is on the ledger, the commander's session key signed
// exactly these inputs and this score, the inputs replay to that score in this
// browser, and the record sits under the root anchored on Cardano.

import { fromHex } from '../../shared/crypto.js';
import { MESSAGE_SUBJECT, authorshipChecks, rootChecks, typedProof } from '../../shared/proofs.js';
import { RUN_FRAMES, replay } from './sim.js';
import { decodeInputs, fieldTopic } from './runs.js';

export async function proveRun(cfg, ledger, moves, arcade, run, { threshold } = {}) {
  const message = await ledger.message(cfg.movesChain, run.messageId);
  if (!message) return { checks: [{ ok: false, text: 'the run is not visible on this member' }] };
  const { checks: signed, body } = await authorshipChecks(moves, message, run.id, run.pub);
  let encoded = new Uint8Array(0);
  try { encoded = fromHex(body?.inputs ?? ''); } catch { /* checked below */ }
  let replayed = null;
  try { replayed = replay(fromHex(arcade.seed), decodeInputs(encoded, RUN_FRAMES)).score; } catch { /* stays null */ }

  const anchor = await ledger.anchor(cfg.movesChain);
  const sealed = !!anchor && run.height <= anchor.anchoredHeight;
  const proof = await typedProof(ledger, cfg.movesChain, MESSAGE_SUBJECT, { 'message-id': run.messageId },
    sealed ? 'latest-confirmed-anchor' : 'latest', { claimId: 'recorded', operands: {} });
  if (!proof?.proof) return { checks: [{ ok: false, text: 'the member returned no proof' }] };
  const f = proof.fact?.fields ?? {};
  const checks = [
    ...signed,
    { ok: body?.score === run.score, text: `the signed move claims the score ${body?.score?.toLocaleString() ?? '—'}` },
    { ok: replayed === run.score, text: `replayed here: ${RUN_FRAMES.toLocaleString()} frames of inputs reach ${replayed?.toLocaleString() ?? '—'}` },
    { ok: proof.claimResult?.satisfied === true, text: proof.claimResult?.explanation ?? 'claim not evaluated' },
    { ok: f.height === run.height && f.index === run.index && f.topic === fieldTopic(cfg, arcade.field),
      text: `recorded at block #${f.height}, position ${f.index}, on this field’s topic ${fieldTopic(cfg, arcade.field)}` },
    ...rootChecks(proof, anchor, sealed, threshold),
  ];
  return { sealed, anchor, checks, trust: proof.trust,
    pending: sealed ? null : `finalized at block #${run.height}; the moves chain is sealed through #${anchor?.anchoredHeight ?? '—'}` };
}

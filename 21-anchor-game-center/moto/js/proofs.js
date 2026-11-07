// Proving a run: the circuit comes from the season's first block, the rider's
// session key signed exactly these inputs and this time, the inputs replay to that time in
// this browser, and the run sits under the root anchored on Cardano.

import { fromHex } from '../../shared/crypto.js';
import { MESSAGE_SUBJECT, authorshipChecks, rootChecks, typedProof } from '../../shared/proofs.js';
import { decodeInputs } from '../../arcade/js/runs.js';
import { lapTime, replay } from './sim.js';
import { circuitSeed, seasonTopic } from './races.js';

export async function proveRun(cfg, ledger, moves, circuit, run, { threshold } = {}) {
  const message = await ledger.message(cfg.movesChain, run.messageId);
  if (!message) return { checks: [{ ok: false, text: 'the run is not visible on this member' }] };
  const { checks: signed, body } = await authorshipChecks(moves, message, run.id, run.pub);
  let encoded = new Uint8Array(0);
  try { encoded = fromHex(body?.inputs ?? ''); } catch { /* checked below */ }
  const opening = await ledger.block(cfg.movesChain, circuit.seededBy.height);
  const seedOk = !!opening && circuitSeed(cfg, circuit.season, opening.stateRoot) === circuit.seed;
  let replayed = null;
  try { replayed = replay(circuit.track, decodeInputs(encoded, body?.frames)).finished; } catch { /* stays null */ }

  const anchor = await ledger.anchor(cfg.movesChain);
  const sealed = !!anchor && run.height <= anchor.anchoredHeight;
  const proof = await typedProof(ledger, cfg.movesChain, MESSAGE_SUBJECT, { 'message-id': run.messageId },
    sealed ? 'latest-confirmed-anchor' : 'latest', { claimId: 'recorded', operands: {} });
  if (!proof?.proof) return { checks: [{ ok: false, text: 'the member returned no proof' }] };
  const f = proof.fact?.fields ?? {};
  const checks = [
    { ok: seedOk, text: `the circuit comes from block #${circuit.seededBy.height}’s state root — nobody could ride it before that block` },
    ...signed,
    { ok: body?.frames === run.frames, text: `the signed move holds ${body?.frames?.toLocaleString() ?? '—'} frames of inputs (${encoded.length.toLocaleString()} bytes) and claims the time ${lapTime(run.frames)}` },
    { ok: replayed === run.frames, text: `replayed here: the inputs cross the line at frame ${replayed ?? '—'} = ${replayed ? lapTime(replayed) : '—'}` },
    { ok: proof.claimResult?.satisfied === true, text: proof.claimResult?.explanation ?? 'claim not evaluated' },
    { ok: f.height === run.height && f.index === run.index && f.topic === seasonTopic(cfg, circuit.season),
      text: `recorded at block #${f.height}, position ${f.index}, on this season’s topic` },
    ...rootChecks(proof, anchor, sealed, threshold),
  ];
  return { sealed, anchor, checks, trust: proof.trust,
    pending: sealed ? null : `finalized at block #${run.height}; the moves chain is sealed through #${anchor?.anchoredHeight ?? '—'}` };
}

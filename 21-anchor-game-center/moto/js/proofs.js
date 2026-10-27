// Proving a run: the circuit comes from the season's first block, the rider
// signed exactly these inputs and this time, the inputs replay to that time in
// this browser, and the run sits under the root anchored on Cardano.

import { decodeMove } from './topic-session.js';
import { ed25519Verify, fromHex, utf8 } from '../../shared/crypto.js';
import { MESSAGE_SUBJECT, rootChecks, typedProof } from '../../shared/proofs.js';
import { decodeInputs } from '../../arcade/js/runs.js';
import { lapTime, replay } from './sim.js';
import { circuitSeed, inputsHash, runStatement, seasonTopic } from './races.js';

export async function proveRun(cfg, ledger, circuit, run, { threshold } = {}) {
  const message = await ledger.message(cfg.movesChain, run.messageId);
  if (!message) return { checks: [{ ok: false, text: 'the run is not visible on this member' }] };
  const body = await decodeMove(cfg, seasonTopic(cfg, circuit.season), message.bodyHex);
  const encoded = body ? fromHex(body.inputs) : new Uint8Array(0);
  const signed = !!body && await ed25519Verify(fromHex(run.pub), fromHex(body.sig),
    utf8(runStatement(cfg, circuit.season, body.seed, body.id, body.n, inputsHash(encoded), body.frames)));
  const opening = await ledger.block(cfg.movesChain, circuit.seededBy.height);
  const seedOk = !!opening && circuitSeed(cfg, circuit.season, opening.stateRoot) === circuit.seed;
  let replayed = null;
  try { replayed = replay(circuit.track, decodeInputs(encoded, body.frames)).finished; } catch { /* stays null */ }

  const anchor = await ledger.anchor(cfg.movesChain);
  const sealed = !!anchor && run.height <= anchor.anchoredHeight;
  const proof = await typedProof(ledger, cfg.movesChain, MESSAGE_SUBJECT, { 'message-id': run.messageId },
    sealed ? 'latest-confirmed-anchor' : 'latest', { claimId: 'recorded', operands: {} });
  if (!proof?.proof) return { checks: [{ ok: false, text: 'the member returned no proof' }] };
  const f = proof.fact?.fields ?? {};
  const checks = [
    { ok: seedOk, text: `the circuit comes from block #${circuit.seededBy.height}’s state root — nobody could ride it before that block` },
    { ok: !!body, text: 'the original message retains its session-signed topic frame and canonical payload' },
    { ok: signed, text: `${run.id} signed these ${body?.frames?.toLocaleString()} frames of inputs (${encoded.length.toLocaleString()} bytes) and the time ${lapTime(run.frames)}` },
    { ok: replayed === run.frames, text: `replayed here: the inputs cross the line at frame ${replayed ?? '—'} = ${replayed ? lapTime(replayed) : '—'}` },
    { ok: proof.claimResult?.satisfied === true, text: proof.claimResult?.explanation ?? 'claim not evaluated' },
    { ok: f.height === run.height && f.index === run.index && f.topic === seasonTopic(cfg, circuit.season),
      text: `recorded at block #${f.height}, position ${f.index}, on this season’s topic` },
    ...rootChecks(proof, anchor, sealed, threshold),
  ];
  return { sealed, anchor, checks, trust: proof.trust,
    pending: sealed ? null : `finalized at block #${run.height}; the moves chain is sealed through #${anchor?.anchoredHeight ?? '—'}` };
}

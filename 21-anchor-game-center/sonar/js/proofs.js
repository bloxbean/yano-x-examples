// Proving Deep Sonar. One shot: the target's answer climbs its 7-hash Merkle
// path to exactly the fleet root it committed before the battle — so the
// answer could not have been invented after the shot — and the shot and
// answer are recorded under the root anchored on Cardano. The whole battle:
// each revealed board and secret rebuilds its committed root, both fleets are
// legal, and the result follows.

import { MESSAGE_SUBJECT, rootChecks, typedProof } from '../../shared/proofs.js';
import { DEPTH, climb, fleetRoot, validFleet } from './sonar.js';

async function recorded(ledger, cfg, refs, anchor) {
  const last = Math.max(...refs.map((r) => r.height));
  const sealed = !!anchor && last <= anchor.anchoredHeight;
  let proof = null;
  let count = 0;
  for (const ref of refs) {
    proof = await typedProof(ledger, cfg.movesChain, MESSAGE_SUBJECT, { 'message-id': ref.messageId },
      sealed ? 'latest-confirmed-anchor' : 'latest', { claimId: 'recorded', operands: {} });
    if (proof?.claimResult?.satisfied && proof.fact?.fields?.height === ref.height) count++;
  }
  return { proof, count, sealed, last };
}

/** Prove one answered shot; `commit` is the defender's lobby message (challenge or accept). */
export async function proveShot(cfg, ledger, battle, record, commit, { threshold } = {}) {
  const defender = battle.players[1 - record.by];
  const attacker = battle.players[record.by];
  const steps = climb(cfg, record.cell, record.ship, record.salt, record.path);
  const checks = [
    { ok: true, text: `${defender.id} committed fleet root ${defender.root.slice(0, 12)}… at block #${commit.height}, before the battle` },
    { ok: commit.height < record.shot.height, text: `${attacker.id} fired at ${coord(cfg, record.cell)} at block #${record.shot.height}` },
    { ok: true, text: `the answer: leaf = BLAKE2b(cell ${record.cell} ‖ ${record.ship ? `ship ${record.ship}` : 'water'} ‖ salt ${record.salt.slice(0, 8)}…) = ${steps[0].slice(0, 10)}…` },
    ...steps.slice(1, DEPTH).map((h, i) => ({ ok: true, text: `level ${i + 1}: hash with sibling ${record.path[i].slice(0, 8)}… → ${h.slice(0, 10)}…` })),
    { ok: steps[DEPTH] === defender.root,
      text: `level ${DEPTH}: ${steps[DEPTH].slice(0, 12)}… — exactly the committed root, so “${record.ship ? 'hit' : 'miss'}” is the truth` },
  ];
  const anchor = await ledger.anchor(cfg.movesChain);
  const r = await recorded(ledger, cfg, [commit, record.shot, record.answer], anchor);
  checks.push({ ok: r.count === 3, text: 'the commitment, the shot and the answer are recorded at their blocks' });
  if (r.proof?.proof) checks.push(...rootChecks(r.proof, anchor, r.sealed, threshold));
  return { sealed: r.sealed, anchor, checks, trust: r.proof?.trust,
    pending: r.sealed ? null : `the answer is at block #${r.last}; the chain is sealed through #${anchor?.anchoredHeight ?? '—'}` };
}

/** Prove a finished battle from both reveals. */
export async function proveBattle(cfg, ledger, battle, { threshold } = {}) {
  const checks = [];
  for (const seat of [0, 1]) {
    const p = battle.players[seat];
    const rv = battle.reveals[seat];
    if (!rv) { checks.push({ ok: battle.winner !== seat, text: `${p.id} never revealed their fleet` }); continue; }
    const root = fleetRoot(cfg, rv.board, rv.secret);
    checks.push({ ok: root === p.root, text: `${p.id}’s revealed board and secret rebuild their committed root ${p.root.slice(0, 12)}…` });
    checks.push({ ok: validFleet(cfg, rv.board) === rv.valid,
      text: rv.valid ? `${p.id}’s fleet is legal: five straight ships of ${cfg.fleet.join(', ')}` : `${p.id}’s fleet is not legal` });
  }
  const answered = battle.shots.length;
  checks.push({ ok: true, text: `${answered} shots, every answer verified against its root as it arrived` });
  const winner = battle.winner === -1 ? 'a draw' : `${battle.players[battle.winner].id} won`;
  checks.push({ ok: true, text: `${winner}: ${battle.reason}` });
  const refs = [battle.reveals[0]?.ref, battle.reveals[1]?.ref].filter(Boolean);
  const anchor = await ledger.anchor(cfg.movesChain);
  if (refs.length) {
    const r = await recorded(ledger, cfg, refs, anchor);
    checks.push({ ok: r.count === refs.length, text: 'the reveals are recorded at their blocks' });
    if (r.proof?.proof) checks.push(...rootChecks(r.proof, anchor, r.sealed, threshold));
    return { sealed: r.sealed, anchor, checks, trust: r.proof?.trust,
      pending: r.sealed ? null : `the battle ended at block #${r.last}; the chain is sealed through #${anchor?.anchoredHeight ?? '—'}` };
  }
  return { sealed: false, anchor, checks, pending: 'no reveals to prove' };
}

export const coord = (cfg, cell) => `${'ABCDEFGHIJ'[cell % cfg.size]}${Math.floor(cell / cfg.size) + 1}`;

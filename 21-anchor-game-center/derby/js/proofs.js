// Proving a race: the bet was final before betting closed, the seed is the
// hash of a block certified after the close (so nobody could know it when
// betting), the race recomputed from that seed gives the same winner, the
// payout follows from the pool — and the bet and the beacon are recorded under
// the root anchored on Cardano.

import { ed25519Verify, fromHex, toHex, utf8 } from '../../shared/crypto.js';
import { MESSAGE_SUBJECT, rootChecks, typedProof } from '../../shared/proofs.js';
import { betStatement, raceClose, raceSeed, runRace } from './derby.js';

/** Prove race `rec` of `derby`, and `bet` (one of rec.bets) if given. */
export async function proveRace(cfg, ledger, derby, rec, bet, { threshold } = {}) {
  const checks = [];
  const close = raceClose(cfg, rec.race);
  const beacon = rec.beacon;
  const names = cfg.comets.map((c) => c.name);
  if (bet) {
    const message = await ledger.message(cfg.movesChain, bet.messageId);
    let body = null;
    try { body = JSON.parse(new TextDecoder().decode(fromHex(message.bodyHex))); } catch { /* checked below */ }
    const signed = !!body && await ed25519Verify(fromHex(body.pub), fromHex(body.sig),
      utf8(betStatement(cfg, derby.hour, body.id, body.n, body.race, body.comet, body.stake)));
    checks.push({ ok: signed && body.comet === bet.comet && body.stake === bet.stake,
      text: `${bet.id} signed “${bet.stake} on ${names[bet.comet]}” with their commander key` });
    checks.push({ ok: bet.timestamp < close, text: `the bet was final at block #${bet.height}, ${((close - bet.timestamp) / 1000).toFixed(1)} s before betting closed` });
  }
  const block = await ledger.block(cfg.movesChain, beacon.height);
  checks.push({ ok: !!block && block.timestamp >= close && block.stateRoot === beacon.stateRoot,
    text: `the beacon is block #${beacon.height}, certified ${(((block?.timestamp ?? 0) - close) / 1000).toFixed(1)} s after the close, root ${beacon.stateRoot.slice(0, 12)}…` });
  if (bet) checks.push({ ok: bet.height < beacon.height, text: 'so that root did not exist yet when the bet was placed' });
  const seed = raceSeed(cfg, rec.race, block?.stateRoot ?? '');
  checks.push({ ok: toHex(seed) === beacon.seed, text: `seed = BLAKE2b(root) = ${beacon.seed.slice(0, 12)}…, recomputed here` });
  const { order } = runRace(seed, cfg.comets.length);
  checks.push({ ok: order[0] === rec.result.winner,
    text: `this browser re-ran the race from that seed: ${order.slice(0, 3).map((i) => names[i]).join(', ')}…` });
  const backing = rec.byComet[rec.result.winner];
  const mine = bet ? (rec.result.payouts.get(bet.id) ?? 0) : null;
  checks.push({ ok: true, text: rec.result.refunded
    ? `nobody backed ${names[rec.result.winner]}, so every stake came back`
    : `pool ${rec.pool} credits, ${backing} on ${names[rec.result.winner]}: each credit on the winner returns ${(rec.pool / backing).toFixed(2)}`
      + (bet ? ` · ${bet.id} received ${mine}` : '') });

  const anchor = await ledger.anchor(cfg.movesChain);
  const last = Math.max(beacon.height, bet?.height ?? 0);
  const sealed = !!anchor && last <= anchor.anchoredHeight;
  const view = sealed ? 'latest-confirmed-anchor' : 'latest';
  let proof = null;
  let recorded = 0;
  const refs = [beacon, ...(bet ? [bet] : [])];
  for (const ref of refs) {
    proof = await typedProof(ledger, cfg.movesChain, MESSAGE_SUBJECT, { 'message-id': ref.messageId }, view,
      { claimId: 'recorded', operands: {} });
    if (proof?.claimResult?.satisfied && proof.fact?.fields?.height === ref.height) recorded++;
  }
  checks.push({ ok: recorded === refs.length,
    text: bet ? 'the bet and the beacon are recorded at those blocks' : 'the beacon is recorded at that block' });
  if (proof?.proof) checks.push(...rootChecks(proof, anchor, sealed, threshold));
  return { sealed, anchor, checks, trust: proof?.trust,
    pending: sealed ? null : `the race settled at block #${last}; the chain is sealed through #${anchor?.anchoredHeight ?? '—'}` };
}

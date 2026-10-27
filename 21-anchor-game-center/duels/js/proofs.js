// Proving a round: each seal was final before the other side's reveal (so
// nobody chose after seeing), each reveal matches its seal, the die is the
// hash of both secrets, every message is signed by its commander — and all of
// it is recorded under the root anchored on Cardano.

import { ed25519Verify, fromHex, utf8 } from '../../shared/crypto.js';
import { MESSAGE_SUBJECT, rootChecks, typedProof } from '../../shared/proofs.js';
import { rollDie, sealHash, statement } from './duels.js';

async function signedBy(cfg, ledger, duel, seat, ref, kind, fields) {
  const message = await ledger.message(cfg.movesChain, ref.messageId);
  if (!message) return false;
  let body;
  try { body = JSON.parse(new TextDecoder().decode(fromHex(message.bodyHex))); } catch { return false; }
  return ed25519Verify(fromHex(duel.players[seat].pub), fromHex(body.sig),
    utf8(statement(cfg, duel.duelId, kind, duel.players[seat].id, ...fields)));
}

export async function proveRound(cfg, ledger, duel, record, { threshold } = {}) {
  const names = duel.players.map((p) => p.id);
  const checks = [];
  for (const seat of [0, 1]) {
    const seal = record.seals[seat];
    const otherReveal = record.reveals[1 - seat];
    if (!seal) { checks.push({ ok: true, text: `${names[seat]} never sealed — forfeited at the deadline` }); continue; }
    if (otherReveal) {
      checks.push({ ok: seal.height < otherReveal.height,
        text: `${names[seat]}’s seal was final at block #${seal.height}, before ${names[1 - seat]} revealed at #${otherReveal.height}` });
    }
    checks.push({ ok: await signedBy(cfg, ledger, duel, seat, seal, 'seal', [record.round, seal.hash]),
      text: `${names[seat]} signed the seal ${seal.hash.slice(0, 10)}…` });
    const reveal = record.reveals[seat];
    if (!reveal) { checks.push({ ok: true, text: `${names[seat]} never revealed — forfeited at the deadline` }); continue; }
    checks.push({ ok: sealHash(cfg, duel.duelId, record.round, names[seat], reveal.move, reveal.secret) === seal.hash,
      text: `${names[seat]}’s reveal (${reveal.move}) hashes to exactly that seal` });
  }
  if (record.die) {
    checks.push({ ok: rollDie(cfg, duel.duelId, record.round, record.reveals[0].secret, record.reveals[1].secret) === record.die,
      text: `the die (${record.die}) is BLAKE2b of both secrets — neither side could steer it` });
  }

  const refs = [...record.seals, ...record.reveals].filter(Boolean);
  if (cfg.engine === 'plugin') return pluginRound(cfg, ledger, duel, record, refs, checks, threshold);
  const last = refs.reduce((a, b) => (b.height > a.height || (b.height === a.height && b.index > a.index) ? b : a));
  const anchor = await ledger.anchor(cfg.movesChain);
  const sealed = !!anchor && last.height <= anchor.anchoredHeight;
  const view = sealed ? 'latest-confirmed-anchor' : 'latest';
  let proof = null;
  let recorded = 0;
  for (const ref of refs) {
    proof = await typedProof(ledger, cfg.movesChain, MESSAGE_SUBJECT, { 'message-id': ref.messageId }, view,
      { claimId: 'recorded', operands: {} });
    if (proof?.claimResult?.satisfied && proof.fact?.fields?.height === ref.height) recorded++;
  }
  checks.push({ ok: recorded === refs.length, text: `all ${refs.length} seals and reveals are recorded at their blocks on ${cfg.movesChain}` });
  if (proof?.proof) checks.push(...rootChecks(proof, anchor, sealed, threshold));
  return { sealed, anchor, checks, trust: proof?.trust,
    pending: sealed ? null : `the round ended at block #${last.height}; the chain is sealed through #${anchor?.anchoredHeight ?? '—'}` };
}

/**
 * Plugin edition, one round: the stock message proof subject comes with the
 * stock machines, so use the host's generic inclusion proof for each move, and
 * the members' duel record — which settles every round — for the anchored root.
 */
async function pluginRound(cfg, ledger, duel, record, refs, checks, threshold) {
  let included = 0;
  for (const ref of refs) {
    const p = await ledger.read(ledger.chainPath(cfg.movesChain, `/messages/${ref.messageId}/proof`));
    if (p?.messageId === ref.messageId && p.blockHeight === ref.height) included++;
  }
  checks.push({ ok: included === refs.length,
    text: `all ${refs.length} seals and reveals are included in their finalized blocks on ${cfg.movesChain}` });
  const state = await duelState(cfg, ledger, duel);
  const settled = state.record?.history?.find((h) => h.round === record.round);
  checks.push({ ok: !!settled && JSON.stringify([settled.moves, settled.forfeited, settled.die ?? null, settled.dealt])
      === JSON.stringify([record.moves, record.forfeited, record.die ?? null, record.dealt]),
    text: `the members’ duel record settles round ${record.round} exactly as this browser did` });
  checks.push(...anchorChecks(state, threshold));
  return { ...result(state), checks };
}

/**
 * Plugin edition: prove the duel's result itself. The members committed the
 * duel record to the state root under `duel/<id>`, so one state proof at the
 * anchored height shows who won — no move needs replaying to trust it.
 */
export async function proveDuel(cfg, ledger, duel, { threshold } = {}) {
  const state = await duelState(cfg, ledger, duel);
  const { key, proof, record } = state;
  if (!proof) return { checks: [{ ok: false, text: 'the member returned no proof' }] };
  const names = duel.players.map((p) => p.id);
  const outcome = !record ? '' : record.phase === 'done'
    ? (record.winner === -1 ? 'a draw' : `${names[record.winner]} won`) + ` ${record.hp[0]}–${record.hp[1]} HP after ${record.history.length} rounds`
    : `round ${record.round}, ${record.hp[0]}–${record.hp[1]} HP`;
  const checks = [
    { ok: proof.presence === 'PRESENT', text: `the state holds the key ${key.slice(0, 21)}… on ${cfg.movesChain}` },
    { ok: record?.duel === duel.duelId, text: 'the proven value is this duel’s record, as the members wrote it' },
    { ok: !!record && [0, 1].every((s) => record[s ? 'opponent' : 'challenger']?.pub === duel.players[s].pub),
      text: `between the keys of ${names[0]} and ${names[1]}` },
    { ok: !!record && comparable(record) === comparable(duel), text: `it records ${outcome} — exactly what this browser’s replay found` },
    ...anchorChecks(state, threshold),
  ];
  return { ...result(state), checks };
}

/** The duel record's state proof: at the anchored height once the duel is sealed, else at the tip. */
async function duelState(cfg, ledger, duel) {
  const key = `duel/${duel.duelId}`;
  const anchor = await ledger.anchor(cfg.movesChain);
  const sealed = !!anchor && duel.position.height <= anchor.anchoredHeight;
  const proof = await ledger.stateProof(cfg.movesChain, key, sealed ? anchor.anchoredHeight : null);
  let record = null;
  try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromHex(proof.valueHex))); } catch { /* absent or not a record */ }
  return { key, anchor, sealed, proof, record, height: duel.position.height };
}

function anchorChecks({ proof, anchor, sealed }, threshold) {
  if (!proof) return [{ ok: false, text: 'the member returned no state proof for the duel record' }];
  const sigs = proof.finalityCertificate?.signatures?.length ?? 0;
  const checks = [
    { ok: sigs >= threshold, text: `finality certificate: ${sigs} member signatures (threshold ${threshold})` },
    { ok: true, text: `proven under state root ${proof.stateRoot.slice(0, 16)}… at height ${proof.committedHeight}` },
  ];
  if (sealed) {
    checks.push({ ok: proof.stateRoot === anchor.stateRoot,
      text: `that root is the one anchored on Cardano in tx ${anchor.transactionHash.slice(0, 16)}…`, tx: anchor.transactionHash });
  }
  return checks;
}

const result = ({ proof, anchor, sealed, height }) => ({ sealed, anchor, trust: proof && `${proof.proofEncodingId}, built by the member`,
  pending: sealed ? null : `the duel last changed at block #${height}; the chain is sealed through #${anchor?.anchoredHeight ?? '—'}` });

const comparable = (d) => JSON.stringify([d.hp, d.energy, d.round, d.phase, d.winner ?? null, d.history?.length ?? 0]);

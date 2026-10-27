// Proving the reef. A placement: signed by its commander, recorded at its
// block, landing at the generation that block's certified time names. The
// world at a generation: rebuilt here from the soup (seeded by the opening
// block's state root) and every placement up to that generation, all of them
// recorded under the root anchored on Cardano — so anyone can recompute the
// same world and the same world hash.

import { ed25519Verify, fromHex, toHex, utf8 } from '../../shared/crypto.js';
import { MESSAGE_SUBJECT, rootChecks, typedProof } from '../../shared/proofs.js';
import { PATTERNS, census, seasonSeed, seedStatement, worldHash } from './reef.js';

async function recorded(ledger, cfg, refs, view) {
  let proof = null;
  let count = 0;
  for (const ref of refs) {
    proof = await typedProof(ledger, cfg.movesChain, MESSAGE_SUBJECT, { 'message-id': ref.messageId }, view,
      { claimId: 'recorded', operands: {} });
    if (proof?.claimResult?.satisfied && proof.fact?.fields?.height === ref.height) count++;
  }
  return { proof, count };
}

export async function provePlacement(cfg, ledger, reef, p, { threshold } = {}) {
  const player = reef.players.get(p.id);
  const message = await ledger.message(cfg.movesChain, p.messageId);
  let body = null;
  try { body = JSON.parse(new TextDecoder().decode(fromHex(message.bodyHex))); } catch { /* checked below */ }
  const signed = !!body && await ed25519Verify(fromHex(player.pub), fromHex(body.sig),
    utf8(seedStatement(cfg, reef.season, body.id, body.n, body.pattern, body.x, body.y, body.rot)));
  const block = await ledger.block(cfg.movesChain, p.height);
  const gen = Math.floor(((block?.timestamp ?? 0) - reef.origin.timestamp) / cfg.genMs) + 1;
  const anchor = await ledger.anchor(cfg.movesChain);
  const sealed = !!anchor && p.height <= anchor.anchoredHeight;
  const { proof, count } = await recorded(ledger, cfg, [p], sealed ? 'latest-confirmed-anchor' : 'latest');
  const checks = [
    { ok: signed && body.pattern === p.pattern && body.x === p.x && body.y === p.y,
      text: `${p.id} signed “${PATTERNS[p.pattern].name} at ${p.x},${p.y}” with their commander key` },
    { ok: gen === p.gen, text: `block #${p.height} was certified ${((block.timestamp - reef.origin.timestamp) / 1000).toFixed(1)} s into the season: generation ${gen}` },
    { ok: count === 1, text: `recorded at block #${p.height} on this season’s topic` },
  ];
  if (proof?.proof) checks.push(...rootChecks(proof, anchor, sealed, threshold));
  return { sealed, anchor, checks, trust: proof?.trust,
    pending: sealed ? null : `placed at block #${p.height}; the chain is sealed through #${anchor?.anchoredHeight ?? '—'}` };
}

/** Prove the world at `gen`: `cells` is what this browser computed for it. */
export async function proveWorld(cfg, ledger, reef, gen, cells, { threshold } = {}) {
  const used = reef.placements.filter((p) => p.gen <= gen);
  const opening = await ledger.block(cfg.movesChain, reef.origin.height);
  const seedOk = !!opening && toHex(seasonSeed(cfg, reef.season, opening.stateRoot)) === reef.origin.seed;
  const counts = census(cells);
  const alive = counts.slice(1).reduce((a, b) => a + b, 0);
  const anchor = await ledger.anchor(cfg.movesChain);
  const last = used.length ? used[used.length - 1].height : reef.origin.height;
  const sealed = !!anchor && last <= anchor.anchoredHeight;
  const sample = [reef.origin, ...used.slice(-24)];
  const { proof, count } = await recorded(ledger, cfg, sample, sealed ? 'latest-confirmed-anchor' : 'latest');
  const checks = [
    { ok: seedOk, text: `the soup comes from block #${reef.origin.height}’s state root (${opening?.stateRoot.slice(0, 12)}…), the season’s first block` },
    { ok: true, text: `${used.length} placements land at or before generation ${gen}; this browser stepped all ${gen} generations` },
    { ok: true, text: `world hash ${worldHash(cells)} · ${alive.toLocaleString()} living cells — every browser computes exactly this` },
    { ok: count === sample.length,
      text: used.length > 24 ? `the opening and the latest 24 placements are recorded at their blocks` : `the opening and every placement are recorded at their blocks` },
  ];
  if (proof?.proof) checks.push(...rootChecks(proof, anchor, sealed, threshold));
  return { sealed, anchor, checks, trust: proof?.trust,
    pending: sealed ? null : `the last placement used is at block #${last}; the chain is sealed through #${anchor?.anchoredHeight ?? '—'}` };
}

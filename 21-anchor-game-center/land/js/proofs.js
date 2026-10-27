// Proving a tile against the root anchored on Cardano — who holds it, or that
// nobody does.
//
// A claimed tile is an authenticated-map entry: the proof must show it at
// revision 1 (the first and only claim), its value digest must match the exact
// claim bytes this browser checked, and the claim's signature must verify.
// A free tile has no entry: the member proves its absence under the anchored
// root — an exclusion proof, not just an empty answer.

import { ed25519Verify, fromHex, toHex, utf8 } from '../../shared/crypto.js';
import { ENTRY_SUBJECT, logicalValueHash, rootChecks, typedProof } from '../../shared/proofs.js';
import { claimStatement, tileKey } from './land.js';

export async function proveTile(cfg, ledger, land, c, r, { threshold } = {}) {
  const key = tileKey(cfg, land.season, land.seed, c, r);
  const tile = land.tiles.get(`${c},${r}`);
  const anchor = await ledger.anchor(cfg.chain);
  const sealed = !!anchor && (!tile || tile.height <= anchor.anchoredHeight);
  const proof = await typedProof(ledger, cfg.chain, ENTRY_SUBJECT,
    { collection: cfg.collection, key: toHex(utf8(key)) },
    sealed ? 'latest-confirmed-anchor' : 'latest',
    { claimId: 'revision-exact', operands: { expected: 1 } });
  if (!proof?.proof) return { checks: [{ ok: false, text: 'the member returned no proof' }] };

  if (!tile) {
    const presence = proof.proof.presence;
    const checks = [
      { ok: presence === 'ABSENT', text: `no entry exists for this tile — an exclusion proof (${presence ?? 'no presence'}), not just silence` },
      ...rootChecks(proof, anchor, sealed, threshold),
    ];
    return { sealed, anchor, checks, trust: proof.trust,
      pending: sealed ? null : 'nothing is anchored on this chain yet' };
  }

  const fields = proof.fact?.fields ?? {};
  let claim = null;
  try { claim = JSON.parse(new TextDecoder().decode(tile.value)); } catch { /* scorched, unreadable */ }
  const signed = !!claim && await ed25519Verify(fromHex(claim.pub), fromHex(claim.sig),
    utf8(claimStatement(cfg, land.season, land.seed, c, r, claim.id)));
  const checks = [
    { ok: proof.claimResult?.satisfied === true && fields.status === 'ACTIVE',
      text: `the ledger holds this tile at revision ${fields.revision} — the first and only claim` },
    { ok: fields['value-digest'] === logicalValueHash(tile.value),
      text: 'the proven value is exactly the claim this browser checked (value digest matches)' },
    tile.owner
      ? { ok: signed, text: `the claim is signed by ${tile.owner}’s commander key` }
      : { ok: true, text: `scorched: ${tile.reason} — so it counts for nobody` },
    ...rootChecks(proof, anchor, sealed, threshold),
  ];
  return { sealed, anchor, checks, trust: proof.trust,
    pending: sealed ? null : `claimed at block #${tile.height}; this chain is sealed through #${anchor?.anchoredHeight ?? '—'}` };
}

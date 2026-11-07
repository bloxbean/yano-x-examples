// How a game's rules learn who made a move. Every fold uses these two helpers
// and nothing else to read a move and check its author.
//
// Session games (cfg.sessions, on games-chain): a move is a Yano topic frame
// whose payload is signed by the player's session key, under a one-hour
// credential from the game publisher's delegation service. The members refuse
// any other write on a game topic. Before the rules see a move, this browser
// re-checks every signature itself (shared/sessions.js, openMove) and attaches
//   entry.body    the move (the frame's JSON payload, without its session pass)
//   entry.author  { id, pub, session, issuer } — the commander who bound that
//                 session key with their pass, or null if anything failed
// so a fold only asks: is the author the commander this move names?
//
// Signed games (the duels plugin edition on duels-chain): a move is plain JSON
// carrying the commander's own Ed25519 signature `sig` over a statement, as
// before topic policies existed. The members check it in the plugin.

import { ed25519Verify, fromHex, utf8 } from './crypto.js';

const HEX128 = /^[0-9a-f]{128}$/;

/** The move in an entry, or null when it is not one. */
export function moveBody(cfg, entry) {
  if (cfg.sessions) return entry.body ?? null;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromHex(entry.bodyHex)));
  } catch {
    return null;
  }
}

/** Does the move carry its authentication in the right shape? (A session move carries none in its body.) */
export const signatureShape = (cfg, b) => cfg.sessions || (typeof b?.sig === 'string' && HEX128.test(b.sig));

/**
 * Was `b` made by commander `b.id` holding public key `pub` (hex)?
 * Session games: the verified author must be exactly that commander and key.
 * Signed games: `b.sig` must verify over `statement` with `pub`.
 */
export async function authentic(cfg, entry, b, pub, statement) {
  if (cfg.sessions) return !!entry.author && entry.author.id === b.id && entry.author.pub === pub;
  return signatureShape(cfg, b) && ed25519Verify(fromHex(pub), fromHex(b.sig), utf8(statement));
}

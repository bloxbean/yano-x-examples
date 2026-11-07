// The game is a deterministic fold over the finalized log.
//
// ordered-log never reads a message body, so the ledger cannot enforce game
// rules. It does not need to: it gives every player the same messages in the
// same order, each with a block timestamp the members certified. Any client
// that applies the rules below to that sequence reaches the same wall, pixel
// for pixel. Nothing here may read the wall clock, randomness or local state.
//
// Two message kinds, as UTF-8 JSON on the game topic:
//
//   join  {"t":"join","cose":<COSE_Sign1 hex>,"key":<COSE_Key hex>}
//         A Cardano wallet signs (CIP-30 signData) the text
//         {"app","chain","session","name","expires"}, authorizing a browser
//         session key to paint in its name until `expires`. One wallet popup
//         per session, not per pixel.
//
//   px    {"t":"px","s":<session key hex>,"n":<nonce>,"x","y","c","sig":<hex>}
//         Signed by the session key. A session no wallet authorized paints as
//         a guest, with a longer cooldown.
//
// The member that relays a message signs the envelope, but that only says
// which member admitted it. Who painted is decided by these signatures alone.

import { verifyCip8 } from './cip8.js';
import { cardanoAddressBech32, ed25519Verify, fromHex, utf8 } from './crypto.js';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const NAME = /^[\p{L}\p{N} _.\-!?]+$/u;

export const pixelStatement = (cfg, s, n, x, y, c) => `${cfg.app}|${cfg.chainId}|px|${s}|${n}|${x}|${y}|${c}`;

/** The exact text a wallet is asked to sign for a session. Key order is fixed. */
export const joinPayload = (cfg, session, name, expires) =>
  JSON.stringify({ app: cfg.app, chain: cfg.chainId, session, name, expires });

const isInt = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v < hi;

export class CanvasState {
  constructor(cfg) {
    this.cfg = cfg;
    this.cells = new Array(cfg.size * cfg.size).fill(null);
    this.sessions = new Map(); // session key → { player, expires }
    this.lastNonce = new Map(); // session key → highest signed nonce seen
    this.lastPaint = new Map(); // player id → timestamp of last accepted pixel
    this.players = new Map(); // player id → { id, kind, name, address?, painted }
    this.placements = []; // accepted pixels, in log order
    this.position = { height: 0, index: -1 };
  }

  /**
   * Apply one finalized message: { height, index, messageId, timestamp, bodyHex }.
   * Entries must arrive in log order; anything at or before the current
   * position has already been applied and is skipped.
   */
  async apply(entry) {
    const { height, index } = entry;
    if (height < this.position.height || (height === this.position.height && index <= this.position.index)) {
      return { skipped: true };
    }
    this.position = { height, index };

    let body;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromHex(entry.bodyHex)));
    } catch {
      return reject('not JSON');
    }
    if (body?.t === 'join') return this.#join(entry, body);
    if (body?.t === 'px') return this.#pixel(entry, body);
    return reject('unknown message kind');
  }

  async #join(entry, body) {
    if (typeof body.cose !== 'string' || typeof body.key !== 'string') return reject('join without COSE');
    const signed = await verifyCip8(body.cose, body.key);
    if (!signed.ok) return reject(`wallet signature: ${signed.reason}`);

    let claim;
    try {
      claim = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(signed.payload));
    } catch {
      return reject('signed payload is not JSON');
    }
    const { cfg } = this;
    if (claim.app !== cfg.app || claim.chain !== cfg.chainId) return reject('signed for another game');
    if (typeof claim.session !== 'string' || !HEX64.test(claim.session)) return reject('bad session key');
    if (!Number.isSafeInteger(claim.expires) || claim.expires <= entry.timestamp) return reject('already expired');
    if (claim.expires - entry.timestamp > cfg.maxSessionMs) return reject('session too long');
    if (this.sessions.has(claim.session)) return reject('session already bound');

    const address = cardanoAddressBech32(signed.address);
    const id = `wallet:${address}`;
    const name = typeof claim.name === 'string' && claim.name.trim().length <= cfg.maxNameLength
      && NAME.test(claim.name.trim()) ? claim.name.trim() : '';
    const player = this.#player(id, 'wallet', name || shortAddress(address), address);
    if (name) player.name = name;
    this.sessions.set(claim.session, { player: id, expires: claim.expires });
    return { accepted: true, kind: 'join', player };
  }

  async #pixel(entry, body) {
    const { cfg } = this;
    const { s, n, x, y, c, sig } = body;
    if (typeof s !== 'string' || !HEX64.test(s) || typeof sig !== 'string' || !HEX128.test(sig)) {
      return reject('bad key or signature encoding');
    }
    if (!isInt(n, 1, Number.MAX_SAFE_INTEGER) || !isInt(x, 0, cfg.size) || !isInt(y, 0, cfg.size)
        || !isInt(c, 0, cfg.palette.length)) {
      return reject('field out of range');
    }
    if (n <= (this.lastNonce.get(s) ?? 0)) return reject('stale nonce (replayed)');
    if (!(await ed25519Verify(fromHex(s), fromHex(sig), utf8(pixelStatement(cfg, s, n, x, y, c))))) {
      return reject('session signature does not verify');
    }
    // A valid signature burns its nonce even if the pixel is refused below, so
    // nobody can replay a refused move later when it would succeed.
    this.lastNonce.set(s, n);

    const session = this.sessions.get(s);
    if (session && entry.timestamp > session.expires) return reject('session expired');
    const player = session
      ? this.players.get(session.player)
      : this.#player(`guest:${s}`, 'guest', `guest-${s.slice(0, 4)}`);

    const last = this.lastPaint.get(player.id);
    const cooldown = cfg.cooldownMs[player.kind];
    if (last !== undefined && entry.timestamp - last < cooldown) return reject('cooling down');

    this.lastPaint.set(player.id, entry.timestamp);
    player.painted += 1;
    const placement = {
      x, y, c, player: player.id, height: entry.height, index: entry.index,
      messageId: entry.messageId, timestamp: entry.timestamp,
    };
    this.cells[y * cfg.size + x] = placement;
    this.placements.push(placement);
    return { accepted: true, kind: 'px', placement, player };
  }

  #player(id, kind, name, address) {
    let player = this.players.get(id);
    if (!player) {
      player = { id, kind, name, address, painted: 0 };
      this.players.set(id, player);
    }
    return player;
  }

  /** The wall as it stood after every message up to and including `height`. */
  frameAt(height) {
    const cells = new Array(this.cfg.size * this.cfg.size).fill(null);
    for (const p of this.placements) {
      if (p.height > height) break;
      cells[p.y * this.cfg.size + p.x] = p;
    }
    return cells;
  }

  /** Players ranked by cells they currently hold in `cells`. */
  leaderboard(cells = this.cells) {
    const held = new Map();
    for (const cell of cells) if (cell) held.set(cell.player, (held.get(cell.player) ?? 0) + 1);
    return [...held].map(([id, count]) => ({ player: this.players.get(id), held: count }))
      .sort((a, b) => b.held - a.held || a.player.id.localeCompare(b.player.id));
  }

  /** Earliest finalized timestamp at which this player may paint again. */
  nextPaintAt(playerId, kind) {
    const last = this.lastPaint.get(playerId);
    return last === undefined ? 0 : last + this.cfg.cooldownMs[kind];
  }
}

const reject = (reason) => ({ accepted: false, reason });

export const shortAddress = (address) => `${address.slice(0, 12)}…${address.slice(-6)}`;

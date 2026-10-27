// Sealed Duels: hidden moves without a server, decided by the finalized log.
//
// Each round both commanders first post a seal, hash(move ‖ secret), and only
// when both seals are final do they post the move and secret. Every browser
// checks each reveal against its seal, so nobody can change a move after
// seeing the other — and nobody, members included, could see a move early.
// The round's die comes from both secrets together, so neither player (nor any
// member) can steer it. Deadlines use certified block time: a later message
// past a deadline (a "forfeit" claim, or anything else) settles a missed seal
// or reveal identically in every browser.
//
// Lobby topic (one per hour):
//   challenge {"t":"challenge","id","pub","n","rounds","sig"}       its message id is the duel id
//   accept    {"t":"accept","id","pub","n","challenge","sig"}       the first valid accept wins
// Duel topic (one per duel):
//   seal      {"t":"seal","id","round","hash","sig"}
//   reveal    {"t":"reveal","id","round","move","secret","sig"}
//   forfeit   {"t":"forfeit","id","round","sig"}                   only advances block time

import { blake2b } from '../../shared/blake2b.js';
import { ed25519Verify, fromHex, toHex, utf8 } from '../../shared/crypto.js';

const CALLSIGN = /^[a-z0-9][a-z0-9_-]{2,19}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

const base = (cfg) => cfg.app.replace('/', '.');
export const lobbyOf = (cfg, ts) => Math.floor(ts / cfg.lobbyMs);
export const lobbyTopic = (cfg, hour) => `${base(cfg)}.lobby.h${hour}`;
export const duelTopic = (cfg, duelId) => `${base(cfg)}.d${duelId.slice(0, 16)}`;
export const statement = (cfg, scope, kind, id, ...fields) => [cfg.app, cfg.movesChain, scope, kind, id, ...fields].join('|');
export const sealHash = (cfg, duelId, round, id, move, secret) =>
  toHex(blake2b(utf8([cfg.app, duelId, round, id, move, secret].join('|')), 32));

/** The round's die, 1–6, from both players' secrets in seat order. */
export function rollDie(cfg, duelId, round, secretA, secretB) {
  const h = blake2b(utf8(`${cfg.app}|dice|${duelId}|${round}|${secretA}|${secretB}`), 32);
  return 1 + (((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0) % 6;
}

/** Damage `attack` deals to a defender who played `defend` (null: they forfeited). */
export function damage(attack, defend) {
  if (attack === 'laser') return defend === 'shield' ? 0 : 2;
  if (attack === 'missile') return defend === 'emp' ? 0 : defend === 'shield' ? 1 : 4;
  if (attack === 'emp') return defend === 'shield' ? 3 : defend === 'missile' ? 0 : 1;
  return 0;
}

const reject = (reason) => ({ accepted: false, reason });

/** Challenges and acceptances across the lobby topics, in log order. */
export class Lobby {
  constructor(cfg) {
    this.cfg = cfg;
    this.challenges = new Map(); // duel id → { id, pub, rounds, timestamp, height, index, opponent? }
    this.nonces = new Map();
    this.keys = new Map(); // call sign → the first key that used it here (cfg.keyBinding 'first-seen')
    this.position = { height: 0, index: -1 };
  }

  /**
   * As Galaxy: `profiles(id, pub, ts)` answers { ok } / { ok: false, reason } or throws to retry.
   *
   * The plugin edition (cfg.keyBinding 'first-seen') cannot read the profile
   * chain: a state machine sees only its own chain's state. It binds a call
   * sign to the first key that uses it on its own chain instead, and this fold
   * applies the same rule so the browser can check the members' result.
   */
  async apply(entry, profiles) {
    const { height, index } = entry;
    if (height < this.position.height || (height === this.position.height && index <= this.position.index)) {
      return { skipped: true };
    }
    let b;
    try { b = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromHex(entry.bodyHex))); } catch { b = null; }
    let result = reject('not a lobby message');
    if (b && (b.t === 'challenge' || b.t === 'accept')) result = await this.#message(entry, b, profiles);
    this.position = { height, index };
    return result;
  }

  async #message(entry, b, profiles) {
    const { cfg } = this;
    if (typeof b.id !== 'string' || !CALLSIGN.test(b.id) || typeof b.pub !== 'string' || !HEX64.test(b.pub)
        || !Number.isSafeInteger(b.n) || b.n < 1 || typeof b.sig !== 'string' || !HEX128.test(b.sig)) {
      return reject('malformed');
    }
    const fields = b.t === 'challenge' ? [b.n, b.rounds] : [b.n, b.challenge];
    if (!(await ed25519Verify(fromHex(b.pub), fromHex(b.sig), utf8(statement(cfg, 'lobby', b.t, b.id, ...fields))))) {
      return reject('signature does not verify');
    }
    if (b.n <= (this.nonces.get(b.id) ?? 0)) return reject('stale nonce (replayed)');
    if (cfg.keyBinding === 'first-seen' && (this.keys.get(b.id) ?? b.pub) !== b.pub) {
      return reject('that call sign belongs to another key on this chain');
    }
    if (b.t === 'challenge' && !cfg.roundOptions.includes(b.rounds)) return reject('unsupported duel length');
    let challenge;
    if (b.t === 'accept') {
      challenge = typeof b.challenge === 'string' ? this.challenges.get(b.challenge) : undefined;
      if (!challenge) return reject('no such challenge');
      if (challenge.opponent) return reject('already accepted');
      if (entry.timestamp > challenge.timestamp + cfg.challengeMs) return reject('the challenge expired');
      if (challenge.id === b.id) return reject('you cannot accept your own challenge');
    }
    const check = await profiles(b.id, b.pub, entry.timestamp); // may throw: retry later
    if (!check.ok) return reject(check.reason);
    this.nonces.set(b.id, b.n);
    if (!this.keys.has(b.id)) this.keys.set(b.id, b.pub);
    const who = { id: b.id, pub: b.pub, timestamp: entry.timestamp, height: entry.height, index: entry.index, messageId: entry.messageId };
    if (b.t === 'challenge') {
      this.challenges.set(entry.messageId, { ...who, rounds: b.rounds, opponent: null });
      return { accepted: true, kind: 'challenge', duelId: entry.messageId };
    }
    challenge.opponent = who;
    return { accepted: true, kind: 'accept', duelId: b.challenge };
  }

  /** Open challenges at time t, newest first. */
  open(t) {
    return [...this.challenges.entries()]
      .filter(([, c]) => !c.opponent && t <= c.timestamp + this.cfg.challengeMs)
      .map(([duelId, c]) => ({ duelId, ...c }))
      .sort((a, b) => b.timestamp - a.timestamp);
  }
}

/** One accepted duel, folded from its own topic. */
export class Duel {
  constructor(cfg, duelId, challenge) {
    this.cfg = cfg;
    this.duelId = duelId;
    this.rounds = challenge.rounds;
    this.players = [{ id: challenge.id, pub: challenge.pub }, { id: challenge.opponent.id, pub: challenge.opponent.pub }];
    this.hp = [cfg.hp, cfg.hp];
    this.energy = [cfg.energy.start, cfg.energy.start];
    this.round = 1;
    this.phase = 'seal';
    this.roundStart = challenge.opponent.timestamp;
    this.revealDeadline = null;
    this.seals = [null, null];
    this.reveals = [null, null];
    this.history = []; // resolved rounds
    this.done = false;
    this.winner = null; // seat index, or -1 for a draw
    this.accepted = { height: challenge.opponent.height, index: challenge.opponent.index };
    this.position = { height: 0, index: -1 };
  }

  get sealDeadline() { return this.roundStart + this.cfg.sealMs; }
  seat(id) { return this.players.findIndex((p) => p.id === id); }

  /** Settle every deadline that passed before `ts`. */
  #expire(ts) {
    while (!this.done) {
      if (this.phase === 'seal' && ts > this.sealDeadline) this.#resolve(this.sealDeadline);
      else if (this.phase === 'reveal' && ts > this.revealDeadline) this.#resolve(this.revealDeadline);
      else break;
    }
  }

  /** Apply one finalized duel message; `settled` lists rounds resolved by it (including by deadlines). */
  async apply(entry) {
    const { height, index, timestamp } = entry;
    if (height < this.position.height || (height === this.position.height && index <= this.position.index)) {
      return { skipped: true };
    }
    this.position = { height, index };
    const at = this.accepted;
    if (height < at.height || (height === at.height && index <= at.index)) {
      return { ...reject('before the duel started'), settled: [] };
    }
    const before = this.history.length;
    this.#expire(timestamp);
    let b;
    try { b = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromHex(entry.bodyHex))); } catch { b = null; }
    const result = await this.#message(entry, b);
    return { ...result, settled: this.history.slice(before) };
  }

  async #message(entry, b) {
    const { cfg } = this;
    if (!b || typeof b.id !== 'string' || typeof b.sig !== 'string' || !HEX128.test(b.sig)) return reject('malformed');
    const i = this.seat(b.id);
    if (i < 0) return reject('not in this duel');
    if (this.done) return reject('the duel is over');
    const pub = fromHex(this.players[i].pub);
    const verify = (kind, ...fields) => ed25519Verify(pub, fromHex(b.sig), utf8(statement(cfg, this.duelId, kind, b.id, ...fields)));

    if (b.t === 'forfeit') {
      if (!(await verify('forfeit', b.round))) return reject('signature does not verify');
      return { accepted: true, kind: 'forfeit' };
    }
    if (b.round !== this.round) return reject(`not round ${b.round}`);
    if (b.t === 'seal') {
      if (this.phase !== 'seal') return reject('sealing is closed');
      if (this.seals[i]) return reject('already sealed');
      if (typeof b.hash !== 'string' || !HEX64.test(b.hash)) return reject('malformed seal');
      if (!(await verify('seal', b.round, b.hash))) return reject('signature does not verify');
      this.seals[i] = { hash: b.hash, timestamp: entry.timestamp, height: entry.height, index: entry.index, messageId: entry.messageId };
      if (this.seals[1 - i]) {
        this.phase = 'reveal';
        this.revealDeadline = entry.timestamp + cfg.revealMs;
      }
      return { accepted: true, kind: 'seal', seat: i };
    }
    if (b.t === 'reveal') {
      if (this.phase !== 'reveal') return reject('nothing to reveal yet');
      if (this.reveals[i]) return reject('already revealed');
      const move = cfg.moves.find((m) => m.id === b.move);
      if (!move || typeof b.secret !== 'string' || !HEX32.test(b.secret)) return reject('malformed reveal');
      if (!(await verify('reveal', b.round, b.move, b.secret))) return reject('signature does not verify');
      if (sealHash(cfg, this.duelId, this.round, b.id, b.move, b.secret) !== this.seals[i].hash) {
        return reject('the reveal does not match the seal');
      }
      this.reveals[i] = { move: b.move, secret: b.secret, legal: move.cost <= this.energy[i],
        timestamp: entry.timestamp, height: entry.height, index: entry.index, messageId: entry.messageId };
      if (this.reveals[1 - i]) this.#resolve(entry.timestamp);
      return { accepted: true, kind: 'reveal', seat: i };
    }
    return reject('not a duel message');
  }

  /**
   * Settle the round at time `at`. If sealing timed out, whoever did not seal
   * forfeits (a sealed, never-revealed move just doesn't happen); otherwise
   * whoever did not reveal an affordable move forfeits.
   */
  #resolve(at) {
    const { cfg } = this;
    const moves = this.reveals.map((r) => (r?.legal ? r.move : null));
    const sealingTimedOut = this.phase === 'seal';
    const forfeited = [0, 1].map((i) => (sealingTimedOut ? !this.seals[i] : moves[i] === null));
    for (let i = 0; i < 2; i++) {
      if (moves[i]) {
        const cost = cfg.moves.find((m) => m.id === moves[i]).cost;
        this.energy[i] = Math.min(cfg.energy.max, this.energy[i] - cost);
      }
    }
    const die = moves[0] && moves[1]
      ? rollDie(cfg, this.duelId, this.round, this.reveals[0].secret, this.reveals[1].secret) : null;
    const crit = die === 6 ? 3 : 2; // ×1.5 as integer halves
    const dealt = [0, 1].map((i) => {
      if (forfeited[1 - i]) return cfg.forfeitDamage;
      if (!moves[i]) return 0;
      return Math.floor((damage(moves[i], moves[1 - i]) * crit) / 2);
    });
    for (let i = 0; i < 2; i++) this.hp[1 - i] = Math.max(0, this.hp[1 - i] - dealt[i]);
    this.history.push({
      round: this.round, moves, forfeited, die, dealt, at,
      seals: this.seals.map((s) => s && { ...s }), reveals: this.reveals.map((r) => r && { ...r }),
      hp: [...this.hp], energy: [...this.energy],
    });
    if (this.hp[0] === 0 || this.hp[1] === 0 || this.round === this.rounds) {
      this.done = true;
      this.winner = this.hp[0] === this.hp[1] ? -1 : this.hp[0] > this.hp[1] ? 0 : 1;
      this.phase = 'done';
      return;
    }
    this.round++;
    this.phase = 'seal';
    this.roundStart = at;
    this.revealDeadline = null;
    this.seals = [null, null];
    this.reveals = [null, null];
  }

  /** When the current phase's deadline falls (certified block time). */
  deadline() {
    return this.phase === 'seal' ? this.sealDeadline : this.phase === 'reveal' ? this.revealDeadline : null;
  }
}

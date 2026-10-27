// Deep Sonar: battleship with hidden fleets and no referee.
//
// Before the battle each commander commits to their whole fleet with one hash:
// the Merkle root of 100 salted cells (padded to 128 leaves), where each leaf
// is BLAKE2b(cell ‖ ship ‖ salt) and each cell's salt comes from a secret that
// never leaves their browser. The root says nothing about where the ships are.
//
// Then every shot is a ledger message, and the target must answer it with the
// cell's ship id, its salt and its 7-hash Merkle path. Every browser checks the
// path against the committed root, so a player cannot claim "miss" on a ship
// cell, or move a ship mid-battle: the answer would not hash to the root. A
// fleet with too many or too few ship cells is caught by the answers alone; at
// the end both reveal the whole board and secret, and every browser checks the
// shapes. Deadlines run on certified block time.
//
// Lobby topic (one per hour):
//   challenge {"t":"challenge","id","pub","n","root","sig"}           its message id is the battle id
//   accept    {"t":"accept","id","pub","n","challenge","root","sig"}  the first valid accept wins
// Battle topic (one per battle):
//   shot      {"t":"shot","id","k","cell","sig"}
//   answer    {"t":"answer","id","k","cell","ship","salt","path":[7 hashes],"sig"}
//   reveal    {"t":"reveal","id","board":"<100 digits>","secret","sig"}
//   forfeit   {"t":"forfeit","id","k","sig"}                          only advances block time

import { blake2b } from '../../shared/blake2b.js';
import { ed25519Verify, fromHex, toHex, utf8 } from '../../shared/crypto.js';

const CALLSIGN = /^[a-z0-9][a-z0-9_-]{2,19}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const LEAVES = 128;
export const DEPTH = 7;

const base = (cfg) => cfg.app.replace('/', '.');
export const lobbyOf = (cfg, ts) => Math.floor(ts / cfg.lobbyMs);
export const lobbyTopic = (cfg, hour) => `${base(cfg)}.lobby.h${hour}`;
export const battleTopic = (cfg, battleId) => `${base(cfg)}.d${battleId.slice(0, 16)}`;
export const statement = (cfg, scope, kind, id, ...fields) => [cfg.app, cfg.movesChain, scope, kind, id, ...fields].join('|');

// ------------------------------------------------------------------ commitments

export const cellSalt = (cfg, secret, cell) => toHex(blake2b(utf8(`${cfg.app}|salt|${secret}|${cell}`), 16));
export const leafHash = (cfg, cell, ship, salt) => blake2b(utf8(`${cfg.app}|leaf|${cell}|${ship}|${salt}`), 32);
const padLeaf = (cfg, i) => blake2b(utf8(`${cfg.app}|pad|${i}`), 32);
const node = (left, right) => {
  const bytes = new Uint8Array(65);
  bytes[0] = 1;
  bytes.set(left, 1);
  bytes.set(right, 33);
  return blake2b(bytes, 32);
};

/** Every level of the tree, leaves first. */
export function merkleLevels(cfg, board, secret) {
  const leaves = Array.from({ length: LEAVES }, (_, i) => (i < board.length
    ? leafHash(cfg, i, board[i], cellSalt(cfg, secret, i)) : padLeaf(cfg, i)));
  const levels = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(node(prev[i], prev[i + 1]));
    levels.push(next);
  }
  return levels;
}

export const fleetRoot = (cfg, board, secret) => toHex(merkleLevels(cfg, board, secret)[DEPTH][0]);

/** The answer to a shot at `cell`: ship id, salt and the sibling path to the root. */
export function answerFor(cfg, board, secret, cell, levels = merkleLevels(cfg, board, secret)) {
  const path = [];
  let i = cell;
  for (let l = 0; l < DEPTH; l++) { path.push(toHex(levels[l][i ^ 1])); i >>= 1; }
  return { cell, ship: board[cell], salt: cellSalt(cfg, secret, cell), path };
}

/** Recompute the root from one answered cell; returns the hashes climbed (leaf … root). */
export function climb(cfg, cell, ship, salt, path) {
  let h = leafHash(cfg, cell, ship, salt);
  const steps = [toHex(h)];
  let i = cell;
  for (let l = 0; l < DEPTH; l++) {
    const sib = fromHex(path[l]);
    h = i & 1 ? node(sib, h) : node(h, sib);
    steps.push(toHex(h));
    i >>= 1;
  }
  return steps;
}

export const verifyAnswer = (cfg, root, cell, ship, salt, path) => climb(cfg, cell, ship, salt, path)[DEPTH] === root;

// ------------------------------------------------------------------ fleets

/** A random legal fleet: `int(n)` is the source of randomness (crypto in the page, seeded in tests). */
export function randomFleet(cfg, int) {
  const n = cfg.size;
  for (;;) {
    const board = new Array(n * n).fill(0);
    let ok = true;
    cfg.fleet.forEach((len, k) => {
      if (!ok) return;
      for (let tries = 0; tries < 200; tries++) {
        const across = int(2) === 0;
        const x = int(across ? n - len + 1 : n);
        const y = int(across ? n : n - len + 1);
        const cells = Array.from({ length: len }, (_, j) => (across ? y * n + x + j : (y + j) * n + x));
        if (cells.every((c) => board[c] === 0)) { for (const c of cells) board[c] = k + 1; return; }
      }
      ok = false;
    });
    if (ok) return board;
  }
}

/** A legal fleet: each ship id is one straight, unbroken line of its length; nothing else. */
export function validFleet(cfg, board) {
  const n = cfg.size;
  if (board.length !== n * n || board.some((v) => !Number.isInteger(v) || v < 0 || v > cfg.fleet.length)) return false;
  return cfg.fleet.every((len, k) => {
    const cells = board.flatMap((v, i) => (v === k + 1 ? [i] : []));
    if (cells.length !== len) return false;
    const row = (c) => Math.floor(c / n);
    const across = cells.every((c, j) => row(c) === row(cells[0]) && c === cells[0] + j);
    const down = cells.every((c, j) => c === cells[0] + j * n);
    return across || down;
  });
}

const parse = (entry) => {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromHex(entry.bodyHex))); } catch { return null; }
};
const reject = (reason) => ({ accepted: false, reason });

// ------------------------------------------------------------------ lobby

/** Challenges and acceptances across the lobby topics, in log order. */
export class Lobby {
  constructor(cfg) {
    this.cfg = cfg;
    this.challenges = new Map(); // battle id → { id, pub, root, timestamp, height, index, opponent? }
    this.nonces = new Map();
    this.position = { height: 0, index: -1 };
  }

  /** `profiles(id, pub, ts)` answers { ok } / { ok: false, reason } or throws to retry. */
  async apply(entry, profiles) {
    const { height, index } = entry;
    if (height < this.position.height || (height === this.position.height && index <= this.position.index)) {
      return { skipped: true };
    }
    const b = parse(entry);
    let result = reject('not a lobby message');
    if (b && (b.t === 'challenge' || b.t === 'accept')) result = await this.#message(entry, b, profiles);
    this.position = { height, index };
    return result;
  }

  async #message(entry, b, profiles) {
    const { cfg } = this;
    if (typeof b.id !== 'string' || !CALLSIGN.test(b.id) || typeof b.pub !== 'string' || !HEX64.test(b.pub)
        || !Number.isSafeInteger(b.n) || b.n < 1 || typeof b.root !== 'string' || !HEX64.test(b.root)
        || typeof b.sig !== 'string' || !HEX128.test(b.sig)) {
      return reject('malformed');
    }
    const fields = b.t === 'challenge' ? [b.n, b.root] : [b.n, b.challenge, b.root];
    if (!(await ed25519Verify(fromHex(b.pub), fromHex(b.sig), utf8(statement(cfg, 'lobby', b.t, b.id, ...fields))))) {
      return reject('signature does not verify');
    }
    if (b.n <= (this.nonces.get(b.id) ?? 0)) return reject('stale nonce (replayed)');
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
    const who = { id: b.id, pub: b.pub, root: b.root, timestamp: entry.timestamp, height: entry.height,
      index: entry.index, messageId: entry.messageId };
    if (b.t === 'challenge') {
      this.challenges.set(entry.messageId, { ...who, opponent: null });
      return { accepted: true, kind: 'challenge', battleId: entry.messageId };
    }
    challenge.opponent = who;
    return { accepted: true, kind: 'accept', battleId: b.challenge };
  }

  open(t) {
    return [...this.challenges.entries()]
      .filter(([, c]) => !c.opponent && t <= c.timestamp + this.cfg.challengeMs)
      .map(([battleId, c]) => ({ battleId, ...c }))
      .sort((a, b) => b.timestamp - a.timestamp);
  }
}

// ------------------------------------------------------------------ battle

/** One accepted battle, folded from its own topic. Seat 0 (the challenger) fires first. */
export class Battle {
  constructor(cfg, battleId, challenge) {
    this.cfg = cfg;
    this.battleId = battleId;
    this.players = [challenge, challenge.opponent].map((p) => ({ id: p.id, pub: p.pub, root: p.root }));
    this.accepted = { height: challenge.opponent.height, index: challenge.opponent.index };
    this.since = challenge.opponent.timestamp; // when the current phase began
    this.turn = 0; // the seat that fires next
    this.k = 1; // the shot number being played
    this.phase = 'shot'; // shot | answer | reveal | done
    this.pendingShot = null;
    const cells = cfg.size * cfg.size;
    this.known = [new Map(), new Map()]; // seat → cell → ship id, as proven by answers
    this.hits = [0, 0]; // hits taken by each seat
    this.shipHits = [new Array(cfg.fleet.length + 1).fill(0), new Array(cfg.fleet.length + 1).fill(0)];
    this.shots = []; // { k, by, cell, ship, shot: ref, answer: ref, sunk }
    this.reveals = [null, null];
    this.tentative = null;
    this.winner = null; // seat, or -1 for a draw
    this.reason = null;
    this.total = cells;
    this.shipCells = cfg.fleet.reduce((a, b) => a + b, 0);
    this.position = { ...this.accepted };
  }

  seat(id) { return this.players.findIndex((p) => p.id === id); }
  get done() { return this.phase === 'done'; }

  deadline() {
    const { cfg } = this;
    if (this.phase === 'shot') return this.since + cfg.shotMs;
    if (this.phase === 'answer') return this.since + cfg.answerMs;
    if (this.phase === 'reveal') return this.since + cfg.revealMs;
    return null;
  }

  #end(winner, reason) {
    this.phase = 'done';
    this.winner = winner;
    this.reason = reason;
  }

  /** A message certified past the deadline settles the phase first. */
  #expire(ts) {
    const d = this.deadline();
    if (d === null || ts <= d) return null;
    if (this.phase === 'shot') { this.#end(1 - this.turn, `${this.players[this.turn].id} did not fire in time`); return 'timeout'; }
    if (this.phase === 'answer') { this.#end(this.turn, `${this.players[1 - this.turn].id} did not answer in time`); return 'timeout'; }
    this.#settleReveals();
    return 'reveal-deadline';
  }

  #settleReveals() {
    const bad = [0, 1].map((s) => !this.reveals[s]?.valid);
    const t = this.tentative;
    if (bad[0] && bad[1]) this.#end(-1, 'neither fleet was revealed as a legal fleet');
    else if (bad[t]) this.#end(1 - t, `${this.players[t].id}’s fleet ${this.reveals[t] ? 'was not legal' : 'was never revealed'}`);
    else this.#end(t, bad[1 - t] ? `${this.players[1 - t].id}’s fleet ${this.reveals[1 - t] ? 'was not legal' : 'was never revealed'} — and was sunk anyway`
      : `${this.players[1 - t].id}’s whole fleet was sunk, and both fleets were legal`);
  }

  /** Apply one finalized message on the battle's topic. */
  async apply(entry) {
    const { height, index } = entry;
    const at = this.position;
    if (height < at.height || (height === at.height && index <= at.index)) return { skipped: true };
    this.position = { height, index };
    const expired = this.#expire(entry.timestamp);
    if (this.done) return { ...reject(expired ? 'after the battle ended' : 'the battle is over'), expired };
    const b = parse(entry);
    const seat = b && typeof b.id === 'string' ? this.seat(b.id) : -1;
    if (seat < 0) return { ...reject('not a player in this battle'), expired };
    const pub = fromHex(this.players[seat].pub);
    const say = (kind, ...fields) => utf8(statement(this.cfg, this.battleId, kind, b.id, ...fields));
    const sigOk = typeof b.sig === 'string' && HEX128.test(b.sig);
    const ref = { height, index, messageId: entry.messageId, timestamp: entry.timestamp };

    if (b.t === 'forfeit') {
      if (!sigOk || !Number.isSafeInteger(b.k) || !(await ed25519Verify(pub, fromHex(b.sig), say('forfeit', b.k)))) {
        return { ...reject('bad forfeit claim'), expired };
      }
      return { accepted: true, kind: 'forfeit', seat, expired };
    }

    if (b.t === 'shot') {
      if (this.phase !== 'shot' || seat !== this.turn) return { ...reject('not your turn to fire'), expired };
      if (b.k !== this.k || !Number.isSafeInteger(b.cell) || b.cell < 0 || b.cell >= this.total) return { ...reject('malformed shot'), expired };
      if (this.known[1 - seat].has(b.cell)) return { ...reject('already fired at that cell'), expired };
      if (!sigOk || !(await ed25519Verify(pub, fromHex(b.sig), say('shot', b.k, b.cell)))) return { ...reject('signature does not verify'), expired };
      this.pendingShot = { k: b.k, by: seat, cell: b.cell, shot: ref };
      this.phase = 'answer';
      this.since = entry.timestamp;
      return { accepted: true, kind: 'shot', seat, cell: b.cell, expired };
    }

    if (b.t === 'answer') {
      const s = this.pendingShot;
      if (this.phase !== 'answer' || seat !== 1 - this.turn) return { ...reject('no shot of yours to answer'), expired };
      if (b.k !== s.k || b.cell !== s.cell || !Number.isSafeInteger(b.ship) || b.ship < 0 || b.ship > this.cfg.fleet.length
          || typeof b.salt !== 'string' || !HEX32.test(b.salt) || !Array.isArray(b.path) || b.path.length !== DEPTH
          || !b.path.every((h) => typeof h === 'string' && HEX64.test(h))) {
        return { ...reject('malformed answer'), expired };
      }
      if (!sigOk || !(await ed25519Verify(pub, fromHex(b.sig), say('answer', b.k, b.cell, b.ship, b.salt)))) {
        return { ...reject('signature does not verify'), expired };
      }
      if (!verifyAnswer(this.cfg, this.players[seat].root, b.cell, b.ship, b.salt, b.path)) {
        return { ...reject('the answer does not match the committed fleet'), expired };
      }
      this.known[seat].set(b.cell, b.ship);
      const record = { k: s.k, by: s.by, cell: s.cell, ship: b.ship, shot: s.shot, answer: ref, sunk: null,
        salt: b.salt, path: b.path };
      this.shots.push(record);
      this.pendingShot = null;
      this.since = entry.timestamp;
      if (b.ship) {
        this.hits[seat]++;
        this.shipHits[seat][b.ship]++;
        if (this.shipHits[seat][b.ship] > this.cfg.fleet[b.ship - 1]) {
          this.#end(1 - seat, `${b.id}’s fleet has more ${this.cfg.shipNames[b.ship - 1]} cells than a fleet may — proven by the answers`);
          return { accepted: true, kind: 'answer', seat, record, expired };
        }
        if (this.shipHits[seat][b.ship] === this.cfg.fleet[b.ship - 1]) record.sunk = b.ship;
      }
      const water = this.known[seat].size - this.hits[seat];
      if (water > this.total - this.shipCells) {
        this.#end(1 - seat, `${b.id}’s fleet has fewer ship cells than a fleet must — proven by the answers`);
      } else if (this.hits[seat] === this.shipCells) {
        this.phase = 'reveal';
        this.tentative = s.by;
      } else {
        this.turn = seat;
        this.k++;
        this.phase = 'shot';
      }
      return { accepted: true, kind: 'answer', seat, record, expired };
    }

    if (b.t === 'reveal') {
      if (this.phase !== 'reveal') return { ...reject('nothing to reveal yet'), expired };
      if (this.reveals[seat]) return { ...reject('already revealed'), expired };
      if (typeof b.board !== 'string' || !/^[0-9]{100}$/.test(b.board) || typeof b.secret !== 'string' || !HEX64.test(b.secret)) {
        return { ...reject('malformed reveal'), expired };
      }
      if (!sigOk || !(await ed25519Verify(pub, fromHex(b.sig), say('reveal', b.board, b.secret)))) {
        return { ...reject('signature does not verify'), expired };
      }
      const board = [...b.board].map(Number);
      const matches = fleetRoot(this.cfg, board, b.secret) === this.players[seat].root;
      const legal = matches && validFleet(this.cfg, board);
      this.reveals[seat] = { valid: legal, matches, board, secret: b.secret, ref };
      if (this.reveals[0] && this.reveals[1]) this.#settleReveals();
      return { accepted: true, kind: 'reveal', seat, legal, expired };
    }
    return { ...reject('not a move'), expired };
  }
}

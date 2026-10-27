// The galaxy is a deterministic simulation driven by the finalized log.
//
// ordered-log never reads a move. It gives every player the same moves in the
// same order, each stamped with a block time the members certified. Every
// browser runs those moves through the rules below and gets the same galaxy:
// same planets, same fleets, same battles, same winner — with nobody running
// a game server.
//
// To stay identical across browsers the simulation uses integers only (ships
// are counted in thousandths), no trigonometry, no wall clock and no
// Math.random. The map comes from BLAKE2b of the round number. Time is
// certified block time; fleet arrivals between blocks are computed exactly.
//
// A round is a fixed window of block time; moves go on a per-round topic:
//
//   join  {"t":"join","id","pub","n","sig"}             claim a home planet
//   go    {"t":"go","id","n","from","to","pct","sig"}   launch a fleet
//
// `sig` is the commander's Ed25519 signature over moveStatement(...). Every
// planet remembers the finalized move that took it (`taken`), so a capture
// can be proven later against the Cardano anchor. Joins
// are also checked against the commander's profile on the authenticated-map
// chain (see Profiles in app.js): the key must match and the profile must
// have been registered before the join.

import { blake2b } from '../../shared/blake2b.js';
import { ed25519Verify, fromHex, utf8 } from '../../shared/crypto.js';

export const roundOf = (cfg, ts) => Math.floor(ts / cfg.game.roundMs);
export const roundStart = (cfg, round) => round * cfg.game.roundMs;
export const roundTopic = (cfg, round) => `${cfg.app.replace('/', '.')}.r${round}`;
export const moveStatement = (cfg, round, kind, id, n, fields) =>
  [cfg.app, cfg.movesChain, round, kind, id, n, ...fields].join('|');

const CALLSIGN = /^[a-z0-9][a-z0-9_-]{2,19}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const PRODUCTION = [0, 900, 1400, 2000]; // thousandths of a ship per second, by planet size
const CAP = [0, 80, 140, 200]; // production stops at this many ships
const NEUTRAL_HOME_GARRISON = 20;

/** Integer square root, exact for any safe integer. */
export function isqrt(n) {
  if (n < 2) return n;
  let x = Math.floor(Math.sqrt(n));
  while (x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}

/** xoshiro128** seeded from 16 bytes: unsigned 32-bit integers, identical in every engine. */
function rng(seed) {
  const s = [0, 1, 2, 3].map((i) => (seed[i * 4] | (seed[i * 4 + 1] << 8) | (seed[i * 4 + 2] << 16) | (seed[i * 4 + 3] << 24)) >>> 0);
  return () => {
    const x = Math.imul(s[1], 5);
    const result = Math.imul((x << 7) | (x >>> 25), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t;
    s[3] = (s[3] << 11) | (s[3] >>> 21);
    return result;
  };
}

const NAMES = ['Kepler', 'Vesta', 'Ion', 'Rhea', 'Lyra', 'Draco', 'Ceres', 'Altair', 'Juno', 'Hydra', 'Orion',
  'Pallas', 'Sirius', 'Deneb', 'Mira', 'Talos', 'Nyx', 'Tau', 'Vega', 'Rigel', 'Atlas', 'Electra', 'Castor',
  'Pollux', 'Spica', 'Antares', 'Bellatrix', 'Hadar', 'Izar', 'Merak'];
const HOME_SLOTS = [[90, 90], [500, 64], [910, 90], [936, 310], [910, 530], [500, 556], [90, 530], [64, 310]];

/** The round's map: home planets first (index = home slot), then neutrals. */
export function generateMap(cfg, round) {
  const g = cfg.game;
  const next = rng(blake2b(utf8(`${cfg.app}|map|${round}`), 16));
  const between = (lo, hi) => lo + (next() % (hi - lo + 1));
  const names = [...NAMES];
  const name = () => names.splice(next() % names.length, 1)[0];
  const planets = [];
  const add = (x, y, size, ships) => planets.push({
    id: planets.length, x, y, size, name: name(), owner: -1, milli: ships * 1000, at: roundStart(cfg, round),
  });
  const scale = (v, from, to) => Math.floor((v * to) / from);
  for (let i = 0; i < g.homes; i++) {
    const [sx, sy] = HOME_SLOTS[i % HOME_SLOTS.length];
    add(scale(sx, 1000, g.width) + between(0, 30) - 15, scale(sy, 620, g.height) + between(0, 30) - 15,
      3, NEUTRAL_HOME_GARRISON);
  }
  let tries = 0;
  while (planets.length < g.planets && tries++ < 4000) {
    const x = between(150, g.width - 150);
    const y = between(110, g.height - 110);
    if (planets.every((p) => (p.x - x) ** 2 + (p.y - y) ** 2 >= 120 ** 2)) {
      const size = between(1, 3);
      add(x, y, size, between(4, 8 + size * 8));
    }
  }
  return planets;
}

export class Galaxy {
  /** `state` is for clone() only: a new round always starts from its generated map. */
  constructor(cfg, round, state) {
    this.cfg = cfg;
    this.round = round;
    this.start = roundStart(cfg, round);
    this.end = this.start + cfg.game.roundMs;
    this.s = state ?? {
      time: this.start,
      planets: generateMap(cfg, round),
      fleets: [], // sorted by (arrive, seq)
      players: [], // in join order; a player's index is the owner value of its planets
      seq: 0,
      events: [], // recent captures, for the renderer
      position: { height: 0, index: -1 },
      moves: 0,
    };
  }

  /** A copy to run ahead of the ledger for drawing; the original stays authoritative. */
  clone() {
    return new Galaxy(this.cfg, this.round, structuredClone(this.s));
  }

  get time() { return this.s.time; }
  get planets() { return this.s.planets; }
  get fleets() { return this.s.fleets; }
  get players() { return this.s.players; }
  get position() { return this.s.position; }
  player(id) { return this.s.players.find((p) => p.id === id); }

  /** Ships (in thousandths) on a planet at time t, without changing it. */
  shipsAt(p, t) {
    if (p.owner < 0 || t <= p.at || p.milli >= CAP[p.size] * 1000) return p.milli;
    return Math.min(CAP[p.size] * 1000, p.milli + Math.floor(((t - p.at) * PRODUCTION[p.size]) / 1000));
  }

  #grow(p, t) {
    p.milli = this.shipsAt(p, t);
    p.at = Math.max(p.at, t);
  }

  /** Resolve every fleet that arrives by t (never past the round's end). */
  advanceTo(t) {
    const until = Math.min(t, this.end);
    const fleets = this.s.fleets;
    while (fleets.length && fleets[0].arrive <= until) this.#arrive(fleets.shift());
    this.s.time = Math.max(this.s.time, until);
  }

  #arrive(f) {
    const p = this.s.planets[f.to];
    this.#grow(p, f.arrive);
    if (p.owner === f.owner) {
      p.milli += f.milli;
      return;
    }
    const left = p.milli - f.milli;
    if (left >= 0) {
      p.milli = left;
      this.#event({ kind: 'hold', planet: p.id, owner: p.owner, attacker: f.owner, time: f.arrive, seq: f.seq });
    } else {
      const was = p.owner;
      p.owner = f.owner;
      p.milli = -left;
      p.taken = { kind: 'capture', owner: f.owner, from: f.from, time: f.arrive, launched: f.launched,
        messageId: f.messageId, height: f.height, index: f.index };
      this.#event({ kind: 'capture', planet: p.id, owner: f.owner, was, time: f.arrive, seq: f.seq });
    }
  }

  #event(e) {
    this.s.events.push(e);
    if (this.s.events.length > 200) this.s.events.shift();
  }

  /**
   * Apply one finalized move: { height, index, messageId, timestamp, bodyHex }.
   * `profiles(id, pub, timestamp)` checks a joining commander and answers
   * { ok } or { ok: false, reason }; it throws to say "ask again later", in
   * which case nothing is applied and the same entry must be retried.
   */
  async apply(entry, profiles) {
    const { height, index, timestamp } = entry;
    const at = this.s.position;
    if (height < at.height || (height === at.height && index <= at.index)) return { skipped: true };

    let body;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromHex(entry.bodyHex)));
    } catch {
      body = null;
    }
    let result;
    if (timestamp < this.start || timestamp >= this.end) result = reject('outside this round');
    else if (body?.t === 'join') result = await this.#join(entry, body, profiles);
    else if (body?.t === 'go') result = await this.#go(entry, body);
    else result = reject('not a move');

    this.s.position = { height, index };
    if (result.accepted) this.s.moves++;
    return result;
  }

  async #join(entry, b, profiles) {
    const { cfg } = this;
    if (typeof b.id !== 'string' || !CALLSIGN.test(b.id) || typeof b.pub !== 'string' || !HEX64.test(b.pub)
        || !Number.isSafeInteger(b.n) || b.n < 1 || typeof b.sig !== 'string' || !HEX128.test(b.sig)) {
      return reject('malformed join');
    }
    if (!(await ed25519Verify(fromHex(b.pub), fromHex(b.sig),
      utf8(moveStatement(cfg, this.round, 'join', b.id, b.n, [b.pub]))))) {
      return reject('join signature does not verify');
    }
    if (this.player(b.id)) return reject('already in this round');
    const check = await profiles(b.id, b.pub, entry.timestamp); // may throw: retry later
    if (!check.ok) return reject(check.reason);

    this.advanceTo(entry.timestamp);
    const home = this.s.planets.slice(0, cfg.game.homes).find((p) => p.owner < 0);
    if (!home || this.s.players.length >= cfg.game.homes) return reject('galaxy full');
    const player = { id: b.id, pub: b.pub, index: this.s.players.length, n: b.n, joinedAt: entry.timestamp,
      home: home.id, blockHeight: 0, blockLaunches: 0 };
    this.s.players.push(player);
    this.#grow(home, entry.timestamp);
    home.owner = player.index;
    home.milli = cfg.game.homeShips * 1000;
    home.at = entry.timestamp;
    home.taken = { kind: 'join', owner: player.index, time: entry.timestamp,
      messageId: entry.messageId, height: entry.height, index: entry.index };
    return { accepted: true, kind: 'join', player };
  }

  async #go(entry, b) {
    const { cfg } = this;
    const g = cfg.game;
    const player = typeof b.id === 'string' ? this.player(b.id) : undefined;
    if (!player) return reject('not in this round');
    const n = this.s.planets.length;
    if (!Number.isSafeInteger(b.n) || !isInt(b.from, n) || !isInt(b.to, n) || b.from === b.to
        || !g.ratios.includes(b.pct) || typeof b.sig !== 'string' || !HEX128.test(b.sig)) {
      return reject('malformed launch');
    }
    if (b.n <= player.n) return reject('stale nonce (replayed)');
    if (!(await ed25519Verify(fromHex(player.pub), fromHex(b.sig),
      utf8(moveStatement(cfg, this.round, 'go', b.id, b.n, [b.from, b.to, b.pct]))))) {
      return reject('launch signature does not verify');
    }
    player.n = b.n; // a verified move burns its nonce even if refused below

    if (player.blockHeight !== entry.height) { player.blockHeight = entry.height; player.blockLaunches = 0; }
    if (player.blockLaunches >= g.maxLaunchesPerBlock) return reject('too many launches in one block');

    this.advanceTo(entry.timestamp);
    const from = this.s.planets[b.from];
    const to = this.s.planets[b.to];
    this.#grow(from, entry.timestamp);
    if (from.owner !== player.index) return reject('not your planet');
    const ships = Math.floor((Math.floor(from.milli / 1000) * b.pct) / 100);
    if (ships < 1) return reject('no ships to send');

    player.blockLaunches++;
    from.milli -= ships * 1000;
    const distance = isqrt((to.x - from.x) ** 2 + (to.y - from.y) ** 2);
    const fleet = {
      seq: ++this.s.seq, owner: player.index, from: from.id, to: to.id, milli: ships * 1000,
      launched: entry.timestamp, arrive: entry.timestamp + Math.floor((distance * 1000) / g.fleetSpeed),
      messageId: entry.messageId, height: entry.height, index: entry.index,
    };
    const fleets = this.s.fleets;
    let i = fleets.length;
    while (i > 0 && (fleets[i - 1].arrive > fleet.arrive
        || (fleets[i - 1].arrive === fleet.arrive && fleets[i - 1].seq > fleet.seq))) i--;
    fleets.splice(i, 0, fleet);
    return { accepted: true, kind: 'go', fleet, player };
  }

  /** Players ranked at time t: planets held, then ships (docked plus in flight). */
  standings(t = this.s.time) {
    return this.s.players.map((player) => {
      const owned = this.s.planets.filter((p) => p.owner === player.index);
      const milli = owned.reduce((sum, p) => sum + this.shipsAt(p, t), 0)
        + this.s.fleets.filter((f) => f.owner === player.index).reduce((sum, f) => sum + f.milli, 0);
      return { player, planets: owned.length, ships: Math.floor(milli / 1000) };
    }).sort((a, b) => b.planets - a.planets || b.ships - a.ships || a.player.index - b.player.index);
  }
}

const isInt = (v, n) => Number.isSafeInteger(v) && v >= 0 && v < n;
const reject = (reason) => ({ accepted: false, reason });

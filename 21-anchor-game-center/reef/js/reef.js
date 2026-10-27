// Reef: a living world that every browser grows identically from the ledger.
//
// The world is a 160 × 100 torus of cells running a multi-species Game of Life
// (B3/S23; a newborn takes the species most of its three parents share) at
// five generations a second of *certified block time*. Commanders drop living
// patterns — gliders, spaceships, methuselahs, a glider gun — that join the
// world at the generation their block's timestamp names. Nothing but the
// placements is stored: a whole twenty-minute season is a few kilobytes of
// messages, and any browser can rebuild the world at any generation, so the
// page can travel back to any moment and every browser gets the same picture
// and the same world hash.
//
// One topic per season (CONFIG.seasonMs):
//   open  {"t":"open"}                                         anyone
//   seed  {"t":"seed","id","pub","n","pattern","x","y","rot","sig"}
//
// The season's first message opens it: its block's certified time is
// generation 0, and BLAKE2b of its state root seeds the primordial soup, so
// nobody knows the starting world before that block exists. Commanders are
// checked against their profile on the authenticated-map chain.

import { blake2b } from '../../shared/blake2b.js';
import { ed25519Verify, fromHex, toHex, utf8 } from '../../shared/crypto.js';
import { rng } from '../../shared/rng.js';

const CALLSIGN = /^[a-z0-9][a-z0-9_-]{2,19}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
export const WILD = 7;

const GUN = [[24, 0], [22, 1], [24, 1], [12, 2], [13, 2], [20, 2], [21, 2], [34, 2], [35, 2], [11, 3], [15, 3], [20, 3],
  [21, 3], [34, 3], [35, 3], [0, 4], [1, 4], [10, 4], [16, 4], [20, 4], [21, 4], [0, 5], [1, 5], [10, 5], [14, 5], [16, 5],
  [17, 5], [22, 5], [24, 5], [10, 6], [16, 6], [24, 6], [11, 7], [15, 7], [12, 8], [13, 8]];

export const PATTERNS = {
  glider: { name: 'Glider', cost: 1, cells: [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]], note: 'travels diagonally' },
  lwss: { name: 'Spaceship', cost: 2, cells: [[1, 0], [4, 0], [0, 1], [0, 2], [4, 2], [0, 3], [1, 3], [2, 3], [3, 3]], note: 'flies straight' },
  rpent: { name: 'R-pentomino', cost: 2, cells: [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]], note: 'erupts for 1,100 generations' },
  diehard: { name: 'Diehard', cost: 2, cells: [[6, 0], [0, 1], [1, 1], [1, 2], [5, 2], [6, 2], [7, 2]], note: 'a bloom that vanishes' },
  acorn: { name: 'Acorn', cost: 3, cells: [[1, 0], [3, 1], [0, 2], [1, 2], [4, 2], [5, 2], [6, 2]], note: 'grows a forest' },
  gun: { name: 'Glider gun', cost: 8, cells: GUN, note: 'fires a glider every 30 generations' },
};

export const seasonOf = (cfg, ts) => Math.floor(ts / cfg.seasonMs);
export const seasonTopic = (cfg, season) => `${cfg.app.replace('/', '.')}.s${season}`;
export const seasonSeed = (cfg, season, stateRoot) => blake2b(utf8(`${cfg.app}|soup|${season}|${stateRoot}`), 16);
export const seedStatement = (cfg, season, id, n, pattern, x, y, rot) =>
  [cfg.app, cfg.movesChain, season, 'seed', id, n, pattern, x, y, rot].join('|');

/** A pattern's cells rotated by rot quarter turns, shifted to start at 0,0. */
export function shape(pattern, rot) {
  let cells = PATTERNS[pattern].cells.map(([x, y]) => [x, y]);
  for (let k = 0; k < rot; k++) cells = cells.map(([x, y]) => [-y, x]);
  const mx = Math.min(...cells.map((c) => c[0]));
  const my = Math.min(...cells.map((c) => c[1]));
  return cells.map(([x, y]) => [x - mx, y - my]);
}

// ------------------------------------------------------------------ the world

/** The primordial soup: wild blobs drawn from the season seed. */
export function soup(cfg, seed) {
  const { width: W, height: H } = cfg;
  const cells = new Uint8Array(W * H);
  const r = rng(seed);
  for (let b = 0; b < 34; b++) {
    const cx = r.int(W);
    const cy = r.int(H);
    for (let dy = 0; dy < 7; dy++) {
      for (let dx = 0; dx < 7; dx++) {
        if (r.int(100) < 42) cells[((cy + dy) % H) * W + ((cx + dx) % W)] = WILD;
      }
    }
  }
  return cells;
}

/** One generation: B3/S23 on a torus; a newborn takes its parents' majority species. */
export function step(cfg, cells, gen) {
  const { width: W, height: H } = cfg;
  const next = new Uint8Array(W * H);
  const n = new Int32Array(8);
  for (let y = 0; y < H; y++) {
    const up = ((y + H - 1) % H) * W;
    const row = y * W;
    const down = ((y + 1) % H) * W;
    for (let x = 0; x < W; x++) {
      const l = x === 0 ? W - 1 : x - 1;
      const r = x === W - 1 ? 0 : x + 1;
      n[0] = cells[up + l]; n[1] = cells[up + x]; n[2] = cells[up + r]; n[3] = cells[row + l];
      n[4] = cells[row + r]; n[5] = cells[down + l]; n[6] = cells[down + x]; n[7] = cells[down + r];
      let count = 0;
      let a = 0;
      let b = 0;
      let c = 0;
      for (let k = 0; k < 8; k++) {
        const s = n[k];
        if (!s) continue;
        if (count === 0) a = s; else if (count === 1) b = s; else if (count === 2) c = s;
        count++;
      }
      const self = cells[row + x];
      if (self) {
        if (count === 2 || count === 3) next[row + x] = self;
      } else if (count === 3) {
        next[row + x] = a === b || a === c ? a : b === c ? b : [a, b, c][(x * 7 + y * 13 + gen) % 3];
      }
    }
  }
  return next;
}

/** Stamp a placement onto the world (living cells of the commander's species). */
export function stamp(cfg, cells, p) {
  for (const [dx, dy] of shape(p.pattern, p.rot)) {
    cells[((p.y + dy) % cfg.height) * cfg.width + ((p.x + dx) % cfg.width)] = p.species;
  }
}

export function census(cells) {
  const counts = new Array(8).fill(0);
  for (let i = 0; i < cells.length; i++) counts[cells[i]]++;
  return counts;
}

export const worldHash = (cells) => toHex(blake2b(cells, 16));

// ------------------------------------------------------------------ the season

const reject = (reason) => ({ accepted: false, reason });

/** Placements and players for one season, folded from its topic in log order. */
export class Reef {
  constructor(cfg, season) {
    this.cfg = cfg;
    this.season = season;
    this.start = season * cfg.seasonMs;
    this.end = this.start + cfg.seasonMs;
    this.origin = null; // { height, messageId, timestamp, stateRoot, seed }
    this.players = new Map(); // id → { id, pub, species, spores, sporesAt, placed }
    this.placements = []; // accepted, in log order: { gen, id, species, pattern, x, y, rot, height, index, messageId, timestamp }
    this.byGen = new Map(); // gen → placements stamped at that generation
    this.nonces = new Map();
    this.position = { height: 0, index: -1 };
  }

  /** The generation a certified timestamp names (placements land at the start of it). */
  genAt(ts) { return Math.floor((ts - this.origin.timestamp) / this.cfg.genMs) + 1; }
  /** The last generation of the season. */
  get lastGen() { return this.origin ? Math.floor((this.end - this.origin.timestamp) / this.cfg.genMs) : 0; }

  spores(player, ts) {
    const { spores: s } = this.cfg;
    const gained = Math.floor((ts - player.sporesAt) / s.regenMs);
    return Math.min(s.max, player.spores + gained);
  }

  /**
   * Apply one finalized message: { height, index, messageId, timestamp, stateRoot, bodyHex }.
   * `profiles(id, pub, ts)` answers { ok } / { ok: false, reason }, or throws to retry.
   */
  async apply(entry, profiles) {
    const { height, index } = entry;
    if (height < this.position.height || (height === this.position.height && index <= this.position.index)) {
      return { skipped: true };
    }
    let result;
    if (entry.timestamp < this.start || entry.timestamp >= this.end) {
      result = reject('outside this season');
    } else {
      let opened = false;
      if (!this.origin) {
        this.origin = { height, messageId: entry.messageId, timestamp: entry.timestamp, stateRoot: entry.stateRoot,
          seed: toHex(seasonSeed(this.cfg, this.season, entry.stateRoot)) };
        opened = true;
      }
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromHex(entry.bodyHex))); } catch { body = null; }
      if (body?.t === 'open') result = { accepted: true, kind: 'open', opened };
      else if (body?.t === 'seed') result = { ...(await this.#seed(entry, body, profiles)), opened };
      else result = { ...reject('not a move'), opened };
    }
    this.position = { height, index };
    return result;
  }

  async #seed(entry, b, profiles) {
    const { cfg } = this;
    if (typeof b.id !== 'string' || !CALLSIGN.test(b.id) || typeof b.pub !== 'string' || !HEX64.test(b.pub)
        || !Number.isSafeInteger(b.n) || b.n < 1 || typeof b.pattern !== 'string' || !Object.hasOwn(PATTERNS, b.pattern)
        || !Number.isSafeInteger(b.x) || !Number.isSafeInteger(b.y) || !Number.isSafeInteger(b.rot)
        || b.x < 0 || b.x >= cfg.width || b.y < 0 || b.y >= cfg.height || b.rot < 0 || b.rot > 3
        || typeof b.sig !== 'string' || !HEX128.test(b.sig)) {
      return reject('malformed placement');
    }
    const statement = seedStatement(cfg, this.season, b.id, b.n, b.pattern, b.x, b.y, b.rot);
    if (!(await ed25519Verify(fromHex(b.pub), fromHex(b.sig), utf8(statement)))) return reject('signature does not verify');
    if (b.n <= (this.nonces.get(b.id) ?? 0)) return reject('stale nonce (replayed)');
    const gen = this.genAt(entry.timestamp);
    if (gen > this.lastGen) return reject('the season is over');
    let player = this.players.get(b.id);
    if (player && player.pub !== b.pub) return reject('not this commander’s key');
    if (!player) {
      if (this.players.size >= cfg.maxPlayers) return reject('the reef is full this season');
      const check = await profiles(b.id, b.pub, entry.timestamp); // may throw: retry later
      if (!check.ok) return reject(check.reason);
    }
    const cost = PATTERNS[b.pattern].cost;
    const have = player ? this.spores(player, entry.timestamp) : cfg.spores.start;
    if (cost > have) return reject(`needs ${cost} spores, has ${have}`);
    if (!player) {
      player = { id: b.id, pub: b.pub, species: this.players.size + 1, spores: cfg.spores.start, sporesAt: entry.timestamp, placed: 0 };
      this.players.set(b.id, player);
    }
    // Spend: keep the regeneration clock's remainder unless the meter was full.
    const regen = cfg.spores.regenMs;
    const gained = Math.floor((entry.timestamp - player.sporesAt) / regen);
    if (player.spores + gained >= cfg.spores.max) { player.spores = cfg.spores.max; player.sporesAt = entry.timestamp; }
    else { player.spores += gained; player.sporesAt += gained * regen; }
    player.spores -= cost;
    player.placed++;
    this.nonces.set(b.id, b.n);
    const p = { gen, id: b.id, species: player.species, pattern: b.pattern, x: b.x, y: b.y, rot: b.rot,
      height: entry.height, index: entry.index, messageId: entry.messageId, timestamp: entry.timestamp };
    this.placements.push(p);
    if (!this.byGen.has(gen)) this.byGen.set(gen, []);
    this.byGen.get(gen).push(p);
    return { accepted: true, kind: 'seed', placement: p };
  }

  speciesOf(id) { return this.players.get(id)?.species ?? null; }
  playerOf(species) { return [...this.players.values()].find((p) => p.species === species) ?? null; }
}

/**
 * The world at any generation, rebuilt from the soup and the placements, with
 * a checkpoint every 50 generations so travelling back in time is cheap.
 */
export class Timeline {
  constructor(cfg, reef) {
    this.cfg = cfg;
    this.reef = reef;
    this.checkpoints = new Map(); // gen → cells (after that generation's placements)
    this.populations = []; // gen → census, as far as computed
    this.head = null; // { gen, cells }
  }

  /** New placements at `gen` change everything from there on. */
  invalidateFrom(gen) {
    for (const g of [...this.checkpoints.keys()]) if (g >= gen) this.checkpoints.delete(g);
    if (this.head && this.head.gen >= gen) this.head = null;
    if (this.populations.length > gen) this.populations.length = gen;
  }

  #start() {
    const cells = soup(this.cfg, fromHex(this.reef.origin.seed));
    for (const p of this.reef.byGen.get(0) ?? []) stamp(this.cfg, cells, p);
    return { gen: 0, cells };
  }

  #best(gen) {
    if (this.head && this.head.gen <= gen) return this.head;
    let best = null;
    for (const [g, cells] of this.checkpoints) if (g <= gen && (!best || g > best.gen)) best = { gen: g, cells };
    return best ? { gen: best.gen, cells: best.cells.slice() } : this.#start();
  }

  /** The world at `gen`; at most `budget` generations of work (returns null if not there yet). */
  at(gen, budget = Infinity) {
    if (!this.reef.origin) return null;
    let { gen: g, cells } = this.#best(gen);
    if (this.populations.length === g) this.populations.push(census(cells));
    let work = 0;
    while (g < gen) {
      if (work++ >= budget) { this.head = { gen: g, cells }; return null; }
      g++;
      cells = step(this.cfg, cells, g);
      for (const p of this.reef.byGen.get(g) ?? []) stamp(this.cfg, cells, p);
      if (g % 50 === 0) this.checkpoints.set(g, cells.slice());
      if (this.populations.length === g) this.populations.push(census(cells));
    }
    this.head = { gen: g, cells };
    return cells;
  }
}

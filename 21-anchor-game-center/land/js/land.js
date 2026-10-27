// Land Rush: tiles claimed first come, first served — and that rule is the
// ledger's, not the browser's.
//
// A claim is an authenticated-map PUT_IF_ABSENT on the tile's key. The members
// refuse a second claim on the same key (ALREADY_EXISTS), so who owns a tile
// is decided by the ledger itself. This fold reads the authenticated-map
// chain's finalized commands in order and mirrors that decision; anything it
// cannot mirror exactly (another command shape, a batch, a plain PUT) is
// settled by the ledger's own receipt for that message.
//
// On top of ownership, every browser applies the game's rules to each tile's
// first claim, identically:
//
//   the claim's value is {"v":1,"id","pub","sig"}, signed by the commander's
//   key; the commander's profile was created earlier in this same log;
//   a commander's first valid claim of the season is their capital (anywhere),
//   later ones must touch their land; each claim costs stamina, which refills
//   by certified block time.
//
// A first claim that breaks a rule still holds the key on the ledger, so the
// tile is "scorched": it counts for nobody this season.
//
// Each season's keys and terrain come from the state root of the first block
// of the season on this chain. Nobody knows it in advance, so nobody can
// pre-claim — or pre-scorch — a season before it opens.

import { decode } from '../../shared/cbor.js';
import { blake2b } from '../../shared/blake2b.js';
import { ed25519Verify, fromHex, toHex, utf8 } from '../../shared/crypto.js';
import { readProfile } from '../../shared/accounts.js';

const OP_PUT = 0;
const OP_PUT_IF_ABSENT = 1;
const AUTH_OWNER = 1;
const CALLSIGN = /^[a-z0-9][a-z0-9_-]{2,19}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export const seasonOf = (cfg, ts) => Math.floor(ts / cfg.seasonMs);
export const seasonSeed = (cfg, season, stateRoot) => toHex(blake2b(utf8(`${cfg.app}|season|${season}|${stateRoot}`), 16));
/** The marker anyone may write to open a season when the chain is quiet. */
export const openKey = (cfg, season) => `${cfg.app}/open/s${season}`;
export const tilePrefix = (cfg, season, seed) => `${cfg.app}/s${season}-${seed.slice(0, 8)}/`;
export const tileKey = (cfg, season, seed, c, r) => `${tilePrefix(cfg, season, seed)}${c},${r}`;
export const claimStatement = (cfg, season, seed, c, r, id) => `${cfg.app}|claim|${season}|${seed}|${c},${r}|${id}`;

/** Odd rows are shifted right by half a tile. */
export function neighbors(cfg, c, r) {
  const d = r % 2
    ? [[1, 0], [-1, 0], [0, -1], [1, -1], [0, 1], [1, 1]]
    : [[1, 0], [-1, 0], [-1, -1], [0, -1], [-1, 1], [0, 1]];
  return d.map(([dc, dr]) => [c + dc, r + dr]).filter(([x, y]) => x >= 0 && y >= 0 && x < cfg.cols && y < cfg.rows);
}

/** xoshiro128** seeded from 16 bytes: identical in every engine. */
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

const SYLLABLES = ['ash', 'ember', 'frost', 'gold', 'iron', 'moon', 'star', 'storm', 'thorn', 'wolf', 'raven', 'sun',
  'glen', 'vale', 'oak', 'silver', 'stone', 'mist', 'red', 'black'];
const ENDINGS = ['fall', 'reach', 'hold', 'mere', 'crest', 'ford', 'haven', 'moor', 'peak', 'wick', 'stead', 'gate'];

/** The season's terrain: smooth integer value noise, so every browser draws the same land. */
export function generateMap(cfg, seed) {
  const next = rng(fromHex(seed));
  const GX = 7;
  const GY = 5;
  const grid = Array.from({ length: GX * GY }, () => next() % 1001);
  const tiles = [];
  for (let r = 0; r < cfg.rows; r++) {
    for (let c = 0; c < cfg.cols; c++) {
      const fx = Math.floor((c * (GX - 1) * 1000) / (cfg.cols - 1));
      const fy = Math.floor((r * (GY - 1) * 1000) / (cfg.rows - 1));
      const x0 = Math.min(GX - 2, Math.floor(fx / 1000));
      const y0 = Math.min(GY - 2, Math.floor(fy / 1000));
      const tx = fx - x0 * 1000;
      const ty = fy - y0 * 1000;
      const g = (x, y) => grid[y * GX + x];
      const top = g(x0, y0) * (1000 - tx) + g(x0 + 1, y0) * tx;
      const bottom = g(x0, y0 + 1) * (1000 - tx) + g(x0 + 1, y0 + 1) * tx;
      const v = Math.floor((top * (1000 - ty) + bottom * ty) / 1_000_000) + (next() % 151) - 75;
      const terrain = v > 780 ? 3 : v > 600 ? 2 : v > 380 ? 1 : 0;
      const name = SYLLABLES[next() % SYLLABLES.length] + ENDINGS[next() % ENDINGS.length];
      tiles.push({ c, r, terrain, name: name[0].toUpperCase() + name.slice(1) });
    }
  }
  return tiles;
}

/** Decode an authenticated-map command envelope, or null. */
export function decodeCommand(bodyHex) {
  try {
    const envelope = decode(fromHex(bodyHex));
    if (!Array.isArray(envelope) || envelope[0] !== 1 || !(envelope[1] instanceof Uint8Array)) return null;
    const action = decode(envelope[1]);
    if (!Array.isArray(action) || action[0] !== 1 || !Array.isArray(action[2])) return null;
    const mutations = action[2].map((m) => ({
      op: m[0], collection: m[1], key: new TextDecoder().decode(m[2]), value: m[3],
    }));
    return { shape: action[1], mutations, assignments: action[3], evidence: envelope[2] };
  } catch {
    return null;
  }
}

/** The one shape whose outcome the fold can mirror without a receipt: a lone owner PUT_IF_ABSENT. */
function plainClaim(cmd, collection) {
  if (cmd.shape !== 0 || cmd.mutations.length !== 1 || !Array.isArray(cmd.evidence) || cmd.evidence.length !== 0) return false;
  const m = cmd.mutations[0];
  const a = cmd.assignments;
  return m.op === OP_PUT_IF_ABSENT && m.collection === collection && m.value instanceof Uint8Array
    && Array.isArray(a) && a.length === 1 && Array.isArray(a[0])
    && a[0][0] === 0 && a[0][1] === AUTH_OWNER && a[0][2] === '' && a[0][3] === 0;
}

export class Land {
  constructor(cfg, accounts, season) {
    this.cfg = cfg;
    this.accounts = accounts;
    this.season = season;
    this.start = season * cfg.seasonMs;
    this.end = this.start + cfg.seasonMs;
    this.seed = null;
    this.seededBy = null;
    this.map = null;
    this.tiles = new Map(); // "c,r" → { owner?, scorched?, reason?, height, index, messageId, timestamp, value }
    this.created = new Set(); // keys this season (and profiles) already created on the ledger
    this.profiles = new Map(); // id → { bytes, profile (lazy) }
    this.players = new Map(); // id → { id, pub, capital, stamina, at, tiles }
    this.position = { height: 0, index: -1 };
    this.claims = 0;
  }

  /**
   * Apply one finalized authenticated-map command:
   * { height, index, messageId, timestamp, stateRoot, bodyHex }.
   * `receipt(messageId)` resolves the ledger's receipt record ({ status }) for
   * shapes the fold does not mirror itself. Returns the outcomes for this
   * message's tiles: [{ c, r, kind: 'claimed' | 'scorched' | 'lost', ... }].
   */
  async apply(entry, { receipt }) {
    const { height, index } = entry;
    if (height < this.position.height || (height === this.position.height && index <= this.position.index)) {
      return { skipped: true };
    }
    const outcomes = [];
    if (!this.seed && entry.timestamp >= this.start && entry.timestamp < this.end) {
      this.seed = seasonSeed(this.cfg, this.season, entry.stateRoot);
      this.seededBy = { height, messageId: entry.messageId, timestamp: entry.timestamp };
      this.map = generateMap(this.cfg, this.seed);
      outcomes.push({ kind: 'opened' });
    }
    const cmd = decodeCommand(entry.bodyHex);
    if (cmd) {
      const profilePrefix = `${this.accounts.app}/commander/`;
      const prefix = this.seed ? tilePrefix(this.cfg, this.season, this.seed) : null;
      const ours = (m) => m.collection === this.accounts.profilesCollection
        && (m.key.startsWith(profilePrefix) || (prefix && m.key.startsWith(prefix)));
      const relevant = cmd.mutations.filter(ours);
      if (relevant.length) {
        let created;
        if (plainClaim(cmd, this.accounts.profilesCollection)) {
          const m = cmd.mutations[0];
          created = this.created.has(m.key) ? [] : [m];
          if (!created.length && prefix && m.key.startsWith(prefix)) outcomes.push(this.#lost(m, entry));
        } else {
          // Not a shape we mirror: the ledger's receipt says whether it applied.
          const record = await receipt(entry.messageId);
          created = record?.status === 0
            ? cmd.mutations.filter((m) => (m.op === OP_PUT || m.op === OP_PUT_IF_ABSENT) && !this.created.has(m.key))
            : [];
        }
        for (const m of created) {
          this.created.add(m.key);
          if (m.key.startsWith(profilePrefix)) {
            const id = m.key.slice(profilePrefix.length);
            if (!this.profiles.has(id)) this.profiles.set(id, { bytes: m.value });
          } else if (ours(m)) {
            const outcome = await this.#claim(m, entry, prefix);
            if (outcome) outcomes.push(outcome);
          }
        }
      }
    }
    this.position = { height, index };
    return { outcomes };
  }

  #lost(m, entry) {
    const [c, r] = m.key.slice(m.key.lastIndexOf('/') + 1).split(',').map(Number);
    let id = null;
    try { id = JSON.parse(new TextDecoder().decode(m.value)).id; } catch { /* unreadable */ }
    return { kind: 'lost', c, r, id, holder: this.tiles.get(`${c},${r}`), messageId: entry.messageId };
  }

  async #claim(m, entry, prefix) {
    const coords = m.key.slice(prefix.length);
    const match = /^(\d+),(\d+)$/.exec(coords);
    if (!match) return null; // not a tile key: holds nothing on the map
    const c = Number(match[1]);
    const r = Number(match[2]);
    if (c >= this.cfg.cols || r >= this.cfg.rows || `${c},${r}` !== coords) return null;
    const tile = { height: entry.height, index: entry.index, messageId: entry.messageId, timestamp: entry.timestamp,
      value: m.value, key: m.key };
    this.tiles.set(coords, tile);
    this.claims++;
    const scorch = (reason) => {
      tile.scorched = true;
      tile.reason = reason;
      return { kind: 'scorched', c, r, reason, tile };
    };

    if (entry.timestamp >= this.end) return scorch('claimed after the season ended');
    let claim;
    try {
      claim = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(m.value));
    } catch {
      return scorch('the claim is not readable');
    }
    if (claim?.v !== 1 || typeof claim.id !== 'string' || !CALLSIGN.test(claim.id) || typeof claim.pub !== 'string'
        || !HEX64.test(claim.pub) || typeof claim.sig !== 'string' || !HEX128.test(claim.sig)) {
      return scorch('the claim is malformed');
    }
    const profile = await this.#profile(claim.id);
    if (!profile) return scorch(`${claim.id} had no profile before this claim`);
    if (profile.pub !== claim.pub) return scorch(`the key is not ${claim.id}’s`);
    const statement = claimStatement(this.cfg, this.season, this.seed, c, r, claim.id);
    if (!(await ed25519Verify(fromHex(claim.pub), fromHex(claim.sig), utf8(statement)))) {
      return scorch('the signature does not verify');
    }

    const st = this.cfg.stamina;
    let player = this.players.get(claim.id);
    if (player) {
      const touches = neighbors(this.cfg, c, r).some(([x, y]) => this.tiles.get(`${x},${y}`)?.owner === claim.id);
      if (!touches) return scorch(`${claim.id}’s claim does not touch their land`);
      const gained = Math.floor((entry.timestamp - player.at) / st.regenMs);
      player.stamina = Math.min(st.max, player.stamina + gained);
      player.at = player.stamina === st.max ? entry.timestamp : player.at + gained * st.regenMs;
      if (player.stamina < 1) return scorch(`${claim.id} was out of stamina`);
    } else {
      player = { id: claim.id, pub: claim.pub, capital: coords, stamina: st.start, at: entry.timestamp, tiles: 0 };
      this.players.set(claim.id, player);
    }
    player.stamina--;
    player.tiles++;
    tile.owner = claim.id;
    return { kind: 'claimed', c, r, id: claim.id, capital: player.capital === coords, tile };
  }

  async #profile(id) {
    const p = this.profiles.get(id);
    if (!p) return null;
    if (p.profile === undefined) p.profile = await readProfile(this.accounts, id, p.bytes);
    return p.profile;
  }

  /** Stamina a commander would have at time t (for the HUD). */
  staminaAt(id, t) {
    const st = this.cfg.stamina;
    const p = this.players.get(id);
    if (!p) return st.start;
    return Math.min(st.max, p.stamina + Math.max(0, Math.floor((t - p.at) / st.regenMs)));
  }

  /** Free tiles this commander may claim now: anywhere for a first claim, else touching their land. */
  claimable(id, c, r) {
    if (!this.seed || this.tiles.has(`${c},${r}`)) return false;
    const p = this.players.get(id);
    if (!p) return true;
    return neighbors(this.cfg, c, r).some(([x, y]) => this.tiles.get(`${x},${y}`)?.owner === id);
  }

  /** Commanders ranked by score: land value plus the bonus for their largest connected realm. */
  standings() {
    const rows = [];
    for (const player of this.players.values()) {
      const mine = [...this.tiles.entries()].filter(([, t]) => t.owner === player.id).map(([k]) => k);
      const own = new Set(mine);
      let value = 0;
      for (const k of mine) {
        const [c, r] = k.split(',').map(Number);
        value += this.cfg.terrain[this.map[r * this.cfg.cols + c].terrain].value;
      }
      let realm = 0;
      const seen = new Set();
      for (const k of mine) {
        if (seen.has(k)) continue;
        let size = 0;
        const stack = [k];
        seen.add(k);
        while (stack.length) {
          const [c, r] = stack.pop().split(',').map(Number);
          size++;
          for (const [x, y] of neighbors(this.cfg, c, r)) {
            const n = `${x},${y}`;
            if (own.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
          }
        }
        realm = Math.max(realm, size);
      }
      rows.push({ id: player.id, tiles: mine.length, value, realm, score: value + this.cfg.realmBonus * realm });
    }
    return rows.sort((a, b) => b.score - a.score || b.tiles - a.tiles || a.id.localeCompare(b.id));
  }
}

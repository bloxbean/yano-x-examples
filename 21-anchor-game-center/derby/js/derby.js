// Comet Derby: bet on a race whose outcome nobody can know when betting closes.
//
// Every 75 s a race slot opens; for its first 45 s commanders bet credits on
// one of six comets. The race's seed is BLAKE2b of the state root of the first
// block on the hour's topic that is certified *after* betting closed (the
// "beacon"). That root does not exist while bets are still being placed, so no
// player can know the result when betting — and every browser agrees on it
// once the block is final. Every browser then runs the same integer race
// simulation and pays out the same pari-mutuel pool. There is no house and no
// server: balances are whatever folding the hour's finalized messages says.
//
// One topic per hour (CONFIG.hourMs), so balances reset hourly:
//   bet  {"t":"bet","id","pub","n","race","comet","stake","sig"}
//   go   {"t":"go"}                     anyone; just a message after the close
//
// Commanders are checked against their profile on the authenticated-map chain
// (shared/profiles.js), as in the other games.

import { blake2b } from '../../shared/blake2b.js';
import { ed25519Verify, fromHex, toHex, utf8 } from '../../shared/crypto.js';
import { rng } from '../../shared/rng.js';

const CALLSIGN = /^[a-z0-9][a-z0-9_-]{2,19}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export const hourOf = (cfg, ts) => Math.floor(ts / cfg.hourMs);
export const hourTopic = (cfg, hour) => `${cfg.app.replace('/', '.')}.h${hour}`;
export const raceOf = (cfg, ts) => Math.floor(ts / cfg.raceMs);
export const raceStart = (cfg, race) => race * cfg.raceMs;
export const raceClose = (cfg, race) => race * cfg.raceMs + cfg.betMs;
export const betStatement = (cfg, hour, id, n, race, comet, stake) =>
  [cfg.app, cfg.movesChain, hour, 'bet', id, n, race, comet, stake].join('|');
/** The race's seed: 16 bytes from the beacon block's state root. */
export const raceSeed = (cfg, race, stateRoot) => blake2b(utf8(`${cfg.app}|race|${race}|${stateRoot}`), 16);

// ------------------------------------------------------------------ the race

export const LAP = 1_000_000; // track units per lap
export const LAPS = 3;
export const FINISH = LAP * LAPS;
export const TICKS_PER_SECOND = 60;
export const MAX_TICKS = 2400;
export const PADS = [180_000, 520_000, 810_000]; // boost pads, per lap
export const WELLS = [330_000, 700_000]; // gravity wells: slingshot or snare

const crossed = (before, after, mark) => {
  const lapBefore = Math.floor(before / LAP);
  const lapAfter = Math.floor(after / LAP);
  for (let lap = lapBefore; lap <= lapAfter; lap++) {
    const at = lap * LAP + mark;
    if (before < at && after >= at) return true;
  }
  return false;
};

/**
 * One race, tick by tick, in integers. The same seed gives the same race in
 * every browser; drawing reads the state but never feeds back into it.
 * Events: { tick, comet, kind: 'boost' | 'sling' | 'snare' | 'flare' | 'finish' }.
 */
export class Race {
  constructor(seed, count = 6) {
    this.r = rng(seed);
    this.tick = 0;
    this.comets = Array.from({ length: count }, (_, i) => ({
      i, pos: 0, vel: 0, base: 2250 + this.r.int(160), boost: 0, stun: 0, finished: null,
    }));
    this.order = [];
    this.events = [];
  }

  get done() { return this.order.length === this.comets.length || this.tick >= MAX_TICKS; }

  step() {
    if (this.done) return;
    this.tick++;
    const ranked = [...this.comets].sort((a, b) => b.pos - a.pos || a.i - b.i);
    if (this.tick % 120 === 0) { // a solar flare stuns one comet, more likely near the front
      const pick = ranked[Math.min(this.r.int(6), this.r.int(6))];
      if (!pick.finished && this.r.int(100) < 65) { pick.stun = 40; this.events.push({ tick: this.tick, comet: pick.i, kind: 'flare' }); }
    }
    const finishing = [];
    for (const c of this.comets) {
      if (c.finished) continue;
      const ahead = ranked.find((o) => o !== c && o.pos > c.pos && o.pos - c.pos < 24_000);
      let target = c.base + (ahead ? 140 : 0);
      if (c.boost > 0) { target += 950; c.boost--; }
      if (c.stun > 0) { target -= 1150; c.stun--; }
      c.vel += Math.trunc((target - c.vel) / 16);
      const before = c.pos;
      c.pos += c.vel;
      for (const pad of PADS) {
        if (crossed(before, c.pos, pad) && this.r.int(100) < 55) {
          c.boost = 50; this.events.push({ tick: this.tick, comet: c.i, kind: 'boost' });
        }
      }
      for (const well of WELLS) {
        if (crossed(before, c.pos, well)) {
          if (this.r.int(100) < 50) { c.boost = 30; this.events.push({ tick: this.tick, comet: c.i, kind: 'sling' }); }
          else { c.stun = 25; this.events.push({ tick: this.tick, comet: c.i, kind: 'snare' }); }
        }
      }
      if (c.pos >= FINISH) finishing.push(c);
    }
    finishing.sort((a, b) => b.pos - a.pos || a.i - b.i);
    for (const c of finishing) {
      c.finished = this.tick;
      this.order.push(c.i);
      this.events.push({ tick: this.tick, comet: c.i, kind: 'finish' });
    }
    if (this.done && this.order.length < this.comets.length) {
      for (const c of [...this.comets].filter((x) => !x.finished).sort((a, b) => b.pos - a.pos || a.i - b.i)) {
        this.order.push(c.i);
      }
    }
  }

  /** Advance to `tick` (never backwards). */
  runTo(tick) { while (this.tick < tick && !this.done) this.step(); return this; }
}

/** The finishing order of a whole race: [winner, second, …]. */
export function runRace(seed, count = 6) {
  const race = new Race(seed, count);
  while (!race.done) race.step();
  return { order: race.order, ticks: race.tick, events: race.events };
}

// ------------------------------------------------------------------ the hour

const reject = (reason) => ({ accepted: false, reason });

/** Bets, beacons, races and balances for one hour, folded from its topic in log order. */
export class Derby {
  constructor(cfg, hour) {
    this.cfg = cfg;
    this.hour = hour;
    this.start = hour * cfg.hourMs;
    this.end = this.start + cfg.hourMs;
    this.balances = new Map(); // id → credits
    this.keys = new Map(); // id → pub
    this.nonces = new Map();
    this.races = new Map(); // race → { race, bets, pool, byComet, beacon, result }
    this.position = { height: 0, index: -1 };
  }

  race(r) {
    if (!this.races.has(r)) {
      this.races.set(r, { race: r, bets: [], pool: 0, byComet: this.cfg.comets.map(() => 0), beacon: null, result: null });
    }
    return this.races.get(r);
  }

  balance(id) { return this.balances.get(id) ?? this.cfg.grant; }

  /**
   * Apply one finalized message: { height, index, messageId, timestamp, stateRoot, bodyHex }.
   * `profiles(id, pub, ts)` answers { ok } / { ok: false, reason }, or throws to
   * say "ask again later" — the same entry must then be retried.
   * Returns { accepted, kind?, reason?, settled: [race records settled by this block] }.
   */
  async apply(entry, profiles) {
    const { height, index } = entry;
    if (height < this.position.height || (height === this.position.height && index <= this.position.index)) {
      return { skipped: true };
    }
    const settled = this.#settle(entry);
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromHex(entry.bodyHex))); } catch { body = null; }
    let result;
    if (entry.timestamp < this.start || entry.timestamp >= this.end) result = reject('outside this hour');
    else if (body?.t === 'go') result = { accepted: true, kind: 'go' };
    else if (body?.t === 'bet') result = await this.#bet(entry, body, profiles); // may throw: retry
    else result = reject('not a move');
    this.position = { height, index };
    return { ...result, settled };
  }

  /** The first message certified after a race's close is that race's beacon. */
  #settle(entry) {
    const settled = [];
    for (const rec of [...this.races.values()].sort((a, b) => a.race - b.race)) {
      if (rec.beacon || !rec.bets.length || entry.timestamp < raceClose(this.cfg, rec.race)) continue;
      const seed = raceSeed(this.cfg, rec.race, entry.stateRoot);
      rec.beacon = { height: entry.height, index: entry.index, messageId: entry.messageId, timestamp: entry.timestamp,
        stateRoot: entry.stateRoot, seed: toHex(seed) };
      const { order, ticks } = runRace(seed, this.cfg.comets.length);
      rec.result = { ...this.#payout(rec, order), ticks };
      settled.push(rec);
    }
    return settled;
  }

  #payout(rec, order) {
    const winner = order[0];
    const backing = rec.byComet[winner];
    const payouts = new Map();
    for (const bet of rec.bets) {
      let won = 0;
      if (!backing) won = bet.stake; // nobody backed the winner: every stake comes back
      else if (bet.comet === winner) won = Math.floor((bet.stake * rec.pool) / backing);
      if (won) {
        payouts.set(bet.id, (payouts.get(bet.id) ?? 0) + won);
        this.balances.set(bet.id, this.balance(bet.id) + won);
      }
    }
    return { order, winner, refunded: !backing, payouts };
  }

  async #bet(entry, b, profiles) {
    const { cfg } = this;
    if (typeof b.id !== 'string' || !CALLSIGN.test(b.id) || typeof b.pub !== 'string' || !HEX64.test(b.pub)
        || !Number.isSafeInteger(b.n) || b.n < 1 || !Number.isSafeInteger(b.race) || !Number.isSafeInteger(b.comet)
        || !Number.isSafeInteger(b.stake) || typeof b.sig !== 'string' || !HEX128.test(b.sig)) {
      return reject('malformed bet');
    }
    if (b.comet < 0 || b.comet >= cfg.comets.length) return reject('no such comet');
    if (b.stake < cfg.minStake || b.stake > cfg.maxStake) return reject(`stakes are ${cfg.minStake}–${cfg.maxStake}`);
    if (b.race !== raceOf(cfg, entry.timestamp)) return reject('final in another race slot');
    if (entry.timestamp >= raceClose(cfg, b.race)) return reject('betting had closed when this was final');
    const statement = betStatement(cfg, this.hour, b.id, b.n, b.race, b.comet, b.stake);
    if (!(await ed25519Verify(fromHex(b.pub), fromHex(b.sig), utf8(statement)))) return reject('signature does not verify');
    if (b.n <= (this.nonces.get(b.id) ?? 0)) return reject('stale nonce (replayed)');
    if (this.keys.has(b.id) && this.keys.get(b.id) !== b.pub) return reject('not this commander’s key');
    if (!this.keys.has(b.id)) {
      const check = await profiles(b.id, b.pub, entry.timestamp); // may throw: retry later
      if (!check.ok) return reject(check.reason);
    }
    if (b.stake > this.balance(b.id)) return reject('not enough credits');
    this.keys.set(b.id, b.pub);
    this.nonces.set(b.id, b.n);
    this.balances.set(b.id, this.balance(b.id) - b.stake);
    const rec = this.race(b.race);
    const bet = { id: b.id, comet: b.comet, stake: b.stake, height: entry.height, index: entry.index,
      messageId: entry.messageId, timestamp: entry.timestamp };
    rec.bets.push(bet);
    rec.pool += b.stake;
    rec.byComet[b.comet] += b.stake;
    return { accepted: true, kind: 'bet', bet };
  }

  /**
   * After the hour: races that never got a beacon (no message after their
   * close before the hour ended) are void, and their stakes come back.
   */
  closeHour() {
    const voided = [];
    for (const rec of this.races.values()) {
      if (rec.beacon || rec.result || !rec.bets.length) continue;
      for (const bet of rec.bets) this.balances.set(bet.id, this.balance(bet.id) + bet.stake);
      rec.result = { order: [], winner: null, refunded: true, void: true, payouts: new Map() };
      voided.push(rec);
    }
    return voided;
  }

  /** Commanders by credits, richest first. */
  leaderboard() {
    return [...this.balances.entries()].map(([id, credits]) => ({ id, credits }))
      .sort((a, b) => b.credits - a.credits || (a.id < b.id ? -1 : 1));
  }

  /** Pari-mutuel odds per comet: what 1 credit would return if it won now. */
  odds(r) {
    const rec = this.races.get(r);
    if (!rec?.pool) return this.cfg.comets.map(() => null);
    return rec.byComet.map((s) => (s ? rec.pool / s : null));
  }
}

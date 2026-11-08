// Runs on the ledger, the live splits of riders still racing, and the
// leaderboard every browser recomputes.
//
// Time is cut into seasons (CONFIG.seasonMs), each with its own topic and its
// own city circuit:
//
//   open   {"t":"open"}                                       anyone; seeds the circuit
//   split  {"t":"split","id","pub","n","run","cp","frame"[,"race"]}   live: checkpoint cp reached at frame
//   run    {"t":"run","id","pub","n","seed","inputs","frames"[,"race"]}  a finished run
//   lobby  {"t":"lobby","id","pub","n","wait","max","alone"}   open a race lobby; its message id is the race
//   join   {"t":"join","id","pub","n","race"}                  take a place on that race's grid
//   leave  {"t":"leave","id","pub","n","race"}                 give it up (the host leaving cancels the race)
//   start  {"t":"start","id","pub","n","race"}                 the host closes the lobby now
//
// Each season's topic is games/neon-rush/s<season>, under the game's protected
// registry entry; every message is signed by a rider's session key.
//
// The circuit comes from BLAKE2b of the state root of the block that finalized
// the season's first message, so nobody can practise it before it exists.
//
// A run carries the rider's inputs (run-length encoded) and the finishing
// frame they saw, signed by their session key for this game. Every browser replays the
// inputs on the season's circuit; the run counts only if the replay crosses
// the line at exactly that frame. The leaderboard is what the replays say.
//
// Splits are posted while riding, one per checkpoint, so other browsers can
// show the rider live on the circuit about a second later. They are signed too,
// but only advisory: a run's own replay decides its splits.
//
// Race lobbies. A lobby closes `wait` ms of ledger time after the block that
// opened it (or when its host starts it); joins finalized in a block stamped
// before that take a place on the grid, later ones are refused. The race starts
// CONFIG.race.leadMs after the close, the same moment for every browser,
// because both come from block timestamps. A rider in the race submits an
// ordinary run tagged with the race: it counts for the season like any other,
// and for the race if it was finalized in the window its own time allows after
// the start (no jump start, no late start). Riders are placed by ridden time —
// they all started together — and anyone on the grid without a counted ride
// when the race ends did not finish. See lobbyPhase() and raceStandings().

import { blake2b } from '../../shared/blake2b.js';
import { fromHex, toHex, utf8 } from '../../shared/crypto.js';
import { authentic, moveBody, signatureShape } from '../../shared/moves.js';
import { decodeInputs } from '../../arcade/js/runs.js';
import { CHECKPOINTS, FPS, LAPS, MAX_FRAMES, Track, replay } from './sim.js';

const CALLSIGN = /^[a-z0-9][a-z0-9_-]{2,19}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_INPUT_HEX = 32_768;

export const seasonOf = (cfg, ts) => Math.floor(ts / cfg.seasonMs);
export const seasonTopic = (cfg, season) => `${cfg.scope}s${season}`;
export const circuitSeed = (cfg, season, stateRoot) => toHex(blake2b(utf8(`${cfg.app}|circuit|${season}|${stateRoot}`), 16));
export const inputsHash = (encoded) => toHex(blake2b(encoded, 32));
export const runStatement = (cfg, season, seed, id, n, hash, frames, race) =>
  [cfg.app, cfg.movesChain, season, seed, 'run', id, n, hash, frames, ...(race ? [race] : [])].join('|');
export const splitStatement = (cfg, season, id, n, run, cp, frame) =>
  [cfg.app, cfg.movesChain, season, 'split', id, n, run, cp, frame].join('|');

export const lobbyStatement = (cfg, season, b) =>
  [cfg.app, cfg.movesChain, season, b.t, b.id, b.n, ...(b.t === 'lobby' ? [b.wait, b.max, b.alone] : [b.race])].join('|');

/** The longest a ride can take; a race ends this long (plus the grace) after its start. */
export const RIDE_MS = (MAX_FRAMES * 1000) / FPS;

const reject = (reason) => ({ accepted: false, reason });
const ACTIVE = new Set(['open', 'countdown', 'racing']);

/**
 * Where a lobby is at ledger time t: { state, closesAt, startAt, endsAt, extended, reason }.
 * state: open → countdown (closed, grid final) → racing → finished, or cancelled.
 * A pure function of the lobby's finalized history, so every browser agrees.
 */
export function lobbyPhase(cfg, lobby, t) {
  const { leadMs, graceMs } = cfg.race;
  const at = (closesAt, extended) => {
    const startAt = closesAt + leadMs;
    const endsAt = startAt + RIDE_MS + graceMs;
    const state = t < closesAt ? 'open' : t < startAt ? 'countdown' : t < endsAt ? 'racing' : 'finished';
    return { state, closesAt, startAt, endsAt, extended };
  };
  const cancelled = (when, reason) => ({ state: 'cancelled', reason, closesAt: when, startAt: null, endsAt: when, extended: false });
  if (lobby.cancelled && lobby.cancelled.at <= t) return cancelled(lobby.cancelled.at, lobby.cancelled.reason);
  if (lobby.startedAt !== null) return at(lobby.startedAt, false);
  const first = lobby.createdAt + lobby.wait;
  const riders = (before) => lobby.members.filter((m) => m.at < before).length;
  if (t < first || riders(first) >= 2 || lobby.alone === 'ride') return at(first, false);
  if (lobby.alone === 'cancel') return cancelled(first, 'nobody joined');
  const second = first + lobby.wait; // 'wait': once more, then give up
  if (t < second || riders(second) >= 2) return at(second, true);
  return cancelled(second, 'nobody joined');
}

/**
 * The race's grid at ledger time t, in finishing order: riders with a counted
 * ride by ridden time (ties: the earlier message), then the rest — still
 * racing, or DNF once the race has ended.
 * [{ id, place, status: 'finished' | 'racing' | 'waiting' | 'dnf', run }]
 */
export function raceStandings(cfg, lobby, t) {
  const phase = lobbyPhase(cfg, lobby, t);
  const done = lobby.members.map((m) => ({ id: m.id, run: lobby.results.get(m.id) ?? null }))
    .filter((r) => r.run)
    .sort((a, b) => a.run.frames - b.run.frames || a.run.height - b.run.height || a.run.index - b.run.index)
    .map((r, i) => ({ ...r, place: i + 1, status: 'finished' }));
  const rest = lobby.members.filter((m) => !lobby.results.has(m.id)).map((m) => ({
    id: m.id, run: null, place: null,
    status: phase.state === 'finished' || phase.state === 'cancelled' ? 'dnf' : phase.state === 'racing' ? 'racing' : 'waiting',
  }));
  return [...done, ...rest];
}

export class Circuit {
  constructor(cfg, season) {
    this.cfg = cfg;
    this.season = season;
    this.start = season * cfg.seasonMs;
    this.end = this.start + cfg.seasonMs;
    this.seed = null; // hex, once the season's first message is final
    this.track = null;
    this.seededBy = null;
    this.runs = [];
    this.best = new Map(); // id → fastest verified run
    this.live = new Map(); // id → { run, cp, frame, timestamp, height } of a ride in progress
    this.keys = new Map(); // id → pub, once a run verified
    this.nonces = new Map();
    this.splitNonces = new Map();
    this.lobbies = new Map(); // race id (the lobby message's id) → lobby
    this.lobbyNonces = new Map();
    this.position = { height: 0, index: -1 };
  }

  /**
   * Apply one finalized message: { height, index, messageId, timestamp, stateRoot, body, author } (shared/moves.js).
   * `profiles(id, pub, ts)` answers { ok } / { ok: false, reason }, or throws to retry.
   */
  async apply(entry, profiles) {
    const { height, index } = entry;
    if (height < this.position.height || (height === this.position.height && index <= this.position.index)) {
      return { skipped: true };
    }
    const body = moveBody(this.cfg, entry);
    let result;
    if (entry.timestamp < this.start || entry.timestamp >= this.end) {
      result = reject('outside this season');
    } else {
      let opened = false;
      if (!this.seed) {
        this.seed = circuitSeed(this.cfg, this.season, entry.stateRoot);
        this.track = new Track(fromHex(this.seed));
        this.seededBy = { height, messageId: entry.messageId, timestamp: entry.timestamp, stateRoot: entry.stateRoot };
        opened = true;
      }
      if (body?.t === 'open') result = { accepted: true, kind: 'open', opened };
      else if (body?.t === 'split') result = { ...(await this.#split(entry, body)), opened };
      else if (body?.t === 'run') result = { ...(await this.#run(entry, body, profiles)), opened };
      else if (['lobby', 'join', 'leave', 'start'].includes(body?.t)) result = { ...(await this.#lobby(entry, body, profiles)), opened };
      else result = { ...reject('not a move'), opened };
    }
    this.position = { height, index };
    return result;
  }

  async #split(entry, b) {
    if (typeof b.id !== 'string' || !CALLSIGN.test(b.id) || typeof b.pub !== 'string' || !HEX64.test(b.pub)
        || !Number.isSafeInteger(b.n) || !Number.isSafeInteger(b.run) || !Number.isSafeInteger(b.cp)
        || !Number.isSafeInteger(b.frame) || b.cp < 0 || b.cp > LAPS * CHECKPOINTS || b.frame < 0 || b.frame > MAX_FRAMES
        || (b.race !== undefined && (typeof b.race !== 'string' || !HEX64.test(b.race))) || !signatureShape(this.cfg, b)) {
      return reject('malformed split');
    }
    if (this.keys.has(b.id) && this.keys.get(b.id) !== b.pub) return reject('not this rider’s key');
    if (b.n <= (this.splitNonces.get(b.id) ?? 0)) return reject('stale split');
    const ok = await authentic(this.cfg, entry, b, b.pub, splitStatement(this.cfg, this.season, b.id, b.n, b.run, b.cp, b.frame));
    if (!ok) return reject('split signature does not verify');
    this.splitNonces.set(b.id, b.n);
    this.live.set(b.id, { id: b.id, run: b.run, cp: b.cp, frame: b.frame, race: b.race ?? null, timestamp: entry.timestamp, height: entry.height });
    return { accepted: true, kind: 'split', id: b.id, cp: b.cp, frame: b.frame };
  }

  async #run(entry, b, profiles) {
    if (typeof b.id !== 'string' || !CALLSIGN.test(b.id) || typeof b.pub !== 'string' || !HEX64.test(b.pub)
        || !Number.isSafeInteger(b.n) || b.n < 1 || !Number.isSafeInteger(b.frames) || b.frames < 1 || b.frames > MAX_FRAMES
        || typeof b.seed !== 'string' || !HEX32.test(b.seed) || !signatureShape(this.cfg, b)
        || typeof b.inputs !== 'string' || b.inputs.length > MAX_INPUT_HEX
        || (b.race !== undefined && (typeof b.race !== 'string' || !HEX64.test(b.race)))) {
      return reject('malformed run');
    }
    if (b.seed !== this.seed) return reject('ridden on another circuit');
    let encoded;
    let frames;
    try {
      encoded = fromHex(b.inputs);
      frames = decodeInputs(encoded, b.frames);
    } catch (error) {
      return reject(`bad inputs: ${error.message}`);
    }
    const statement = runStatement(this.cfg, this.season, b.seed, b.id, b.n, inputsHash(encoded), b.frames, b.race);
    if (!(await authentic(this.cfg, entry, b, b.pub, statement))) return reject('run signature does not verify');
    if (b.n <= (this.nonces.get(b.id) ?? 0)) return reject('stale nonce (replayed)');
    const check = await profiles(b.id, b.pub, entry.timestamp); // may throw: retry later
    if (!check.ok) return reject(check.reason);
    this.nonces.set(b.id, b.n);
    const replayed = replay(this.track, frames);
    if (replayed.finished !== b.frames) {
      return reject(replayed.finished === null
        ? 'the inputs never reach the finish line'
        : `the time does not replay: claimed frame ${b.frames}, replay finishes at ${replayed.finished}`);
    }
    this.keys.set(b.id, b.pub);
    if (this.live.get(b.id)) this.live.delete(b.id);
    const run = { id: b.id, pub: b.pub, frames: b.frames, crashes: replayed.crashes, splits: replayed.splits, inputs: frames,
      messageId: entry.messageId, height: entry.height, index: entry.index, timestamp: entry.timestamp };
    this.runs.push(run);
    const best = this.best.get(b.id);
    const personalBest = !best || run.frames < best.frames;
    if (personalBest) this.best.set(b.id, run);
    const race = b.race === undefined ? null : this.#raceRide(entry, b, run);
    return { accepted: true, kind: 'run', run, personalBest, race };
  }

  /** A verified run tagged with a race: does it count for that race? It counts for the season either way. */
  #raceRide(entry, b, run) {
    const no = (reason) => ({ id: b.race, counted: false, reason });
    const lobby = this.lobbies.get(b.race);
    if (!lobby) return no('no such race this season');
    const phase = lobbyPhase(this.cfg, lobby, entry.timestamp);
    if (phase.state === 'cancelled') return no(`the race was cancelled: ${phase.reason}`);
    if (!lobby.members.some((m) => m.id === b.id)) return no('not on this race’s grid');
    if (lobby.results.has(b.id)) return no('already raced');
    const crossed = phase.startAt + (b.frames * 1000) / FPS; // ledger time the line is crossed, from the start
    const { earlyMs, graceMs } = this.cfg.race;
    if (entry.timestamp < crossed - earlyMs) return no('finalized before the race could have finished it: a jump start');
    if (entry.timestamp > crossed + graceMs) return no('finalized too long after the start plus its own time: the start was missed');
    lobby.results.set(b.id, run);
    run.race = b.race;
    return { id: b.race, counted: true };
  }

  /** Lobby events: create, join, leave, start. */
  async #lobby(entry, b, profiles) {
    const race = this.cfg.race;
    const ts = entry.timestamp;
    if (typeof b.id !== 'string' || !CALLSIGN.test(b.id) || typeof b.pub !== 'string' || !HEX64.test(b.pub)
        || !Number.isSafeInteger(b.n) || b.n < 1 || !signatureShape(this.cfg, b)
        || (b.t === 'lobby'
          ? !race.waits.includes(b.wait) || !Number.isSafeInteger(b.max) || b.max < 2 || b.max > race.maxRiders
            || !race.alone.includes(b.alone)
          : typeof b.race !== 'string' || !HEX64.test(b.race))) {
      return reject(`malformed ${b.t}`);
    }
    if (this.keys.has(b.id) && this.keys.get(b.id) !== b.pub) return reject('not this rider’s key');
    if (b.n <= (this.lobbyNonces.get(b.id) ?? 0)) return reject('stale nonce (replayed)');
    if (!(await authentic(this.cfg, entry, b, b.pub, lobbyStatement(this.cfg, this.season, b)))) {
      return reject(`${b.t} signature does not verify`);
    }
    const lobby = b.t === 'lobby' ? null : this.lobbies.get(b.race);
    if (b.t !== 'lobby' && !lobby) return reject('no such race this season');
    const phase = lobby && lobbyPhase(this.cfg, lobby, ts);
    const busy = () => [...this.lobbies.values()].find((l) => l !== lobby && l.members.some((m) => m.id === b.id)
      && !l.results.has(b.id) && ACTIVE.has(lobbyPhase(this.cfg, l, ts).state));
    const verdict = (() => {
      if (b.t === 'lobby') {
        const active = [...this.lobbies.values()].filter((l) => ACTIVE.has(lobbyPhase(this.cfg, l, ts).state));
        if (active.length >= race.maxOpen) return 'too many races under way this season';
        const longest = ts + b.wait * (b.alone === 'wait' ? 2 : 1) + race.leadMs + RIDE_MS + race.graceMs;
        if (longest > this.end) return 'too close to the season change: the race would not end in this season';
      } else if (b.t === 'join') {
        if (phase.state !== 'open') return phase.state === 'cancelled' ? 'the race was cancelled' : 'the lobby has closed';
        if (lobby.members.some((m) => m.id === b.id)) return 'already on this grid';
        if (lobby.members.length >= lobby.max) return 'the grid is full';
      } else if (!lobby.members.some((m) => m.id === b.id)) {
        return 'not on this race’s grid';
      } else if (phase.state !== 'open') {
        return 'the lobby has closed';
      } else if (b.t === 'start' && lobby.host !== b.id) {
        return 'only the host can start the race';
      }
      if ((b.t === 'lobby' || b.t === 'join') && busy()) return `already on the grid of race ${busy().id.slice(0, 8)}`;
      return null;
    })();
    if (verdict) return reject(verdict);
    if (b.t === 'lobby' || b.t === 'join') {
      const check = await profiles(b.id, b.pub, ts); // may throw: retry later
      if (!check.ok) return reject(check.reason);
    }
    this.lobbyNonces.set(b.id, b.n);
    this.keys.set(b.id, b.pub);
    const member = { id: b.id, at: ts, height: entry.height, index: entry.index };
    if (b.t === 'lobby') {
      const created = { id: entry.messageId, host: b.id, createdAt: ts, height: entry.height, wait: b.wait, max: b.max,
        alone: b.alone, members: [member], startedAt: null, cancelled: null, results: new Map() };
      this.lobbies.set(created.id, created);
      return { accepted: true, kind: 'lobby', lobby: created };
    }
    if (b.t === 'join') lobby.members.push(member);
    else if (b.t === 'start') lobby.startedAt = ts;
    else if (lobby.host === b.id) lobby.cancelled = { at: ts, reason: 'its host left' };
    else lobby.members = lobby.members.filter((m) => m.id !== b.id);
    return { accepted: true, kind: b.t, lobby };
  }

  /** Every lobby of the season at ledger time t, newest first: [{ lobby, phase }]. */
  races(t) {
    return [...this.lobbies.values()].map((lobby) => ({ lobby, phase: lobbyPhase(this.cfg, lobby, t) }))
      .sort((a, b) => b.lobby.createdAt - a.lobby.createdAt || b.lobby.height - a.lobby.height);
  }

  /** The race this rider is on the grid of and has not finished, at ledger time t. */
  raceOf(id, t) {
    return this.races(t).find(({ lobby, phase }) => ACTIVE.has(phase.state)
      && lobby.members.some((m) => m.id === id) && !lobby.results.has(id)) ?? null;
  }

  /** Fastest verified run per rider; ties go to the earlier run. */
  leaderboard() {
    return [...this.best.values()].sort((a, b) => a.frames - b.frames || a.height - b.height || a.index - b.index);
  }

  /** Riders whose last split is recent: [{ id, cp, frame, timestamp }]. */
  liveRiders(now, exclude) {
    return [...this.live.values()].filter((r) => r.id !== exclude && now - r.timestamp < this.cfg.liveMs);
  }
}

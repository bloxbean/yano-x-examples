// Runs on the ledger, the live splits of riders still racing, and the
// leaderboard every browser recomputes.
//
// Time is cut into seasons (CONFIG.seasonMs), each with its own topic and its
// own city circuit:
//
//   open   {"t":"open"}                                              anyone; seeds the circuit
//   split  {"t":"split","id","pub","n","run","cp","frame","sig"}      live: checkpoint cp reached at frame
//   run    {"t":"run","id","pub","n","seed","inputs","frames","sig"}  a finished run
//
// The circuit comes from BLAKE2b of the state root of the block that finalized
// the season's first message, so nobody can practise it before it exists.
//
// A run carries the rider's inputs (run-length encoded) and the finishing
// frame they saw, signed by their commander key. Every browser replays the
// inputs on the season's circuit; the run counts only if the replay crosses
// the line at exactly that frame. The leaderboard is what the replays say.
//
// Splits are posted while riding, one per checkpoint, so other browsers can
// show the rider live on the circuit about a second later. They are signed
// but only advisory: a run's own replay decides its splits.

import { blake2b } from '../../shared/blake2b.js';
import { ed25519Verify, fromHex, toHex, utf8 } from '../../shared/crypto.js';
import { decodeInputs } from '../../arcade/js/runs.js';
import { decodeMove } from './topic-session.js';
import { CHECKPOINTS, LAPS, MAX_FRAMES, Track, replay } from './sim.js';

const CALLSIGN = /^[a-z0-9][a-z0-9_-]{2,19}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const MAX_INPUT_HEX = 32_768;

export const seasonOf = (cfg, ts) => Math.floor(ts / cfg.seasonMs);
export const seasonTopic = (cfg, season) => `games/neon-rush/s${season}`;
export const circuitSeed = (cfg, season, stateRoot) => toHex(blake2b(utf8(`${cfg.app}|circuit|${season}|${stateRoot}`), 16));
export const inputsHash = (encoded) => toHex(blake2b(encoded, 32));
export const runStatement = (cfg, season, seed, id, n, hash, frames) =>
  [cfg.app, cfg.movesChain, season, seed, 'run', id, n, hash, frames].join('|');
export const splitStatement = (cfg, season, id, n, run, cp, frame) =>
  [cfg.app, cfg.movesChain, season, 'split', id, n, run, cp, frame].join('|');

const reject = (reason) => ({ accepted: false, reason });

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
    this.position = { height: 0, index: -1 };
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
    const body = await decodeMove(this.cfg, seasonTopic(this.cfg, this.season), entry.bodyHex);
    let result;
    if (!body) {
      result = reject('invalid topic frame');
    } else if (entry.timestamp < this.start || entry.timestamp >= this.end) {
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
      else result = { ...reject('not a move'), opened };
    }
    this.position = { height, index };
    return result;
  }

  async #split(entry, b) {
    if (typeof b.id !== 'string' || !CALLSIGN.test(b.id) || typeof b.pub !== 'string' || !HEX64.test(b.pub)
        || !Number.isSafeInteger(b.n) || !Number.isSafeInteger(b.run) || !Number.isSafeInteger(b.cp)
        || !Number.isSafeInteger(b.frame) || b.cp < 0 || b.cp > LAPS * CHECKPOINTS || b.frame < 0 || b.frame > MAX_FRAMES
        || typeof b.sig !== 'string' || !HEX128.test(b.sig)) {
      return reject('malformed split');
    }
    if (this.keys.has(b.id) && this.keys.get(b.id) !== b.pub) return reject('not this rider’s key');
    if (b.n <= (this.splitNonces.get(b.id) ?? 0)) return reject('stale split');
    const ok = await ed25519Verify(fromHex(b.pub), fromHex(b.sig),
      utf8(splitStatement(this.cfg, this.season, b.id, b.n, b.run, b.cp, b.frame)));
    if (!ok) return reject('split signature does not verify');
    this.splitNonces.set(b.id, b.n);
    this.live.set(b.id, { id: b.id, run: b.run, cp: b.cp, frame: b.frame, timestamp: entry.timestamp, height: entry.height });
    return { accepted: true, kind: 'split', id: b.id, cp: b.cp, frame: b.frame };
  }

  async #run(entry, b, profiles) {
    if (typeof b.id !== 'string' || !CALLSIGN.test(b.id) || typeof b.pub !== 'string' || !HEX64.test(b.pub)
        || !Number.isSafeInteger(b.n) || b.n < 1 || !Number.isSafeInteger(b.frames) || b.frames < 1 || b.frames > MAX_FRAMES
        || typeof b.seed !== 'string' || !HEX32.test(b.seed) || typeof b.sig !== 'string' || !HEX128.test(b.sig)
        || typeof b.inputs !== 'string' || b.inputs.length > MAX_INPUT_HEX) {
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
    const statement = runStatement(this.cfg, this.season, b.seed, b.id, b.n, inputsHash(encoded), b.frames);
    if (!(await ed25519Verify(fromHex(b.pub), fromHex(b.sig), utf8(statement)))) return reject('run signature does not verify');
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
    return { accepted: true, kind: 'run', run, personalBest };
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

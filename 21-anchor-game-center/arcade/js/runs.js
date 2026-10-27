// Runs on the ledger, and the leaderboard every browser recomputes.
//
// Time is cut into fields (CONFIG.fieldMs). Each field has its own topic on
// the moves chain and its own rocks:
//
//   open  {"t":"open"}                                   anyone; seeds the field
//   run   {"t":"run","id","pub","n","seed","inputs","score","sig"}
//
// The field's seed is BLAKE2b of the state root of the block that finalized
// the field's first message. Nobody knows that root before the block exists,
// so nobody can practise a field before it opens — and everyone agrees on it.
//
// A run carries the player's inputs (run-length encoded) and the score they
// saw, signed by their commander key. Every browser replays the inputs on the
// field's seed; the run counts only if the replay reaches exactly the claimed
// score. The leaderboard is therefore whatever the replays say, not whatever
// anyone claims. Commanders are checked against their profile on the
// authenticated-map chain, as in Anchor Galaxy (shared/profiles.js).

import { blake2b } from '../../shared/blake2b.js';
import { ed25519Verify, fromHex, toHex, utf8 } from '../../shared/crypto.js';
import { RUN_FRAMES, replay } from './sim.js';

const CALLSIGN = /^[a-z0-9][a-z0-9_-]{2,19}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const MAX_INPUT_HEX = 32_768;

export const fieldOf = (cfg, ts) => Math.floor(ts / cfg.fieldMs);
export const fieldTopic = (cfg, field) => `${cfg.app.replace('/', '.')}.f${field}`;
export const fieldSeed = (cfg, field, stateRoot) => toHex(blake2b(utf8(`${cfg.app}|field|${field}|${stateRoot}`), 16));
export const inputsHash = (encoded) => toHex(blake2b(encoded, 32));
export const runStatement = (cfg, field, seed, id, n, hash, score) =>
  [cfg.app, cfg.movesChain, field, seed, 'run', id, n, hash, RUN_FRAMES, score].join('|');

/** Run-length encode one byte per frame: (varint count, byte) pairs. */
export function encodeInputs(frames) {
  const out = [];
  for (let i = 0; i < frames.length;) {
    let j = i;
    while (j < frames.length && frames[j] === frames[i]) j++;
    let count = j - i;
    while (count >= 0x80) { out.push((count & 0x7f) | 0x80); count >>>= 7; }
    out.push(count, frames[i]);
    i = j;
  }
  return Uint8Array.from(out);
}

/** Decode exactly `total` frames, or throw. Only the four input bits may be set. */
export function decodeInputs(encoded, total) {
  const frames = new Uint8Array(total);
  let at = 0;
  for (let i = 0; i < encoded.length;) {
    let count = 0;
    for (let shift = 0; ; shift += 7) {
      if (i >= encoded.length || shift > 21) throw new Error('bad run length');
      const b = encoded[i++];
      count |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
    }
    if (i >= encoded.length) throw new Error('truncated inputs');
    const bits = encoded[i++];
    if (count < 1 || bits > 15 || at + count > total) throw new Error('inputs out of range');
    frames.fill(bits, at, at + count);
    at += count;
  }
  if (at !== total) throw new Error(`inputs cover ${at} of ${total} frames`);
  return frames;
}

export class Arcade {
  constructor(cfg, field) {
    this.cfg = cfg;
    this.field = field;
    this.start = field * cfg.fieldMs;
    this.end = this.start + cfg.fieldMs;
    this.seed = null; // hex, once the field's first message is final
    this.seededBy = null;
    this.runs = [];
    this.best = new Map(); // id → best verified run
    this.nonces = new Map();
    this.position = { height: 0, index: -1 };
  }

  /**
   * Apply one finalized message: { height, index, messageId, timestamp, stateRoot, bodyHex }.
   * `profiles(id, pub, timestamp)` answers { ok } or { ok: false, reason }, or
   * throws to say "ask again later" — then nothing changes and the same entry
   * must be retried.
   */
  async apply(entry, profiles) {
    const { height, index } = entry;
    if (height < this.position.height || (height === this.position.height && index <= this.position.index)) {
      return { skipped: true };
    }
    let body;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromHex(entry.bodyHex)));
    } catch {
      body = null;
    }
    let result;
    if (entry.timestamp < this.start || entry.timestamp >= this.end) {
      result = reject('outside this field');
    } else {
      let opened = false;
      if (!this.seed) {
        this.seed = fieldSeed(this.cfg, this.field, entry.stateRoot);
        this.seededBy = { height, messageId: entry.messageId, timestamp: entry.timestamp };
        opened = true;
      }
      if (body?.t === 'open') result = { accepted: true, kind: 'open', opened };
      else if (body?.t === 'run') result = { ...(await this.#run(entry, body, profiles)), opened };
      else result = { ...reject('not a move'), opened };
    }
    this.position = { height, index };
    return result;
  }

  async #run(entry, b, profiles) {
    if (typeof b.id !== 'string' || !CALLSIGN.test(b.id) || typeof b.pub !== 'string' || !HEX64.test(b.pub)
        || !Number.isSafeInteger(b.n) || b.n < 1 || !Number.isSafeInteger(b.score) || b.score < 0
        || typeof b.seed !== 'string' || !HEX32.test(b.seed) || typeof b.sig !== 'string' || !HEX128.test(b.sig)
        || typeof b.inputs !== 'string' || b.inputs.length > MAX_INPUT_HEX) {
      return reject('malformed run');
    }
    if (b.seed !== this.seed) return reject('played on another field');
    let encoded;
    let frames;
    try {
      encoded = fromHex(b.inputs);
      frames = decodeInputs(encoded, RUN_FRAMES);
    } catch (error) {
      return reject(`bad inputs: ${error.message}`);
    }
    const statement = runStatement(this.cfg, this.field, b.seed, b.id, b.n, inputsHash(encoded), b.score);
    if (!(await ed25519Verify(fromHex(b.pub), fromHex(b.sig), utf8(statement)))) {
      return reject('run signature does not verify');
    }
    if (b.n <= (this.nonces.get(b.id) ?? 0)) return reject('stale nonce (replayed)');
    const check = await profiles(b.id, b.pub, entry.timestamp); // may throw: retry later
    if (!check.ok) return reject(check.reason);
    this.nonces.set(b.id, b.n);

    const replayed = replay(fromHex(b.seed), frames);
    if (replayed.score !== b.score) {
      return reject(`score does not replay: claimed ${b.score}, replay gives ${replayed.score}`);
    }
    const run = {
      id: b.id, pub: b.pub, score: b.score, kills: replayed.kills, crashes: replayed.crashes,
      inputs: frames, messageId: entry.messageId, height: entry.height, index: entry.index, timestamp: entry.timestamp,
    };
    this.runs.push(run);
    const best = this.best.get(b.id);
    if (!best || run.score > best.score) this.best.set(b.id, run);
    return { accepted: true, kind: 'run', run, personalBest: !best || run.score > best.score };
  }

  /** Best verified run per commander, highest first; ties go to the earlier run. */
  leaderboard() {
    return [...this.best.values()].sort((a, b) => b.score - a.score || a.height - b.height || a.index - b.index);
  }
}

const reject = (reason) => ({ accepted: false, reason });

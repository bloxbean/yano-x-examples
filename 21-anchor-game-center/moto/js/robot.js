// A robot rider: a second commander kept in this browser that takes a place on a
// race's grid and rides it with the attract mode's autopilot, so one person at one
// screen can race a rival. Nothing about it is special to the ledger or to other
// browsers: it has its own call sign (bot-…), profile and session key, and its
// lobby moves, splits and run are ordinary moves, replayed and verified like anyone's.
//
// The robot rides only while a page that keeps it is open: close the tab before
// its race and it is a DNF like any rider who left.

import { ACCOUNTS } from '../../shared/config.js';
import { CALLSIGN, createCommander, forgetDevice, rememberOnDevice, restoreFromDevice } from '../../shared/accounts.js';
import { randomBytes, toHex } from '../../shared/crypto.js';
import { Moves } from '../../shared/sessions.js';
import { encodeInputs } from '../../arcade/js/runs.js';
import { CHECKPOINTS, FPS, LAPS, Run, THROTTLE, autopilot } from './sim.js';
import { lobbyPhase, seasonTopic } from './races.js';

/** How often it eases off the throttle: easy ≈ 45 s a ride, fair ≈ 39 s, fast ≈ 35 s. */
export const SKILLS = { easy: 0.3, fair: 0.15, fast: 0 };
export const isRobot = (id) => typeof id === 'string' && id.startsWith('bot-');
const STEP_MS = 1000 / FPS;

/** A whole ride decided up front: the autopilot's inputs, eased by skill from a seeded xorshift. */
export function robotRide(track, skill, salt) {
  const ease = SKILLS[skill] ?? SKILLS.fair;
  const run = new Run(track);
  const frames = [];
  let h = (salt >>> 0) || 0x9e3779b9;
  while (!run.over) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
    let bits = autopilot(run);
    if (ease && h / 2 ** 32 < ease) bits &= ~THROTTLE;
    frames.push(bits);
    run.step(bits);
  }
  return { frames: Uint8Array.from(frames), finished: run.finished, splits: run.splits };
}

export class Robot {
  /**
   * cfg: the game's config; ledger, profiles: the page's; topics: games-chain topic settings;
   * relay(): which member relays; now(): ledger time; onEvent(text): tell the page.
   */
  constructor({ cfg, ledger, profiles, topics, relay, now, onEvent = () => {} }) {
    Object.assign(this, { cfg, ledger, profiles, relay, now, onEvent });
    this.moves = new Moves(ledger, cfg, topics);
    this.commander = null;
    this.owner = null;
    this.busy = false; // building the robot's commander
    this.n = 0;
    this.rides = new Map(); // race id → { timers, state }
    this.skill = (() => { try { return localStorage.getItem(`${ACCOUNTS.app}:robot-skill`) ?? 'fair'; } catch { return 'fair'; } })();
  }

  get id() { return this.commander?.id ?? null; }
  #slot(owner) { return `robot:${owner}`; }
  #nonce() { return (this.n = Math.max(Date.now(), this.n + 1)); }

  setSkill(skill) {
    if (!(skill in SKILLS)) return;
    this.skill = skill;
    try { localStorage.setItem(`${ACCOUNTS.app}:robot-skill`, skill); } catch { /* this tab only */ }
  }

  /** Switch to `owner`'s robot (or none): the one remembered here, if this ledger still knows it. */
  async load(owner) {
    if (owner === this.owner) return this.commander;
    this.stop();
    this.owner = owner;
    this.commander = null;
    if (!owner) return null;
    const saved = await restoreFromDevice(ACCOUNTS, this.#slot(owner));
    if (!saved || this.owner !== owner) return null;
    const found = await this.profiles.lookup(saved.id).catch(() => null);
    if (found?.present && found.profile?.pub === saved.pub) this.commander = saved;
    else if (found) await forgetDevice(ACCOUNTS, this.#slot(owner)); // from an earlier chain
    return this.commander;
  }

  /** The owner's robot, building one the first time: a call sign, a profile, a session key. */
  async ensure(owner, relay) {
    if (this.owner !== owner) await this.load(owner);
    if (this.commander) return this.commander;
    if (this.busy) throw new Error('the robot is still being built');
    this.busy = true;
    try {
      let id = `bot-${owner}`.slice(0, 20);
      for (let i = 0; !CALLSIGN.test(id) || (await this.profiles.lookup(id)).present; i++) {
        if (i > 5) throw new Error('could not find a free call sign for the robot');
        id = `bot-${owner.slice(0, 10)}-${toHex(randomBytes(2))}`;
      }
      this.onEvent(`Building your robot rider ${id}: a key, a profile on the ledger, a session key…`);
      // A random password nobody keeps: the robot lives in this browser only.
      const { commander, profileBytes } = await createCommander(ACCOUNTS, id, toHex(randomBytes(16)));
      await this.profiles.register(id, profileBytes, relay);
      for (let i = 0; i < 40 && !(await this.profiles.lookup(id)).present; i++) await new Promise((r) => setTimeout(r, 250));
      await rememberOnDevice(ACCOUNTS, commander, this.#slot(owner));
      if (this.owner === owner) this.commander = commander;
      await this.moves.prepare(commander);
      return commander;
    } finally {
      this.busy = false;
    }
  }

  /** Post one of the robot's moves on the circuit's season topic; resolves to { messageId }. */
  async #move(circuit, fields) {
    const c = this.commander;
    return this.moves.submit(c, this.relay(), seasonTopic(this.cfg, circuit.season),
      { id: c.id, pub: c.pub, n: this.#nonce(), ...fields });
  }

  async join(circuit, race, owner, relay) {
    await this.ensure(owner, relay);
    return this.#move(circuit, { t: 'join', race });
  }

  async leave(circuit, race) {
    return this.#move(circuit, { t: 'leave', race });
  }

  /** The race the robot is on the grid of and has not finished, if any. */
  race(circuit) { return this.id && circuit?.seed ? circuit.raceOf(this.id, this.now()) : null; }

  /** Called every second: when the robot's race closes, plan its ride to the ledger clock. */
  tick(circuit) {
    const mine = this.race(circuit);
    if (!mine || this.rides.has(mine.lobby.id)) return;
    const { lobby, phase } = mine;
    if (phase.state !== 'countdown' && phase.state !== 'racing') return;
    const late = Math.max(0, this.now() - phase.startAt);
    if (late > this.cfg.race.graceMs - 5000) { this.rides.set(lobby.id, { timers: [], state: 'missed' }); return; }
    this.#ride(circuit, lobby, phase.startAt, phase.startAt + late);
  }

  #ride(circuit, lobby, startAt, rideStart) {
    const c = this.commander;
    const rideId = this.#nonce();
    const skill = this.skill;
    const { frames, finished, splits } = robotRide(circuit.track, skill, rideId);
    const ride = { timers: [], state: 'grid', skill, race: lobby.id, track: circuit.track, frames, rideStart, run: null };
    this.rides.set(lobby.id, ride);
    const at = (ledgerTime, fn) => ride.timers.push(setTimeout(fn, Math.max(0, ledgerTime - this.now())));
    const still = () => this.commander === c
      && lobbyPhase(this.cfg, circuit.lobbies.get(lobby.id) ?? lobby, this.now()).state === 'racing';
    at(rideStart, () => { ride.state = 'riding'; });
    // Splits at the moments it passes each checkpoint, so every browser sees it live.
    for (let cp = 1; cp < LAPS * CHECKPOINTS && cp <= splits.length; cp++) {
      const frame = splits[cp - 1];
      at(rideStart + frame * STEP_MS, () => {
        if (still()) this.#move(circuit, { t: 'split', run: rideId, cp, frame, race: lobby.id }).catch(() => {});
      });
    }
    if (finished === null) { at(rideStart + frames.length * STEP_MS, () => { ride.state = 'no finish'; }); return; }
    // The run once it has really crossed the line, retried through a dropped connection
    // until the race's grace for this time runs out.
    at(rideStart + finished * STEP_MS + 200, async () => {
      const until = startAt + finished * STEP_MS + this.cfg.race.graceMs - 2000;
      const move = { t: 'run', seed: circuit.seed, inputs: toHex(encodeInputs(frames)), frames: finished, race: lobby.id };
      for (;;) {
        if (this.commander !== c) return;
        try {
          await this.#move(circuit, move);
          ride.state = 'finished';
          this.onEvent(`${c.id} crossed the line (${skill})`);
          return;
        } catch (error) {
          if (this.now() > until) { ride.state = `not submitted: ${error.message}`; return; }
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    });
  }

  /**
   * The robot's ride as it is at ledger time `now`, frame for frame: { id, race, run } or
   * null. This page decided the ride, so it can show it exactly, not estimated from splits.
   * It stays on the road for two seconds after the line, then leaves it.
   */
  live(now) {
    for (const ride of this.rides.values()) {
      if (!ride.frames || now < ride.rideStart) continue;
      const target = Math.min(ride.frames.length, Math.floor((now - ride.rideStart) / STEP_MS));
      if (!ride.run || target < ride.run.frame) ride.run = new Run(ride.track);
      while (ride.run.frame < target && !ride.run.over) ride.run.step(ride.frames[ride.run.frame]);
      if (ride.run.over && now - (ride.rideStart + ride.run.frame * STEP_MS) > 2000) continue;
      return { id: this.id, race: ride.race, run: ride.run };
    }
    return null;
  }

  /** Cancel every planned move (owner signed out, or the page moved to another circuit). */
  stop() {
    for (const ride of this.rides.values()) ride.timers.forEach(clearTimeout);
    this.rides.clear();
  }
}

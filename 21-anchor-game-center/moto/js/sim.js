// Neon Rush's physics: a motorbike time trial through a night city, in integers.
//
// The circuit (curves, traffic, the city along it) is generated from the
// season's seed. A run is the bike's state stepped once per frame at a fixed
// 60 Hz from one input byte per frame — left, right, throttle, brake — with
// integer arithmetic and a seeded xoshiro128** only, so the same seed and the
// same inputs reach the same finishing frame in every browser. Drawing reads
// this state and never feeds back into it.

import { rng } from '../../shared/rng.js';

export const FPS = 60;
export const LEFT = 1;
export const RIGHT = 2;
export const THROTTLE = 4;
export const BRAKE = 8;

export const SEG = 200; // track units per segment
export const SEGMENTS = 640; // segments per lap
export const LAP = SEG * SEGMENTS;
export const LAPS = 2;
export const FINISH = LAP * LAPS;
export const CHECKPOINTS = 4; // splits per lap; the last one of the last lap is the finish
export const ROAD = 1000; // half the road's width
export const WALL = 2300; // the buildings
export const MAX_FRAMES = 150 * FPS; // a run that has not finished by then does not count
export const LANES = [-650, -220, 220, 650];

const SECTIONS = [ // [curve, hill]: curve > 0 bends right
  [0, 0], [0, 2], [2, 0], [-2, -1], [4, 0], [-4, 1], [3, -2], [-3, 2], [6, 0], [-6, 0], [5, 1], [-5, -1], [0, -3], [1, 3],
];

/** The circuit for a seed: segments with their curve and height, traffic, and the city along the road. */
export class Track {
  constructor(seed) {
    const r = rng(seed);
    this.segments = [];
    const add = (curve, hill) => this.segments.push({ i: this.segments.length, curve, hill });
    for (let i = 0; i < 24; i++) add(0, 0); // the start straight
    while (this.segments.length < SEGMENTS - 30) {
      const [curve, hill] = SECTIONS[r.int(SECTIONS.length)];
      const enter = 10 + r.int(20);
      const hold = 20 + r.int(50);
      const leave = 10 + r.int(20);
      for (let k = 0; k < enter; k++) add(Math.trunc((curve * k) / enter), hill);
      for (let k = 0; k < hold; k++) add(curve, hill);
      for (let k = 0; k < leave; k++) add(Math.trunc((curve * (leave - k)) / leave), hill);
    }
    this.segments.length = Math.min(this.segments.length, SEGMENTS - 30);
    while (this.segments.length < SEGMENTS) add(0, 0); // the finish straight
    // heights, for drawing: a smooth roll from each segment's hill
    let y = 0;
    let dy = 0;
    for (const s of this.segments) {
      dy += Math.trunc((s.hill * 12 - dy) / 8);
      y += dy;
      s.y = y;
    }
    const drift = y; // close the loop: spread the height mismatch over the lap
    for (const s of this.segments) s.y -= Math.trunc((drift * s.i) / SEGMENTS);
    // traffic: cars in lanes at steady speeds
    this.cars = Array.from({ length: 18 }, (_, i) => ({
      z: 3000 + Math.trunc((i * LAP) / 18) + r.int(2400),
      x: LANES[r.int(LANES.length)],
      speed: 40 + r.int(36),
      kind: r.int(6),
    }));
    // the city: buildings, lamps and neon signs, decided by the seed so everyone sees the same street
    for (const s of this.segments) {
      s.left = s.i % 3 === 0 ? { kind: r.int(12), x: -(1500 + r.int(700)) } : null;
      s.right = s.i % 3 === 1 ? { kind: r.int(12), x: 1500 + r.int(700) } : null;
      s.lamp = s.i % 8 === 0;
      s.sign = r.int(100) < 6 ? { side: r.int(2) ? 1 : -1, hue: r.int(6) } : null;
    }
  }

  segment(z) { return this.segments[Math.floor((((z % LAP) + LAP) % LAP) / SEG)]; }
}

/** One run on a track, stepped one frame at a time. */
export class Run {
  constructor(track) {
    this.track = track;
    this.frame = 0;
    this.z = 0; // distance travelled
    this.x = 0; // across the road; |x| > ROAD is off the asphalt
    this.v = 0; // speed × 16, in track units per frame
    this.crashes = 0;
    this.bump = 0; // frames until the next crash can count
    this.finished = null; // the frame the finish line was crossed
    this.splits = []; // frame at each checkpoint
    this.steer = 0;
    this.draft = false; // in a car's slipstream this frame
    this.cars = track.cars.map((c) => ({ ...c }));
  }

  get speed() { return this.v >> 4; }
  get lap() { return Math.min(LAPS, Math.floor(this.z / LAP) + 1); }
  get over() { return this.finished !== null || this.frame >= MAX_FRAMES; }

  step(bits) {
    if (this.over) return;
    this.frame++;
    for (const c of this.cars) c.z = (c.z + c.speed) % LAP;
    const seg = this.track.segment(this.z);
    const lapNow = this.z % LAP;
    this.draft = this.cars.some((c) => {
      let dz = c.z - lapNow;
      if (dz < -LAP / 2) dz += LAP;
      return dz > 300 && dz < 1400 && Math.abs(c.x - this.x) < 300;
    });
    if (bits & BRAKE) this.v -= 60;
    else if (bits & THROTTLE) this.v += 24 - Math.trunc(this.v / (this.draft ? 78 : 90)); // a slipstream lifts top speed
    else this.v -= 6 + Math.trunc(this.v / 200);
    if (Math.abs(this.x) > ROAD + 150 && this.v > 600) this.v -= 4 + Math.trunc(this.v / 40); // off the asphalt
    if (this.v < 0) this.v = 0;
    const s = this.v >> 4;
    const turn = Math.trunc((s * 5) / 12);
    this.steer = (bits & LEFT ? -1 : 0) + (bits & RIGHT ? 1 : 0);
    this.x += this.steer * turn;
    this.x -= throw_(seg.curve, s); // a bend throws you outwards, with the square of your speed
    if (this.bump > 0) this.bump--;
    if (Math.abs(this.x) > WALL) {
      this.x = Math.sign(this.x) * WALL;
      if (!this.bump) { this.v = Math.trunc(this.v / 2); this.crashes++; this.bump = 30; }
    }
    this.z += s;
    const lapZ = this.z % LAP;
    for (const c of this.cars) {
      let dz = c.z - lapZ;
      if (dz > LAP / 2) dz -= LAP;
      if (dz < -LAP / 2) dz += LAP;
      if (!this.bump && dz >= 0 && dz < 150 && Math.abs(this.x - c.x) < 330) {
        this.v = Math.max(0, Math.min(this.v, c.speed * 16) - 240);
        this.crashes++;
        this.bump = 40;
      }
    }
    const every = LAP / CHECKPOINTS;
    while (this.splits.length < LAPS * CHECKPOINTS && (this.splits.length + 1) * every <= this.z) this.splits.push(this.frame);
    if (this.z >= FINISH) this.finished = this.frame;
  }
}

/** How far a bend pushes the bike outwards this frame: grows with the square of speed. */
export const throw_ = (curve, s) => Math.trunc((curve * s * s) / 1600);

/** Replay `frames` (one input byte per frame) on a track: { finished, frame, crashes, splits }. */
export function replay(track, frames) {
  const run = new Run(track);
  for (let i = 0; i < frames.length && !run.over; i++) run.step(frames[i]);
  return { finished: run.finished, frame: run.frame, crashes: run.crashes, splits: run.splits };
}

/** A competent rider: weave around traffic, hold the line through bends. Used for attract mode and tests. */
export function autopilot(run) {
  const lapZ = run.z % LAP;
  let target = 0;
  for (const c of run.cars) {
    let dz = c.z - lapZ;
    if (dz < -LAP / 2) dz += LAP;
    if (dz > 0 && dz < 2600 && Math.abs(c.x - run.x) < 520) {
      target = c.x > 0 ? c.x - 760 : c.x + 760;
      break;
    }
  }
  const s = run.v >> 4;
  const seg = run.track.segment(run.z);
  const ahead = run.track.segment(run.z + 6 * SEG);
  const push = throw_(seg.curve, s);
  const next = run.x - push;
  const grip = Math.trunc((s * 5) / 12);
  // ease off when the bend (or the one coming) would out-pull the steering
  let bits = s > 70 && (Math.abs(throw_(ahead.curve, s)) > grip - 4 || Math.abs(push) > grip - 4) ? 0 : THROTTLE;
  if (next < target - 40) bits |= RIGHT;
  else if (next > target + 40) bits |= LEFT;
  return bits;
}

/** mm:ss.cc for a frame count. */
export function lapTime(frames) {
  const cs = Math.round((frames * 100) / FPS);
  return `${Math.floor(cs / 6000)}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

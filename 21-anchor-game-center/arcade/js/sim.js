// The shooter itself: a deterministic simulation every browser can replay.
//
// A run is a seed and one input byte per frame — left, right, thrust, fire —
// for exactly RUN_FRAMES frames at a fixed 60 Hz. Given the same seed and the
// same inputs, every browser computes the same rocks, the same shots and the
// same score, which is what lets the leaderboard trust replays instead of
// claims. So nothing here may depend on the machine: positions are integers in
// 1/256 px, angles are 0..255 with a sine table baked into the source (never
// Math.sin), randomness comes from a seeded xoshiro128**, and every division
// truncates explicitly. Drawing reads this state but never feeds back into it.

export const FPS = 60;
export const RUN_FRAMES = 60 * FPS;
export const W = 960;
export const H = 600;
export const LEFT = 1;
export const RIGHT = 2;
export const THRUST = 4;
export const FIRE = 8;

const FP = 256; // fixed point: 1 px = 256 units
const WF = W * FP;
const HF = H * FP;
const TURN = 4; // angle units per frame: a full turn in 64 frames
const THRUST_ACC = 41; // ≈ 0.16 px/frame²
const SHOT_SPEED = 9 * FP;
const SHOT_LIFE = 50;
const COOLDOWN = 7;
const SHIELD = 120;
const RESPAWN = 70;
const COMBO_FRAMES = 90;
const MAX_COMBO = 8;
const CRASH_PENALTY = 250;
const MIN_ROCKS = 5;
export const POINTS = [0, 100, 50, 20]; // by rock size: 1 small, 3 big

/** sin(2π·i/256) × 16384, for i = 0..64; the other quadrants follow by symmetry. */
const QUARTER = [
  0, 402, 804, 1205, 1606, 2006, 2404, 2801, 3196, 3590, 3981, 4370, 4756, 5139, 5520, 5897, 6270, 6639, 7005, 7366,
  7723, 8076, 8423, 8765, 9102, 9434, 9760, 10080, 10394, 10702, 11003, 11297, 11585, 11866, 12140, 12406, 12665,
  12916, 13160, 13395, 13623, 13842, 14053, 14256, 14449, 14635, 14811, 14978, 15137, 15286, 15426, 15557, 15679,
  15791, 15893, 15986, 16069, 16143, 16207, 16261, 16305, 16340, 16364, 16379, 16384,
];

export function sin(a) {
  const i = a & 255;
  if (i <= 64) return QUARTER[i];
  if (i <= 128) return QUARTER[128 - i];
  if (i <= 192) return -QUARTER[i - 128];
  return -QUARTER[256 - i];
}
export const cos = (a) => sin(a + 64);

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

const wrap = (v, size) => ((v % size) + size) % size;
const scale = (unit, amount) => Math.trunc((unit * amount) / 16384);

/** Within r px of each other, measured across the wrapped edges. */
function near(a, b, r) {
  let dx = Math.abs(a.x - b.x);
  let dy = Math.abs(a.y - b.y);
  dx = Math.trunc(Math.min(dx, WF - dx) / FP);
  dy = Math.trunc(Math.min(dy, HF - dy) / FP);
  return dx * dx + dy * dy < r * r;
}

export class Run {
  constructor(seed) {
    this.next = rng(seed);
    this.frame = 0;
    this.score = 0;
    this.combo = 1;
    this.lastKill = -COMBO_FRAMES - 1;
    this.kills = 0;
    this.crashes = 0;
    this.ship = { x: WF / 2, y: HF / 2, a: 192, vx: 0, vy: 0, cool: 0, dead: 0, shield: SHIELD, thrust: false };
    this.rocks = [];
    this.shots = [];
    this.events = []; // recent kills and crashes, for the renderer
    this.rockSeq = 0;
    for (let i = 0; i < 6; i++) this.#spawn(3);
  }

  #int(n) { return this.next() % n; }

  #spawn(size, x, y) {
    const fromSide = this.#int(2) === 1;
    const dir = this.#int(256);
    const speed = (4 - size) * 70 + this.#int(110);
    const shape = [];
    for (let i = 0; i < 11; i++) shape.push(72 + this.#int(39));
    this.rocks.push({
      id: ++this.rockSeq, size, r: size * 15 + 8,
      x: x ?? (fromSide ? 0 : this.#int(WF)), y: y ?? (fromSide ? this.#int(HF) : 0),
      vx: scale(cos(dir), speed), vy: scale(sin(dir), speed),
      rot: this.#int(256), spin: this.#int(5) - 2, shape, hue: this.#int(4),
    });
  }

  #event(e) {
    this.events.push({ ...e, frame: this.frame });
    if (this.events.length > 64) this.events.shift();
  }

  /** Advance one frame with this frame's input bits. */
  step(input) {
    this.frame++;
    const s = this.ship;
    s.thrust = false;
    if (s.dead > 0) {
      s.dead--;
      if (s.dead === 0) Object.assign(s, { x: WF / 2, y: HF / 2, a: 192, vx: 0, vy: 0, shield: SHIELD });
    } else {
      if (input & LEFT) s.a = (s.a - TURN) & 255;
      if (input & RIGHT) s.a = (s.a + TURN) & 255;
      if (input & THRUST) {
        s.vx += scale(cos(s.a), THRUST_ACC);
        s.vy += scale(sin(s.a), THRUST_ACC);
        s.thrust = true;
      }
      s.vx -= Math.trunc(s.vx / 128);
      s.vy -= Math.trunc(s.vy / 128);
      s.x = wrap(s.x + s.vx, WF);
      s.y = wrap(s.y + s.vy, HF);
      if (s.cool > 0) s.cool--;
      if ((input & FIRE) && s.cool === 0) {
        this.shots.push({
          x: wrap(s.x + scale(cos(s.a), 14 * FP), WF), y: wrap(s.y + scale(sin(s.a), 14 * FP), HF),
          vx: s.vx + scale(cos(s.a), SHOT_SPEED), vy: s.vy + scale(sin(s.a), SHOT_SPEED), life: SHOT_LIFE,
        });
        s.cool = COOLDOWN;
      }
      if (s.shield > 0) s.shield--;
    }

    for (const shot of this.shots) {
      shot.x = wrap(shot.x + shot.vx, WF);
      shot.y = wrap(shot.y + shot.vy, HF);
      shot.life--;
    }
    for (const r of this.rocks) {
      r.x = wrap(r.x + r.vx, WF);
      r.y = wrap(r.y + r.vy, HF);
      r.rot = (r.rot + r.spin) & 255;
    }

    const born = [];
    for (const shot of this.shots) {
      if (shot.life <= 0) continue;
      for (const r of this.rocks) {
        if (r.dead || !near(shot, r, r.r)) continue;
        r.dead = true;
        shot.life = 0;
        this.combo = this.frame - this.lastKill <= COMBO_FRAMES ? Math.min(MAX_COMBO, this.combo + 1) : 1;
        this.lastKill = this.frame;
        const points = POINTS[r.size] * this.combo;
        this.score += points;
        this.kills++;
        this.#event({ kind: 'kill', x: r.x, y: r.y, size: r.size, points, combo: this.combo, hue: r.hue });
        if (r.size > 1) born.push(r);
        break;
      }
    }
    this.shots = this.shots.filter((shot) => shot.life > 0);
    this.rocks = this.rocks.filter((r) => !r.dead);
    for (const r of born) {
      this.#spawn(r.size - 1, r.x, r.y);
      this.#spawn(r.size - 1, r.x, r.y);
    }
    while (this.rocks.length < MIN_ROCKS) this.#spawn(3);

    if (s.dead === 0 && s.shield === 0) {
      for (const r of this.rocks) {
        if (!near(s, r, r.r + 8)) continue;
        s.dead = RESPAWN;
        this.score = Math.max(0, this.score - CRASH_PENALTY);
        this.combo = 1;
        this.crashes++;
        this.#event({ kind: 'crash', x: s.x, y: s.y });
        break;
      }
    }
  }
}

/** Replay a whole run: `inputs` has one byte per frame. */
export function replay(seed, inputs) {
  const run = new Run(seed);
  for (let i = 0; i < RUN_FRAMES; i++) run.step(inputs[i]);
  return run;
}

export const toPixels = (v) => v / FP;

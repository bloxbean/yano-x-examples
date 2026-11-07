// Deterministic randomness for game rules: xoshiro128** seeded from bytes.
// Unsigned 32-bit integers, identical in every JavaScript engine, so every
// browser draws the same numbers from the same seed (the arcade's sim.js
// keeps its own copy, frozen with its replays).

/** A generator from at least 16 seed bytes: next() → uint32, int(n) → 0..n-1. */
export function rng(seed) {
  const s = [0, 1, 2, 3].map((i) => (seed[i * 4] | (seed[i * 4 + 1] << 8) | (seed[i * 4 + 2] << 16) | (seed[i * 4 + 3] << 24)) >>> 0);
  if (!(s[0] | s[1] | s[2] | s[3])) s[0] = 1; // the all-zero state never leaves zero
  const next = () => {
    const x = Math.imul(s[1], 5);
    const result = Math.imul((x << 7) | (x >>> 25), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t;
    s[3] = (s[3] << 11) | (s[3] >>> 21);
    return result;
  };
  return { next, int: (n) => next() % n };
}

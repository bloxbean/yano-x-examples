// BLAKE2b-256 — RFC 7693.
//
// Node ships blake2b512 but not blake2b256, and the digest length is part of
// BLAKE2b's parameter block, so you cannot truncate the 512-bit result to get
// it. Yano hashes everything with BLAKE2b-256, so an application that verifies
// anything for itself needs this.
//
// Written with BigInt for clarity over speed: this hashes a few hundred bytes
// per verification, never a stream. test/selftest.js checks it against the
// RFC 7693 vectors before the CLI will run a verification.

const MASK64 = (1n << 64n) - 1n;

const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

const rotr64 = (x, n) => ((x >> n) | (x << (64n - n))) & MASK64;

function compress(h, block, counter, isLast) {
  const v = [...h, ...IV];
  v[12] ^= counter & MASK64;
  v[13] ^= (counter >> 64n) & MASK64;
  if (isLast) v[14] ^= MASK64;

  const m = [];
  for (let i = 0; i < 16; i++) {
    let word = 0n;
    for (let b = 7; b >= 0; b--) word = (word << 8n) | BigInt(block[i * 8 + b]);
    m.push(word);
  }

  const mix = (a, b, c, d, x, y) => {
    v[a] = (v[a] + v[b] + x) & MASK64;
    v[d] = rotr64(v[d] ^ v[a], 32n);
    v[c] = (v[c] + v[d]) & MASK64;
    v[b] = rotr64(v[b] ^ v[c], 24n);
    v[a] = (v[a] + v[b] + y) & MASK64;
    v[d] = rotr64(v[d] ^ v[a], 16n);
    v[c] = (v[c] + v[d]) & MASK64;
    v[b] = rotr64(v[b] ^ v[c], 63n);
  };

  for (let round = 0; round < 12; round++) {
    const s = SIGMA[round];
    mix(0, 4, 8, 12, m[s[0]], m[s[1]]);
    mix(1, 5, 9, 13, m[s[2]], m[s[3]]);
    mix(2, 6, 10, 14, m[s[4]], m[s[5]]);
    mix(3, 7, 11, 15, m[s[6]], m[s[7]]);
    mix(0, 5, 10, 15, m[s[8]], m[s[9]]);
    mix(1, 6, 11, 12, m[s[10]], m[s[11]]);
    mix(2, 7, 8, 13, m[s[12]], m[s[13]]);
    mix(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }

  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

/** BLAKE2b with an arbitrary digest length, unkeyed. */
export function blake2b(input, digestLength = 32) {
  const message = Uint8Array.from(input);
  const h = [...IV];
  h[0] ^= 0x01010000n ^ BigInt(digestLength); // parameter block: depth/fanout 1, no key

  // All but the final block, which must be processed with the last-block flag.
  let offset = 0;
  while (message.length - offset > 128) {
    compress(h, message.subarray(offset, offset + 128), BigInt(offset + 128), false);
    offset += 128;
  }

  const tail = new Uint8Array(128);
  tail.set(message.subarray(offset));
  compress(h, tail, BigInt(message.length), true);

  const out = new Uint8Array(digestLength);
  for (let i = 0; i < digestLength; i++) {
    out[i] = Number((h[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
  }
  return out;
}

export const blake2b256 = (input) => blake2b(input, 32);

// RFC 7693 BLAKE2b with a 32-byte digest. 64-bit words are pairs of uint32 values,
// low word first, avoiding BigInt allocation for every compression operation.
const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);
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
];

function add(v, a, low, high) {
  const sum = v[a] + low;
  v[a] = sum;
  v[a + 1] = v[a + 1] + high + (sum >= 0x100000000 ? 1 : 0);
}

function rotate(v, a, b, bits) {
  const low = v[a] ^ v[b];
  const high = v[a + 1] ^ v[b + 1];
  if (bits === 32) {
    v[a] = high;
    v[a + 1] = low;
  } else if (bits === 63) {
    v[a] = (low << 1) | (high >>> 31);
    v[a + 1] = (high << 1) | (low >>> 31);
  } else {
    v[a] = (low >>> bits) | (high << (32 - bits));
    v[a + 1] = (high >>> bits) | (low << (32 - bits));
  }
}

function mix(v, m, a, b, c, d, x, y) {
  add(v, a, v[b], v[b + 1]);
  add(v, a, m[2 * x], m[2 * x + 1]);
  rotate(v, d, a, 32);
  add(v, c, v[d], v[d + 1]);
  rotate(v, b, c, 24);
  add(v, a, v[b], v[b + 1]);
  add(v, a, m[2 * y], m[2 * y + 1]);
  rotate(v, d, a, 16);
  add(v, c, v[d], v[d + 1]);
  rotate(v, b, c, 63);
}

/** BLAKE2b-256, not a truncated BLAKE2b-512 digest. */
export function blake2b256(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be Uint8Array');
  const h = new Uint32Array(IV);
  h[0] ^= 0x01010020;
  const v = new Uint32Array(32);
  const m = new Uint32Array(32);
  for (let offset = 0; offset < bytes.length || offset === 0; offset += 128) {
    const end = Math.min(offset + 128, bytes.length);
    m.fill(0);
    for (let i = offset; i < end; i++) m[(i - offset) >>> 2] |= bytes[i] << (8 * ((i - offset) & 3));
    v.set(h);
    v.set(IV, 16);
    v[24] ^= end >>> 0;
    v[25] ^= Math.floor(end / 0x100000000);
    if (end === bytes.length) {
      v[28] ^= 0xffffffff;
      v[29] ^= 0xffffffff;
    }
    for (let round = 0; round < 12; round++) {
      const s = SIGMA[round % 10];
      mix(v, m, 0, 8, 16, 24, s[0], s[1]);
      mix(v, m, 2, 10, 18, 26, s[2], s[3]);
      mix(v, m, 4, 12, 20, 28, s[4], s[5]);
      mix(v, m, 6, 14, 22, 30, s[6], s[7]);
      mix(v, m, 0, 10, 20, 30, s[8], s[9]);
      mix(v, m, 2, 12, 22, 24, s[10], s[11]);
      mix(v, m, 4, 14, 16, 26, s[12], s[13]);
      mix(v, m, 6, 8, 18, 28, s[14], s[15]);
    }
    for (let i = 0; i < 16; i++) h[i] ^= v[i] ^ v[i + 16];
  }
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) view.setUint32(i * 4, h[i], true);
  return out;
}

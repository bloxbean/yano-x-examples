// Just enough CBOR for COSE (CIP-8 wallet signatures): integers, byte and
// text strings, arrays, maps, tags and the simple values. Maps decode to a JS
// Map because COSE header labels can be integers or text.
//
// The encoder emits the shortest form of every length, which is what COSE's
// Sig_structure needs: the signed bytes are re-encoded by the verifier, so a
// non-shortest encoding would fail for the wrong reason.

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

function head(major, value) {
  const prefix = major << 5;
  if (value < 24) return Uint8Array.of(prefix | value);
  if (value <= 0xff) return Uint8Array.of(prefix | 24, value);
  if (value <= 0xffff) return Uint8Array.of(prefix | 25, value >> 8, value & 0xff);
  if (value <= 0xffffffff) {
    return Uint8Array.of(prefix | 26, (value >>> 24) & 0xff, (value >>> 16) & 0xff,
      (value >>> 8) & 0xff, value & 0xff);
  }
  const big = BigInt(value);
  const out = new Uint8Array(9);
  out[0] = prefix | 27;
  for (let i = 8; i >= 1; i--) out[i] = Number((big >> BigInt(8 * (8 - i))) & 0xffn);
  return out;
}

/** Encode numbers, Uint8Array, strings, arrays, Maps, booleans and null. */
export function encode(value) {
  if (value === null) return Uint8Array.of(0xf6);
  if (value === true) return Uint8Array.of(0xf5);
  if (value === false) return Uint8Array.of(0xf4);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`cannot encode ${value}`);
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (value instanceof Uint8Array) return concat([head(2, value.length), value]);
  if (typeof value === 'string') {
    const utf8 = new TextEncoder().encode(value);
    return concat([head(3, utf8.length), utf8]);
  }
  if (Array.isArray(value)) return concat([head(4, value.length), ...value.map(encode)]);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(encode(k), encode(v));
    return concat(parts);
  }
  throw new Error(`cannot encode ${typeof value}`);
}

/** Decode exactly one CBOR item that spans all of `buf`. */
export function decode(buf) {
  const { value, next } = decodeAt(buf, 0);
  if (next !== buf.length) throw new Error('trailing bytes after CBOR item');
  return value;
}

function decodeAt(buf, at) {
  if (at >= buf.length) throw new Error('truncated CBOR');
  const initial = buf[at++];
  const major = initial >> 5;
  const info = initial & 0x1f;

  let length = info;
  if (info === 24) length = buf[at++];
  else if (info === 25) { length = (buf[at] << 8) | buf[at + 1]; at += 2; }
  else if (info === 26) {
    length = ((buf[at] << 24) >>> 0) + (buf[at + 1] << 16) + (buf[at + 2] << 8) + buf[at + 3];
    at += 4;
  } else if (info === 27) {
    let big = 0n;
    for (let i = 0; i < 8; i++) big = (big << 8n) | BigInt(buf[at + i]);
    at += 8;
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR integer too large');
    length = Number(big);
  } else if (info > 27) {
    throw new Error('indefinite-length CBOR is not supported');
  }

  switch (major) {
    case 0: return { value: length, next: at };
    case 1: return { value: -1 - length, next: at };
    case 2:
      if (at + length > buf.length) throw new Error('truncated CBOR bytes');
      return { value: buf.slice(at, at + length), next: at + length };
    case 3:
      if (at + length > buf.length) throw new Error('truncated CBOR text');
      return { value: new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(at, at + length)), next: at + length };
    case 4: {
      const items = [];
      for (let i = 0; i < length; i++) {
        const item = decodeAt(buf, at);
        items.push(item.value);
        at = item.next;
      }
      return { value: items, next: at };
    }
    case 5: {
      const map = new Map();
      for (let i = 0; i < length; i++) {
        const k = decodeAt(buf, at);
        const v = decodeAt(buf, k.next);
        map.set(k.value, v.value);
        at = v.next;
      }
      return { value: map, next: at };
    }
    case 6: return decodeAt(buf, at); // a tag: keep the tagged item
    case 7:
      if (info === 20) return { value: false, next: at };
      if (info === 21) return { value: true, next: at };
      if (info === 22 || info === 23) return { value: null, next: at };
      throw new Error(`unsupported CBOR simple value ${info}`);
    default:
      throw new Error(`unsupported CBOR major type ${major}`);
  }
}

// Just enough canonical CBOR for this example: unsigned integers, byte
// strings, text strings and arrays.
//
// Yano's wire formats are canonical, which means the shortest encoding of a
// length or value is the only valid one. That matters here because we re-encode
// a block header and hash it: a non-canonical encoding would produce a
// different hash and the verification would fail for the wrong reason.

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

const concat = (parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

export const uint = (value) => head(0, value);
export const bytes = (value) => concat([head(2, value.length), Uint8Array.from(value)]);
export const text = (value) => {
  const encoded = new TextEncoder().encode(value);
  return concat([head(3, encoded.length), encoded]);
};
export const array = (...items) => concat([head(4, items.length), ...items]);

/** Decode one CBOR item. Returns { value, next }. Arrays become JS arrays, byte/text strings become Uint8Array/string. */
export function decode(buf, at = 0) {
  const initial = buf[at++];
  const major = initial >> 5;
  const info = initial & 0x1f;

  let value = info;
  if (info === 24) value = buf[at++];
  else if (info === 25) { value = (buf[at] << 8) | buf[at + 1]; at += 2; }
  else if (info === 26) { value = ((buf[at] << 24) >>> 0) + (buf[at + 1] << 16) + (buf[at + 2] << 8) + buf[at + 3]; at += 4; }
  else if (info === 27) {
    let big = 0n;
    for (let i = 0; i < 8; i++) big = (big << 8n) | BigInt(buf[at + i]);
    at += 8;
    value = Number(big);
  } else if (info > 27) {
    throw new Error(`unsupported CBOR additional information ${info}`);
  }

  switch (major) {
    case 0: return { value, next: at };
    case 2: return { value: buf.subarray(at, at + value), next: at + value };
    case 3: return { value: new TextDecoder().decode(buf.subarray(at, at + value)), next: at + value };
    case 4: {
      const items = [];
      for (let i = 0; i < value; i++) {
        const item = decode(buf, at);
        items.push(item.value);
        at = item.next;
      }
      return { value: items, next: at };
    }
    default:
      throw new Error(`unsupported CBOR major type ${major}`);
  }
}

export const decodeOne = (buf) => decode(buf, 0).value;

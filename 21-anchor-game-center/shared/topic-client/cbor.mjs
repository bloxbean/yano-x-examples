// Deterministic, bounded CBOR used by topic wire v1. Payload bytes remain opaque.
// Integers beyond Number.MAX_SAFE_INTEGER are represented by BigInt, never rounded.
export const MAX_WIRE_BYTES = 1 << 20;
const MAX_UINT = (1n << 63n) - 1n;
const utf8 = new TextEncoder();
const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function unhex(value, size) {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(value)
      || (size !== undefined && value.length !== size * 2) || value.length > MAX_WIRE_BYTES * 2) {
    throw new TypeError('expected canonical bounded lowercase hex');
  }
  return Uint8Array.from(value.match(/../g) ?? [], byte => parseInt(byte, 16));
}

export function compareBytes(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Encode unsigned integers, booleans, null, text, byte strings and arrays. */
export function encodeCbor(value) {
  const parts = [];
  let size = 0;
  let items = 0;
  const append = bytes => {
    size += bytes.length;
    if (size > MAX_WIRE_BYTES) throw new RangeError('CBOR exceeds 1 MiB');
    parts.push(bytes);
  };
  const header = (major, input) => {
    let value = BigInt(input);
    const width = value < 24n ? 0 : value <= 0xffn ? 1 : value <= 0xffffn ? 2 : value <= 0xffffffffn ? 4 : 8;
    const out = new Uint8Array(width + 1);
    out[0] = major * 32 + (width === 0 ? Number(value) : 24 + Math.log2(width));
    for (let i = width; i > 0; i--) { out[i] = Number(value & 255n); value >>= 8n; }
    append(out);
  };
  const visit = (value, depth) => {
    if (++items > 4096 || depth > 16) throw new RangeError('CBOR structural bound exceeded');
    if (value === null) append(Uint8Array.of(0xf6));
    else if (typeof value === 'boolean') append(Uint8Array.of(value ? 0xf5 : 0xf4));
    else if (typeof value === 'number' || typeof value === 'bigint') {
      if ((typeof value === 'number' && !Number.isSafeInteger(value)) || value < 0 || BigInt(value) > MAX_UINT) {
        throw new RangeError('CBOR integer must be in 0..2^63-1');
      }
      header(0, value);
    } else if (typeof value === 'string') {
      if (!value.isWellFormed()) throw new TypeError('invalid Unicode');
      const bytes = utf8.encode(value);
      header(3, bytes.length);
      append(bytes);
    } else if (value instanceof Uint8Array) {
      header(2, value.length);
      append(value);
    } else if (Array.isArray(value)) {
      if (value.length > 512) throw new RangeError('CBOR array exceeds 512 entries');
      header(4, value.length);
      for (const item of value) visit(item, depth + 1);
    } else throw new TypeError('unsupported CBOR value');
  };
  visit(value, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

export function decodeCbor(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_WIRE_BYTES) {
    throw new TypeError('expected 1..1048576 CBOR bytes');
  }
  let offset = 0;
  let items = 0;
  const read = () => {
    if (offset >= bytes.length) throw new TypeError('truncated CBOR');
    return bytes[offset++];
  };
  const visit = depth => {
    if (++items > 4096 || depth > 16) throw new RangeError('CBOR structural bound exceeded');
    const first = read();
    const major = first >>> 5;
    const info = first & 31;
    if (major === 7) {
      if (first === 0xf4) return false;
      if (first === 0xf5) return true;
      if (first === 0xf6) return null;
      throw new TypeError('unsupported CBOR simple value');
    }
    if (![0, 2, 3, 4].includes(major) || info > 27) throw new TypeError('unsupported CBOR type');
    let value = BigInt(info);
    if (info >= 24) {
      const width = 1 << (info - 24);
      value = 0n;
      for (let i = 0; i < width; i++) value = (value << 8n) | BigInt(read());
      const min = [24n, 256n, 65536n, 4294967296n][info - 24];
      if (value < min) throw new TypeError('non-shortest CBOR integer or length');
    }
    if (value > MAX_UINT) throw new RangeError('CBOR integer exceeds 2^63-1');
    if (major === 0) return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
    if (value > BigInt(bytes.length)) throw new RangeError('CBOR length exceeds input');
    const length = Number(value);
    if (major === 4) {
      if (length > 512) throw new RangeError('CBOR array exceeds 512 entries');
      return Array.from({ length }, () => visit(depth + 1));
    }
    if (offset + length > bytes.length) throw new TypeError('truncated CBOR string');
    const slice = bytes.slice(offset, offset + length);
    offset += length;
    return major === 2 ? slice : text.decode(slice);
  };
  const result = visit(0);
  if (offset !== bytes.length) throw new TypeError('trailing CBOR bytes');
  return result;
}

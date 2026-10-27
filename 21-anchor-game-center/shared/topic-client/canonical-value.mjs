// Canonical application values and schema IR. Topic wire keeps its narrower grammar in cbor.mjs.
import { compareBytes } from './cbor.mjs';

const MAX_BYTES = 1048576;
const MAX_UINT = (1n << 64n) - 1n;
const utf8 = new TextEncoder();

/**
 * Encode bounded canonical CBOR values: native integers, text, bytes, booleans, null, arrays and maps.
 * Map keys are sorted bytewise by their canonical CBOR encoding, as required by core CborSchema.
 * Numbers must be safe integers; use BigInt for the remainder of CBOR's native integer domain.
 * Floating point, tags and indefinite lengths are intentionally not application schema types.
 */
export function encodeCanonicalValue(value, { maximumBytes = MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_BYTES) {
    throw new RangeError('maximumBytes must be in 1..1048576');
  }
  let items = 0;
  const join = (parts, size) => {
    const result = new Uint8Array(size); let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  };
  const sink = () => ({ parts: [], size: 0 });
  const append = (out, bytes) => {
    out.size += bytes.length;
    if (out.size > maximumBytes) throw new RangeError('canonical value exceeds its byte bound');
    out.parts.push(bytes);
  };
  const header = (out, major, input) => {
    let value = BigInt(input);
    const width = value < 24n ? 0 : value <= 255n ? 1 : value <= 65535n ? 2 : value <= 4294967295n ? 4 : 8;
    const encoded = new Uint8Array(width + 1);
    encoded[0] = major * 32 + (width === 0 ? Number(value) : 24 + Math.log2(width));
    for (let i = width; i > 0; i--) { encoded[i] = Number(value & 255n); value >>= 8n; }
    append(out, encoded);
  };
  const visit = (value, depth, out) => {
    if (++items > 65536 || depth > 32) throw new RangeError('canonical value exceeds its structural bound');
    if (value === null) append(out, Uint8Array.of(0xf6));
    else if (typeof value === 'boolean') append(out, Uint8Array.of(value ? 0xf5 : 0xf4));
    else if (typeof value === 'number' || typeof value === 'bigint') {
      if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError('expected a safe integer');
      const integer = BigInt(value);
      if (integer > MAX_UINT || integer < -1n - MAX_UINT) throw new RangeError('integer exceeds native CBOR range');
      header(out, integer < 0n ? 1 : 0, integer < 0n ? -1n - integer : integer);
    } else if (typeof value === 'string') {
      if (!value.isWellFormed()) throw new TypeError('invalid Unicode');
      if (value.length > maximumBytes) throw new RangeError('canonical text exceeds its byte bound');
      const bytes = utf8.encode(value);
      header(out, 3, bytes.length); append(out, bytes);
    } else if (value instanceof Uint8Array) {
      header(out, 2, value.length); append(out, value);
    } else if (Array.isArray(value)) {
      if (value.length > 65536) throw new RangeError('canonical array exceeds its item bound');
      header(out, 4, value.length);
      for (const item of value) visit(item, depth + 1, out);
    } else if (value instanceof Map || value && typeof value === 'object'
        && [null, Object.prototype].includes(Object.getPrototypeOf(value))) {
      const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
      if (entries.length > 65536) throw new RangeError('canonical map exceeds its item bound');
      let keyBytes = 0;
      const keyed = entries.map(([key, value]) => {
        const keyOut = sink(); visit(key, depth + 1, keyOut);
        keyBytes += keyOut.size;
        if (keyBytes > maximumBytes - out.size) throw new RangeError('canonical keys exceed their byte bound');
        return [join(keyOut.parts, keyOut.size), value];
      });
      keyed.sort((a, b) => compareBytes(a[0], b[0]));
      header(out, 5, keyed.length);
      let previous = null;
      for (const [key, value] of keyed) {
        if (previous && compareBytes(previous, key) === 0) throw new TypeError('duplicate canonical map key');
        append(out, key); visit(value, depth + 1, out); previous = key;
      }
    } else throw new TypeError('unsupported canonical CBOR value');
  };
  const out = sink(); visit(value, 0, out);
  return join(out.parts, out.size);
}

/** Decode the same closed value subset with allocation, depth, UTF-8 and canonical-order checks. */
export function decodeCanonicalValue(bytes, { maximumBytes = MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_BYTES
      || !(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > maximumBytes) {
    throw new RangeError('canonical value exceeds its byte bound');
  }
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let offset = 0; let items = 0;
  const read = () => {
    if (offset >= bytes.length) throw new TypeError('truncated canonical value');
    return bytes[offset++];
  };
  const integer = value => value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value) : value;
  const visit = depth => {
    if (++items > 65536 || depth > 32) throw new RangeError('canonical value exceeds its structural bound');
    const first = read(); const major = first >>> 5; const info = first & 31;
    if (major === 7) {
      if (first === 0xf4) return false;
      if (first === 0xf5) return true;
      if (first === 0xf6) return null;
      throw new TypeError('unsupported canonical simple value');
    }
    if (major > 5 || info > 27) throw new TypeError('unsupported canonical value');
    let value = BigInt(info);
    if (info >= 24) {
      value = 0n;
      for (let index = 0; index < 1 << (info - 24); index++) value = (value << 8n) | BigInt(read());
      if (value < [24n, 256n, 65536n, 4294967296n][info - 24]) {
        throw new TypeError('non-shortest canonical value');
      }
    }
    if (major === 0) return integer(value);
    if (major === 1) return integer(-1n - value);
    if (value > BigInt(bytes.length)) throw new RangeError('canonical length exceeds input');
    const length = Number(value);
    if (major === 2 || major === 3) {
      if (offset + length > bytes.length) throw new TypeError('truncated canonical string');
      const result = bytes.slice(offset, offset + length); offset += length;
      return major === 2 ? result : text.decode(result);
    }
    if (length > 65536) throw new RangeError('canonical collection exceeds its item bound');
    if (major === 4) return Array.from({ length }, () => visit(depth + 1));
    const map = new Map(); let previous = null;
    for (let index = 0; index < length; index++) {
      const start = offset;
      const key = visit(depth + 1);
      const encoded = bytes.subarray(start, offset);
      if (previous && compareBytes(previous, encoded) >= 0) throw new TypeError('unordered or duplicate canonical key');
      map.set(key, visit(depth + 1)); previous = encoded;
    }
    return map;
  };
  const result = visit(0);
  if (offset !== bytes.length) throw new TypeError('trailing canonical bytes');
  return result;
}

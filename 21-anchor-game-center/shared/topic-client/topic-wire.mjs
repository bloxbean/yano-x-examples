import { compareBytes, decodeCbor, encodeCbor } from './cbor.mjs';

const invalid = message => { throw new TypeError(`Invalid topic wire: ${message}`); };
const array = (value, length) => {
  if (!Array.isArray(value) || (length !== undefined && value.length !== length)) invalid('array length');
};
const uint = (value, min = 0) => {
  if (!['number', 'bigint'].includes(typeof value) || (typeof value === 'number' && !Number.isSafeInteger(value))
      || value < min || BigInt(value) > (1n << 63n) - 1n) invalid('unsigned integer');
};
const str = value => { if (typeof value !== 'string' || !value.isWellFormed()) invalid('text'); };
const bool = value => { if (typeof value !== 'boolean') invalid('boolean'); };
const bytes = (value, length) => {
  if (!(value instanceof Uint8Array) || (length !== undefined && value.length !== length)) invalid('byte length');
};
const version = value => { if (value !== 1) invalid('version'); };
const domain = (value, expected) => { if (value !== expected) invalid('domain'); };
const optional = (value, check) => { if (value !== null) check(value); };
const hashOrNone = value => { bytes(value); if (![0, 32].includes(value.length)) invalid('schema hash'); };

function keys(value, min = 0, max = 16) {
  array(value);
  if (value.length < min || value.length > max) invalid('key count');
  for (let i = 0; i < value.length; i++) {
    bytes(value[i], 32);
    if (i && compareBytes(value[i - 1], value[i]) >= 0) invalid('keys must be sorted and unique');
  }
}

function keySet(value) {
  array(value, 2); uint(value[0], 1); keys(value[1], 1);
  if (value[0] > value[1].length) invalid('threshold');
}

function writers(value) { if (value !== 0) keySet(value); }
function policy(value) {
  array(value, 5);
  optional(value[0], writers); optional(value[1], keys); optional(value[2], v => uint(v, 1));
  optional(value[3], hashOrNone); optional(value[4], v => uint(v, 1));
}
function content(value) { array(value, 3); keySet(value[0]); policy(value[1]); bool(value[2]); }
function settings(value) {
  array(value, 11); bool(value[0]); optional(value[1], keySet); bool(value[2]); bool(value[3]);
  for (let i = 4; i < value.length; i++) uint(value[i], 1);
  if (value[4] > 31536000000 || value[5] > 31536000000 || value[9] > 1000000) invalid('settings limit');
}
function signatures(value) {
  array(value);
  keys(value.map(signature => { array(signature, 2); bytes(signature[1], 64); return signature[0]; }), 1);
}
function delegation(value) {
  array(value, 7); version(value[0]); bytes(value[1], 32); str(value[2]);
  uint(value[3]); uint(value[4]); bytes(value[5], 32); bytes(value[6], 64);
  if (value[3] > value[4]) invalid('delegation window');
}
function operation(value) {
  array(value); uint(value[0]);
  switch (value[0]) {
    case 0: array(value, 4); keySet(value[1]); policy(value[2]); optional(value[3], bytes); break;
    case 1: array(value, 3); policy(value[1]); optional(value[2], bytes); break;
    case 2: array(value, 2); keySet(value[1]); break;
    case 3: array(value, 1); break;
    case 4: array(value, 2); delegation(value[1]); break;
    default: invalid('operation');
  }
}
function command(value) {
  array(value, 9); domain(value[0], 'yano-topic-command-v1'); str(value[1]); bytes(value[2], 32);
  str(value[3]); str(value[4]); optional(value[5], v => uint(v, 1)); bytes(value[6], 16);
  uint(value[7]); operation(value[8]);
}

/** All frozen core wire structures, represented as CBOR arrays with Uint8Array byte strings. */
export function validateWire(type, value) {
  switch (type) {
    case 'config':
      array(value, 4); version(value[0]); uint(value[1], 1); uint(value[2], 1); settings(value[3]);
      if (value[2] > value[1]) invalid('registrars revision');
      break;
    case 'entry-record':
      array(value, 6); version(value[0]); str(value[1]); uint(value[3], 1); uint(value[4]); uint(value[5]);
      if (value[2] === null) { if (value[4] < 1) invalid('pending creation'); }
      else {
        array(value[2], 4); uint(value[2][0], 1); uint(value[2][1], 1); uint(value[2][2], 1);
        content(value[2][3]);
        if (value[2][2] > value[2][0] || value[2][0] > value[3]) invalid('active revision');
      }
      break;
    case 'queued-revision':
      array(value, 6); uint(value[0], 1); uint(value[1], 1); str(value[2]); uint(value[3]);
      content(value[4]); bytes(value[5], 32); break;
    case 'expiry-batch':
      array(value, 4); value.forEach(v => uint(v));
      if (value[2] < 1 || value[3] >= value[2]) invalid('expiry batch');
      break;
    case 'expiry-item':
      array(value, 2); if (![0, 1, 2].includes(value[0])) invalid('expiry kind'); bytes(value[1], 32); break;
    case 'activation':
      array(value, 3); str(value[0]); uint(value[1], 1); bytes(value[2], 32); break;
    case 'receipt': array(value, 2); str(value[0]); uint(value[1]); break;
    case 'governance-pending':
      array(value);
      for (const entry of value) { array(entry, 3); bytes(entry[0], 32); uint(entry[1], 1); keys(entry[2], 1, 32); }
      break;
    case 'delegation': delegation(value); break;
    case 'command-statement': command(value); break;
    case 'registry-command':
      array(value, 3); version(value[0]); command(value[1]); signatures(value[2]); break;
    case 'governance-command': {
      array(value, 5); domain(value[0], 'yano-topic-governance-v1'); str(value[1]); bytes(value[2], 32);
      bytes(value[3], 16); array(value[4]);
      const op = value[4];
      switch (op[0]) {
        case 0: array(op, 5); str(op[1]); keySet(op[2]); policy(op[3]); optional(op[4], bytes); break;
        case 1: array(op, 3); str(op[1]); keySet(op[2]); break;
        case 2: array(op, 2); str(op[1]); break;
        case 3: array(op, 2); settings(op[1]); break;
        default: invalid('governance operation');
      }
      break;
    }
    case 'delegation-signed':
      array(value, 9); domain(value[0], 'yano-topic-delegation-v1'); str(value[1]); bytes(value[2], 32);
      delegation([...value.slice(3), new Uint8Array(64)]); break;
    case 'write-statement':
      array(value, 8); domain(value[0], 'yano-topic-write-v1'); str(value[1]); bytes(value[2], 32);
      str(value[3]); bytes(value[4], 32); bytes(value[5], 16); uint(value[6]);
      optional(value[7], v => bytes(v, 32)); break;
    case 'frame': {
      array(value, 3); version(value[0]); bytes(value[1]); array(value[2], 4);
      const proof = value[2];
      bytes(proof[0], 16); uint(proof[1]); signatures(proof[2]); optional(proof[3], delegation); break;
    }
    case 'effective-outcome': {
      array(value, 5); domain(value[0], 'yano-topic-outcome-v1');
      if (![0, 1, 2, 3].includes(value[1])) invalid('outcome kind');
      optional(value[3], v => uint(v, 1)); array(value[4]);
      if ((value[1] === 0) !== (value[3] === null) || (value[1] === 1) !== (value[2] !== null)
          || (value[1] !== 1 && value[4].length !== 0)) invalid('outcome');
      if (value[2] !== null) {
        const p = value[2]; array(p, 6); writers(p[0]); keys(p[1]); uint(p[2], 1);
        hashOrNone(p[3]); uint(p[4], 1); bool(p[5]);
      }
      for (const source of value[4]) { array(source, 2); str(source[0]); uint(source[1], 1); }
      break;
    }
    default: invalid('unknown structure type');
  }
}

export function encodeWire(type, value) {
  validateWire(type, value);
  const result = encodeCbor(value);
  if (['config', 'entry-record'].includes(type) && result.length > 4096) invalid('record exceeds 4096 bytes');
  return result;
}

export function decodeWire(type, bytes) {
  if (['config', 'entry-record'].includes(type) && bytes.length > 4096) invalid('record exceeds 4096 bytes');
  const value = decodeCbor(bytes);
  validateWire(type, value);
  return value;
}

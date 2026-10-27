/** Browser-first topic-policy client. No dependencies, private-key exports or node-specific imports. */
import { blake2b256 } from './blake2b.mjs';
import { compareBytes, encodeCbor, hex, unhex } from './cbor.mjs';
import { decodeWire, encodeWire } from './topic-wire.mjs';
export { blake2b256, encodeCbor, hex, unhex, decodeWire, encodeWire };
export { encodeCanonicalValue, decodeCanonicalValue } from './canonical-value.mjs';

const utf8 = new TextEncoder();
const ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;
const SMALL_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
];

function cryptoApi() {
  if (!globalThis.crypto?.subtle) throw new Error('WebCrypto requires a secure context');
  return globalThis.crypto;
}
function littleEndian(bytes) {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}
function strictPoint(bytes) {
  const y = bytes.slice(); y[31] &= 127;
  return littleEndian(y) < (1n << 255n) - 19n && !SMALL_ORDER.includes(hex(y));
}
function boundedTime(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('time must be a nonnegative safe integer');
}
export function isValidTopic(topic) {
  return typeof topic === 'string' && topic.isWellFormed() && topic.length > 0
    && !topic.startsWith('~') && !topic.includes('\0') && utf8.encode(topic).length <= 256;
}
export function isNamespace(name) {
  return isValidTopic(name) && /^(?:(?!\.+\/)[a-z0-9._-]{1,64}\/)+$/.test(name);
}
export function isValidEntryName(name) { return isNamespace(name) || isValidTopic(name) && !name.endsWith('/'); }
export function covers(scope, topic) { return scope === topic || isNamespace(scope) && topic.startsWith(scope); }

/** Canonical, non-small-order points and S<L, followed by WebCrypto Ed25519 verification. */
export async function verifySignature(publicKey, signature, message) {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32
      || !(signature instanceof Uint8Array) || signature.length !== 64
      || !(message instanceof Uint8Array)) return false;
  // The same bytes must pass the strict checks and the asynchronous equation check.
  publicKey = publicKey.slice(); signature = signature.slice(); message = message.slice();
  if (!strictPoint(publicKey) || !strictPoint(signature.slice(0, 32))
      || littleEndian(signature.slice(32)) >= ORDER) return false;
  try {
    const key = await cryptoApi().subtle.importKey('raw', publicKey, 'Ed25519', false, ['verify']);
    return await cryptoApi().subtle.verify('Ed25519', key, signature, message);
  } catch (error) {
    if (error.name === 'DataError' || error.name === 'OperationError') return false;
    throw error; // unsupported crypto must not be reported as an invalid user signature
  }
}

/** Returns { publicKey, privateKey }; the session private CryptoKey cannot be exported. */
export async function createSessionKey() {
  const pair = await cryptoApi().subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  return { publicKey: hex(new Uint8Array(await cryptoApi().subtle.exportKey('raw', pair.publicKey))),
    privateKey: pair.privateKey };
}

/** Wrap a caller-owned CryptoKey. Only publicKey and the signature leave this object. */
export function signerFromKey(key) {
  unhex(key.publicKey, 32);
  if (key.privateKey?.algorithm?.name !== 'Ed25519' || key.privateKey.type !== 'private'
      || !key.privateKey.usages.includes('sign')) throw new TypeError('expected an Ed25519 signing CryptoKey');
  return { publicKey: key.publicKey,
    sign: async bytes => new Uint8Array(await cryptoApi().subtle.sign('Ed25519', key.privateKey, bytes)) };
}

export function nonce() { return hex(cryptoApi().getRandomValues(new Uint8Array(16))); }

function delegationValue(value) {
  return value instanceof Uint8Array ? decodeWire('delegation', value) : decodeWire('delegation',
    encodeWire('delegation', value));
}

export function delegationSigningBytes(chainId, generationId, delegation) {
  const value = delegationValue(delegation);
  return encodeWire('delegation-signed', ['yano-topic-delegation-v1', chainId, unhex(generationId, 32),
    ...value.slice(0, 6)]);
}

export function delegationHash(chainId, generationId, delegation) {
  return hex(blake2b256(delegationSigningBytes(chainId, generationId, delegation)));
}

export async function issueDelegation({ chainId, generationId, delegate, scope, notBefore, notAfter, issuer }) {
  if (!isValidEntryName(scope)) throw new TypeError('invalid delegation scope');
  boundedTime(notBefore); boundedTime(notAfter);
  const value = [1, unhex(delegate, 32), scope, notBefore, notAfter, unhex(issuer.publicKey, 32),
    new Uint8Array(64)];
  const bytes = delegationSigningBytes(chainId, generationId, value);
  const signed = await issuer.sign(bytes.slice());
  if (!(signed instanceof Uint8Array)) throw new TypeError('signature must be Uint8Array');
  value[6] = signed.slice();
  if (!await verifySignature(value[5], value[6], bytes)) throw new TypeError('issuer signature does not verify');
  return encodeWire('delegation', value);
}

export async function verifyDelegation(chainId, generationId, encoded) {
  try {
    const value = delegationValue(encoded);
    return isValidEntryName(value[2])
      && await verifySignature(value[5], value[6], delegationSigningBytes(chainId, generationId, value));
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return false;
    throw error;
  }
}

export function writeStatement({ chainId, generationId, topic, payload, nonce: writeNonce,
  notAfter, delegation = null }) {
  if (!isValidTopic(topic)) throw new TypeError('invalid topic');
  boundedTime(notAfter);
  return encodeWire('write-statement', ['yano-topic-write-v1', chainId, unhex(generationId, 32), topic,
    blake2b256(payload), unhex(writeNonce, 16), notAfter,
    delegation === null ? null : unhex(delegationHash(chainId, generationId, delegation), 32)]);
}

async function checkedSignatures(statement, signers) {
  if (!Array.isArray(signers) || signers.length < 1 || signers.length > 16) {
    throw new TypeError('requires 1..16 signers');
  }
  const signatures = await Promise.all(signers.map(async signer => {
    const key = unhex(signer.publicKey, 32);
    const signature = await signer.sign(statement.slice());
    if (!(signature instanceof Uint8Array)) throw new TypeError('signature must be Uint8Array');
    return [key, signature.slice()];
  }));
  signatures.sort((a, b) => compareBytes(a[0], b[0]));
  for (let i = 0; i < signatures.length; i++) {
    if (i > 0 && compareBytes(signatures[i - 1][0], signatures[i][0]) === 0
        || !await verifySignature(signatures[i][0], signatures[i][1], statement)) {
      throw new TypeError('signature is invalid or its key is duplicated');
    }
  }
  return signatures;
}

export async function signWrite(request, signers) {
  // Snapshot caller-owned buffers before awaiting an external signer.
  const payload = request.payload.slice();
  const delegation = request.delegation == null ? null : delegationValue(request.delegation);
  const snapshot = { ...request, payload, delegation };
  const statement = writeStatement(snapshot);
  if (delegation !== null && (!await verifyDelegation(snapshot.chainId, snapshot.generationId, delegation)
      || !covers(delegation[2], snapshot.topic) || snapshot.notAfter < delegation[3]
      || snapshot.notAfter > delegation[4])) throw new TypeError('delegation does not cover this write');
  const signatures = await checkedSignatures(statement, signers);
  if (delegation !== null && (signatures.length !== 1 || compareBytes(signatures[0][0], delegation[1]) !== 0)) {
    throw new TypeError('delegated writes require exactly the session key signature');
  }
  return encodeWire('frame', [1, payload, [unhex(snapshot.nonce, 16), snapshot.notAfter, signatures, delegation]]);
}

export async function signRegistry(statement, signers) {
  const bytes = statement instanceof Uint8Array ? statement.slice() : encodeWire('command-statement', statement);
  const value = decodeWire('command-statement', bytes);
  return encodeWire('registry-command', [1, value, await checkedSignatures(bytes, signers)]);
}

/** Signature consistency only; does not verify registry authority, revocation, replay, time or finality. */
export async function verifyFrameSignatures({ chainId, generationId, topic }, encoded) {
  try {
    const [, payload, [writeNonce, notAfter, signatures, delegation]] = decodeWire('frame', encoded);
    if (delegation !== null && (!await verifyDelegation(chainId, generationId, delegation)
        || !covers(delegation[2], topic) || notAfter < delegation[3] || notAfter > delegation[4]
        || signatures.length !== 1 || compareBytes(signatures[0][0], delegation[1]) !== 0)) return false;
    const statement = writeStatement({ chainId, generationId, topic, payload, nonce: hex(writeNonce),
      notAfter, delegation });
    for (const [key, signature] of signatures) if (!await verifySignature(key, signature, statement)) return false;
    return true;
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return false;
    throw error;
  }
}

export class TopicError extends Error {
  constructor(status, code) {
    super(`Topic request failed with HTTP ${status}${code ? ` (${code})` : ''}`);
    this.name = 'TopicError'; this.status = status; this.code = code;
  }
}

export function refusalCode(body) {
  return typeof body?.code === 'string' && /^[A-Z_]{1,64}$/.test(body.code) ? body.code : null;
}

/** Bounded transport shared by write submissions and application-owned delegation services. */
export async function topicRequest(url, body, { fetch: request = globalThis.fetch, headers = {}, signal,
  timeoutMs = 15000 } = {}) {
  const address = new URL(url);
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) {
    throw new TypeError('invalid topic endpoint');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new TypeError('request timeout must be in 1..60000 milliseconds');
  }
  const encoded = JSON.stringify(body);
  if (typeof encoded !== 'string' || utf8.encode(encoded).length > 2 * 1048576 + 4096) {
    throw new RangeError('topic request exceeds the client size limit');
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Topic request timed out', 'TimeoutError')),
    timeoutMs);
  try {
    const response = await request(address, { method: 'POST', redirect: 'error', credentials: 'omit',
      signal: controller.signal,
      headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' }, body: encoded });
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError('missing topic response');
    const parts = []; let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 65536) throw new RangeError('topic response exceeds 64 KiB');
        parts.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new TypeError('malformed topic response'); }
    if (!response.ok) throw new TopicError(response.status, refusalCode(value));
    return value;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function submitFrame({ baseUrl, chainId, topic, frame }, options) {
  if (!isValidTopic(topic)) throw new TypeError('invalid topic');
  decodeWire('frame', frame);
  const url = `${baseUrl.replace(/\/$/, '')}/app-chain/chains/${encodeURIComponent(chainId)}/messages`;
  const result = await topicRequest(url, { topic, bodyHex: hex(frame) }, options);
  if (result === null || typeof result !== 'object' || Array.isArray(result)
      || Object.keys(result).sort().join(',') !== 'chainId,messageId,topic'
      || result.chainId !== chainId || result.topic !== topic
      || typeof result.messageId !== 'string' || !/^[0-9a-f]{64}$/.test(result.messageId)) {
    throw new TypeError('topic submission response does not match the request');
  }
  return result;
}

/**
 * Delegated browser session. The optional store is an IndexedDB-style structured-clone adapter
 * {get(key), set(key,value), delete(key)}; it stores a non-extractable CryptoKey, never a seed.
 * requestDelegation receives only public fields; the application supplies its login proof.
 */
export class DelegatedSession {
  #options; #key; #delegation = null; #refresh = null;
  constructor(options) {
    const { chainId, generationId, scope, issuers, requestDelegation, maxDelegationMs = 3600000,
      refreshBeforeMs = 60000, now = Date.now, store } = options;
    unhex(generationId, 32);
    if (!isValidEntryName(scope) || !Array.isArray(issuers) || issuers.length < 1 || issuers.length > 16
        || typeof requestDelegation !== 'function') throw new TypeError('invalid session options');
    issuers.forEach(key => unhex(key, 32));
    boundedTime(maxDelegationMs); boundedTime(refreshBeforeMs);
    if (maxDelegationMs < 1 || refreshBeforeMs >= maxDelegationMs) throw new TypeError('invalid session window');
    this.#options = { chainId, generationId, scope, issuers: [...issuers], requestDelegation,
      maxDelegationMs, refreshBeforeMs, now, store };
  }
  get storageKey() {
    const o = this.#options;
    return `yano-topic-session-v1:${hex(blake2b256(encodeCbor([o.chainId, unhex(o.generationId, 32), o.scope])))}`;
  }
  async #initialize() {
    if (this.#key) return;
    const saved = await this.#options.store?.get(this.storageKey);
    if (saved?.key?.privateKey?.extractable === false) {
      try { signerFromKey(saved.key); this.#key = saved.key;
        if (saved.delegation) this.#delegation = await this.#accept(saved.delegation); }
      catch { this.#key = null; this.#delegation = null; }
    }
    this.#key ??= await createSessionKey();
  }
  async #accept(encoded) {
    const o = this.#options;
    const value = delegationValue(encoded);
    const now = o.now(); boundedTime(now);
    boundedTime(value[3]); boundedTime(value[4]);
    if (hex(value[1]) !== this.#key.publicKey || value[2] !== o.scope || !o.issuers.includes(hex(value[5]))
        || value[3] > now || value[4] <= now || value[4] - value[3] > o.maxDelegationMs
        || !await verifyDelegation(o.chainId, o.generationId, value)) {
      throw new TypeError('delegation service returned an invalid credential');
    }
    return encodeWire('delegation', value);
  }
  async ensureDelegation({ force = false } = {}) {
    if (this.#refresh) return (await this.#refresh).slice();
    this.#refresh = (async () => {
      await this.#initialize();
      const o = this.#options;
      const expiry = this.#delegation ? decodeWire('delegation', this.#delegation)[4] : 0;
      if (!force && o.now() + o.refreshBeforeMs < expiry) return this.#delegation;
      const encoded = await o.requestDelegation({ chainId: o.chainId, generationId: o.generationId,
        scope: o.scope, delegate: this.#key.publicKey });
      this.#delegation = await this.#accept(encoded);
      await o.store?.set(this.storageKey, { key: this.#key, delegation: this.#delegation.slice() });
      return this.#delegation;
    })();
    try { return (await this.#refresh).slice(); } finally { this.#refresh = null; }
  }
  async frame(topic, payload, { nonce: writeNonce = nonce(), notAfter } = {}) {
    if (!(payload instanceof Uint8Array)) throw new TypeError('payload must be Uint8Array');
    payload = payload.slice();
    const delegation = await this.ensureDelegation();
    const o = this.#options;
    const deadline = notAfter ?? Math.min(o.now() + 60000, decodeWire('delegation', delegation)[4]);
    return signWrite({ chainId: o.chainId, generationId: o.generationId, topic, payload,
      nonce: writeNonce, notAfter: deadline, delegation }, [signerFromKey(this.#key)]);
  }
  async clear() {
    // Wait for an in-flight refresh so it cannot restore a credential after logout.
    try { await this.#refresh; } catch { /* a failed refresh is already discarded */ }
    this.#key = null; this.#delegation = null;
    await this.#options.store?.delete(this.storageKey);
  }
}

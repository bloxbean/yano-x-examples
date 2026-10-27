// Session authorization for Neon Rush. Commander keys sign login proofs; a short-lived key signs node writes.
import { DelegatedSession, encodeCanonicalValue, decodeCanonicalValue, decodeWire, hex, unhex,
  submitFrame, topicRequest, verifyFrameSignatures } from '../../shared/topic-client/topics.mjs';
import { NEON_SCOPE, signedDelegationRequest } from '../../shared/neon-auth.js';

export async function loadTopicConfiguration(cfg, fetcher = fetch) {
  const response = await fetcher(new URL('../topic-config.json', import.meta.url), { cache: 'no-store' });
  if (!response.ok) throw new Error('Neon topic policy is not configured. Follow delegation/README.md.');
  const text = await response.text();
  if (text.length > 4096) throw new Error('Neon topic configuration is too large');
  const value = JSON.parse(text);
  unhex(value.generationId, 32);
  if (value.chainId !== cfg.movesChain || value.scope !== NEON_SCOPE || !Array.isArray(value.issuers)
      || value.issuers.length < 1 || value.issuers.length > 16) throw new Error('Invalid Neon topic configuration');
  value.issuers.forEach(key => unhex(key, 32));
  const endpoint = new URL(value.delegationEndpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
      || endpoint.hash || endpoint.search) throw new Error('Invalid delegation endpoint');
  cfg.generationId = value.generationId;
  return value;
}

/** An IndexedDB structured-clone store keeps non-extractable CryptoKeys; it never exports seeds. */
export function sessionStore(owner) {
  if (typeof indexedDB === 'undefined') return undefined;
  const database = new Promise((resolve, reject) => {
    const request = indexedDB.open('yano-neon-sessions-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sessions');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Session storage unavailable'));
  });
  const operation = async (mode, action) => {
    const db = await database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('sessions', mode);
      const request = action(transaction.objectStore('sessions'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () => reject(new Error('Session storage failed'));
    });
  };
  return { get: key => operation('readonly', store => store.get(`${owner}:${key}`)),
    set: (key, value) => operation('readwrite', store => store.put(value, `${owner}:${key}`)),
    delete: key => operation('readwrite', store => store.delete(`${owner}:${key}`)) };
}

export class NeonTopicSession {
  constructor(configuration, { fetch: request = globalThis.fetch, store = sessionStore } = {}) {
    this.configuration = configuration; this.request = request; this.store = store;
    this.current = null; this.commander = null;
  }
  async select(commander) {
    if (this.commander === commander) return this.current;
    if (this.current) await this.current.clear();
    this.commander = commander;
    if (!commander) { this.current = null; return null; }
    const config = this.configuration;
    this.current = new DelegatedSession({ chainId: config.chainId, generationId: config.generationId,
      scope: config.scope, issuers: config.issuers, store: this.store(`${commander.id}:${commander.pub}`),
      requestDelegation: async parameters => {
        const login = await signedDelegationRequest(commander, parameters);
        const result = await topicRequest(config.delegationEndpoint, login, { fetch: this.request });
        return unhex(result.delegationHex);
      } });
    return this.current;
  }
  async submit(ledger, relay, commander, topic, body) {
    if (!commander) throw new Error('Sign in to obtain a rider session');
    const session = await this.select(commander);
    const frame = await session.frame(topic, encodeCanonicalValue(body, { maximumBytes: 40000 }));
    const baseUrl = new URL(`${ledger.bases[relay]}/api/v1`, globalThis.location?.href ?? 'http://localhost').href;
    return submitFrame({ baseUrl, chainId: this.configuration.chainId, topic, frame }, { fetch: this.request });
  }
  async clear() { await this.current?.clear(); this.current = null; this.commander = null; }
}

/** Decode only a signed core frame; leave the original message id/body available as authorship evidence. */
export async function decodeMove(cfg, topic, bodyHex) {
  try {
    const frame = unhex(bodyHex);
    if (!await verifyFrameSignatures({ chainId: cfg.movesChain, generationId: cfg.generationId, topic }, frame)) {
      return null;
    }
    const value = decodeCanonicalValue(decodeWire('frame', frame)[1], { maximumBytes: 40000 });
    if (!(value instanceof Map) || [...value.keys()].some(key => typeof key !== 'string')) return null;
    return Object.fromEntries(value);
  } catch { return null; }
}

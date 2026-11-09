// Session keys: how a player writes to the protected game topics.
//
// games-chain's topic registry protects the games/ namespace. Each game has an
// entry (games/galaxy/, games/arcade/, …) and every round, field, duel or
// season is a topic below it that inherits the policy: one writer, the game
// publisher's issuer key, which may delegate. Nobody else's write is accepted.
//
// So a page does this, once per game per hour:
//
//   1. makes a session key: a non-extractable Ed25519 WebCrypto key, kept in
//      IndexedDB, that never leaves this browser;
//   2. signs a login request with the commander key (call sign, session key,
//      scope, a 60-second window, a nonce) and sends it to the publisher's
//      delegation service, which checks the commander's profile on
//      authenticated-map-chain and returns a credential: the issuer's
//      signature over (session key, scope games/<game>/, one-hour window);
//   3. signs a session pass with the commander key: "this session key plays
//      for <call sign> in games/<game>/". It travels inside every move, so
//      every browser can tell who a session key belongs to.
//
// A wallet commander signs steps 2 and 3 with this browser's device key and
// attaches the device certificate its wallet signed (shared/accounts.js), so
// the service and every browser can check device key → wallet → profile. The
// wallet itself is asked once per browser, not once per game or per hour.
//
// After that every move is signed by the session key alone. The members check
// the frame (session signature, credential, scope, time window, replay) before
// it is stored; every browser checks it again here before its rules run.

import { DelegatedSession, decodeWire, hex, nonce, topicRequest, unhex, verifyFrameSignatures }
  from './topic-client/topics.mjs';
import { CALLSIGN, verifySigned } from './accounts.js';
import { ACCOUNTS } from './config.js';

export const NAMESPACE = 'games/';
export const SESSION_MS = 3_600_000;
export const REQUEST_MS = 60_000;
const PASS_DOMAIN = 'anchor-games/session-pass/v1';
const REQUEST_DOMAIN = 'anchor-games/delegation-request/v1';
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const utf8 = (text) => new TextEncoder().encode(text);

/** games/<name>/ for one game. */
export const scopeFor = (name) => `${NAMESPACE}${name}/`;
export const isGameScope = (scope) => typeof scope === 'string' && /^games\/[a-z0-9-]{1,32}\/$/.test(scope);

// ------------------------------------------------------------------ statements

/** What the commander signs to bind a session key to their call sign within one game. */
export const passStatement = ({ chainId, generationId }, scope, id, pub, session) =>
  [PASS_DOMAIN, chainId, generationId, scope, id, pub, session].join('|');

const REQUEST_FIELDS = ['v', 'chainId', 'generationId', 'scope', 'id', 'pub', 'session', 'issuedAt', 'expiresAt', 'nonce'];

/** What the commander signs to ask for a credential. Throws on a malformed request. */
export function requestStatement(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)
      || Object.keys(r).some((key) => ![...REQUEST_FIELDS, 'sig', 'cert'].includes(key))
      || r.v !== 1 || typeof r.chainId !== 'string' || !r.chainId.length || r.chainId.length > 128
      || typeof r.generationId !== 'string' || !HEX64.test(r.generationId) || !isGameScope(r.scope)
      || typeof r.id !== 'string' || !CALLSIGN.test(r.id) || typeof r.pub !== 'string' || !HEX64.test(r.pub)
      || typeof r.session !== 'string' || !HEX64.test(r.session) || typeof r.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(r.nonce)
      || !Number.isSafeInteger(r.issuedAt) || r.issuedAt < 0 || !Number.isSafeInteger(r.expiresAt)
      || r.expiresAt <= r.issuedAt || r.expiresAt - r.issuedAt > REQUEST_MS) {
    throw new TypeError('invalid delegation request');
  }
  return REQUEST_FIELDS.slice(1).reduce((parts, key) => [...parts, r[key]], [REQUEST_DOMAIN]).join('|');
}

// ------------------------------------------------------------------ the deployment's public topic settings

/**
 * topics.json at the site root: { chainId, generationId, issuers: [hex], delegationEndpoint }.
 * All public. ./cluster start writes it for a local cluster and node serve.mjs --local serves it.
 * Returns null when the site has none (then nobody can play the session games here).
 */
export async function loadTopics(fetcher = fetch) {
  let response;
  try {
    response = await fetcher(new URL('../topics.json', import.meta.url), { cache: 'no-store' });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const value = JSON.parse(await response.text());
  if (typeof value.chainId !== 'string' || !HEX64.test(value.generationId ?? '')
      || !Array.isArray(value.issuers) || value.issuers.length < 1 || value.issuers.length > 16
      || value.issuers.some((key) => !HEX64.test(key)) || typeof value.delegationEndpoint !== 'string') {
    throw new Error('topics.json is not valid');
  }
  const base = typeof location === 'undefined' ? 'http://localhost/' : location.href;
  return { ...value, delegationEndpoint: new URL(value.delegationEndpoint, base).href };
}

// ------------------------------------------------------------------ reading moves

/**
 * Open one finalized message from a game topic: { ...entry, session: true, body, author, refusal }.
 * Every check runs here, in this browser, without trusting the member that served it:
 *   - the body is a core topic frame, and every signature in it verifies: the session key's
 *     over (chain, generation, topic, payload, nonce, deadline, credential), and the issuer's
 *     over the credential;
 *   - the credential's issuer is one this deployment publishes, its scope is exactly this game,
 *     and it covers the topic and the write's deadline;
 *   - the payload is a JSON move carrying a session pass that the named commander signed for
 *     exactly this session key and scope.
 * `body` and `author` are null when anything fails; the rules then refuse the move.
 * `cache` (a Map) remembers verified passes, one per session key.
 */
export async function openMove(topics, scope, entry, cache = new Map()) {
  const refuse = (refusal) => ({ ...entry, session: true, body: null, author: null, refusal });
  let frame;
  let delegation;
  let payload;
  try {
    frame = unhex(entry.bodyHex);
    [, payload, [, , , delegation]] = decodeWire('frame', frame);
  } catch {
    return refuse('not a session move');
  }
  if (!delegation) return refuse('not written with a session key');
  if (!(await verifyFrameSignatures({ chainId: topics.chainId, generationId: topics.generationId, topic: entry.topic }, frame))) {
    return refuse('the session signature or its credential does not verify');
  }
  const session = hex(delegation[1]);
  const issuer = hex(delegation[5]);
  if (!topics.issuers.includes(issuer)) return refuse('the credential is from an unknown issuer');
  if (delegation[2] !== scope) return refuse(`the credential is for ${delegation[2]}, not ${scope}`);

  let move;
  try {
    move = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch {
    return refuse('not a JSON move');
  }
  const pass = move?.pass;
  if (!pass || typeof pass.id !== 'string' || !CALLSIGN.test(pass.id) || typeof pass.pub !== 'string'
      || !HEX64.test(pass.pub) || typeof pass.sig !== 'string' || !HEX128.test(pass.sig)
      || Object.keys(pass).some((k) => !['id', 'pub', 'sig', 'cert'].includes(k))) {
    return refuse('the move carries no session pass');
  }
  // A wallet commander's pass is signed by a device key its wallet certified; the certificate
  // must still be valid when the issuer delegated this session key (the credential's notBefore).
  const key = `${session}|${pass.id}|${pass.pub}|${pass.sig}|${pass.cert?.cose ?? ''}|${pass.cert?.until ?? ''}`;
  if (!cache.has(key)) {
    cache.set(key, await verifySigned(ACCOUNTS, pass, passStatement(topics, scope, pass.id, pass.pub, session),
      Number(delegation[3])));
  }
  if (!cache.get(key)) {
    return refuse(pass.cert ? 'the session pass is not signed by a device that commander’s wallet certified'
      : 'the session pass is not signed by that commander');
  }
  const { pass: _, ...body } = move;
  return { ...entry, session: true, body, refusal: null,
    author: { id: pass.id, pub: pass.pub, session, issuer, until: Number(delegation[4]),
      ...(pass.cert ? { device: pass.cert.device, certUntil: pass.cert.until } : {}) } };
}

// ------------------------------------------------------------------ this browser's sessions

/** IndexedDB keeps the non-extractable session CryptoKey by structured cloning; never a seed. */
function sessionStore(owner) {
  if (typeof indexedDB === 'undefined') return undefined;
  const key = (name) => `${owner}|${name}`;
  return {
    get: (name) => idb('readonly', (store) => store.get(key(name))),
    set: (name, value) => idb('readwrite', (store) => store.put(value, key(name))),
    delete: (name) => idb('readwrite', (store) => store.delete(key(name))),
  };
}

let database;
function idb(mode, action) {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('anchor-games-sessions-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sessions');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('session storage is unavailable'));
  });
  return database.then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction('sessions', mode);
    const request = action(transaction.objectStore('sessions'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = transaction.onerror = () => reject(new Error('session storage failed'));
  }));
}

/** Forget every session key this browser holds, for every commander ("Clear browser data"). */
export async function forgetAllSessions() {
  if (typeof indexedDB === 'undefined') return;
  await idb('readwrite', (store) => store.clear()).catch(() => {});
}

/** Forget every session key this browser holds for a commander (on sign-out). */
export async function forgetSessions(commanderId) {
  if (typeof indexedDB === 'undefined' || !commanderId) return;
  const prefix = `${commanderId}:`;
  await idb('readwrite', (store) => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (String(cursor.key).startsWith(prefix)) cursor.delete();
      cursor.continue();
    };
    return request;
  }).catch(() => {});
}

/**
 * One game's moves: read them opened and verified, and write them with this
 * browser's session key. For a signed game (cfg.sessions false) it reads raw
 * entries and writes plain JSON, as before.
 */
export class Moves {
  constructor(ledger, cfg, topics) {
    this.ledger = ledger;
    this.cfg = cfg;
    this.topics = topics;
    this.passes = new Map(); // verified passes, shared by every read
    this.mine = new Map(); // session key → the pass this commander signed for it
    this.current = null; // { commander, session: DelegatedSession }
    this.info = null; // { session, until } of the credential in use, for the page
  }

  get ready() { return !this.cfg.sessions || !!this.topics; }

  /** Every finalized move on `topic` from `fromHeight`, opened (see openMove). */
  async entries(topic, fromHeight) {
    const raw = await this.ledger.entriesFrom(this.cfg.movesChain, topic, fromHeight);
    if (!this.cfg.sessions) return raw;
    if (!this.topics) throw new Error('this site has no topics.json for games-chain — locally: ./cluster start, then node serve.mjs --local');
    const opened = [];
    for (const entry of raw) opened.push(await openMove(this.topics, this.cfg.scope, entry, this.passes));
    return opened;
  }

  /** Open one message fetched by id (for proofs). */
  async open(message) {
    if (!this.cfg.sessions) return message;
    return openMove(this.topics, this.cfg.scope, message, this.passes);
  }

  #session(commander) {
    if (this.current?.commander === commander) return this.current.session;
    const { chainId, generationId, issuers, delegationEndpoint } = this.topics;
    const scope = this.cfg.scope;
    const session = new DelegatedSession({
      chainId, generationId, scope, issuers, maxDelegationMs: SESSION_MS,
      store: sessionStore(`${commander.id}:${commander.pub}`),
      requestDelegation: async ({ delegate }) => {
        const now = Date.now();
        const request = { v: 1, chainId, generationId, scope, id: commander.id, pub: commander.pub, session: delegate,
          issuedAt: now, expiresAt: now + REQUEST_MS, nonce: nonce() };
        request.sig = await commander.sign(requestStatement(request));
        if (commander.cert) request.cert = commander.cert;
        const result = await topicRequest(delegationEndpoint, request);
        return unhex(result.delegationHex);
      },
    });
    this.current = { commander, session };
    return session;
  }

  /** Make sure this commander holds a live credential for the game; returns { session, until }. */
  async prepare(commander) {
    const session = this.#session(commander);
    try {
      const credential = decodeWire('delegation', await session.ensureDelegation());
      this.info = { session: hex(credential[1]), until: Number(credential[4]) };
      this.error = null;
      return this.info;
    } catch (error) {
      this.error = error.code ?? error.message;
      throw new Error(`no session key from the delegation service: ${this.error}`);
    }
  }

  /** Submit a move through member `relay`. A 202 is admission, not finality. */
  async submit(commander, relay, topic, move) {
    if (!this.cfg.sessions) {
      return this.ledger.submit(this.cfg.movesChain, relay, topic, { body: JSON.stringify(move) });
    }
    if (!commander) throw new Error('sign in to play');
    if (!this.topics) throw new Error('this site has no games-chain topic settings (topics.json)');
    const { session: key } = await this.prepare(commander);
    if (!this.mine.has(key)) {
      const sig = await commander.sign(passStatement(this.topics, this.cfg.scope, commander.id, commander.pub, key));
      this.mine.set(key, { id: commander.id, pub: commander.pub, sig, ...(commander.cert ? { cert: commander.cert } : {}) });
    }
    const payload = utf8(JSON.stringify({ ...move, pass: this.mine.get(key) }));
    const frame = await this.current.session.frame(topic, payload);
    try {
      return await this.ledger.submit(this.cfg.movesChain, relay, topic, { bodyHex: hex(frame) });
    } catch (error) {
      const code = /"code"\s*:\s*"([A-Z_]+)"/.exec(error.body ?? '')?.[1];
      throw code ? new Error(`the members refused it: ${code}`) : error;
    }
  }

  /** Drop this page's session (sign-out or a different commander). */
  async clear() {
    await this.current?.session.clear();
    this.current = null;
    this.info = null;
    this.error = null;
    this.mine.clear();
  }

  /** One line for the page: which key is signing, for what, until when. */
  describe() {
    if (!this.cfg.sessions) return '';
    if (!this.topics) return 'no session keys: this site has no topics.json';
    if (this.error) return `no session key yet: ${this.error}`;
    if (!this.info) return `session key: requesting one for ${this.cfg.scope}…`;
    const until = new Date(this.info.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `session ${this.info.session.slice(0, 6)}…${this.info.session.slice(-4)} · ${this.cfg.scope} · until ${until}`;
  }
}

/**
 * A game page's moves, wired to its sign-in session: a credential is requested as
 * soon as a commander is signed in (so the page can show the session key), and
 * dropped when the commander changes. Call before session.restore().
 */
export async function connectMoves(ledger, cfg, session, onUpdate = () => {}) {
  const topics = cfg.sessions ? await loadTopics().catch(() => null) : null;
  const moves = new Moves(ledger, cfg, topics);
  session.onChange(async (commander) => {
    if (moves.current && moves.current.commander !== commander) await moves.clear();
    onUpdate();
    if (commander && cfg.sessions && topics) {
      await moves.prepare(commander).catch(() => {});
      onUpdate();
    }
  });
  return moves;
}

/** Add the session line under a signed-in panel's key line. */
export function showSession(el, moves) {
  if (!moves?.cfg.sessions) return;
  const line = document.createElement('span');
  line.className = 'session-line';
  line.textContent = moves.describe();
  el.append(document.createElement('br'), line);
}

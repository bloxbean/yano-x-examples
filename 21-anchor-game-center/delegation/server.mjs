#!/usr/bin/env node
// The delegation service over HTTP: POST /delegations, JSON in and out.
//
//   node delegation/server.mjs --config .yano/games/delegation.json
//
// ./cluster start writes that configuration for the local cluster, and
// `node serve.mjs --local` starts this service beside the site. A hosted game
// runs it on its own HTTPS endpoint with an explicit origin allowlist; the
// static site never holds the issuer key, and neither do the members.
//
// The configuration is public apart from keyFile, the path of the issuer's
// 32-byte Ed25519 seed (64 hex characters): an owner-only regular file outside
// the static site.

import http from 'node:http';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ACCOUNTS } from '../shared/config.js';
import { profileKey } from '../shared/accounts.js';
import { decodeEntry } from '../shared/authmap.js';
import { SESSION_MS } from '../shared/sessions.js';
import { hex, signerFromKey, unhex } from '../shared/topic-client/topics.mjs';
import { createDelegationService, DelegationError } from './service.mjs';

const STATIC_ROOT = fileURLToPath(new URL('../', import.meta.url));
const LIMIT = 16384;

/** The issuer's signer, from an owner-only seed file outside the static site. */
export async function loadIssuer(file) {
  const info = await lstat(file);
  const canonical = await realpath(file);
  const insideSite = canonical.startsWith(STATIC_ROOT) && !canonical.startsWith(resolve(STATIC_ROOT, '.yano'));
  if (!info.isFile() || info.isSymbolicLink() || insideSite
      || (process.platform !== 'win32' && (info.mode & 0o077) !== 0) || info.size > 66) {
    throw new Error('the issuer key must be an owner-only regular file outside the served files');
  }
  const encoded = await readFile(canonical);
  const seed = unhex(encoded.toString('ascii').trim(), 32);
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  try {
    const privateKey = await crypto.subtle.importKey('pkcs8', der, 'Ed25519', false, ['sign']);
    const publicKey = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x;
    return signerFromKey({ privateKey, publicKey: Buffer.from(publicKey, 'base64url').toString('hex') });
  } finally {
    der.fill(0);
    encoded.fill(0);
    seed.fill(0);
  }
}

export function createHttpServer(service, { origins = [], maxConcurrent = 32 } = {}) {
  let active = 0;
  const allowed = new Set(origins);
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const respond = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        ...(origin && allowed.has(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}) });
      res.end(JSON.stringify(value));
    };
    if (origin && !allowed.has(origin)) return respond(403, { code: 'DELEGATION_ORIGIN_DENIED' });
    if (req.url !== '/delegations') return respond(404, { code: 'NOT_FOUND' });
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return respond(200, {});
    }
    if (req.method !== 'POST' || req.headers['content-type']?.split(';')[0] !== 'application/json') {
      return respond(415, { code: 'DELEGATION_JSON_REQUIRED' });
    }
    if (active >= maxConcurrent) return respond(503, { code: 'DELEGATION_SERVICE_BUSY' });
    active++;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > LIMIT) return respond(413, { code: 'DELEGATION_REQUEST_TOO_LARGE' });
        chunks.push(chunk);
      }
      let request;
      try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { return respond(400, { code: 'DELEGATION_REQUEST_INVALID' }); }
      const result = await service(request);
      console.log(`  issued a session credential: ${request.id} · ${request.scope} · key ${request.session.slice(0, 8)}…`);
      respond(200, result);
    } catch (error) {
      if (error instanceof DelegationError) {
        console.log(`  refused a credential: ${error.code}`);
        respond(error.status, { code: error.code });
      } else {
        console.log(`  delegation service error: ${error.message}`);
        respond(503, { code: 'DELEGATION_SERVICE_UNAVAILABLE' });
      }
    } finally {
      active--;
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

async function boundedJson(url, request = globalThis.fetch) {
  const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(3000),
    headers: { Accept: 'application/json' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`trusted member answered ${response.status}`);
  const text = await response.text();
  if (text.length > 262144) throw new Error('member response too large');
  return JSON.parse(text);
}

/**
 * Reads from the one member the operator trusts: commander profiles, and whether
 * the issuer may still delegate a scope. Never from anything in a request.
 */
export function trustedPeerReaders(config, issuer, { fetch: request = globalThis.fetch } = {}) {
  unhex(config.profileGenerationId, 32);
  const peer = new URL(config.peer);
  if (!['http:', 'https:'].includes(peer.protocol) || peer.username || peer.password || peer.search || peer.hash) {
    throw new Error('invalid trusted peer');
  }
  const base = config.peer.replace(/\/$/, '');
  const chainPath = (chain) => `${base}/api/v1/app-chain/chains/${encodeURIComponent(chain)}`;
  const profileGeneration = async () => {
    const status = await boundedJson(`${chainPath(ACCOUNTS.profilesChain)}/status`, request);
    if (status.chainId !== ACCOUNTS.profilesChain || status.stateCommitment?.generationId !== config.profileGenerationId) {
      throw new DelegationError('DELEGATION_PROFILE_GENERATION_MISMATCH', 409);
    }
    return status.stateCommitment.version;
  };
  return {
    lookupProfile: async (id) => {
      const before = await profileGeneration();
      const record = await boundedJson(`${base}/api/v1/plugins/org.yanoproject.x.stdlib/authenticated-map/entries/`
        + `${encodeURIComponent(ACCOUNTS.profilesCollection)}/${hex(profileKey(ACCOUNTS, id))}`
        + `?chain=${encodeURIComponent(ACCOUNTS.profilesChain)}`, request);
      const after = await profileGeneration();
      if (record && (record.committedHeight < before || record.committedHeight > after)) {
        throw new DelegationError('DELEGATION_PROFILE_GENERATION_MISMATCH', 409);
      }
      return decodeEntry(record);
    },
    checkAuthority: async (scope) => {
      const status = await boundedJson(`${chainPath(config.chainId)}/status`, request);
      const resolved = await boundedJson(`${chainPath(config.chainId)}/topics/resolve?topic=${encodeURIComponent(scope)}`, request);
      const policy = resolved.outcome?.kind === 'POLICY' ? resolved.outcome.policy : null;
      return status.stateCommitment?.generationId === config.generationId && !!policy && !policy.retired
        && policy.delegate?.includes(issuer.publicKey) && policy.maxDelegationMs >= SESSION_MS;
    },
  };
}

/** Start the service from a configuration file; resolves to the listening server. */
export async function startDelegationServer(configPath, { keyFile, log = true } = {}) {
  const bytes = await readFile(resolve(configPath));
  if (bytes.length > LIMIT) throw new Error('the configuration is too large');
  const config = JSON.parse(bytes.toString('utf8'));
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535
      || !Array.isArray(config.origins) || config.origins.some((origin) => new URL(origin).origin !== origin)) {
    throw new Error('invalid port or allowed origins');
  }
  const issuer = await loadIssuer(resolve(dirname(resolve(configPath)), keyFile ?? config.keyFile));
  if (issuer.publicKey !== config.issuerPublicKey) throw new Error('the issuer key does not match issuerPublicKey');
  const service = createDelegationService({ ...config, issuer, ...trustedPeerReaders(config, issuer) });
  const server = createHttpServer(service, config);
  await new Promise((done) => server.listen(config.port, '127.0.0.1', done));
  if (log) console.log(`Delegation service on http://127.0.0.1:${config.port}/delegations (issuer ${issuer.publicKey.slice(0, 16)}…)`);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const config = option('--config');
  if (!config) {
    console.error('Usage: node delegation/server.mjs --config <service.json> [--key-file <issuer seed file>]');
    process.exit(2);
  }
  startDelegationServer(config, { keyFile: option('--key-file') }).then((server) => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
  }).catch((error) => {
    console.error(`The delegation service could not start: ${error.message}`);
    process.exitCode = 1;
  });
}

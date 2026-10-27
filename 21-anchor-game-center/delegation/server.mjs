#!/usr/bin/env node
import http from 'node:http';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ACCOUNTS } from '../shared/config.js';
import { profileKey } from '../shared/accounts.js';
import { decodeEntry } from '../shared/authmap.js';
import { NEON_SCOPE, SESSION_MS } from '../shared/neon-auth.js';
import { hex, unhex, signerFromKey } from '../shared/topic-client/topics.mjs';
import { createDelegationService, DelegationError } from './service.mjs';

const STATIC_ROOT = fileURLToPath(new URL('../', import.meta.url));
const LIMIT = 16384;

export async function loadIssuer(file) {
  const info = await lstat(file);
  const canonical = await realpath(file);
  if (!info.isFile() || info.isSymbolicLink() || canonical.startsWith(STATIC_ROOT)
      || process.platform !== 'win32' && (info.mode & 0o077) !== 0 || info.size > 66) {
    throw new Error('issuer key must be an owner-only regular file outside the static site');
  }
  const encoded = await readFile(canonical);
  let seed;
  try {
    const value = encoded.toString('ascii').trim();
    seed = unhex(value, 32);
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    try {
      const privateKey = await crypto.subtle.importKey('pkcs8', der, 'Ed25519', false, ['sign']);
      const nodeKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
      const publicKey = createPublicKey(nodeKey).export({ format: 'jwk' }).x;
      return signerFromKey({ privateKey, publicKey: Buffer.from(publicKey, 'base64url').toString('hex') });
    } finally { der.fill(0); }
  } finally { encoded.fill(0); seed?.fill(0); }
}

export function createHttpServer(service, { origins = ['http://localhost:8787'], maxConcurrent = 32 } = {}) {
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
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > LIMIT) return respond(413, { code: 'DELEGATION_REQUEST_TOO_LARGE' });
        chunks.push(chunk);
      }
      let request;
      try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { return respond(400, { code: 'DELEGATION_REQUEST_INVALID' }); }
      respond(200, await service(request));
    } catch (error) {
      respond(error instanceof DelegationError ? error.status : 503,
        { code: error instanceof DelegationError ? error.code : 'DELEGATION_SERVICE_UNAVAILABLE' });
    } finally { active--; }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.maxRequestsPerSocket = 100;
  return server;
}

async function boundedJson(url, request = globalThis.fetch) {
  const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(3000),
    headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('trusted profile peer unavailable');
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 131072) throw new Error('peer response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

export function trustedPeerReaders(config, issuer, { fetch: request = globalThis.fetch } = {}) {
  unhex(config.profileGenerationId, 32);
  const peer = new URL(config.peer);
  if (!['http:', 'https:'].includes(peer.protocol) || peer.username || peer.password || peer.search || peer.hash) {
    throw new Error('invalid trusted peer');
  }
  const base = config.peer.replace(/\/$/, '');
  const chain = `/api/v1/app-chain/chains/${encodeURIComponent(config.chainId)}`;
  const profileStatus = base + `/api/v1/app-chain/chains/${encodeURIComponent(ACCOUNTS.profilesChain)}/status`;
  const checkProfileIdentity = status => {
    if (status.chainId !== ACCOUNTS.profilesChain || status.stateCommitment?.generationId !== config.profileGenerationId
        || !Number.isSafeInteger(status.stateCommitment?.version) || status.stateCommitment.version < 1) {
      throw new DelegationError('DELEGATION_PROFILE_GENERATION_MISMATCH', 409);
    }
    return status.stateCommitment.version;
  };
  return {
    lookupProfile: async id => {
      const before = checkProfileIdentity(await boundedJson(profileStatus, request));
      const path = '/api/v1/plugins/org.yanoproject.x.stdlib/authenticated-map/entries/'
        + `${encodeURIComponent(ACCOUNTS.profilesCollection)}/${hex(profileKey(ACCOUNTS, id))}`
        + `?chain=${encodeURIComponent(ACCOUNTS.profilesChain)}`;
      const record = await boundedJson(base + path, request);
      const after = checkProfileIdentity(await boundedJson(profileStatus, request));
      if (record.chainId !== ACCOUNTS.profilesChain || record.committedHeight < before || record.committedHeight > after) {
        throw new DelegationError('DELEGATION_PROFILE_GENERATION_MISMATCH', 409);
      }
      return decodeEntry(record);
    },
    checkAuthority: async () => {
      const status = await boundedJson(base + chain + '/status', request);
      const resolved = await boundedJson(base + chain + `/topics/resolve?topic=${encodeURIComponent(NEON_SCOPE)}`, request);
      const outcome = resolved.outcome;
      return status.chainId === config.chainId && status.stateCommitment?.generationId === config.generationId
        && outcome?.kind === 'POLICY' && !outcome.policy.retired && outcome.policy.writers?.keys !== null
        && outcome.policy.delegate?.includes(issuer.publicKey) && outcome.policy.maxDelegationMs >= SESSION_MS;
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--key-file') {
    throw new Error('Usage: node delegation/server.mjs --config service.json --key-file /outside/site/issuer.seed');
  }
  const configBytes = await readFile(resolve(args[1]));
  if (configBytes.length > LIMIT) throw new Error('configuration exceeds bound');
  const config = JSON.parse(configBytes.toString('utf8'));
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535
      || !Array.isArray(config.origins) || config.origins.some(origin => new URL(origin).origin !== origin)) {
    throw new Error('invalid server port or allowed origins');
  }
  const issuer = await loadIssuer(resolve(args[3]));
  if (issuer.publicKey !== config.issuerPublicKey) throw new Error('issuer does not match pinned public key');
  const service = createDelegationService({ ...config, issuer, ...trustedPeerReaders(config, issuer) });
  const server = createHttpServer(service, config);
  server.listen(config.port, '127.0.0.1', () => console.log(`Delegation service on 127.0.0.1:${config.port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Delegation service could not start. Check configuration and private-key file.');
    process.exitCode = 1; });
}

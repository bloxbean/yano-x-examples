import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommander } from '../../shared/accounts.js';
import { ACCOUNTS } from '../../shared/config.js';
import { createSessionKey, signerFromKey, decodeWire, verifyDelegation, unhex, hex, encodeCanonicalValue,
  encodeCbor, verifyFrameSignatures } from '../../shared/topic-client/topics.mjs';
import { signedDelegationRequest, NEON_SCOPE } from '../../shared/neon-auth.js';
import { createDelegationService } from '../../delegation/service.mjs';
import { createHttpServer, loadIssuer, trustedPeerReaders } from '../../delegation/server.mjs';
import { decodeMove, NeonTopicSession } from '../../moto/js/topic-session.js';

const chainId = 'neon-rush-chain';
const generationId = '11'.repeat(32);
const now = 1800000000000;
async function fixture(options = {}) {
  const { commander, profileBytes } = await createCommander(ACCOUNTS, 'rider', 'strong test password', 1000);
  const issuer = signerFromKey(await createSessionKey());
  const session = signerFromKey(await createSessionKey());
  const profile = { present: true, status: 0, revision: 1, value: profileBytes, createdHeight: 10, committedHeight: 15 };
  const parameters = { chainId, generationId, scope: NEON_SCOPE, delegate: session.publicKey };
  const request = await signedDelegationRequest(commander, parameters, now);
  const service = createDelegationService({ chainId, generationId, issuer, lookupProfile: async () => profile,
    now: () => now, ...options });
  return { commander, issuer, session, profile, parameters, request, service };
}

test('profile possession issues exactly a one-hour scoped credential and refuses request replay', async () => {
  const f = await fixture();
  const response = await f.service(f.request);
  const bytes = unhex(response.delegationHex);
  assert(await verifyDelegation(chainId, generationId, bytes));
  const value = decodeWire('delegation', bytes);
  assert.equal(hex(value[1]), f.session.publicKey);
  assert.equal(value[2], NEON_SCOPE);
  assert.equal(value[4] - value[3], 3600000);
  assert.equal(hex(value[5]), f.issuer.publicKey);
  await assert.rejects(f.service(f.request), /REPLAYED/);
  assert.deepEqual(Object.keys(response), ['delegationHex']);
});

test('a copied public profile cannot authenticate without signing the session request', async () => {
  const f = await fixture();
  const attacker = await createCommander(ACCOUNTS, 'thief', 'strong test password', 1000);
  const forged = await signedDelegationRequest(attacker.commander, f.parameters, now);
  forged.commander = f.commander.id; forged.publicKey = f.commander.pub;
  await assert.rejects(f.service(forged), /AUTHENTICATION_FAILED/);
  await assert.rejects(f.service({ ...f.request, profile: f.profile.value }), /REQUEST_INVALID/);
  for (const field of ['delegate', 'generationId', 'publicKey']) {
    await assert.rejects(f.service({ ...f.request, [field]: '22'.repeat(32) }), /MISMATCH|AUTHENTICATION_FAILED/);
  }
});

test('only immutable revision-one live profiles on the configured chain count', async () => {
  const f = await fixture();
  for (const mutation of [{ present: false }, { status: 1 }, { revision: 2 }, { createdHeight: 0 },
    { committedHeight: 9 }, { value: new Uint8Array() }]) {
    const service = createDelegationService({ chainId, generationId, issuer: f.issuer, now: () => now,
      lookupProfile: async () => ({ ...f.profile, ...mutation }) });
    await assert.rejects(service(f.request), /PROFILE_INVALID/);
  }
  const forgedProfile = JSON.parse(new TextDecoder().decode(f.profile.value));
  forgedProfile.sig = '00'.repeat(64);
  const service = createDelegationService({ chainId, generationId, issuer: f.issuer, now: () => now,
    lookupProfile: async () => ({ ...f.profile, value: new TextEncoder().encode(JSON.stringify(forgedProfile)) }) });
  await assert.rejects(service(f.request), /PROFILE_INVALID/);
});

test('expiry, foreign chains/scopes, issuer removal and concurrent replays fail closed', async () => {
  const f = await fixture();
  const expired = await signedDelegationRequest(f.commander, f.parameters, now - 60000);
  await assert.rejects(f.service(expired), /EXPIRED/);
  const future = await signedDelegationRequest(f.commander, f.parameters, now + 1001);
  await assert.rejects(f.service(future), /EXPIRED/);
  const foreign = await signedDelegationRequest(f.commander, { ...f.parameters, chainId: 'other' }, now);
  await assert.rejects(f.service(foreign), /MISMATCH/);
  await assert.rejects(f.service({ ...f.request, scope: 'games/other/' }), /INVALID/);
  const removed = createDelegationService({ chainId, generationId, issuer: f.issuer, lookupProfile: async () => f.profile,
    now: () => now, checkAuthority: async () => false });
  await assert.rejects(removed(f.request), /ISSUER_INACTIVE/);
  const results = await Promise.allSettled([f.service(f.request), f.service(f.request)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /REPLAYED/);
});

test('a browser session stores only non-extractable keys and submits/reads the original framed move', async () => {
  const f = await fixture();
  const store = new Map(); let submitted;
  const fetch = async (url, options) => {
    if (url.pathname === '/delegations') {
      const request = JSON.parse(options.body);
      // The production browser uses its wall clock; this fixture pins the service to the same request window.
      const service = createDelegationService({ chainId, generationId, issuer: f.issuer,
        lookupProfile: async () => f.profile, now: () => request.issuedAt });
      return new Response(JSON.stringify(await service(request)));
    }
    submitted = JSON.parse(options.body);
    return new Response(JSON.stringify({ chainId, topic: submitted.topic, messageId: 'ab'.repeat(32) }), { status: 202 });
  };
  const cfg = { chainId, generationId, scope: NEON_SCOPE, issuers: [f.issuer.publicKey],
    delegationEndpoint: 'https://service.test/delegations' };
  const client = new NeonTopicSession(cfg, { fetch, store: () => store });
  const body = { t: 'open' }; const topic = 'games/neon-rush/s2000';
  const result = await client.submit({ bases: ['https://node.test'] }, 0, f.commander, topic, body);
  assert.equal(result.messageId, 'ab'.repeat(32));
  assert(await verifyFrameSignatures({ chainId, generationId, topic }, unhex(submitted.bodyHex)));
  assert.deepEqual(await decodeMove({ movesChain: chainId, generationId }, topic, submitted.bodyHex), body);
  assert.equal(await decodeMove({ movesChain: chainId, generationId }, topic, hex(encodeCanonicalValue(body))), null);
  assert.equal(await decodeMove({ movesChain: chainId, generationId: '22'.repeat(32) }, topic, submitted.bodyHex), null);
  for (const value of store.values()) assert.equal(value.key.privateKey.extractable, false);
  await client.clear(); assert.equal(store.size, 0);
});

test('HTTP bounds input, checks origin and never reflects secrets in errors', async t => {
  const f = await fixture();
  const server = createHttpServer(f.service);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/delegations`;
  const post = (body, origin = 'http://localhost:8787') => fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin }, body });
  let response = await post(JSON.stringify(f.request));
  assert.equal(response.status, 200); assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8787');
  response = await post('{"secret":"canary-secret"}');
  assert.equal(response.status, 400); assert(!await response.text().then(text => text.includes('canary-secret')));
  response = await post('x'.repeat(16385)); assert.equal(response.status, 413);
  response = await post('{}', 'https://untrusted.test'); assert.equal(response.status, 403);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('issuer seed files are private, bounded and imported without extractable key material', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'neon-key-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'issuer.seed');
  await writeFile(file, '12'.repeat(32) + '\n', { mode: 0o600 });
  const issuer = await loadIssuer(file);
  assert.match(issuer.publicKey, /^[0-9a-f]{64}$/);
  assert.equal((await issuer.sign(Uint8Array.of(1))).length, 64);
  await chmod(file, 0o644);
  await assert.rejects(loadIssuer(file), /owner-only/);
  await chmod(file, 0o600);
  const link = join(directory, 'issuer-link.seed'); await symlink(file, link);
  await assert.rejects(loadIssuer(link), /owner-only/);
  for (const invalid of ['00'.repeat(34), '00'.repeat(31), 'gg'.repeat(32)]) {
    await writeFile(file, invalid, { mode: 0o600 }); await assert.rejects(loadIssuer(file));
  }
  const inside = new URL('../../delegation/test-private.seed', import.meta.url);
  await writeFile(inside, '34'.repeat(32), { mode: 0o600 });
  try { await assert.rejects(loadIssuer(inside), /outside the static site/); }
  finally { await rm(inside); }
});

test('nonce reservations are bounded and expire without letting an old request become usable', async () => {
  const f = await fixture(); let time = now;
  const service = createDelegationService({ chainId, generationId, issuer: f.issuer, maxRequests: 1,
    lookupProfile: async () => f.profile, now: () => time });
  await service(f.request);
  await assert.rejects(service(await signedDelegationRequest(f.commander, f.parameters, time)), /SERVICE_BUSY/);
  time += 60001;
  await assert.rejects(service(f.request), /EXPIRED/);
  assert(await service(await signedDelegationRequest(f.commander, f.parameters, time)));
});

test('profile reader pins its separate generation before and after the immutable-record read', async () => {
  const f = await fixture(); let reads = 0; let changed = false;
  const profileGenerationId = '33'.repeat(32);
  const fetch = async url => {
    if (url.endsWith('/status')) {
      reads++;
      return new Response(JSON.stringify({ chainId: ACCOUNTS.profilesChain, stateCommitment: { version: 15,
        generationId: changed && reads >= 2 ? '44'.repeat(32) : profileGenerationId } }));
    }
    return new Response(JSON.stringify({ chainId: ACCOUNTS.profilesChain, committedHeight: 15, record: { presence: 1 },
      recordValue: hex(encodeCbor([1, 0, 1, new Uint8Array(), f.profile.value, new Uint8Array(32), 10, 10])) }));
  };
  const readers = trustedPeerReaders({ chainId, generationId, profileGenerationId, peer: 'http://localhost:7210' }, f.issuer, { fetch });
  assert.deepEqual((await readers.lookupProfile('rider')).value, f.profile.value);
  changed = true; reads = 0;
  await assert.rejects(readers.lookupProfile('rider'), /PROFILE_GENERATION_MISMATCH/);
  await assert.rejects(readers.lookupProfile('rider'), /PROFILE_GENERATION_MISMATCH/);
  assert.throws(() => trustedPeerReaders({ chainId, generationId, peer: 'http://localhost:7210' }, f.issuer));
});

#!/usr/bin/env node
// ADR-038 V4. Fresh, loopback-only, no anchoring or public-network traffic. Preserve evidence; stop on exit.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, mkdir, cp, readFile, writeFile, readdir, chmod, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCommander } from '../../shared/accounts.js';
import { ACCOUNTS } from '../../shared/config.js';
import { Ledger } from '../../shared/ledger.js';
import { Profiles } from '../../shared/profiles.js';
import { signedDelegationRequest, NEON_SCOPE } from '../../shared/neon-auth.js';
import { createDelegationService } from '../../delegation/service.mjs';
import { createHttpServer, loadIssuer, trustedPeerReaders } from '../../delegation/server.mjs';
import { bootstrapCommand } from '../../delegation/bootstrap.mjs';
import { NeonTopicSession, decodeMove } from '../../moto/js/topic-session.js';
import { CONFIG as MOTO } from '../../moto/js/config.js';
import { Circuit, runStatement, inputsHash, seasonTopic, seasonOf } from '../../moto/js/races.js';
import { Run, autopilot } from '../../moto/js/sim.js';
import { encodeInputs } from '../../arcade/js/runs.js';
import { hex, unhex, nonce, createSessionKey, signerFromKey, signWrite, issueDelegation, decodeWire, encodeWire,
  encodeCanonicalValue, encodeCbor, writeStatement, blake2b256, delegationHash, verifySignature }
  from '../../shared/topic-client/topics.mjs';

const execute = promisify(execFile);
const interrupted = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => interrupted.abort());
const arguments_ = process.argv.slice(2);
if (arguments_.length !== 2 || arguments_[0] !== '--distribution') {
  throw new Error('Usage: node test/topics/live-v4.mjs --distribution /path/to/extracted-yano-x');
}
let distribution = resolve(arguments_[1]);
const example = fileURLToPath(new URL('../../', import.meta.url));
const work = await mkdtemp('/private/tmp/yano-neon-v4-'); await chmod(work, 0o700);
let zipSha256;
if (distribution.endsWith('.zip')) {
  zipSha256 = createHash('sha256').update(await readFile(distribution)).digest('hex');
  const extracted = join(work, 'distribution'); await mkdir(extracted);
  await execute('unzip', ['-q', distribution, '-d', extracted], { timeout: 60000 });
  const entries = await readdir(extracted);
  assert.equal(entries.length, 1); distribution = join(extracted, entries[0]);
}
assert((await stat(join(distribution, 'yano.jar'))).isFile());
const clusterHome = join(work, 'cluster'); const data = join(work, 'data'); const secrets = join(work, 'secrets');
await mkdir(clusterHome); await mkdir(secrets, { mode: 0o700 });
const report = { startedAt: new Date().toISOString(), distribution, work, checks: [] };
if (zipSha256) report.distributionZipSha256 = zipSha256;
report.distributionJarSha256 = createHash('sha256').update(await readFile(join(distribution, 'yano.jar'))).digest('hex');
const basePort = 28970; const peers = [0, 1, 2].map(i => `http://127.0.0.1:${basePort + i}`);
const chainId = 'neon-rush-chain'; const prefix = `/api/v1/app-chain/chains/${chainId}`;
const cluster = join(distribution, 'appchain-cluster/cluster.sh');
const apiKey = randomBytes(24).toString('hex');
// Operator shell settings must not redirect a fresh fixture into retained stores, keys or anchoring.
const inherited = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !name.startsWith('YANO_') && !name.startsWith('QUARKUS_')));
const environment = { ...inherited, YANO_HOME: clusterHome, YANO_JAR: join(distribution, 'yano.jar'),
  YANO_PLUGINS_DIRECTORY: join(distribution, 'plugins'), YANO_CLUSTER_API_KEY: apiKey,
  YANO_CLUSTER_MEMBER_KEY_DIR: join(secrets, 'members'), YANO_CLUSTER_NODE_CONFIG_DIR: join(secrets, 'overlays'),
  JAVA_OPTS: '-Xms128m -Xmx512m -Dyano.plugins.startup-diagnostics=full' };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const checked = (name, evidence = true) => { report.checks.push({ name, evidence }); console.log(`PASS ${name}`); };
async function command(file, args, log) {
  try {
    const result = await execute(file, args, { env: environment, cwd: distribution, maxBuffer: 16 * 1024 * 1024,
      timeout: 240000, ...(args[0] === 'stop' ? {} : { signal: interrupted.signal }) });
    if (log) await writeFile(join(work, log), result.stdout + result.stderr, { mode: 0o600 });
    return result.stdout;
  } catch (error) {
    if (log) await writeFile(join(work, log), (error.stdout ?? '') + (error.stderr ?? ''), { mode: 0o600 });
    throw new Error(`Command failed: ${file.split('/').at(-1)} (${log ?? 'inspect public plan with CLI'})`);
  }
}
async function cli(args) { return JSON.parse(await command(join(distribution, 'yano.sh'), ['appchain', 'topics', ...args])); }
async function json(url, body, admin = false) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(admin ? { 'X-API-Key': apiKey } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(10000), interrupted.signal]), redirect: 'error' });
  const text = await response.text();
  if (response.status === 404) return null;
  const value = text ? JSON.parse(text) : null;
  if (!response.ok) { const failure = new Error(value?.code ?? value?.error ?? `HTTP ${response.status}`);
    failure.status = response.status; failure.body = value; throw failure; }
  return value;
}
async function poll(label, fn, ms = 45000) {
  const deadline = Date.now() + ms; let last;
  while (Date.now() < deadline) {
    interrupted.signal.throwIfAborted();
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep(350);
  }
  throw new Error(`Timed out: ${label}`, { cause: last });
}
async function key(name) {
  const path = join(secrets, name + '.seed'); const bytes = randomBytes(32);
  await writeFile(path, bytes.toString('hex') + '\n', { mode: 0o600 }); bytes.fill(0);
  return { path, signer: await loadIssuer(path) };
}
async function readyMessage(id, chain = chainId) {
  return poll('finalized message ' + id, () => json(`${peers[0]}/api/v1/app-chain/chains/${chain}/messages/${id}`));
}
async function planCommand(name, commandValue, signer) {
  const document = { schemaVersion: 1, kind: 'Topics', chainId,
    commands: [{ ...commandValue, nonce: nonce(), ...(commandValue.authority === 'governance'
      ? {} : { notAfter: Date.now() + 180000 }) }] };
  const documentFile = join(work, name + '.json');
  const planFile = join(work, name + '-plan.json');
  await writeFile(documentFile, JSON.stringify(document));
  const plan = await cli(['plan', '--file', documentFile, '--peer', peers[0]]);
  await writeFile(planFile, JSON.stringify(plan));
  if (signer) {
    const signed = await cli(['sign', '--plan', planFile, '--key-file', signer.path]);
    const signedFile = join(work, name + '-signed.json'); await writeFile(signedFile, JSON.stringify(signed));
    const result = await cli(['submit', '--plan', signedFile, '--peer', peers[0]]);
    await readyMessage(result.commands[0].submission.messageId);
    const receipt = await poll('registry receipt', () => json(`${peers[0]}${prefix}/topics/receipts/${result.commands[0].submission.messageId}`));
    assert.equal(receipt.code, 'ACCEPTED');
  } else {
    const result = await cli(['submit', '--plan', planFile, '--peer', peers[0]]);
    assert.equal(result.commands[0].status, 'MEMBER_GOVERNANCE_REQUIRED');
    for (const peer of peers.slice(0, 2)) {
      const response = await json(peer + prefix + '/admin/topics/governance',
        { commandHex: result.commands[0].commandHex }, true);
      await readyMessage(response.messageId);
    }
  }
  return plan;
}
let advanceChain;
async function entry(name, predicate) {
  return poll('active entry ' + name, async () => {
    const entries = await Promise.all(peers.map(peer => json(peer + prefix + '/topics/entries/' + encodeURIComponent(name))));
    if (entries.every(value => value && predicate(value))) return entries[0];
    // This fixture rejects unregistered traffic; an operator vote for unchanged configuration
    // gives an idle chain a block without admitting an unprotected application payload.
    await advanceChain(); return null;
  });
}
// Verify the fixed-membership local fixture's certificate cryptographically, using the same core header format.
// This is a test helper, not a browser trust implementation for changing membership or Cardano anchors.
async function verifyCertificate(proof, members) {
  const b = proof.block; assert.equal(proof.chainId, chainId); assert.equal(proof.finalityCertificate.scheme, 0);
  const header = [b.version, chainId, b.height, unhex(b.consensusContextDigest), b.view, unhex(b.prevHash),
    b.l1Slot, unhex(b.l1BlockHash), b.timestamp, unhex(b.messagesRoot), unhex(b.stateRoot)];
  const blockHash = blake2b256(encodeCbor([...header, unhex(b.proposer), unhex(b.justificationDigest)]));
  assert.equal(hex(blockHash), proof.blockHash); assert.equal(b.stateRoot, proof.stateRoot);
  const value = header.filter((_, index) => index !== 4);
  const u64 = n => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(n)); return bytes; };
  const digest = blake2b256(Buffer.concat([Buffer.from('yano-appchain-commit-v2\0'), u64(b.height), u64(b.view),
    unhex(b.consensusContextDigest), blockHash, blake2b256(encodeCbor(value))]));
  const seen = new Set();
  for (const signature of proof.finalityCertificate.signatures) {
    assert(members.includes(signature.signer) && !seen.has(signature.signer)); seen.add(signature.signer);
    assert(await verifySignature(unhex(signature.signer), unhex(signature.signature), digest));
  }
  assert(seen.size >= 2);
}
let serviceServer; let launched = false;
console.log(`V4 evidence directory: ${work}`);
try {
  await cp(join(distribution, 'config'), join(clusterHome, 'config'), { recursive: true });
  const source = await readFile(join(example, 'chain/application-appchain.yml'), 'utf8');
  const profile = source.match(/    chains\[1\]:[\s\S]*?(?=    chains\[2\]:)/)[0].replace('chains[1]', 'chains[0]');
  const neon = source.slice(source.indexOf('    chains[3]:')).replace('chains[3]', 'chains[1]');
  await writeFile(join(clusterHome, 'config/application-appchain.yml'),
    'yano:\n  plugins:\n    allow-list:\n      - org.yanoproject.x.stdlib\n'
    + '      - org.yanoproject.x.authenticated-map-validators\n'
    + '      - org.yanoproject.x.role-workflow\n      - org.yanoproject.x.composite\n  app-chain:\n' + profile + neon);
  // Capture demo keys without printing them; use file overlays so private seeds do not enter node argv.
  const rows = (await command(cluster, ['keys', '3'])).trim().split('\n').slice(1).map(row => row.trim().split(/\s+/));
  assert.equal(rows.length, 3);
  await mkdir(environment.YANO_CLUSTER_MEMBER_KEY_DIR, { mode: 0o700 });
  await mkdir(environment.YANO_CLUSTER_NODE_CONFIG_DIR, { mode: 0o700 });
  for (let i = 0; i < 3; i++) {
    await writeFile(join(environment.YANO_CLUSTER_MEMBER_KEY_DIR, `node${i}.seed`), rows[i][1] + '\n', { mode: 0o600 });
    await writeFile(join(environment.YANO_CLUSTER_MEMBER_KEY_DIR, `node${i}.public`), rows[i][2] + '\n', { mode: 0o600 });
  }
  const memberKeys = rows.map(row => row[2]);
  const validator = (await readdir(join(distribution, 'plugins'))).find(name => /^yano-x-authenticated-map-validators-bundle-.*\.jar$/.test(name));
  const genesis = await command('java', ['-cp', `${distribution}/yano.jar:${distribution}/plugins/*`,
    'org.yanoproject.x.showcase.ShowcaseAuthenticatedMapConfig', '--validator-bundle',
    join(distribution, 'plugins', validator), '--chain-id', ACCOUNTS.profilesChain,
    '--members', memberKeys.join(','), '--threshold', '2']);
  for (let i = 0; i < 3; i++) await writeFile(join(environment.YANO_CLUSTER_NODE_CONFIG_DIR, `node${i}.properties`),
    'config_ordinal=275\n' + genesis.replace(/yano\.app-chain\.chains\[\d+\]\./g, 'yano.app-chain.chains[0].'), { mode: 0o600 });
  launched = true;
  await command(cluster, ['start', '3', '--jar', '--data-dir', data, '--http-base', String(basePort),
    '--server-base', '28980'], 'cluster-start.log');
  checked('fresh three-node devnet started');
  const status = await json(peers[0] + prefix + '/status');
  await writeFile(join(work, 'initial-status.json'), JSON.stringify(status, null, 2));
  const generationId = status.stateCommitment.generationId;
  report.generationId = generationId;
  advanceChain = async () => {
    const commandHex = hex(bootstrapCommand(generationId));
    const response = await json(peers[0] + prefix + '/admin/topics/governance', { commandHex }, true);
    await readyMessage(response.messageId);
  };
  // The host materializes genesis topic settings in its first committed app block.
  // One member's bounded, non-quorate vote does not change the configured policy.
  await advanceChain();
  await writeFile(join(work, 'post-bootstrap-status.json'), JSON.stringify(await json(peers[0] + prefix + '/status'), null, 2));
  await writeFile(join(work, 'post-bootstrap-config.json'), JSON.stringify(await json(peers[0] + prefix + '/topics/config'), null, 2));
  checked('first governed block materializes genesis topic policy before CLI planning');
  const owner = await key('owner'); let issuer = await key('issuer');
  await planCommand('root', { target: 'games/', operation: 'create', authority: 'governance',
    owners: { threshold: 1, keys: [owner.signer.publicKey] }, policy: { writers: 'open', schema: 'none' } });
  await entry('games/', value => value.active?.content.owners.keys[0] === owner.signer.publicKey);
  let schemaHash;
  const policy = signingKey => ({ writers: { threshold: 1, keys: [signingKey] }, delegate: [signingKey],
    maxDelegationMs: 3600000, maxPayloadBytes: 40000, ...(schemaHash ? { schema: schemaHash } : {}) });
  const child = await planCommand('child', { target: NEON_SCOPE, operation: 'create', authority: 'games/',
    owners: { threshold: 1, keys: [owner.signer.publicKey] },
    policy: { ...policy(issuer.signer.publicKey), schemaCddl: await readFile(join(example, 'delegation/ride.cddl'), 'utf8') } }, owner);
  schemaHash = child.commands[0].afterActivation.policy.schema;
  assert.match(schemaHash, /^[0-9a-f]{64}$/); report.schemaHash = schemaHash;
  await entry(NEON_SCOPE, value => value.active?.content.policy.delegate?.includes(issuer.signer.publicKey));
  checked('governance namespace and owner-signed canonical ride schema activated');
  const { commander, profileBytes } = await createCommander(ACCOUNTS, 'v4rider', randomBytes(20).toString('hex'), 1000);
  const ledger = new Ledger({ nodes: peers.map(url => ({ url })) });
  const profiles = new Profiles(ACCOUNTS, ledger);
  await profiles.register(commander.id, profileBytes, 1);
  checked('commander revision-one profile registered on real authenticated map');
  const profileGenerationId = (await ledger.status(ACCOUNTS.profilesChain)).stateCommitment.generationId;
  report.profileGenerationId = profileGenerationId;
  const serviceConfiguration = { chainId, generationId, profileGenerationId, peer: peers[0] };
  let service = createDelegationService({ ...serviceConfiguration, issuer: issuer.signer,
    ...trustedPeerReaders(serviceConfiguration, issuer.signer) });
  serviceServer = createHttpServer(request => service(request));
  serviceServer.listen(0, '127.0.0.1'); await once(serviceServer, 'listening');
  const endpoint = `http://127.0.0.1:${serviceServer.address().port}/delegations`;
  const clientConfig = { chainId, generationId, scope: NEON_SCOPE, issuers: [issuer.signer.publicKey], delegationEndpoint: endpoint };
  const client = new NeonTopicSession(clientConfig, { store: () => new Map() });
  const sessionKey = signerFromKey(await createSessionKey());
  const request = await signedDelegationRequest(commander, { chainId, generationId, scope: NEON_SCOPE, delegate: sessionKey.publicKey });
  const delegation = unhex((await json(endpoint, request)).delegationHex);
  await assert.rejects(json(endpoint, request), /REPLAYED/);
  const forgedRequest = { ...request, nonce: nonce(), delegate: issuer.signer.publicKey };
  await assert.rejects(json(endpoint, forgedRequest), /AUTHENTICATION_FAILED/);
  checked('real service issued scoped credential and refused copied request/profile authentication');
  const cfg = { ...MOTO, generationId };
  const season = seasonOf(cfg, Date.now()); const topic = seasonTopic(cfg, season);
  const opened = await client.submit(ledger, 1, commander, topic, { t: 'open' });
  await readyMessage(opened.messageId);
  const openingEntry = (await ledger.entriesFrom(chainId, topic, 1)).find(value => value.messageId === opened.messageId);
  const circuit = new Circuit(cfg, season);
  assert((await circuit.apply(openingEntry, profiles.check)).accepted);
  const run = new Run(circuit.track); const inputs = [];
  while (!run.over) { const input = autopilot(run); inputs.push(input); run.step(input); }
  assert(run.finished && run.finished >= 1200 && run.finished <= 9000);
  const encodedInputs = encodeInputs(Uint8Array.from(inputs));
  const ride = { t: 'run', id: commander.id, pub: commander.pub, n: 1, seed: circuit.seed,
    inputs: hex(encodedInputs), frames: run.finished };
  ride.sig = await commander.sign(runStatement(cfg, season, ride.seed, ride.id, ride.n, inputsHash(encodedInputs), ride.frames));
  const submitted = await client.submit(ledger, 2, commander, topic, ride);
  const message = await readyMessage(submitted.messageId);
  const rideEntry = (await ledger.entriesFrom(chainId, topic, 1)).find(value => value.messageId === submitted.messageId);
  assert((await circuit.apply(rideEntry, profiles.check)).accepted);
  assert.deepEqual(await decodeMove(cfg, topic, message.bodyHex), ride);
  checked('session-signed canonical ride accepted, read under original id, commander checked and inputs replayed',
    { messageId: message.messageId, frames: ride.frames, height: message.height });

  async function frame({ atTopic = topic, payload = encodeCanonicalValue({ t: 'open' }), credential = delegation,
    notAfter = Date.now() + 30000 } = {}) {
    return signWrite({ chainId, generationId, topic: atTopic, payload, nonce: nonce(), notAfter, delegation: credential }, [sessionKey]);
  }
  async function refused(label, bytes, code, atTopic = topic) {
    for (let i = 0; i < 3; i++) {
      await assert.rejects(ledger.submit(chainId, i, atTopic, { bodyHex: hex(bytes) }), error => error.body?.includes(code));
    }
    checked(label, code);
  }
  const tampered = decodeWire('frame', await frame()); tampered[2][2][0][1][0] ^= 1;
  await refused('forged session signatures refused on all members', encodeWire('frame', tampered), 'TOPIC_WRITER_DENIED');
  await refused('malformed frames refused on all members', Uint8Array.of(0), 'TOPIC_FRAME_INVALID');
  await refused('replayed write proof refused on all members', unhex(message.bodyHex), 'TOPIC_PROOF_REPLAYED');
  const expiredCredential = await issueDelegation({ chainId, generationId, delegate: sessionKey.publicKey,
    scope: NEON_SCOPE, notBefore: Date.now() - 120000, notAfter: Date.now() - 30000, issuer: issuer.signer });
  await refused('expired proof refused on all members',
    await frame({ credential: expiredCredential, notAfter: Date.now() - 60000 }), 'TOPIC_PROOF_EXPIRED');
  await refused('schema-invalid ride refused on all members', await frame({ payload: encodeCanonicalValue({ t: 'run', frames: 1 }) }), 'TOPIC_SCHEMA_REJECTED');
  const scoped = await issueDelegation({ chainId, generationId, delegate: sessionKey.publicKey,
    scope: topic + '/other', notBefore: Date.now() - 1000, notAfter: Date.now() + 60000, issuer: issuer.signer });
  const outsideStatement = { chainId, generationId, topic, payload: encodeCanonicalValue({ t: 'open' }),
    nonce: nonce(), notAfter: Date.now() + 30000, delegation: scoped };
  const outside = encodeWire('frame', [1, outsideStatement.payload, [unhex(outsideStatement.nonce), outsideStatement.notAfter,
    [[unhex(sessionKey.publicKey), await sessionKey.sign(writeStatement(outsideStatement))]], decodeWire('delegation', scoped)]]);
  await refused('out-of-scope credential refused on all members', outside, 'TOPIC_DELEGATION_INVALID');

  // Keep the full frame/message and prove policy at H against state H-1; never use a current entry as historical evidence.
  const proof = await json(`${peers[0]}${prefix}/messages/${message.messageId}/proof`);
  const package_ = await json(`${peers[0]}${prefix}/messages/${message.messageId}/proof-package`);
  const policyProof = await json(`${peers[0]}${prefix}/topics/proof?topic=${encodeURIComponent(topic)}&height=${message.height}`);
  await writeFile(join(work, 'message-package.json'), JSON.stringify(package_, null, 2));
  await writeFile(join(work, 'policy-proof.json'), JSON.stringify(policyProof, null, 2));
  const block = await json(`${peers[0]}${prefix}/blocks/${message.height}`);
  const sameBlocks = await Promise.all(peers.map(peer => json(`${peer}${prefix}/blocks/${message.height}`)));
  assert(sameBlocks.every(value => value.stateRoot === block.stateRoot && value.messagesRoot === block.messagesRoot && value.certSignatures >= 2));
  const framed = decodeWire('frame', unhex(message.bodyHex));
  const statement = writeStatement({ chainId, generationId, topic, payload: framed[1], nonce: hex(framed[2][0]),
    notAfter: framed[2][1], delegation: framed[2][3] });
  const physicalKey = (kind, hash) => Buffer.concat([Buffer.from('~yano/topics/v1/' + kind + '/'), unhex(hash)]);
  const keys = [physicalKey('used', hex(blake2b256(statement))),
    physicalKey('revoked', delegationHash(chainId, generationId, framed[2][3])),
    physicalKey('schema', policyProof.outcome.policy.schema)];
  const additional = await Promise.all(keys.map(key => json(`${peers[0]}${prefix}/state/proof/${hex(key)}?height=${message.height - 1}`)));
  const finality = await json(`${peers[0]}${prefix}/state/proof/${hex(keys[2])}?height=${message.height}`);
  await verifyCertificate(finality, memberKeys); await verifyCertificate(additional[0], memberKeys);
  assert.equal(finality.blockHash, proof.blockHash);
  assert.equal(finality.block.prevHash, additional[0].blockHash);
  checked('ride block and parent have verified threshold certificates and identical roots on all members');
  const supplied = package_.suppliedMessage;
  const bytesHex = value => Buffer.from(value, 'base64').toString('hex');
  const bundle = { schemaVersion: 1, kind: 'TopicAuthorshipBundle',
    message: { version: supplied.version, messageId: message.messageId, chainId, topic,
      sender: message.sender, senderSeq: message.senderSeq, expiresAt: supplied.expiresAt,
      bodyHex: message.bodyHex, authScheme: supplied.authScheme, authProofHex: bytesHex(supplied.authProof) },
    messageProof: proof, policyProof, additionalStateProofs: additional.map(value => ({ keyHex: value.key,
      presence: value.presence, valueHex: value.valueHex ?? null, proofWireHex: value.proofWireHex })) };
  const trust = { chainId, profile: status.stateCommitment.profile, genesisId: status.stateCommitment.genesisId,
    height: message.height, blockHash: proof.blockHash, messagesRoot: block.messagesRoot,
    parentStateRoot: additional[0].stateRoot, timestamp: block.timestamp };
  const bundleFile = join(work, 'authorship-bundle.json'); const trustFile = join(work, 'trusted-block.json');
  await writeFile(bundleFile, JSON.stringify(bundle, null, 2)); await writeFile(trustFile, JSON.stringify(trust, null, 2));
  const verified = await cli(['verify', message.messageId, '--bundle', bundleFile, '--trusted-block', trustFile]);
  assert.equal(verified.verified, true); assert.equal(verified.writerKind, 'delegated');
  assert.equal(verified.issuer, issuer.signer.publicKey);
  checked('complete delegated authorship verified offline against certificate-pinned block and parent root');

  const rotatedIssuer = await key('issuer-rotated');
  await planCommand('rotate-issuer', { target: NEON_SCOPE, operation: 'update', authority: NEON_SCOPE,
    policy: policy(rotatedIssuer.signer.publicKey) }, owner);
  await entry(NEON_SCOPE, value => value.active?.content.policy.delegate?.[0] === rotatedIssuer.signer.publicKey);
  assert.equal((await json(`${peers[0]}${prefix}/topics/resolve?topic=${encodeURIComponent(topic)}`)).outcome.policy.schema, schemaHash);
  await refused('old issuer credential refused after rotation', await frame(), 'TOPIC_DELEGATION_INVALID');
  const newLogin = await signedDelegationRequest(commander, { chainId, generationId, scope: NEON_SCOPE, delegate: sessionKey.publicKey });
  await assert.rejects(json(endpoint, newLogin), /ISSUER_INACTIVE/);
  issuer = rotatedIssuer;
  service = createDelegationService({ ...serviceConfiguration, issuer: issuer.signer,
    ...trustedPeerReaders(serviceConfiguration, issuer.signer) });
  const refreshed = unhex((await json(endpoint, await signedDelegationRequest(commander,
    { chainId, generationId, scope: NEON_SCOPE, delegate: sessionKey.publicKey }))).delegationHex);
  const refreshedWrite = await ledger.submit(chainId, 0, topic, { bodyHex: hex(await frame({ credential: refreshed })) });
  await readyMessage(refreshedWrite.messageId);
  await refused('ride schema remains enforced after issuer rotation',
    await frame({ credential: refreshed, payload: encodeCanonicalValue({ t: 'run', frames: 1 }) }), 'TOPIC_SCHEMA_REJECTED');
  checked('new issuer authenticates and refreshed credential writes after rotation');

  const recovered = await key('owner-recovered');
  await planCommand('recover', { target: NEON_SCOPE, operation: 'recover', authority: 'governance',
    owners: { threshold: 1, keys: [recovered.signer.publicKey] } });
  await entry(NEON_SCOPE, value => value.active?.content.owners.keys[0] === recovered.signer.publicKey);
  await planCommand('recovered-owner-update', { target: NEON_SCOPE, operation: 'update', authority: NEON_SCOPE,
    policy: policy(issuer.signer.publicKey) }, recovered);
  await entry(NEON_SCOPE, value => value.active?.revision === value.head && value.pending === 0);
  assert.equal((await json(`${peers[0]}${prefix}/topics/resolve?topic=${encodeURIComponent(topic)}`)).outcome.policy.schema, schemaHash);
  checked('threshold governance recovery replaces lost owner and new owner can update policy');

  const followerBefore = await json(peers[2] + prefix + '/status');
  const followerPid = Number((await readFile(join(data, 'node2.pid'), 'utf8')).trim());
  assert(Number.isSafeInteger(followerPid) && followerPid > 1);
  process.kill(followerPid, 'SIGTERM');
  await poll('follower clean shutdown', async () => {
    try { await json(peers[2] + prefix + '/status'); return false; } catch { return true; }
  });
  const missed = await ledger.submit(chainId, 1, topic, { bodyHex: hex(await frame({ credential: refreshed })) });
  const missedMessage = await readyMessage(missed.messageId);
  assert(missedMessage.height > followerBefore.stateCommitment.version);
  checked('two-member quorum finalizes another framed write while follower is stopped',
    { messageId: missed.messageId, height: missedMessage.height });
  const before = await Promise.all(peers.slice(0, 2).map(peer => json(peer + prefix + '/status')));
  await writeFile(join(work, 'before-restart-status.json'), JSON.stringify(before, null, 2));
  await command(cluster, ['stop', '--data-dir', data], 'cluster-stop-restart.log');
  await command(cluster, ['start', '3', '--jar', '--data-dir', data, '--http-base', String(basePort),
    '--server-base', '28980'], 'cluster-restart.log');
  await poll('persisted ride after restart', async () => {
    const values = await Promise.all(peers.map(peer => json(`${peer}${prefix}/blocks/${message.height}`)));
    return values.every(value => value?.stateRoot === block.stateRoot && value.certSignatures >= 2);
  });
  await poll('stopped follower catches up missed finalized frame', async () => {
    const caught = await json(`${peers[2]}${prefix}/messages/${missed.messageId}`);
    return caught?.height === missedMessage.height && caught.bodyHex === missedMessage.bodyHex;
  });
  checked('restarted follower catches up the frame finalized while it was offline');
  const after = await Promise.all(peers.map(peer => json(peer + prefix + '/status')));
  assert(after.every(value => value.stateCommitment.generationId === generationId));
  const identity = value => ({ profile: value.stateCommitment.profile, genesisId: value.stateCommitment.genesisId,
    formatFingerprint: value.stateCommitment.formatFingerprint, generationId: value.stateCommitment.generationId,
    capabilityManifestDigest: value.capabilityManifest.manifestDigest });
  assert(after.every(value => JSON.stringify(identity(value)) === JSON.stringify(identity(after[0]))));
  const commonHeight = Math.min(...after.map(value => value.stateCommitment.version));
  const commonBlocks = await Promise.all(peers.map(peer => json(`${peer}${prefix}/blocks/${commonHeight}`)));
  assert(commonBlocks.every(value => value.stateRoot === commonBlocks[0].stateRoot && value.certSignatures >= 2));
  const afterMessages = await Promise.all(peers.map(peer => json(`${peer}${prefix}/messages/${message.messageId}`)));
  assert(afterMessages.every(value => value.bodyHex === message.bodyHex && value.height === message.height && value.index === message.index));
  await writeFile(join(work, 'after-restart-status.json'), JSON.stringify(after, null, 2));
  report.finalState = { ...identity(after[0]), height: commonHeight, stateRoot: commonBlocks[0].stateRoot,
    rideMessageId: message.messageId, rideHeight: message.height, rideIndex: message.index };
  const profileStatuses = await Promise.all(peers.map(peer => json(`${peer}/api/v1/app-chain/chains/${ACCOUNTS.profilesChain}/status`)));
  assert(profileStatuses.every(value => JSON.stringify(identity(value)) === JSON.stringify(identity(profileStatuses[0]))));
  assert.equal(profileStatuses[0].stateCommitment.generationId, profileGenerationId);
  const profileHeight = Math.min(...profileStatuses.map(value => value.stateCommitment.version));
  const profileBlocks = await Promise.all(peers.map(peer => json(`${peer}/api/v1/app-chain/chains/${ACCOUNTS.profilesChain}/blocks/${profileHeight}`)));
  assert(profileBlocks.every(value => value.stateRoot === profileBlocks[0].stateRoot && value.certSignatures >= 2));
  report.profileChainState = { ...identity(profileStatuses[0]), height: profileHeight, stateRoot: profileBlocks[0].stateRoot };
  checked('profile chain also retains identical roots, generation and capability manifest on all members');
  checked('three-node restart preserves original roots, finality, identity and committed recovery');
  await entry(NEON_SCOPE, value => value.active?.content.owners.keys[0] === recovered.signer.publicKey);
  await refused('ride schema remains enforced after recovery and restart',
    await frame({ credential: refreshed, payload: encodeCanonicalValue({ t: 'run', frames: 1 }) }), 'TOPIC_SCHEMA_REJECTED');
  report.status = 'PASS'; report.completedAt = new Date().toISOString();
} catch (error) {
  report.status = 'FAIL'; report.error = error.message;
  console.error(error); process.exitCode = 1;
} finally {
  if (serviceServer) await new Promise(done => serviceServer.close(done));
  if (launched) {
    try { await command(cluster, ['stop', '--data-dir', data], 'cluster-stop.log'); }
    catch (error) { report.stopError = error.message; process.exitCode = 1; }
  }
  await writeFile(join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`${report.status}: ${work}/report.json`);
}

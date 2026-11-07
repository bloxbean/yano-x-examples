#!/usr/bin/env node
// ./cluster start runs this once the members are live. It plays the game
// publisher and the three operators, with the release's own topic commands:
//
//   1. makes the publisher's two keys in .yano/games/secrets (owner-only):
//        publisher.seed  owns games/ and signs registry changes below it
//        issuer.seed     the only writer of games/, which may delegate: the
//                        delegation service signs session credentials with it
//   2. games/          `topics plan`, then `topics approve` on every member:
//                      a top-level namespace is created by a member vote
//   3. games/<game>/   one entry per game, signed by the publisher alone:
//                      `topics plan`, `topics sign`, `topics submit`
//   4. writes topics.json (public: chain, generation, issuer, endpoint) for the
//      pages, and delegation.json for the delegation service.
//
// Every step is skipped once done, so it is safe to run on every start.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ACCOUNTS, TOPIC_ENTRIES } from '../shared/config.js';

const CHAIN = 'games-chain';
const NAMESPACE = 'games/';
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const STATE = option('--state');
const RELEASE = option('--release');
const NODES = Number(option('--nodes', '3'));
const HTTP_BASE = Number(option('--http-base', '7210'));
if (!STATE || !RELEASE) {
  console.error('Usage: node delegation/setup.mjs --state <.yano> --release <.yano/release> [--nodes 3] [--http-base 7210]');
  process.exit(2);
}
const GAMES = join(STATE, 'games');
const SECRETS = join(GAMES, 'secrets');
const nodeDir = (i) => join(STATE, `node${i}`);
const member = (i = 0) => `http://127.0.0.1:${HTTP_BASE + i}/api/v1/app-chain/chains`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function appchain(...parameters) {
  const run = spawnSync(join(RELEASE, 'yano.sh'), ['appchain', ...parameters], { encoding: 'utf8' });
  if (run.status !== 0) {
    throw new Error(`yano.sh appchain ${parameters.slice(0, 2).join(' ')} failed:\n${(run.stderr || run.stdout).trim()}`);
  }
  return run.stdout;
}

async function json(url, init) {
  const response = await fetch(url, init);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`);
  return response.json();
}

/** A 32-byte Ed25519 seed as 64 hex characters, in an owner-only file. */
function seedFile(name) {
  const file = join(SECRETS, name);
  if (!existsSync(file)) writeFileSync(file, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

const entry = (name) => json(`${member()}/${CHAIN}/topics/entries/${encodeURIComponent(name)}`);
const nonce = () => randomBytes(16).toString('hex');

async function main() {
  mkdirSync(SECRETS, { recursive: true });
  chmodSync(GAMES, 0o700);
  chmodSync(SECRETS, 0o700);
  const publisherSeed = seedFile('publisher.seed');
  const issuerSeed = seedFile('issuer.seed');
  const publisher = appchain('topics', 'public-key', publisherSeed).trim();
  const issuer = appchain('topics', 'public-key', issuerSeed).trim();

  // The registry exists from the chain's first block. A fresh chain has none yet.
  for (let i = 0; !(await json(`${member()}/${CHAIN}/topics/config`))?.enabled; i++) {
    if (i === 0) {
      await json(`${member()}/${CHAIN}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: 'appchain.heartbeat', body: 'anchor-games setup' }) });
    }
    if (i > 60) throw new Error(`${CHAIN} made no first block`);
    await sleep(500);
  }

  if (!(await entry(NAMESPACE))?.active) {
    console.log(`  topics: ${NAMESPACE} — a member vote (owner: the publisher; writer and delegator: the issuer)`);
    const document = join(GAMES, 'games.yaml');
    const plan = join(GAMES, 'games.plan.json');
    writeFileSync(document, `schemaVersion: 1
kind: Topics
chainId: ${CHAIN}
commands:
- target: "${NAMESPACE}"
  operation: create
  authority: governance
  nonce: "${nonce()}"
  owners: {threshold: 1, keys: ["${publisher}"]}
  policy:
    writers: {threshold: 1, keys: ["${issuer}"]}
    delegate: ["${issuer}"]
    maxDelegationMs: 3600000
    maxPayloadBytes: 2048
    schema: none
`);
    appchain('topics', 'plan', document, '--output', plan, '--node-dir', nodeDir(0));
    // Every operator votes through their own node; the last waits until it is in effect.
    for (let i = 0; i < NODES - 1; i++) appchain('topics', 'approve', plan, '--node-dir', nodeDir(i), '--yes', '--no-wait');
    appchain('topics', 'approve', plan, '--node-dir', nodeDir(NODES - 1), '--yes', '--heartbeat', '--timeout', '180');
  }

  const missing = [];
  for (const game of TOPIC_ENTRIES) if (!(await entry(game.scope))?.active) missing.push(game);
  if (missing.length) {
    console.log(`  topics: ${missing.map((g) => g.scope).join(' ')} — signed by the publisher`);
    const document = join(GAMES, 'entries.yaml');
    const plan = join(GAMES, 'entries.plan.json');
    const notAfter = Date.now() + 3_600_000;
    writeFileSync(document, `schemaVersion: 1\nkind: Topics\nchainId: ${CHAIN}\ncommands:\n${missing.map((game) => `- target: "${game.scope}"
  operation: create
  authority: "${NAMESPACE}"
  nonce: "${nonce()}"
  notAfter: ${notAfter}
  owners: {threshold: 1, keys: ["${publisher}"]}
  policy:
    maxPayloadBytes: ${game.maxPayloadBytes}
`).join('')}`);
    appchain('topics', 'plan', document, '--output', plan, '--node-dir', nodeDir(0));
    appchain('topics', 'sign', plan, '--key-file', publisherSeed, '--node-dir', nodeDir(0));
    appchain('topics', 'submit', plan.replace(/\.plan\.json$/, '.signed.json'), '--node-dir', nodeDir(0), '--heartbeat');
  }

  const games = await json(`${member()}/${CHAIN}/status`);
  const profiles = await json(`${member()}/${ACCOUNTS.profilesChain}/status`);
  const topics = { chainId: CHAIN, generationId: games.stateCommitment.generationId, issuers: [issuer],
    delegationEndpoint: '/delegations' };
  writeFileSync(join(GAMES, 'topics.json'), `${JSON.stringify(topics, null, 2)}\n`);
  writeFileSync(join(GAMES, 'delegation.json'), `${JSON.stringify({
    chainId: CHAIN,
    generationId: games.stateCommitment.generationId,
    profileGenerationId: profiles.stateCommitment.generationId,
    scopes: TOPIC_ENTRIES.map((game) => game.scope),
    issuerPublicKey: issuer,
    keyFile: 'secrets/issuer.seed',
    peer: `http://127.0.0.1:${HTTP_BASE}`,
    port: 8788,
    origins: ['http://localhost:8787', 'http://127.0.0.1:8787'],
    nodes: Array.from({ length: NODES }, (_, i) => `http://127.0.0.1:${HTTP_BASE + i}`),
  }, null, 2)}\n`);

  console.log(`  topics: ${NAMESPACE} and ${TOPIC_ENTRIES.length} game entries in effect on ${CHAIN}`);
  console.log(`          publisher ${publisher.slice(0, 16)}…  issuer ${issuer.slice(0, 16)}…  (keys in .yano/games/secrets)`);
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});


#!/usr/bin/env node
// Consortium service registry — Yano X example 02.
//
//   registry publish <key> <url>  --as <member>   claim a key and set its value
//   registry update  <key> <url>  --as <member>   change a key you own
//   registry remove  <key>        --as <member>   release a key you own
//   registry get     <key>       [--from <member>] read it back AND verify it
//   registry log                                   every finalized write attempt
//   registry members                               who this app trusts
//   registry tips                                  per-member view of the chain

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Member, NODE_COUNT, MemberUnreachable } from './client.js';
import { putCommand, deleteCommand, submitCommand, readEntry, writeAttempts } from './registry.js';
import { verifyCertifiedRoot } from './verify.js';
import { selfTest } from '../test/selftest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRUST = JSON.parse(readFileSync(join(HERE, '..', 'trust.json'), 'utf8'));

const MEMBER_KEYS = TRUST.members.map((m) => m.publicKey);
const LABELS = new Map(TRUST.members.map((m, i) => [m.publicKey.toLowerCase(), `${m.label} (node ${i})`]));
const label = (publicKey) => LABELS.get((publicKey ?? '').toLowerCase()) ?? `unknown ${(publicKey ?? '').slice(0, 12)}`;

const members = Array.from({ length: NODE_COUNT }, (_, i) => new Member(i, TRUST.chainId));
const memberIndex = (name) => {
  if (name === undefined) return 0;
  const byIndex = Number(name);
  if (Number.isInteger(byIndex) && byIndex >= 0 && byIndex < NODE_COUNT) return byIndex;
  const found = TRUST.members.findIndex((m) => m.label === name);
  if (found < 0) throw new Error(`unknown member "${name}" — use an index or one of: ${TRUST.members.map((m) => m.label).join(', ')}`);
  return found;
};

function options(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument: ${argv[i]}`);
    if (argv[i + 1] === undefined) throw new Error(`option ${argv[i]} needs a value`);
    values[argv[i].slice(2)] = argv[i + 1];
  }
  return values;
}

// ---------------------------------------------------------------- commands

async function publish(key, value, opts, verb) {
  const as = memberIndex(opts.as);
  process.stdout.write(`Submitting via ${TRUST.members[as].label} ... `);
  const result = await submitCommand(members[as], members, putCommand(key, value));
  console.log('finalized');
  console.log(`  command    ${verb} ${key} = ${value}`);
  console.log(`  messageId  ${result.messageId}`);
  console.log(`  position   height ${result.height}, index ${result.index}`);
  console.log();

  // Finality says the command was recorded. It does not say it was applied.
  const { present, entry } = await readEntry(members[as], key);
  if (present && entry.value === value) {
    console.log(`  Registry now reads: ${key} = ${entry.value}`);
    console.log(`  Owned by ${label(entry.owner)}`);
  } else if (present) {
    console.log(`  Registry still reads: ${key} = ${entry.value}`);
    console.log(`  Owned by ${label(entry.owner)} — the command was finalized but changed nothing.`);
    console.log(`  Only the owner may write this key.`);
  } else {
    console.log('  Registry has no entry for this key — the command changed nothing.');
  }
}

async function remove(key, opts) {
  const as = memberIndex(opts.as);
  process.stdout.write(`Submitting via ${TRUST.members[as].label} ... `);
  const result = await submitCommand(members[as], members, deleteCommand(key));
  console.log('finalized');
  console.log(`  command    delete ${key}`);
  console.log(`  position   height ${result.height}, index ${result.index}`);
  console.log();

  const { present, entry } = await readEntry(members[as], key);
  if (!present) {
    console.log(`  ${key} is gone. The next member to publish it becomes its new owner.`);
  } else {
    console.log(`  Registry still reads: ${key} = ${entry.value}`);
    console.log(`  Owned by ${label(entry.owner)} — a delete by a non-owner changes nothing.`);
  }
}

/**
 * Retrieve a value and verify it, the way a real consumer would.
 *
 * This is the point of the example. The application asks ONE member, and then
 * checks the answer against the member keys it pinned in trust.json.
 */
async function get(key, opts) {
  const from = memberIndex(opts.from);
  const { present, entry, envelope } = await readEntry(members[from], key);

  console.log(`Reading "${key}" from ${TRUST.members[from].label}\n`);
  if (!envelope) {
    console.log('  No answer — this member has no state for that key at all.');
    return;
  }
  if (!present) {
    console.log('  Not in the registry (the member returned an exclusion proof).');
  } else {
    console.log(`  value      ${entry.value}`);
    console.log(`  owner      ${label(entry.owner)}`);
  }
  console.log(`  height     ${envelope.committedHeight}`);
  console.log(`  state root ${envelope.stateRoot}`);
  console.log();

  console.log('Verifying against the member keys this application pinned:\n');
  const result = verifyCertifiedRoot(envelope, {
    chainId: TRUST.chainId,
    memberKeys: MEMBER_KEYS,
    threshold: TRUST.threshold,
  });
  for (const check of result.checks) {
    console.log(`  [${check.ok ? 'ok  ' : 'FAIL'}] ${check.label}`);
    if (check.detail) console.log(`         ${check.detail}`);
  }
  console.log();

  if (!result.ok) {
    console.log('REJECTED — do not use this answer.');
    process.exitCode = 3;
    return;
  }
  console.log(`VERIFIED — ${result.signers.length} of ${MEMBER_KEYS.length} members signed state root`);
  console.log(`           ${result.stateRoot}`);
  console.log(`           at height ${result.height}.`);
  console.log();
  console.log('  Signed by:');
  for (const signer of result.signers) console.log(`    - ${label(signer)}`);
}

async function log(opts) {
  const from = memberIndex(opts.from);
  const attempts = await writeAttempts(members[from], Number(opts.limit ?? 50));
  if (attempts.length === 0) {
    console.log('No writes yet.');
    return;
  }

  console.log('Every finalized write attempt, newest first\n');
  console.log('HEIGHT  OP      KEY                        VALUE                             SUBMITTED BY');
  for (const a of attempts) {
    console.log(
      String(a.height).padEnd(8) +
      a.operation.padEnd(8) +
      a.key.slice(0, 26).padEnd(27) +
      String(a.value ?? '—').slice(0, 33).padEnd(34) +
      label(a.sender));
  }
  console.log(`\n${attempts.length} finalized command(s).`);
  console.log('Being in this log means the members agreed it was submitted.');
  console.log('It does NOT mean it changed the registry — compare with `registry get`.');
}

async function tips() {
  console.log('Per-member view of the chain\n');
  console.log('MEMBER                      HEIGHT     STATE ROOT');
  const seen = new Set();
  let reachable = true;
  for (let i = 0; i < NODE_COUNT; i++) {
    try {
      const tip = await members[i].tip();
      console.log(`${TRUST.members[i].label.padEnd(28)}${String(tip.height).padEnd(11)}${tip.stateRoot}`);
      seen.add(`${tip.height}:${tip.stateRoot}`);
    } catch (error) {
      if (!(error instanceof MemberUnreachable)) throw error;
      console.log(`${TRUST.members[i].label.padEnd(28)}${'-'.padEnd(11)}unreachable`);
      reachable = false;
    }
  }
  console.log();
  if (!reachable) console.log('Some members are unreachable.');
  else if (seen.size === 1) console.log('AGREED — every member finalized the same history.');
  else console.log('Roots differ. Members converge within a block or two; run this again.');
}

function showMembers() {
  console.log('What this application trusts (trust.json)\n');
  console.log(`  chain      ${TRUST.chainId}`);
  console.log(`  threshold  ${TRUST.threshold} of ${TRUST.members.length}\n`);
  TRUST.members.forEach((m, i) => console.log(`  node ${i}  ${m.label.padEnd(16)} ${m.publicKey}`));
  console.log('\nThese keys are pinned by the application, not fetched from a node.');
  console.log('Every answer is checked against them. Nothing else is trusted.');
}

function usage() {
  console.log(`Consortium service registry — Yano X example 02

  registry publish <key> <url> --as <member>    claim a key and set its value
  registry update  <key> <url> --as <member>    change a key you own
  registry remove  <key>       --as <member>    release a key you own
  registry get     <key>      [--from <member>] read it back and verify it
  registry log                [--limit <n>]     every finalized write attempt
  registry members                              who this application trusts
  registry tips                                 per-member view of the chain

<member> is a node index (0..${NODE_COUNT - 1}) or a label: ${TRUST.members.map((m) => m.label).join(', ')}

The chain must be running: ./cluster start 3`);
}

// -------------------------------------------------------------------- main

const [command, ...rest] = process.argv.slice(2);

try {
  // The verifier is only meaningful if its primitives are correct, so the
  // BLAKE2b and CBOR self-tests run before any verification does.
  selfTest();

  switch (command) {
    case 'publish': await publish(rest[0], rest[1], options(rest.slice(2)), 'publish'); break;
    case 'update':  await publish(rest[0], rest[1], options(rest.slice(2)), 'update'); break;
    case 'remove':  await remove(rest[0], options(rest.slice(1))); break;
    case 'get':     await get(rest[0], options(rest.slice(1))); break;
    case 'log':     await log(options(rest)); break;
    case 'tips':    await tips(); break;
    case 'members': showMembers(); break;
    case undefined:
    case 'help':    usage(); break;
    default:
      console.error(`unknown command: ${command}`);
      usage();
      process.exit(1);
  }
} catch (error) {
  if (error instanceof MemberUnreachable) {
    console.error('error: cannot reach the chain — is it running? (./cluster start 3)');
    console.error(`       ${error.message}`);
    process.exit(2);
  }
  console.error(`error: ${error.message}`);
  process.exit(2);
}

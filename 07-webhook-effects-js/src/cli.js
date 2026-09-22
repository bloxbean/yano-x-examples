#!/usr/bin/env node
// Release approvals that call an ERP — Yano X example 07.
//
//   erp release <orderId> [--required 2] [--via N]   propose a release
//   erp approve <orderId> --as <member>              approve it
//   erp reject  <orderId> --as <member>
//   erp show    <orderId>                            decision AND effect state
//   erp effects                                      every effect this chain emitted
//   erp members                                      which member runs the executor

import {
  CHAIN_ID, NODE_COUNT, MemberUnreachable,
  submit, awaitFinalized, status, effects as effectRecords,
} from './client.js';
import {
  TOPIC, webhookPayload, propose, approve, reject,
  decision, effectState,
} from './approvals.js';

const DEADLINE_MS = 30 * 60 * 1000;   // generous, so a paused demo cannot expire

function options(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument: ${argv[i]}`);
    if (argv[i + 1] === undefined) throw new Error(`option ${argv[i]} needs a value`);
    values[argv[i].slice(2)] = argv[i + 1];
  }
  return values;
}

const memberIndex = (value, fallback = 0) => {
  if (value === undefined) return fallback;
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index >= NODE_COUNT) {
    throw new Error(`member must be 0..${NODE_COUNT - 1}`);
  }
  return index;
};

// ------------------------------------------------------------------ commands

async function release(orderId, opts) {
  const required = Number(opts.required ?? 2);
  const via = memberIndex(opts.via);

  // What the ERP will receive, verbatim, if and only if this is approved.
  const body = JSON.stringify({ action: 'release-order', orderId });
  const payload = webhookPayload(body);
  const deadline = Date.now() + DEADLINE_MS;

  console.log(`Proposing the release of ${orderId}\n`);
  console.log(`  requires   ${required} approvals`);
  console.log(`  payload    ${body}`);
  console.log(`  submitted  via member ${via}`);

  const accepted = await submit(via, TOPIC, propose(orderId, payload, required, deadline));
  await awaitFinalized(accepted.messageId);

  const state = await decision(orderId);
  console.log(`\n  decision   ${state?.state ?? 'PENDING'}`);
  console.log(`\n  Nothing has been called yet. The ERP hears about this only if`);
  console.log(`  ${required} members approve it.`);
}

async function vote(orderId, opts, approving) {
  const via = memberIndex(opts.as ?? opts.via);
  const before = await decision(orderId);
  if (!before) throw new Error(`no open release for ${orderId} — propose it first`);

  console.log(`${approving ? 'Approving' : 'Rejecting'} ${orderId} as member ${via}\n`);
  const accepted = await submit(via, TOPIC,
    approving ? approve(orderId) : reject(orderId));
  await awaitFinalized(accepted.messageId);

  const after = await decision(orderId);
  console.log(`  decision   ${after.state}   (${after.approvals} of ${after.required} approvals: ${after.approvers.join(', ')})`);

  if (after.state !== 'APPROVED') {
    console.log(`\n  Still short of the threshold — no effect emitted, nothing called.`);
    return;
  }

  console.log(`\n  APPROVED. An effect was emitted as part of this block.`);
  process.stdout.write('  waiting for the executor to call the ERP and report back');
  const outcome = await awaitEffect(orderId);
  console.log();
  if (outcome) {
    console.log(`\n  effect     ${outcome.state}   (committed at height ${outcome.height})`);
    console.log(`  effect id  ${outcome.effectId}`);
    if (outcome.detail) console.log(`  result     ${outcome.detail}`);
    describeOutcome(outcome.state);
  } else {
    console.log('\n  effect     no outcome recorded yet — `erp show` again in a moment');
  }
}

function describeOutcome(state) {
  if (state === 'CONFIRMED') {
    console.log('\n  The ERP answered 2xx, and that outcome is now part of consensus —');
    console.log('  every member agrees the call happened and succeeded.');
  } else if (state === 'FAILED') {
    console.log('\n  The ERP answered 4xx. That is permanent: the request was wrong, so');
    console.log('  repeating it would not help. The approval is still APPROVED — only');
    console.log('  the separate effect record says the call failed.');
  }
}

/** Poll the effect's committed state until it leaves PENDING. */
async function awaitEffect(orderId, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await effectState(orderId);
    if (last && last.state !== 'PENDING') return last;
    process.stdout.write('.');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return last;
}

async function show(orderId) {
  const [state, effect] = await Promise.all([decision(orderId), effectState(orderId)]);
  console.log(`Order ${orderId}\n`);
  if (!state) {
    console.log('  no release proposed');
    return;
  }
  console.log(`  decision   ${state.state}   (${state.approvals} of ${state.required} approvals)`);
  console.log(`  effect     ${effect ? effect.state : 'not emitted'}` +
    (effect?.detail ? `   (${effect.detail})` : ''));
  console.log(`
  Two separate facts, committed separately:

    decision   what the members agreed to do
    effect     whether the outside world actually did it

  An approval does not become "un-approved" because a webhook failed.`);
}

async function listEffects() {
  const records = await effectRecords();
  const list = records?.effects ?? records?.records ?? records;
  console.log('Effects emitted by this chain\n');
  if (!Array.isArray(list) || list.length === 0) {
    console.log('  none yet');
    return;
  }
  for (const record of list) {
    console.log(`  height ${record.height ?? '?'}  ordinal ${record.ordinal ?? '?'}  ` +
      `${record.type ?? record.effectType ?? '?'}  ${record.status ?? record.state ?? ''}`);
  }
  const stats = (await status()).effects?.executor;
  if (stats) {
    console.log(`\n  executor: executed=${stats.executed ?? 0} ` +
      `openOnChain=${stats.openOnChain ?? 0}`);
  }
}

async function members() {
  console.log(`Members of ${CHAIN_ID}\n`);
  for (let i = 0; i < NODE_COUNT; i++) {
    const executor = (await status(i)).effects?.executor;
    const runs = executor?.enabled ?? false;
    console.log(`  member ${i}   executor ${runs ? 'ENABLED — this one calls the ERP' : 'disabled'}`);
  }
  console.log(`
  Every member agrees an effect was emitted and later agrees what its outcome
  was. Only one is configured to perform it. That split is why the executor
  endpoint is node-local config and the emission rule is consensus config.`);
}

// ---------------------------------------------------------------------- main

function usage() {
  console.log(`Release approvals that call an ERP — Yano X example 07

  erp release <orderId> [--required 2] [--via N]
  erp approve <orderId> --as <member>
  erp reject  <orderId> --as <member>
  erp show    <orderId>
  erp effects
  erp members

The chain must be running:   ./cluster start 3
The ERP receiver must be up: npm run receiver`);
}

const [command, ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case 'release': await release(rest[0], options(rest.slice(1))); break;
    case 'approve': await vote(rest[0], options(rest.slice(1)), true); break;
    case 'reject':  await vote(rest[0], options(rest.slice(1)), false); break;
    case 'show':    await show(rest[0]); break;
    case 'effects': await listEffects(); break;
    case 'members': await members(); break;
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
    process.exit(2);
  }
  console.error(`error: ${error.message}`);
  process.exit(2);
}

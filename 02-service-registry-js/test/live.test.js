// Does the verifier still match the actual runtime?
//
// The offline tests use a captured envelope. That pins the verifier's logic,
// but a fixture cannot notice if a future Yano release changes how a block
// header is encoded — it would keep passing while every live answer failed.
//
// This test closes that gap: it writes a real entry to a running chain, reads
// the answer back from a DIFFERENT member, and verifies it. If the header
// encoding ever drifts, this is what fails.
//
//   ./cluster start 3
//   npm run test:live

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Member, NODE_COUNT, MemberUnreachable } from '../src/client.js';
import { putCommand, submitCommand, readEntry } from '../src/registry.js';
import { verifyCertifiedRoot } from '../src/verify.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRUST = JSON.parse(readFileSync(join(HERE, '..', 'trust.json'), 'utf8'));

const trust = {
  chainId: TRUST.chainId,
  memberKeys: TRUST.members.map((m) => m.publicKey),
  threshold: TRUST.threshold,
};

const members = Array.from({ length: NODE_COUNT }, (_, i) => new Member(i, TRUST.chainId));
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });

/**
 * Wait for a specific member to have the entry.
 *
 * Finality on the member that accepted the write does not mean every other
 * member has already applied that block — they converge within a block or two.
 * Reading from a different member is the whole point of this test, so it has to
 * wait for that member rather than assume it has caught up.
 */
async function awaitEntry(member, key, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await readEntry(member, key);
    if (result.present || Date.now() >= deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

try {
  // A unique key per run, so repeated runs do not collide over ownership.
  const key = `live-test.${Date.now()}`;
  const value = `https://live.example/${Math.random().toString(36).slice(2, 8)}`;

  // Write through member 0 ...
  await submitCommand(members[0], members, putCommand(key, value));

  // ... and read it back from member 2. A different member must have the same
  // answer, and must be able to produce a certificate for it.
  const { present, entry, envelope } = await awaitEntry(members[2], key);
  check('a different member returns the value that was written', present && entry.value === value,
    present ? entry.value : 'absent');
  check('the entry is owned by the member that wrote it',
    entry?.owner === trust.memberKeys[0], entry?.owner?.slice(0, 12));

  // The real point: verify a FRESH envelope, not a fixture.
  const verified = verifyCertifiedRoot(envelope, trust);
  check('a freshly produced envelope verifies against the pinned keys', verified.ok,
    verified.checks.find((c) => !c.ok)?.label ?? `${verified.signers?.length} signers`);

  // Tamper with the live envelope too, so this is not just a happy path.
  const tampered = JSON.parse(JSON.stringify(envelope));
  tampered.block.timestamp += 1;
  check('a tampered live envelope is rejected', !verifyCertifiedRoot(tampered, trust).ok);

  // Every member should agree on the same root at the same height.
  const tips = await Promise.all(members.map((m) => m.tip()));
  const distinct = new Set(tips.map((t) => `${t.height}:${t.stateRoot}`));
  check('all members report the same tip and state root', distinct.size === 1,
    `${distinct.size} distinct view(s)`);
} catch (error) {
  if (error instanceof MemberUnreachable) {
    console.error('live tests skipped — the chain is not running.');
    console.error('start it with: ./cluster start 3');
    process.exit(1);
  }
  throw error;
}

console.log('Live verification against a running chain\n');
for (const c of checks) {
  console.log(`  [${c.ok ? 'ok  ' : 'FAIL'}] ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);

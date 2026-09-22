// Does the verifier actually REJECT things?
//
// A verifier that returns "ok" for everything passes every happy-path test
// ever written. These are the tests that matter: each one takes a genuine
// envelope captured from a running chain, breaks exactly one thing, and
// requires the verifier to notice.
//
// No cluster needed — the fixture is self-contained. Run with: npm test

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { verifyCertifiedRoot } from '../src/verify.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'state-proof.json'), 'utf8'));
const TRUST = JSON.parse(readFileSync(join(HERE, '..', 'trust.json'), 'utf8'));

const baseTrust = {
  chainId: FIXTURE.chainId,
  memberKeys: TRUST.members.map((m) => m.publicKey),
  threshold: TRUST.threshold,
};

const clone = () => JSON.parse(JSON.stringify(FIXTURE));
const results = [];

/** Expect the verifier to accept. */
function accepts(name, envelope = clone(), trust = baseTrust) {
  const outcome = verifyCertifiedRoot(envelope, trust);
  results.push({ name, ok: outcome.ok, expected: 'accept', detail: outcome.checks.find((c) => !c.ok)?.label });
}

/** Expect the verifier to reject — and say which check caught it. */
function rejects(name, mutate, trust = baseTrust) {
  const envelope = clone();
  mutate(envelope);
  const outcome = verifyCertifiedRoot(envelope, trust);
  const caughtBy = outcome.checks.find((c) => !c.ok)?.label ?? '(nothing)';
  results.push({ name, ok: !outcome.ok, expected: 'reject', detail: caughtBy });
}

// --- the control ------------------------------------------------------------

accepts('a genuine envelope is accepted');

// --- tampering with what the header commits to ------------------------------

rejects('state root replaced', (e) => { e.block.stateRoot = 'ff'.repeat(32); e.stateRoot = 'ff'.repeat(32); });
rejects('messages root replaced', (e) => { e.block.messagesRoot = '00'.repeat(32); });
rejects('timestamp moved by 1ms', (e) => { e.block.timestamp += 1; });
rejects('previous block hash replaced', (e) => { e.block.prevHash = 'ab'.repeat(32); });
rejects('proposer swapped', (e) => { e.block.proposer = 'cd'.repeat(32); });
rejects('view number changed', (e) => { e.block.view += 1; });
rejects('height changed in the header', (e) => { e.block.height += 1; });
rejects('consensus context digest replaced', (e) => { e.block.consensusContextDigest = '11'.repeat(32); });
rejects('justification digest replaced', (e) => { e.block.justificationDigest = '22'.repeat(32); });

// --- tampering with the certificate -----------------------------------------

rejects('one signature corrupted, dropping 2-of-3 to 1',
  (e) => { e.finalityCertificate.signatures[0].signature = '00'.repeat(64); });
rejects('both signatures corrupted', (e) => {
  for (const s of e.finalityCertificate.signatures) s.signature = '00'.repeat(64);
});
rejects('all signatures removed', (e) => { e.finalityCertificate.signatures = []; });
rejects('a signature re-attributed to another member', (e) => {
  e.finalityCertificate.signatures[0].signer = e.finalityCertificate.signatures[1].signer;
});
rejects('the same valid signature counted twice', (e) => {
  e.finalityCertificate.signatures = [e.finalityCertificate.signatures[0], e.finalityCertificate.signatures[0]];
});
rejects('signed by a key that is not a pinned member', (e) => {
  e.finalityCertificate.signatures[0].signer = 'de'.repeat(32);
  e.finalityCertificate.signatures[1].signer = 'ef'.repeat(32);
});

// --- the envelope disagreeing with itself -----------------------------------

rejects('proof height does not match the header', (e) => { e.committedHeight += 1; });
rejects('proof state root does not match the header', (e) => { e.stateRoot = 'aa'.repeat(32); });
rejects('header missing entirely', (e) => { delete e.block; });
rejects('certificate missing entirely', (e) => { delete e.finalityCertificate; });

// --- the verifier's own expectations ----------------------------------------

rejects('answer is for a different chain', (e) => { e.chainId = 'some-other-chain'; },
  { ...baseTrust, chainId: 'some-other-chain-we-pinned' });
rejects('application pinned the wrong member keys', (e) => e,
  { ...baseTrust, memberKeys: ['aa'.repeat(32), 'bb'.repeat(32), 'cc'.repeat(32)] });
rejects('threshold raised to 3 but only 2 members signed', (e) => e,
  { ...baseTrust, threshold: 3 });

// --- runner -----------------------------------------------------------------

export function runVerifierTests({ verbose = false } = {}) {
  const failed = results.filter((r) => !r.ok);
  if (verbose) {
    for (const r of results) {
      const mark = r.ok ? 'ok  ' : 'FAIL';
      const note = r.expected === 'reject' && r.ok ? `  → caught by: ${r.detail}` : '';
      console.log(`  [${mark}] ${r.name}${note}`);
    }
  }
  if (failed.length > 0) {
    throw new Error('verifier did not behave as required:\n' +
      failed.map((r) => `  ${r.name} — expected to ${r.expected}`).join('\n'));
  }
  return results.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('Verifier rejection tests\n');
  const count = runVerifierTests({ verbose: true });
  console.log(`\n${count} checks passed.`);
}

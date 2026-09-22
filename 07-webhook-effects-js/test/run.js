// Checks that need no chain: the wire encodings this example builds by hand.
import * as cbor from '../src/cbor.js';
import { propose, approve, reject, webhookPayload, itemKey, effectKey } from '../src/approvals.js';

const hex = (b) => Buffer.from(b).toString('hex');
const checks = [];
const check = (name, actual, expected) =>
  checks.push({ name, ok: actual === expected, actual, expected });

// Canonical CBOR maps sort by encoded key length, then bytewise. The runtime
// applies the same rule, so a map built here must match byte for byte.
check('canonical map orders keys',
  hex(cbor.map([['content-type', cbor.uint(1)], ['body', cbor.uint(2)]])),
  hex(cbor.map([['body', cbor.uint(2)], ['content-type', cbor.uint(1)]])));
check('shorter key sorts first',
  hex(cbor.map([['bb', cbor.uint(1)], ['a', cbor.uint(2)]])).startsWith('a2' + '61' + '61'),
  true);

// The webhook payload is the map the executor consumes.
const payload = webhookPayload('{"a":1}', 'application/json');
check('webhook payload is a 2-entry map', payload[0] & 0xe0, 0xa0);
check('webhook payload entry count', payload[0] & 0x1f, 2);

// Approvals commands.
check('propose is [0, itemId, payload, required, deadline]',
  propose('x', Uint8Array.of(1, 2), 2, 5).slice(0, 8), '8500' + '6178');
check('approve is [1, itemId]', approve('x'), '820161' + '78');
check('reject is [2, itemId]', reject('x'), '820261' + '78');

// State keys are plain UTF-8, and the two records are distinct.
check('item key is i/<id>', itemKey('ORD-1'), hex(Buffer.from('i/ORD-1')));
check('effect key is ae/s/<id>', effectKey('ORD-1'), hex(Buffer.from('ae/s/ORD-1')));
check('decision and effect are different keys',
  itemKey('ORD-1') === effectKey('ORD-1'), false);

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`  [${c.ok ? 'ok  ' : 'FAIL'}] ${c.name}`);
if (failed.length) {
  console.error('\n' + failed.map((c) =>
    `  ${c.name}\n    expected ${c.expected}\n    actual   ${c.actual}`).join('\n'));
  process.exit(1);
}
console.log(`\n${checks.length} checks passed.`);

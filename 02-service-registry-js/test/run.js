// Everything that can be checked without a running chain.
//
//   npm test        this file
//   npm run test:live   the same verifier against a live chain

import { selfTest } from './selftest.js';
import { runVerifierTests } from './verifier.test.js';

console.log('1. Verification primitives (BLAKE2b, CBOR, header hashing)\n');
const primitives = selfTest({ verbose: true });

console.log('\n2. Verifier rejection behaviour\n');
const rejections = runVerifierTests({ verbose: true });

console.log(`\nAll good — ${primitives + rejections} checks passed.`);
console.log('Run `npm run test:live` against a started chain to check the');
console.log('verifier still matches the runtime.');

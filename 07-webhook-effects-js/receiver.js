#!/usr/bin/env node
// The ERP endpoint — a separate system that knows nothing about Yano.
//
// This is what the chain calls when a release is approved. It exists to show
// three things about the effect contract:
//
//   1. The request carries a DETERMINISTIC Idempotency-Key. Execution is
//      at-least-once, so a receiver must deduplicate on it. This one keeps a
//      set and reports duplicates rather than acting twice.
//
//   2. The status code decides the outcome that gets written back into
//      consensus:
//        2xx  confirmed
//        4xx  failed, and NOT retried — the request was wrong, repeating it
//             will not help
//        5xx  retryable, with bounded backoff
//
//   3. Nothing here is Yano-specific. It is an HTTP handler.
//
// Run it with:  node receiver.js          (or npm run receiver)
//   --fail-4xx      reject everything with 400, to watch the effect FAIL
//   --fail-5xx N    fail the first N attempts with 503, then succeed

import { createServer } from 'node:http';

const PORT = Number(process.env.RECEIVER_PORT ?? 8160);
const args = process.argv.slice(2);
const FAIL_4XX = args.includes('--fail-4xx');
const FAIL_5XX_TIMES = args.includes('--fail-5xx')
  ? Number(args[args.indexOf('--fail-5xx') + 1] ?? 1) : 0;

const seen = new Map();          // idempotency key -> how many times delivered
const handled = new Set();       // idempotency keys we actually acted on
let transientRemaining = FAIL_5XX_TIMES;

const stamp = () => new Date().toISOString().slice(11, 23);

const server = createServer((request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }

  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const key = request.headers['idempotency-key'] ?? '(none)';
    const delivery = (seen.get(key) ?? 0) + 1;
    seen.set(key, delivery);

    console.log(`\n[${stamp()}] POST ${request.url}`);
    console.log(`  Idempotency-Key  ${key}`);
    console.log(`  X-App-Chain-Id   ${request.headers['x-app-chain-id'] ?? '-'}`);
    console.log(`  X-Effect-Id      ${request.headers['x-effect-id'] ?? '-'}`);
    console.log(`  X-Effect-Type    ${request.headers['x-effect-type'] ?? '-'}`);
    console.log(`  Content-Type     ${request.headers['content-type'] ?? '-'}`);
    console.log(`  body             ${body}`);

    // Order matters. Deduplication means "already ACTED on", not "already
    // seen" — a retry after a transient failure is a fresh attempt at work
    // that never happened, and must not be waved through as a duplicate.
    if (FAIL_4XX) {
      console.log('  → 400, permanent failure: the effect will be recorded as FAILED');
      response.writeHead(400).end('rejected by the ERP');
      return;
    }
    if (transientRemaining > 0) {
      transientRemaining -= 1;
      console.log(`  → 503, transient: not handled, so it will be retried `
        + `(${transientRemaining} more failure(s) queued)`);
      response.writeHead(503).end('try again');
      return;
    }

    if (handled.has(key)) {
      // At-least-once delivery: a crash at the acknowledgement boundary can
      // produce another physical POST with the same key. Releasing the order
      // twice is exactly what the key is there to prevent.
      console.log(`  → DUPLICATE (delivery #${delivery}) — already released, acknowledging again`);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"duplicate":true}');
      return;
    }

    handled.add(key);
    console.log(`  → 200, released on attempt #${delivery}. `
      + 'The chain will record this outcome as CONFIRMED.');
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"released":true}');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ERP receiver listening on http://127.0.0.1:${PORT}/erp/release`);
  if (FAIL_4XX) console.log('mode: rejecting everything with 400');
  if (FAIL_5XX_TIMES) console.log(`mode: failing the first ${FAIL_5XX_TIMES} attempt(s) with 503`);
  console.log('waiting for the chain to call ...');
});

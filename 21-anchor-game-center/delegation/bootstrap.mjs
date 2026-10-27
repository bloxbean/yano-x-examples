#!/usr/bin/env node
// First-block bootstrap for this fresh local example only. One member vote cannot change policy.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodeWire, hex, unhex, nonce, topicRequest } from '../shared/topic-client/topics.mjs';

export function bootstrapCommand(generationId) {
  // Exactly chain/application-appchain.yml plus the documented host defaults.
  const settings = [true, null, false, true, 3600000, 604800000, 4, 100000, 1000, 2, 600];
  return encodeWire('governance-command', ['yano-topic-governance-v1', 'neon-rush-chain', unhex(generationId, 32),
    unhex(nonce(), 16), [3, settings]]);
}

export async function bootstrap({ peer, apiKey, fetch: request = globalThis.fetch }) {
  const url = new URL(peer);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !apiKey) {
    throw new Error('Bootstrap needs a local HTTP peer and YANO_OPERATOR_API_KEY');
  }
  const base = url.origin + '/api/v1/app-chain/chains/neon-rush-chain';
  const response = await request(base + '/status', { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Local chain status unavailable');
  const status = await response.json();
  if (status.chainId !== 'neon-rush-chain' || status.stateCommitment?.version !== 0
      || status.membershipMode !== 'governed' || !Number.isSafeInteger(status.threshold) || status.threshold < 2) {
    throw new Error('Bootstrap requires a fresh governed Neon chain with threshold at least two');
  }
  return topicRequest(base + '/admin/topics/governance',
    { commandHex: hex(bootstrapCommand(status.stateCommitment.generationId)) },
    { fetch: request, headers: { 'X-API-Key': apiKey } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== '--peer') {
    console.error('Usage: node delegation/bootstrap.mjs --peer http://127.0.0.1:7210'); process.exitCode = 1;
  } else {
    bootstrap({ peer: process.argv[3], apiKey: process.env.YANO_OPERATOR_API_KEY })
      .then(value => console.log(`Submitted first-block member vote: ${value.messageId}. Wait for finality, then plan games/.`))
      .catch(() => { console.error('Bootstrap refused or unavailable; inspect local chain status and operator configuration.');
        process.exitCode = 1; });
  }
}

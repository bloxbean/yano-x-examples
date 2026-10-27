import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap } from '../../delegation/bootstrap.mjs';
import { decodeWire, unhex, hex } from '../../shared/topic-client/topics.mjs';

const generationId = '11'.repeat(32);
const status = { chainId: 'neon-rush-chain', membershipMode: 'governed', threshold: 2,
  stateCommitment: { version: 0, generationId } };

test('fresh local bootstrap sends one public member vote for the exact configured genesis settings', async () => {
  let votes = 0;
  const fetch = async (url, options) => {
    if (String(url).endsWith('/status')) return new Response(JSON.stringify(status));
    votes++;
    assert.equal(options.headers['X-API-Key'], 'synthetic-test-credential');
    const command = decodeWire('governance-command', unhex(JSON.parse(options.body).commandHex));
    assert.equal(command[1], 'neon-rush-chain'); assert.equal(hex(command[2]), generationId);
    assert.deepEqual(command[4], [3, [true, null, false, true, 3600000, 604800000, 4, 100000, 1000, 2, 600]]);
    return new Response(JSON.stringify({ messageId: '22'.repeat(32) }));
  };
  await bootstrap({ peer: 'http://127.0.0.1:7210', apiKey: 'synthetic-test-credential', fetch });
  assert.equal(votes, 1);
});

test('bootstrap refuses remote peers, retained chains, missing membership and single-member thresholds', async () => {
  await assert.rejects(bootstrap({ peer: 'https://remote.test', apiKey: 'test' }), /local HTTP/);
  for (const mutation of [{ threshold: 1 }, { threshold: undefined }, { membershipMode: 'static' },
    { stateCommitment: { version: 1, generationId } }, { chainId: 'other-chain' }]) {
    const fetch = async () => new Response(JSON.stringify({ ...status, ...mutation }));
    await assert.rejects(bootstrap({ peer: 'http://localhost:7210', apiKey: 'test', fetch }), /fresh governed/);
  }
});

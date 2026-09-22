// Talking to a member over plain HTTP.

const BASE_PORT = Number(process.env.YANO_HTTP_BASE ?? 7160);
const API_KEY = process.env.YANO_CLUSTER_API_KEY ?? 'yano-local-cluster-full-key';
export const CHAIN_ID = 'release-chain';
export const NODE_COUNT = 3;

export class MemberUnreachable extends Error {}

const url = (index, path) =>
  `http://127.0.0.1:${BASE_PORT + index}/api/v1/app-chain/chains/${CHAIN_ID}${path}`;

async function request(target, options = {}) {
  let response;
  try {
    response = await fetch(target, {
      ...options,
      headers: { 'X-API-Key': API_KEY, ...(options.headers ?? {}) },
    });
  } catch (cause) {
    throw new MemberUnreachable(`cannot reach ${target}`, { cause });
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${target} → ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export const submit = (index, topic, bodyHex) =>
  request(url(index, '/messages'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, bodyHex }),
  });

export const tip = (index = 0) => request(url(index, '/tip'));
export const status = (index = 0) => request(url(index, '/status'));
export const stateProof = (keyHex, index = 0) => request(url(index, `/state/proof/${keyHex}`));
export const finalizedMessage = (messageId, index = 0) =>
  request(url(index, `/messages/${messageId}`));

/** Effect records emitted by this chain. */
export const effects = (index = 0, fromHeight = 1, limit = 50) =>
  request(url(index, `/effects?fromHeight=${fromHeight}&limit=${limit}`));

/** Wait for a submitted message to be finalized. */
export async function awaitFinalized(messageId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await finalizedMessage(messageId)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`message ${messageId} was accepted but not finalized within ${timeoutMs}ms`);
}

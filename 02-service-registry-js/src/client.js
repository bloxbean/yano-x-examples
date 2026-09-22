// Talking to an app-chain member over plain HTTP.
//
// There is no Yano SDK for JavaScript, and this example does not need one: an
// app chain is an ordinary REST service. Everything below is fetch().

const BASE_PORT = Number(process.env.YANO_HTTP_BASE ?? 7110);
export const NODE_COUNT = 3;

export const nodeUrl = (index) =>
  `http://127.0.0.1:${BASE_PORT + index}/api/v1/app-chain/chains`;

export class MemberUnreachable extends Error {}

async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (cause) {
    throw new MemberUnreachable(`cannot reach ${url}`, { cause });
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${url} → ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export class Member {
  constructor(index, chainId) {
    this.index = index;
    this.chainId = chainId;
    this.base = `${nodeUrl(index)}/${chainId}`;
  }

  /**
   * Submit a command. A 202 means the message entered the pending pool — it is
   * NOT a promise that the command changed anything. Wait for finality, then
   * read the resulting state.
   */
  async submit(topic, bodyHex) {
    return request(`${this.base}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, bodyHex }),
    });
  }

  /** The full state-proof envelope: value, block header and finality certificate. */
  async stateProof(keyHex) {
    return request(`${this.base}/state/proof/${keyHex}`);
  }

  async tip() {
    return request(`${this.base}/tip`);
  }

  async block(height) {
    return request(`${this.base}/blocks/${height}`);
  }

  async finalizedMessage(messageId) {
    return request(`${this.base}/messages/${messageId}`);
  }
}

/** Wait until every member has finalized this message, or give up. */
export async function awaitFinalized(members, messageId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await members[0].finalizedMessage(messageId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`message ${messageId} was accepted but not finalized within ${timeoutMs}ms`);
}

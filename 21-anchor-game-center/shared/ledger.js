// Talking to the members over plain HTTP: no SDK, just fetch().
//
// Reads go to the preferred member and fail over to the others. A write goes
// to exactly the member the player picked, because that member signs the
// envelope; silently re-sending it elsewhere would change who relayed it.

import { fromHex, toHex, utf8 } from './crypto.js';

const STDLIB = '/api/v1/plugins/org.yanoproject.x.stdlib/authenticated-map';

export class Ledger {
  /** proxy: use same-origin /proxy/<n> routes (serve.mjs) instead of the members' own URLs. */
  constructor(cfg, { proxy = false } = {}) {
    this.cfg = cfg;
    this.bases = cfg.nodes.map((node, i) => (proxy ? `/proxy/${i}` : node.url));
    this.preferred = 0;
  }

  chainPath(chain, rest = '') {
    return `/api/v1/app-chain/chains/${encodeURIComponent(chain)}${rest}`;
  }

  async #request(node, path, options = {}) {
    const response = await fetch(`${this.bases[node]}${path}`, {
      ...options,
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (response.status === 404) return null;
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`${response.status} ${text.slice(0, 200)}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }

  /** Read with failover: the preferred member first, then the others in order. */
  async read(path, options) {
    let lastError;
    for (let k = 0; k < this.bases.length; k++) {
      const node = (this.preferred + k) % this.bases.length;
      try {
        const result = await this.#request(node, path, options);
        this.preferred = node;
        return result;
      } catch (error) {
        if (error.status && error.status < 500) throw error; // the member answered; others would too
        lastError = error;
      }
    }
    throw new Error(`no member reachable (${lastError?.message ?? 'unknown'})`);
  }

  status(chain) { return this.read(this.chainPath(chain, '/status')); }
  anchor(chain) { return this.read(this.chainPath(chain, '/anchor/commitment')); }
  block(chain, height) { return this.read(this.chainPath(chain, `/blocks/${height}`)); }
  message(chain, id) { return this.read(this.chainPath(chain, `/messages/${id}`)); }

  /** Submit through `node`. `payload` is { body } (text) or { bodyHex }. A 202 is admission, not finality. */
  submit(chain, node, topic, payload) {
    return this.#request(node, this.chainPath(chain, '/messages'), {
      method: 'POST',
      body: JSON.stringify({ topic, ...payload }),
    });
  }

  /** Run a state machine's read hook on one committed snapshot. Returns { committedHeight, stateRoot, payload (text) }. */
  async query(chain, path, params) {
    const r = await this.read(this.chainPath(chain, `/query/${path}`), {
      method: 'POST',
      body: JSON.stringify({ paramsHex: toHex(utf8(params)) }),
    });
    return r && { committedHeight: r.committedHeight, stateRoot: r.stateRoot, payload: new TextDecoder().decode(fromHex(r.payloadHex)) };
  }

  /** A native state proof for a raw state key, at `height` or the tip. */
  stateProof(chain, key, height) {
    return this.read(this.chainPath(chain, `/state/proof/${toHex(utf8(key))}${height ? `?height=${height}` : ''}`));
  }

  authmapEntry(chain, collection, keyHex) {
    return this.read(`${STDLIB}/entries/${encodeURIComponent(collection)}/${keyHex}?chain=${encodeURIComponent(chain)}`);
  }

  authmapReceipt(chain, messageId) {
    return this.read(`${STDLIB}/receipts/${messageId}?chain=${encodeURIComponent(chain)}`);
  }

  /**
   * Every finalized message on `topic` at or above `fromHeight`, in log order,
   * with its block's certified timestamp and state root:
   * [{ height, index, messageId, timestamp, stateRoot, bodyHex }].
   */
  async entriesFrom(chain, topic, fromHeight) {
    const t = encodeURIComponent(topic);
    const refs = new Map();
    let from = fromHeight;
    for (;;) {
      const page = await this.read(this.chainPath(chain, `/messages/by-topic/${t}?fromHeight=${from}&limit=200`));
      const messages = page?.messages ?? [];
      for (const m of messages) refs.set(m.messageIdHex, m);
      if (messages.length < 200) break;
      const last = messages[messages.length - 1].height;
      from = last === from ? last + 1 : last; // re-read the last height so a page break cannot split it
    }
    const heights = [...new Set([...refs.values()].map((r) => r.height))].sort((a, b) => a - b);
    const blocks = await mapLimit(heights, 6, (h) => this.block(chain, h));
    const entries = [];
    for (const block of blocks) {
      for (const m of block?.messages ?? []) {
        const ref = refs.get(m.messageId);
        if (!ref || m.topic !== topic) continue;
        entries.push({ height: block.height, index: ref.index, messageId: m.messageId,
          timestamp: block.timestamp, stateRoot: block.stateRoot, bodyHex: m.bodyHex });
      }
    }
    return entries.sort((a, b) => a.height - b.height || a.index - b.index);
  }

  /** Wake `onWake` when a message on `topic` is finalized: SSE, with polling as a floor. */
  watch(chain, topic, fromHeight, onWake, pollMs = 1500) {
    let source;
    const poll = setInterval(onWake, pollMs);
    if (typeof EventSource !== 'undefined') {
      const t = encodeURIComponent(topic);
      source = new EventSource(`${this.bases[this.preferred]}${this.chainPath(chain, `/stream?fromHeight=${fromHeight}&topic=${t}`)}`);
      source.addEventListener('app-message', () => onWake());
      source.onerror = () => source.close();
    }
    return () => { clearInterval(poll); source?.close(); };
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

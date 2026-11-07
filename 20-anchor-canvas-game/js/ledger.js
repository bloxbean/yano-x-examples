// Talking to the app ledger over plain HTTP: no SDK, just fetch().
//
// Reads go to the preferred member and fail over to the others. A write goes
// to exactly the member the player picked, because that member signs the
// envelope; silently re-sending it elsewhere would change who relayed it.

export class Ledger {
  /** proxy: use same-origin /proxy/<n> routes (serve.mjs) instead of the members' own URLs. */
  constructor(cfg, { proxy = false } = {}) {
    this.cfg = cfg;
    this.bases = cfg.nodes.map((node, i) => (proxy ? `/proxy/${i}` : node.url));
    this.preferred = 0;
  }

  chainUrl(node) {
    return `${this.bases[node]}/api/v1/app-chain/chains/${encodeURIComponent(this.cfg.chainId)}`;
  }

  async #request(node, path, options = {}) {
    const response = await fetch(`${this.chainUrl(node)}${path}`, {
      ...options,
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (response.status === 404) return null;
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`${response.status} ${text.slice(0, 200)}`);
      error.status = response.status;
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

  status() { return this.read('/status'); }
  tip() { return this.read('/tip'); }
  anchor() { return this.read('/anchor/commitment'); }
  block(height) { return this.read(`/blocks/${height}`); }

  /** Submit one message through `node`. A 202 is admission, not finality. */
  submit(node, body) {
    return this.#request(node, '/messages', {
      method: 'POST',
      body: JSON.stringify({ topic: this.cfg.topic, body }),
    });
  }

  /**
   * The finalized-message proof subject. With view "latest-confirmed-anchor"
   * the record is proven under the state root this cluster anchored on Cardano.
   */
  proveMessage(messageId, view) {
    return this.read('/proof-subjects/finalized-message-v1/proof', {
      method: 'POST',
      body: JSON.stringify({
        coordinates: { 'message-id': messageId },
        view,
        claim: { claimId: 'recorded', operands: {} },
        includeEvidence: false,
      }),
    });
  }

  /**
   * Every finalized game message at or above `fromHeight`, in log order, with
   * its block's certified timestamp: [{ height, index, messageId, timestamp, bodyHex }].
   */
  async entriesFrom(fromHeight) {
    const topic = encodeURIComponent(this.cfg.topic);
    const refs = new Map();
    let from = fromHeight;
    for (;;) {
      const page = await this.read(`/messages/by-topic/${topic}?fromHeight=${from}&limit=200`);
      const messages = page?.messages ?? [];
      for (const m of messages) refs.set(m.messageIdHex, m);
      if (messages.length < 200) break;
      const last = messages[messages.length - 1].height;
      from = last === from ? last + 1 : last; // re-read the last height so a page break cannot split it
    }

    const heights = [...new Set([...refs.values()].map((r) => r.height))].sort((a, b) => a - b);
    const blocks = await mapLimit(heights, 6, (h) => this.block(h));
    const entries = [];
    for (const block of blocks) {
      if (!block) continue;
      for (const m of block.messages ?? []) {
        const ref = refs.get(m.messageId);
        if (!ref || m.topic !== this.cfg.topic) continue;
        entries.push({
          height: block.height, index: ref.index, messageId: m.messageId,
          timestamp: block.timestamp, bodyHex: m.bodyHex,
        });
      }
    }
    return entries.sort((a, b) => a.height - b.height || a.index - b.index);
  }

  /**
   * Wake `onWake` whenever a game message is finalized. Server-sent events
   * from the preferred member, falling back to polling if the stream drops.
   */
  watch(fromHeight, onWake, pollMs = 4000) {
    let source;
    const poll = setInterval(onWake, pollMs);
    if (typeof EventSource !== 'undefined') {
      const topic = encodeURIComponent(this.cfg.topic);
      source = new EventSource(`${this.chainUrl(this.preferred)}/stream?fromHeight=${fromHeight}&topic=${topic}`);
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

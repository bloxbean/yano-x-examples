// Commander profiles on the authenticated-map chain, and the cross-chain
// check every browser runs before it lets a commander join a round.
//
// Two chains have no shared clock, so "was this profile registered before the
// join?" is decided with certified block timestamps from both:
//
//   present: accept only if the profile is valid, still at revision 1, holds
//            the join's key, and its creating block is older than the join.
//   absent:  the entry route certifies absence at some height. If that block
//            is no older than the join, nothing registered later can count,
//            so the join is refused for good. Otherwise this browser's view is
//            behind the join: ask again shortly (the fold pauses on it).
//
// A profile is immutable by rule: only revision 1 counts, so even a member
// that could overwrite the entry cannot change who a call sign is.

import { decodeEntry, putIfAbsentEnvelope, AUTHMAP_TOPIC, RECEIPT_ALREADY_EXISTS } from './authmap.js';
import { profileKey, readProfile } from './accounts.js';
import { toHex } from './crypto.js';

const GIVE_UP_MS = 6000;

export class Profiles {
  constructor(cfg, ledger) {
    this.cfg = cfg;
    this.ledger = ledger;
    this.known = new Map(); // id → { profile, revision, createdHeight, createdAt } — present entries never change
    this.blockTimes = new Map();
    this.waiting = new Map(); // `${id}@${joinTs}` → first time this browser had to wait
    this.check = this.check.bind(this);
  }

  async #blockTime(height) {
    if (height < 1) return -Infinity; // genesis: says nothing about any join
    if (!this.blockTimes.has(height)) {
      const block = await this.ledger.block(this.cfg.profilesChain, height);
      if (!block) throw new Error(`profile chain block ${height} not visible yet`);
      this.blockTimes.set(height, block.timestamp);
    }
    return this.blockTimes.get(height);
  }

  /** { present: false, committedHeight } or { present: true, profile (null if invalid), value, revision, createdAt }. */
  async lookup(id) {
    if (this.known.has(id)) return this.known.get(id);
    const response = await this.ledger.authmapEntry(this.cfg.profilesChain, this.cfg.profilesCollection,
      toHex(profileKey(this.cfg, id)));
    const entry = decodeEntry(response);
    if (!entry.present) return entry;
    const found = {
      present: true,
      profile: entry.status === 0 ? await readProfile(this.cfg, id, entry.value) : null,
      value: entry.value,
      revision: entry.revision,
      createdHeight: entry.createdHeight,
      createdAt: await this.#blockTime(entry.createdHeight),
    };
    this.known.set(id, found);
    return found;
  }

  /** The galaxy's join check: { ok } | { ok: false, reason }, or throws to retry. */
  async check(id, pub, joinTs) {
    const found = await this.lookup(id);
    if (found.present) {
      if (!found.profile || found.revision !== 1) return { ok: false, reason: 'profile is not valid' };
      if (found.profile.pub !== pub) return { ok: false, reason: 'key does not match the profile' };
      if (found.createdAt >= joinTs) return { ok: false, reason: 'registered after joining' };
      return { ok: true };
    }
    if ((await this.#blockTime(found.committedHeight)) >= joinTs) return { ok: false, reason: 'unknown commander' };
    // This browser's view of the profile chain is older than the join. Wait,
    // but not forever: an unregistered call sign on an idle chain would
    // otherwise stall everyone's game.
    const key = `${id}@${joinTs}`;
    if (!this.waiting.has(key)) this.waiting.set(key, Date.now());
    if (Date.now() - this.waiting.get(key) > GIVE_UP_MS) return { ok: false, reason: 'unknown commander' };
    throw new Error(`profile for ${id} not visible yet`);
  }

  /**
   * Claim a call sign: PUT_IF_ABSENT through `node`, then wait for the receipt.
   * Resolves when the profile is finalized; rejects "taken" if someone was first.
   */
  async register(id, profileBytes, node, onStage = () => {}) {
    const envelope = putIfAbsentEnvelope(this.cfg.profilesCollection, profileKey(this.cfg, id), profileBytes);
    const started = Date.now();
    const { messageId } = await this.ledger.submit(this.cfg.profilesChain, node, AUTHMAP_TOPIC,
      { bodyHex: toHex(envelope) });
    onStage('submitted', { messageId });
    for (let i = 0; i < 120; i++) {
      const receipt = await this.ledger.authmapReceipt(this.cfg.profilesChain, messageId).catch(() => null);
      const record = receipt?.record;
      if (record?.presence === 1) {
        if (record.status === 0) return { messageId, height: receipt.committedHeight, ms: Date.now() - started };
        throw new Error(record.errorCode === RECEIPT_ALREADY_EXISTS
          ? 'That call sign is taken. Try another.' : `The ledger refused it (code ${record.errorCode})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Registration was not finalized in time');
  }
}

// The game publisher's delegation service: the one place the issuer key lives.
// It never runs in a member or in the static site. For each request it decides
// whether to sign a one-hour credential that lets a browser's session key
// write one game's topics (games/<game>/).
//
// It signs only when:
//   - the request is well formed, for this chain, generation and one of the games;
//   - it is fresh (a 60-second window) and its nonce was not used before;
//   - the commander key signed it, or, for a wallet commander, a device key
//     whose certificate that commander's wallet signed and which has not expired;
//   - that key is the commander's profile on authenticated-map-chain: present,
//     at revision 1, self-signed — read from a member the operator trusts, never
//     from the request;
//   - the issuer is still a delegator for that scope in the committed registry.

import { readProfile, verifySigned } from '../shared/accounts.js';
import { ACCOUNTS } from '../shared/config.js';
import { SESSION_MS, isGameScope, requestStatement } from '../shared/sessions.js';
import { hex, issueDelegation, unhex } from '../shared/topic-client/topics.mjs';

export class DelegationError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const refuse = (code, status) => { throw new DelegationError(code, status); };

/**
 * lookupProfile(id) → { present, status, revision, createdHeight, committedHeight, value } from a trusted member.
 * checkAuthority(scope) → true while the issuer may still delegate that scope.
 */
export function createDelegationService({ chainId, generationId, scopes, issuer, lookupProfile,
  checkAuthority = async () => true, now = Date.now, maxRequests = 4096 }) {
  unhex(generationId, 32);
  unhex(issuer.publicKey, 32);
  if (typeof chainId !== 'string' || !chainId.length || !Array.isArray(scopes) || !scopes.length
      || scopes.some((scope) => !isGameScope(scope)) || typeof lookupProfile !== 'function') {
    throw new TypeError('invalid delegation service configuration');
  }
  const allowed = new Set(scopes);
  const used = new Map(); // `${pub}:${nonce}` → expiry; one instance only (a replicated service needs a shared store)

  return async (request) => {
    let statement;
    try {
      statement = requestStatement(request);
      unhex(request.sig, 64);
    } catch {
      refuse('DELEGATION_REQUEST_INVALID');
    }
    if (request.chainId !== chainId || request.generationId !== generationId) refuse('DELEGATION_CHAIN_MISMATCH');
    if (!allowed.has(request.scope)) refuse('DELEGATION_SCOPE_UNKNOWN');
    const time = now();
    if (request.issuedAt > time + 1000 || request.expiresAt <= time) refuse('DELEGATION_REQUEST_EXPIRED');
    if (!(await verifySigned(ACCOUNTS, request, statement, time))) refuse('DELEGATION_AUTHENTICATION_FAILED', 401);
    const found = await lookupProfile(request.id);
    if (!found?.present || found.status !== 0 || found.revision !== 1
        || !Number.isSafeInteger(found.createdHeight) || found.createdHeight < 1
        || !(found.value instanceof Uint8Array) || found.value.length > 32768) {
      refuse('DELEGATION_PROFILE_INVALID', 401);
    }
    const profile = await readProfile(ACCOUNTS, request.id, found.value);
    // A wallet profile's key signs only through device certificates; a password profile never has one.
    if (!profile || profile.pub !== request.pub || (profile.v === 2) !== (request.cert !== undefined)) {
      refuse('DELEGATION_PROFILE_INVALID', 401);
    }
    if (!(await checkAuthority(request.scope))) refuse('DELEGATION_ISSUER_INACTIVE', 409);

    // Reserve the nonce after the slow checks, with no await between lookup and insertion,
    // so two concurrent copies of one request issue at most one credential.
    const current = now();
    if (request.expiresAt <= current) refuse('DELEGATION_REQUEST_EXPIRED');
    for (const [key, expiry] of used) if (expiry <= current) used.delete(key);
    const replayKey = `${request.pub}:${request.nonce}`;
    if (used.has(replayKey)) refuse('DELEGATION_REQUEST_REPLAYED', 409);
    if (used.size >= maxRequests) refuse('DELEGATION_SERVICE_BUSY', 503);
    used.set(replayKey, request.expiresAt);

    const notBefore = Math.max(0, current - 1000);
    const credential = await issueDelegation({ chainId, generationId, delegate: request.session, scope: request.scope,
      notBefore, notAfter: notBefore + SESSION_MS, issuer });
    return { delegationHex: hex(credential) };
  };
}

// Application service only: this code never runs in a Yano member or a static browser.
import { readProfile } from '../shared/accounts.js';
import { ACCOUNTS } from '../shared/config.js';
import { delegationRequestStatement, NEON_SCOPE, SESSION_MS } from '../shared/neon-auth.js';
import { issueDelegation, hex, unhex, verifySignature } from '../shared/topic-client/topics.mjs';

export class DelegationError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const refuse = (code, status) => { throw new DelegationError(code, status); };

/** lookupProfile reads the configured operator-trusted profile chain, never request-supplied profile bytes. */
export function createDelegationService({ chainId, generationId, issuer, lookupProfile,
  checkAuthority = async () => true, now = Date.now, maxRequests = 4096 }) {
  unhex(generationId, 32); unhex(issuer.publicKey, 32);
  if (typeof chainId !== 'string' || !chainId.length || chainId.length > 128
      || typeof lookupProfile !== 'function' || !Number.isSafeInteger(maxRequests) || maxRequests < 1
      || maxRequests > 65536) throw new TypeError('invalid delegation service configuration');
  const used = new Map();
  return async request => {
    let statement;
    try { statement = delegationRequestStatement(request); unhex(request.signature, 64); }
    catch { refuse('DELEGATION_REQUEST_INVALID'); }
    const time = now();
    if (request.chainId !== chainId || request.generationId !== generationId || request.scope !== NEON_SCOPE) {
      refuse('DELEGATION_SCOPE_MISMATCH');
    }
    if (!Number.isSafeInteger(time) || request.issuedAt > time + 1000 || request.expiresAt <= time) {
      refuse('DELEGATION_REQUEST_EXPIRED');
    }
    if (!await verifySignature(unhex(request.publicKey, 32), unhex(request.signature, 64),
      new TextEncoder().encode(statement))) refuse('DELEGATION_AUTHENTICATION_FAILED', 401);
    const found = await lookupProfile(request.commander);
    if (!found?.present || found.status !== 0 || found.revision !== 1
        || !Number.isSafeInteger(found.createdHeight) || found.createdHeight < 1
        || !Number.isSafeInteger(found.committedHeight) || found.committedHeight < found.createdHeight
        || !(found.value instanceof Uint8Array) || found.value.length > 16384) {
      refuse('DELEGATION_PROFILE_INVALID', 401);
    }
    const profile = await readProfile(ACCOUNTS, request.commander, found.value);
    if (!profile || profile.pub !== request.publicKey) refuse('DELEGATION_PROFILE_INVALID', 401);
    if (!await checkAuthority()) refuse('DELEGATION_ISSUER_INACTIVE', 409);
    // Reservation occurs after expensive checks, with no await between lookup and insertion.
    // A concurrent duplicate can reach this point, but exactly one may issue the credential.
    const current = now();
    if (request.expiresAt <= current) refuse('DELEGATION_REQUEST_EXPIRED');
    for (const [key, expiry] of used) if (expiry <= current) used.delete(key);
    const replayKey = `${request.publicKey}:${request.nonce}`;
    if (used.has(replayKey)) refuse('DELEGATION_REQUEST_REPLAYED', 409);
    if (used.size >= maxRequests) refuse('DELEGATION_SERVICE_BUSY', 503);
    used.set(replayKey, request.expiresAt);
    const notBefore = Math.max(0, current - 1000);
    const credential = await issueDelegation({ chainId, generationId, delegate: request.delegate,
      scope: NEON_SCOPE, notBefore, notAfter: notBefore + SESSION_MS, issuer });
    return { delegationHex: hex(credential) };
  };
}

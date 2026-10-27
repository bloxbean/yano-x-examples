// Application login proof for requesting one scoped session credential. No private material crosses this boundary.
import { CALLSIGN } from './accounts.js';
import { encodeCanonicalValue, hex, unhex, nonce } from './topic-client/topics.mjs';

export const NEON_SCOPE = 'games/neon-rush/';
export const REQUEST_MS = 60000;
export const SESSION_MS = 3600000;
const fields = ['version', 'commander', 'publicKey', 'chainId', 'generationId', 'scope', 'delegate',
  'issuedAt', 'expiresAt', 'nonce'];

export function delegationRequestStatement(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some(key => ![...fields, 'signature'].includes(key))
      || request.version !== 1 || typeof request.commander !== 'string' || !CALLSIGN.test(request.commander)
      || typeof request.chainId !== 'string' || !request.chainId.length || request.chainId.length > 128
      || request.scope !== NEON_SCOPE
      || !Number.isSafeInteger(request.issuedAt) || request.issuedAt < 0
      || !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= request.issuedAt
      || request.expiresAt - request.issuedAt > REQUEST_MS) throw new TypeError('invalid delegation request');
  unhex(request.publicKey, 32); unhex(request.generationId, 32); unhex(request.delegate, 32); unhex(request.nonce, 16);
  return hex(encodeCanonicalValue(['yano-neon-delegation-request-v1', ...fields.map(key => request[key])]));
}

export async function signedDelegationRequest(commander, parameters, now = Date.now()) {
  const request = { version: 1, commander: commander.id, publicKey: commander.pub, ...parameters,
    issuedAt: now, expiresAt: now + REQUEST_MS, nonce: nonce() };
  request.signature = await commander.sign(delegationRequestStatement(request));
  return request;
}

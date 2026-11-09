# The game publisher's delegation service

Static pages cannot hold a signing key that writes on everyone's behalf, and
the members should not either. This small service is the one place the
publisher's **issuer key** lives. It signs one-hour credentials that let a
browser's session key write one game's topics (`games/<game>/`) on
`games-chain`. Everything else in the game center is static.

| File | What it is |
|---|---|
| [`service.mjs`](service.mjs) | the decision: who gets a credential, for what (no I/O) |
| [`server.mjs`](server.mjs) | `POST /delegations` over HTTP, the issuer key loader, and the reads from a trusted member |
| [`setup.mjs`](setup.mjs) | run by `./cluster start`: makes the publisher's keys, registers `games/` (member vote) and the game entries (publisher signature), writes `topics.json` and `delegation.json` |

## A request

The page sends JSON signed by the commander key:

```json
{ "v": 1, "chainId": "games-chain", "generationId": "<64 hex>", "scope": "games/galaxy/",
  "id": "nova", "pub": "<commander key>", "session": "<session public key>",
  "issuedAt": 1793978320934, "expiresAt": 1793978380934, "nonce": "<32 hex>", "sig": "<128 hex>" }
```

The commander signs `anchor-games/delegation-request/v1|chainId|generationId|scope|id|pub|session|issuedAt|expiresAt|nonce`
([`shared/sessions.js`](../shared/sessions.js), `requestStatement`). A wallet
commander's request has `pub` set to its wallet's key, is signed by its
browser's device key, and adds `"cert": { "device", "until", "cose", "key" }`,
the device certificate its wallet signed (CIP-8). The service checks that
certificate against the profile's wallet and that it has not expired. The
service answers `{ "delegationHex" }`, the issuer's credential for that session
key, scope and one hour, or HTTP 4xx with a code:

| Code | Why |
|---|---|
| `DELEGATION_REQUEST_INVALID` | malformed, or a scope that is not one game |
| `DELEGATION_CHAIN_MISMATCH` | another chain or generation |
| `DELEGATION_SCOPE_UNKNOWN` | not one of this deployment's games |
| `DELEGATION_REQUEST_EXPIRED` | outside its 60-second window |
| `DELEGATION_AUTHENTICATION_FAILED` | the commander key did not sign it, or the device certificate is not that wallet's, or has expired |
| `DELEGATION_PROFILE_INVALID` | no profile for that call sign, or not revision 1, not self-signed, another key, or a certificate where the profile has none (or none where a wallet profile needs one) |
| `DELEGATION_ISSUER_INACTIVE` | the committed registry no longer lets this issuer delegate the scope |
| `DELEGATION_REQUEST_REPLAYED` | that nonce was already used |

Profiles and the issuer's authority are read from the one member named in the
configuration (`peer`), never from the request. The profile chain's
generation is pinned (`profileGenerationId`), so a different chain under the
same name cannot reassign a call sign.

## Run it

Locally `node serve.mjs --local` starts it on `127.0.0.1:8788` and proxies
`/delegations` to it from the site's own origin. On its own:

```bash
node delegation/server.mjs --config .yano/games/delegation.json
```

The configuration is public apart from `keyFile`, the path of the issuer's
32-byte Ed25519 seed (64 hex characters), which must be an owner-only regular
file outside the served files. A hosted deployment runs the service on its own
HTTPS origin, lists the site in `origins`, and puts its URL in the site's
`topics.json` as `delegationEndpoint`.

## Rotate the issuer, revoke a credential

The publisher owns `games/`, so it changes the policy alone with
`yano.sh appchain topics init games/` (an `update`), `plan`, `sign` and
`submit`. To rotate, first allow both keys in `writers` and `delegate`, switch
the service and `topics.json` to the new key, then remove the old one once its
credentials have expired. A single credential is revoked with a `revoke`
command on its scope; see the release's `docs/appchain/TOPIC_SESSION_KEYS.md`.
If the publisher loses its key, the members can recover `games/` by vote.

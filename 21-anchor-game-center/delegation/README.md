# Neon Rush topic sessions

Neon Rush uses `neon-rush-chain`, a fresh governed OrderedLog chain with topic
policies enabled and unregistered topics rejected. The other games keep their
existing chains. This reference requires Yano X ADR-038 and host API level 13;
its qualification uses host `0.1.0-pre19-7f92fbe6a-SNAPSHOT` and the matching
JVM ZIP. Do not reinterpret retained prerelease state with this build, change
an existing genesis, or reset a retained deployment to try this example.

The browser creates a non-extractable Ed25519 session key. A separate service
issues a one-hour credential scoped to `games/neon-rush/`. Only that service
holds the application issuer key; Yano members and static assets do not.
The node admits the canonical CBOR payload, core frame and session signature.
The browser still verifies the commander signature and replays the ride's
inputs to calculate its time. Neither the schema nor a delegation proves that
a human played, or that a claimed time is correct.

## Configure a fresh local chain

Use the game center's `chain/application-appchain.yml` in a fresh deployment
of the matching distribution. `./cluster start 3 --no-anchor` starts a private
devnet without submitting Cardano transactions. The game center launcher also
includes the other games and requires the sealed-duels plugin build described
in the main README. The automated V4 driver below uses just the profile and
Neon chains, so it does not need that optional plugin.

Keep both owner and issuer seeds in an owner-only directory outside the game
center, its static root, and node directories. Seed files contain exactly 64
hex characters (32-byte Ed25519 seeds), are regular non-symlink files, and
have mode `0600`. Pass file paths to signing commands, never seed contents in
arguments, environment variables, page configuration, URLs, or logs. A
production issuer can replace the file signer with an external signing
service implementing the SDK signer contract.

1. On a fresh local chain at height zero, set `YANO_OPERATOR_API_KEY` through
   your operator environment and run `node delegation/bootstrap.mjs --peer
   http://127.0.0.1:7210`. This submits one member vote for unchanged genesis
   settings; it cannot reach the two-member threshold. Its first finalized
   block materializes the configured registry, which the CLI can then read.
   The helper refuses retained chains, remote peers and single-member
   thresholds. No issuer/owner seed is involved.
2. Run `yano.sh appchain topics init games/ --output games.yaml`, set
   `chainId: neon-rush-chain`, and replace the public owner key. Keep
   `authority: governance`. Run `topics plan --file games.yaml --peer
   http://127.0.0.1:7210 --output games-plan.json`, then `topics submit --plan
   games-plan.json --peer http://127.0.0.1:7210`. The output contains a public
   `commandHex` and `MEMBER_GOVERNANCE_REQUIRED`.
3. Have a threshold of member operators submit that exact `commandHex` as
   `{"commandHex":"..."}` to their respective
   `POST /api/v1/app-chain/chains/neon-rush-chain/admin/topics/governance`
   endpoints through their authenticated administrative channel. The CLI does
   not hold or use member keys. Wait for the receipt and activation, then
   resolve `games/` on all three members. On an otherwise idle chain, the
   third member's matching vote provides another committed block for the
   two-block activation delay. The live driver also advances idle activation
   with bounded non-quorate votes for the unchanged configuration.
4. Create the child with a document of the shape below, using a fresh 16-byte
   nonce, a deadline within the chain's command window, your public owner and
   issuer keys, and the complete contents of [ride.cddl](ride.cddl) as
   `schemaCddl`. Plan, sign with `topics sign --plan child-plan.json --key-file
   /private/operator/owner.seed --output child-signed.json`, and submit the
   signed plan. Every threshold owner signs the same statement. Wait for
   activation; a successful HTTP submit alone does not mean a command applied.

```yaml
schemaVersion: 1
kind: Topics
chainId: neon-rush-chain
commands:
  - target: games/neon-rush/
    operation: create
    authority: games/
    nonce: REPLACE_WITH_FRESH_32_HEX_CHARACTERS
    notAfter: REPLACE_WITH_EPOCH_MILLISECONDS
    owners: { threshold: 1, keys: [REPLACE_OWNER_PUBLIC_KEY] }
    policy:
      writers: { threshold: 1, keys: [REPLACE_ISSUER_PUBLIC_KEY] }
      delegate: [REPLACE_ISSUER_PUBLIC_KEY]
      maxDelegationMs: 3600000
      maxPayloadBytes: 40000
      schemaCddl: |
        # Insert the full ride.cddl here, including all three alternatives.
```

5. Read the chain's status. Copy its **`stateCommitment.generationId`**, which
   binds profile, format and genesis, into both public configuration files;
   the genesis ID alone is not the generation ID. Copy
   `config.example.json` to a service configuration outside the static root
   and `moto/topic-config.example.json` to `moto/topic-config.json`. Replace
   the generation and issuer public keys, peer address and browser origins.
   Pin the profile chain's separate `stateCommitment.generationId` as
   `profileGenerationId` in the service configuration. Both files contain
   public values only. The service trusts the configured
   operator-controlled peer for finalized profile records and current policy;
   request-supplied profile bytes or peer URLs are never accepted.
6. Start `node delegation/server.mjs --config /private/operator/neon.json
   --key-file /private/operator/issuer.seed`. It binds only to `127.0.0.1`.
   Start the site with `YANO_NODES=http://127.0.0.1:7210,http://127.0.0.1:7211,http://127.0.0.1:7212
   node serve.mjs`, open `http://localhost:8787/?proxy=1`, register a commander,
   and open Neon Rush. A hosted site needs its own HTTPS service and explicit
   origin allowlist. Never publish the local service or node admin endpoints
   directly as a public deployment.

## What the service authenticates

`POST /delegations` accepts at most 16 KiB of JSON. It verifies a domain-bound
signed request containing commander ID/public key, chain ID, generation ID,
scope, new session public key, issue/expiry times and a random nonce. The
request lives at most 60 seconds. The signature is over the UTF-8 lowercase
hex representation of the canonical CBOR statement in
`shared/neon-auth.js`; this matches the existing commander signing interface.

The service reads `attachments` from `authenticated-map-chain`, requires a
live immutable revision-one profile and valid creation/committed heights,
verifies the profile's original self-signature, and matches its public key to
the fresh request. It checks the pinned profile generation before and after
the record lookup, so a replacement chain under the same name cannot reassign
an existing commander's identity. Copying a public profile grants no access. It
then checks the configured generation and active issuer policy, reserves the
nonce, and signs the credential. Concurrent duplicate requests issue at most
one credential in a process. The bounded 60-second replay cache is local to
one service instance; a replicated/serverless deployment needs an atomic
shared TTL reservation store. Restarting this small reference loses only that
cache: replay can reissue a credential for the same already-authenticated
session key during the short request window, without granting another key
authority.

The browser caches only the non-extractable session key and public credential
in IndexedDB, partitioned by commander, chain, generation and scope. It checks
the issuer, scope, generation and signature before using a returned credential,
refreshes within a minute of expiry, and deletes its cached session on signout.
The existing encrypted commander profile/sign-in protocol is unchanged.
Frames carry random 16-byte nonces and short write deadlines. A reused proof,
expired proof, wrong scope, bad signature, malformed frame or schema-invalid
payload is refused by the node. Valid authorized data that violates a game
rule can still enter the log; every browser rejects it during deterministic
replay.

## Rotate an issuer and recover ownership

For an ordinary rotation, owner-sign an `update` command on
`games/neon-rush/`, initially allowing both old and new public keys in
`writers` and `delegate`. Preserve the schema and limits. Activate it, switch
the service's external key file and pinned public key, publish the new issuer
allowlist in `moto/topic-config.json`, and reload clients. After the old
one-hour credentials expire, owner-sign another update removing the old key.
The service checks active authority before each issue, so an old service
stops issuing once its key is removed. For immediate revocation, remove the
old issuer immediately and have clients reload/sign in for a fresh session;
cached old credentials fail closed with `TOPIC_DELEGATION_INVALID`.

If the topic owner threshold is lost, create a governance `recover` plan for
`games/neon-rush/` with replacement `owners`, no owner `notAfter`, and a new
nonce. Members submit the exact reviewed bytes to their authenticated
governance endpoints. The recovery rotates ownership; it does not silently
rewrite writer/schema policy. Once active, the recovered owner can update
issuer policy with a newly planned/signed command. A stale plan or insufficient
owner threshold must be re-planned, never patched after signing. Test this
drill on a fresh devnet, not by resetting production or retained chains.

## Read and prove rides

Reads retain the original `bodyHex` frame and message ID. The page verifies
the session signatures and canonical payload before commander/replay checks.
The proof panel uses the original finalized message for inclusion and anchor
checks. It does **not** independently prove historical issuer policy. Offline
authorship needs the message/frame, generation, the complete `topic-policy-v1`
proof at the message height, required schema/revocation/replay state proofs,
and a separately trusted block root. `yano.sh appchain topics verify
<messageId> --bundle bundle.json --trusted-block trusted-block.json` verifies
that package. An entry-only proof or an unpinned node response is insufficient.

Run `npm test` for all game, session, service and static-server tests. Run the
V4 driver with the matching extracted distribution to qualify real admission,
cross-member parity, proof verification, rotation and governance recovery:

```bash
node test/topics/live-v4.mjs --distribution /path/to/yano-x-jvm-0.1.0-pre4.zip
```

It creates a new private temporary cluster, uses only local devnet traffic,
preserves logs/report for inspection, and stops its members on exit. It never
uses retained `.yano` directories or submits public-network transactions.

The exact archive identity, independent review results and public evidence for
the completed three-node qualification are in [VERIFICATION.md](VERIFICATION.md).

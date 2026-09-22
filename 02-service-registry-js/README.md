# 02 — Consortium service registry (JavaScript)

Three banks publish the settlement endpoint each of them accepts payments on.
Only the owner of an entry can change it, and a consumer can verify an answer
before wiring money to it.

**Start here:** [`DEMO.md`](DEMO.md) — the narrated walkthrough.

| | |
|---|---|
| Capability | `state:kv-registry`, `sequencer:fixed`, static membership |
| Members | 3 nodes, threshold 2 |
| Needs | Node.js 20+, Java 25 (to run the chain), `curl`, `jq`, `python3` |
| Dependencies | **none** — no npm install |
| Network | Local devnet — no funds, no external Cardano node |

## Run it

```bash
./cluster start 3     # three members on a private devnet (~40s first time)
./demo.sh             # the guided walkthrough
```

```bash
./cluster stop        # stop the members, keep the data
./cluster clean       # stop and wipe .yano/
```

## Use it directly

```bash
R="node src/cli.js"

$R members                                          # who this app trusts
$R publish clearing.acme-bank https://api.acme-bank.example/v1 --as acme-bank
$R update  clearing.acme-bank https://new.acme-bank.example/v2 --as acme-bank
$R get     clearing.acme-bank --from clearing-house # retrieve AND verify
$R log                                              # every finalized attempt
$R remove  clearing.acme-bank --as acme-bank
$R tips
npm test                                            # 43 checks, no cluster needed
```

`--as` picks which member relays a command, which decides who owns the key.
`--from` picks which member answers a read. Both take a node index (`0`–`2`) or
a label from `trust.json`.

## What the chain enforces

`kv-registry` is a stock Yano state machine. Its whole authorization rule is
*first writer owns the key*:

| Command | Effect |
|---|---|
| `PUT` on an absent key | creates `[sender, value]`; the sender becomes the owner |
| `PUT` by the owner | replaces the value |
| **`PUT` by anyone else** | **deterministic no-op** |
| `DELETE` by the owner | removes the entry; the key is free again |
| `DELETE` by anyone else | no-op |

A no-op is not an error. The command is finalized and recorded — it simply has
no effect, on every member, identically. That is why the demo's hijack attempt
appears in the log but not in the state.

Wire format, if you want to read `src/registry.js`:

```
[0, keyBytes, valueBytes]   PUT      → state key = the key bytes
[1, keyBytes, emptyBytes]   DELETE   → state value = CBOR [ownerPublicKey, value]
```

## How the verification works

This is the part worth reading. There is no Yano SDK for JavaScript, so the
example does it from first principles — about 200 lines, no dependencies.

A `GET /state/proof/{keyHex}` response carries three things: the value, the
**block header** it was committed in, and the **finality certificate** for that
block. That is enough for an application to check the answer itself.

```
trust.json          ← you pin these member keys, out of band
    │
    ▼
1. re-hash the block header        blockHash = blake2b256(CBOR([...header]))
   from its own fields             — must equal the claimed block hash
    │
2. rebuild the commit digest       blake2b256("yano-appchain-commit-v2\0"
   the members sign                  || height || view || ctx || blockHash || valueHash)
    │
3. verify each Ed25519 signature   against the PINNED keys only,
   in the certificate              counting distinct signers ≥ threshold
    │
    ▼
"2 of 3 members I trust signed state root R at height H"
```

Step 1 is what makes tampering detectable: the header commits to the state
root, the messages root, the timestamp and the previous block. Change any of
them and the hash no longer matches.

Step 3 is what makes the serving node irrelevant. It would have to forge
signatures from members whose private keys it does not have.

### What it does *not* check

The application proves that a threshold of members committed to **state root R**.
It does not verify the MPF inclusion proof that binds *this key's value* to R —
that is the one piece it takes from the node.

The shipped Java verifier does that step (`ProofVerifier.verify`), and
[example 01](../01-audit-log-java/) uses it. Implementing MPF in JavaScript is
possible but substantial, and a subtly wrong implementation would be worse than
an honest gap. Reading from more than one member is a practical stopgap.

## Tests

```bash
npm test          # 43 checks, no cluster needed
npm run test:live # 5 checks against a running chain
```

`npm test` has two halves:

1. **Primitives** — BLAKE2b-256 against RFC 7693 vectors, canonical CBOR
   encodings, and header hashing against a real captured block.
2. **Rejection behaviour** — 22 cases that each take a genuine envelope, break
   exactly one thing, and require the verifier to notice: every committed
   header field, corrupted and duplicated and re-attributed signatures, a
   non-member signer, an envelope that disagrees with itself, the wrong pinned
   keys, the wrong chain, and a threshold that cannot be met.

A verifier that returns "ok" for everything passes every happy-path test ever
written, so the rejection half is the half that matters.

`npm run test:live` closes the gap a fixture cannot: it writes to a running
chain, reads back from a **different** member, and verifies a freshly produced
envelope. If a future Yano release changed the block header encoding, the
offline tests would keep passing while every live answer failed — this is what
would catch that.

> The Java app-chain testkit cannot test this example: it is a JUnit library
> and this is a Node CLI. `test:live` is the equivalent — it checks the same
> thing (does the verifier still match the runtime) through the REST API.

### Why there is a self-test

`npm test` checks BLAKE2b-256 against RFC 7693 vectors, the canonical CBOR
encodings, and a real captured block header. **The CLI runs it before it
verifies anything.** A verifier built on a broken hash would happily "verify"
nonsense, which is worse than not verifying at all.

The commit-digest fixture is not a value this code chose: the real Ed25519
signatures in the captured envelope verify over exactly those bytes.

## Files

```
chain/application-appchain.yml   the chain definition (commented)
trust.json                       the member keys this app pins — read this first
cluster                          start / stop / status
demo.sh                          the guided walkthrough
src/
  cli.js                         the command line
  client.js                      REST calls — plain fetch()
  registry.js                    kv-registry command encoding and state decoding
  verify.js                      block hash, commit digest, Ed25519 certificate check
  cbor.js                        canonical CBOR, just what is needed
  blake2b.js                     BLAKE2b-256 — Node ships blake2b512, not this
test/
  run.js                         npm test — everything that needs no chain
  selftest.js                    primitives checked against known vectors
  verifier.test.js               22 tampered envelopes that must be rejected
  live.test.js                   npm run test:live — against a running chain
  fixtures/state-proof.json      a real envelope captured from a chain
```

## Notes worth knowing

- **Node has no BLAKE2b-256.** It ships `blake2b512`, and you cannot truncate
  it — the digest length is part of BLAKE2b's parameter block. Hence
  `src/blake2b.js`.
- **The chain id is not inside the block object.** It is carried once at the
  envelope level, and the verifier binds the *pinned* chain id when re-hashing.
  Taking it from the node's block object would let a node replay another
  chain's certificate.
- **Canonical CBOR matters.** The header is re-encoded before hashing, so a
  non-canonical length encoding would produce a different hash and fail for the
  wrong reason.
- **Ownership is per member key.** One organization running two nodes has two
  owners. Business-identity ownership needs role-aware authorization.

## Where to go next

- [`../USE_CASES.md`](../USE_CASES.md) — the full catalog of examples
- [`../01-audit-log-java/`](../01-audit-log-java/) — the same trust story in Java, with MPF proof verification
- `kv-registry` reference: `yano-x-jvm-*/docs/appchain/state-machines/kv-registry.md`

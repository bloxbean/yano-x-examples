# 09 — Anchor and verify (Java)

A verifier that reads **Cardano and nothing else**. No Yano node is asked
anything, so nothing a Yano node might claim can change the answer.

**Start here:** [`DEMO.md`](DEMO.md) — the narrated walkthrough.

| | |
|---|---|
| Capability | `anchor:script` (Plutus V3 thread NFT), `state:ordered-log` |
| Members | 3 nodes, threshold 2 |
| Needs | Java 25, Maven, `curl`, `jq`, `python3` |
| Network | Local devnet — the anchor is a real Cardano transaction |

## The question the other examples leave open

Every other example here ends with *"verified — against a root we got from
somewhere"*:

| Example | Trusted root comes from | You have to trust |
|---|---|---|
| 01 audit log | a peer member's block | that peer |
| 02 service registry | signatures against keys in `trust.json` | whoever maintains that file |
| **09 (this)** | **a Cardano transaction** | **Cardano** |

The first two are useful and cheap, but both leave the same question: where did
that root — or that member key list — come from? Ask a node, and a dishonest
node can answer. Pin it by hand, and someone has to keep the pin right.

## What is on Cardano

Script-mode anchoring parks one UTxO at a Plutus validator address, holding a
**thread NFT** minted once for that chain, and an inline datum:

```
chainId              evidence-chain
chainGenesisId       6a9ed0e5b01e2cc7…        which generation
applicationId        ordered-log
commitmentProfileId  mpf-blake2b256-v1
height               1
stateRoot            9d357b52e39ed136…
threshold            2
memberKeys           8139770ea87d…, 8a88e3dd7409…, ed4928c628d1…
```

The last two lines are what make this self-contained. **The member set and the
threshold are in the datum**, so a verifier is not told separately who was
allowed to sign — Cardano carries it. Nothing needs to be looked up anywhere
else, and nothing needs to stay in sync.

The thread token is what identifies the live anchor: the validator enforces a
single-threaded datum chain, so exactly one UTxO carries that token, and that
one is current. The asset name is the chain id.

## Run it

```bash
./cluster start 3    # ~40s, anchoring bootstrapped automatically
mvn -B package
./demo.sh            # ~15s
```

## Use it directly

```bash
A="java -jar target/anchor-verify.jar"

$A record "inspection certificate C-8841"   # talks to the app chain
$A status                                    # talks to the app chain
$A trust init                                # ONCE — the out-of-band step

$A inspect                                   # Cardano only
$A export <messageId> --out bundle.json      # talks to the app chain
$A verify bundle.json                        # Cardano only
$A tamper bundle.json                        # then verify again
```

The split is deliberate and visible in the code: `Verifier` and `L1Anchor` have
no `AppChainClient` import at all.

## The chain of reasoning

```
   Cardano UTxO carrying this chain's thread token
        │
        │  inline datum: at height H the state root was R,
        │                under members M with threshold T
        ▼
   ProofVerifier.verifyInclusion(R, key, value, proof)
        │
        ▼
   this record was in the state a threshold of members committed,
   and Cardano carries the evidence of when
```

Seven checks, each able to fail on its own:

1. this chain's anchor is findable on Cardano
2. the anchor is the chain **and generation** you pinned
3. the bundle is about that chain
4. the bundle's height is the height Cardano anchored
5. the bundle's state root is the anchored root
6. the record is proved under that root
7. Cardano names the member set and threshold

Check 4 is easy to overlook and matters: **an anchor commits one height.** A
proof taken at the tip commits to a root Cardano has not seen yet, and is not
covered. That is why `export` takes the proof at the anchored height, using
`client.proof(key, height)` rather than the tip.

## What the verifier pins, and why

`anchor-trust.json` holds five public facts: chain id, application id, genesis
id, script address, thread policy id.

A bundle deliberately does **not** carry where its anchor lives. If it did, a
forged bundle would simply name a forged anchor — self-certification, which is
the same as no certification.

In this example `trust init` reads those facts from the node once, and says so
plainly. That stands in for the consortium publishing its chain identity: a
website, a registry entry, a signed announcement. The point is that it happens
**once, publicly**, rather than per answer — so a lie has to be told once, in
the open, and permanently.

## Files

```
chain/application-appchain.yml   the chain definition
cluster                          start / stop / status
demo.sh                          the guided walkthrough
src/main/java/.../
  L1Anchor.java                  read the anchor UTxO from Cardano, decode the datum
  Verifier.java                  the seven checks — no AppChainClient anywhere
  Bundle.java                    a self-contained claim about one record
  AnchorTrust.java               the five pinned facts
  AnchorVerifyApp.java           the command line
anchor-trust.json                written by `trust init` (gitignored)
bundle.json                      written by `export` (gitignored)
```

## Limits

- **An anchor is periodic.** Records between anchors are finalized but not yet
  on Cardano. `--anchor-every` controls the cadence; every anchor is a
  fee-paying L1 transaction, so it is a cost/latency trade.

- **This proves inclusion at the anchored height, not the current state.** A key
  deleted after that height still verifies as present *at that height* — which
  is correct, and worth being precise about when quoting it.

- **Trusting Cardano means trusting your Cardano source.** Here that is the
  local devnet node. A real verifier uses a node or resolver it trusts, and
  should confirm L1 stability depth before relying on a recent anchor.

- **The datum says who the members were, not that they were entitled to be.**
  Membership is a configured key list. The anchor makes it public and
  tamper-evident; it does not make it permissionless.

- **Devnet, demo keys.** The anchor wallet is faucet-funded by the launcher.

## Related

- [`../01-audit-log-java/`](../01-audit-log-java/) — the same proof verified
  against a peer member instead
- [`../02-service-registry-js/`](../02-service-registry-js/) — certificate
  verification against pinned keys, in JavaScript
- [`../USE_CASES.md`](../USE_CASES.md) — the full catalog

# 04 — Catalyst-style milestone disbursement (Java)

A fund pays a project when a milestone is accepted. Two reviewers from
different organizations must approve — and what they approve is the **payout
transaction's id**, so the approval names one exact payment and anyone can
check it against Cardano.

**Start here:** [`DEMO.md`](DEMO.md) — the narrated walkthrough.

| | |
|---|---|
| Capability | `state:role-approvals` (preview), `anchor:metadata`, Cardano tx submission |
| Members | 3 nodes, threshold 2 |
| Actors | 4 people, 3 organizations, 1 policy |
| Needs | Java 25, Maven, `curl`, `jq`, `python3` |
| Network | Local devnet — faucet-funded treasury, no real funds |

## The gap this closes

Most approval workflows record *"milestone 1 accepted"*. A separate system then
builds and sends a payment. Nothing binds the two, so nothing stops the amount
or the recipient changing in between — and afterwards you cannot prove which
payment the reviewers meant.

The fix is a property of Cardano itself:

> **A transaction id *is* the Blake2b-256 hash of its transaction body.**

So make the approved payload hash the transaction id. The approval record then
names one specific payment, and the link needs no trust in either direction:
look up the transaction on chain, look up the approval, compare the values.

```
   build the payout, UNSIGNED
            │
            │  transaction id = blake2b256(body)
            ▼
   ┌──────────────────────────────────────────┐
   │ app chain: reviewers sign THAT id        │
   │   2 × reviewer, DISTINCT ORGANIZATION    │
   └──────────────────────────────────────────┘
            │
            │  APPROVED, payload hash = the id
            ▼
   treasury signs        ← witnesses are OUTSIDE the body,
            │              so the id does not change
            ▼
   submit to Cardano  →  on-chain txid == the approved hash
```

## Why the order works

Signing does **not** change a transaction's id, because witnesses live in the
witness set, outside the body that gets hashed. That is what allows:

1. build the payment,
2. get it authorized,
3. *then* apply the treasury key.

The key holder signs bytes that were already approved, rather than approving
bytes that were already signed.

Verified in the code, not assumed — `Treasury.signAndSubmit` re-checks the id
after signing and refuses if it moved.

## Run it

```bash
./cluster start 3 --anchor-mode metadata   # ~40s
mvn -B package
java -jar target/disbursement.jar bootstrap
./demo.sh                                   # ~15s
```

## Use it directly

```bash
D="java -jar target/disbursement.jar"
PAYEE=addr_test1...

$D treasury --fund 2000                     # faucet-fund the fund's address
$D prepare M1-alpha --to $PAYEE --ada 500   # build the payout, unsigned
$D propose M1-alpha                         # open it for review
$D review  M1-alpha --actor reviewer-omar   # Guild North
$D review  M1-alpha --actor reviewer-pia    # Guild South — completes it
$D execute M1-alpha                         # verify, sign, submit
$D show    M1-alpha                         # is it on chain?
```

`--actor` is who signs; `--via` is which member relays it, and never affects a
decision.

## Talking to Cardano

The node running the app chain **is** a Cardano node, and its REST API is
Blockfrost-shaped, so `cardano-client-lib` points straight at it:

```java
BackendService backend = new BFBackendService(
        "http://127.0.0.1:7140/api/v1/", "not-used-by-a-local-node");
```

No Blockfrost account, no Ogmios, no second service. Protocol parameters, UTXO
queries and transaction submission all go to the same node that runs the chain.

## The reviewers

| Actor | Organization | Role |
|---|---|---|
| `proposer-nia` | Lumen Labs (the funded project) | proposer — opens a review, approves nothing |
| `reviewer-omar` | Reviewer Guild North | reviewer |
| `reviewer-pia` | Reviewer Guild **South** | reviewer |
| `reviewer-quinn` | Reviewer Guild **North** | reviewer — same guild as Omar |

Quinn exists to make the negative case real. The policy clause is
`minimumCount: 2, distinctBy: ORGANIZATION`, so Omar + Quinn satisfy it **once**,
not twice. Money moves on this decision, so the control is "two independent
organizations", not "two signatures".

## What gets checked before money moves

`Milestones.requireAuthorized` refuses unless **both** hold:

1. a terminal `APPROVED` decision exists for this milestone, and
2. the approved payload hash equals **this** transaction's id.

The second is the one that catches a swapped payout. Notice there is no rule
about amounts or recipients anywhere — any change to the payment changes the
body, which changes the id.

## Files

```
chain/application-appchain.yml   the chain definition
cluster                          start / stop / status
demo.sh                          the guided walkthrough
src/main/java/.../
  Cast.java                      reviewers, guilds, demo keys
  Policies.java                  the payout policy
  Treasury.java                  Cardano: build, sign, submit, query
  Milestones.java                opening a review, reviewing, the payment gate
  Registry.java                  governed registry changes
  Chain.java                     member clients and the domain API
  DisbursementApp.java           the command line
.payouts/                        prepared transactions, between approval and payment
```

## Limits — read this before reusing the pattern

- **This is authorization, not enforcement.** Nothing here stops whoever holds
  the treasury key from building and submitting a payment with no approval at
  all. What you get is a provable record of who authorized what, and detection
  when a submitted payment differs from an approved one.

  Making it enforceable means moving the check on chain: `mpf-blake2b256-v1` is
  the only commitment profile whose proofs a Cardano script can verify, and the
  only one that may set `l1-proof-consumption-required`. A Plutus validator
  guarding the treasury could require an MPF inclusion proof against an anchored
  app-chain state root. That is a real design, and a much larger example.

- **Approvals do not expire with the transaction.** A prepared payout pins
  specific UTXOs. If they are spent elsewhere, the transaction becomes
  unsubmittable and must be rebuilt and re-approved. A deployment should set a
  validity interval and re-approve deliberately rather than silently rebuilding.

- **The treasury key is a demo key**, derived from a published mnemonic so the
  address is stable across runs. Everything it holds is faucet ada on a local
  devnet. A real fund guards that key, and signs in a KMS or HSM.

- **Actor keys are demo keys** too, derived from actor ids so the example is
  reproducible — which makes every private key here public.

- **`role-approvals` is `preview` maturity.**

## Related

- [`../03-batch-release-java/`](../03-batch-release-java/) — the same role
  machinery over a multi-stage approval, with role replacement
- [`../USE_CASES.md`](../USE_CASES.md) — the full catalog

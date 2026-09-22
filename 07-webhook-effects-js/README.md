# 07 — Webhook effects (JavaScript)

A finalized approval calls an ERP — and the outcome of that call is written
back into consensus, where every member agrees on it.

**Start here:** [`DEMO.md`](DEMO.md) — the narrated walkthrough.

| | |
|---|---|
| Capability | `state:approval-workflow`, `effects:runtime`, `effects:on-approved`, `executor:webhook` |
| Members | 3 nodes, threshold 2 — **only member 0 runs the executor** |
| Needs | Node.js 20+, Java 25 (to run the chain), `curl`, `jq`, `python3` |
| Dependencies | **none** — no npm install |

## The problem

Every approval system eventually has to call something. That call is where
systems come apart:

- the chain says APPROVED, and the ERP was never called
- the ERP was called twice, and the order shipped twice
- the call failed, and nobody can tell whether it ever succeeded

The usual fix is a job queue beside the ledger, which turns one source of truth
into two that must be reconciled.

## What an effect is

Yano treats the outside call as part of the ledger:

```
  approval reaches its threshold
        │
        │  consensus: an EFFECT is emitted as part of the block
        ▼
  one member's executor performs it            ← node-local
        │  POST, with a deterministic Idempotency-Key
        ▼
  the outcome is submitted back to the chain
        │
        ▼
  every member commits the same outcome        ← consensus again
```

**Delivery is at-least-once. Incorporating the outcome is exactly-once.**

That asymmetry is the whole contract. The chain cannot guarantee the ERP is
called precisely once — nothing can, across a network — so it guarantees
something achievable instead: every member agrees on what the ERP *said*, and
the receiver is given a stable key to deduplicate on.

## The configuration split

This is the part worth understanding, and it is visible in two files:

| Setting | Scope | Where |
|---|---|---|
| `state-machine: approvals` | consensus | `chain/application-appchain.yml` |
| `effects.enabled` | consensus | `chain/application-appchain.yml` |
| `machines.approvals.on-approved-effect.*` | consensus | `chain/application-appchain.yml` |
| `effects.executor.enabled` | **node-local** | generated `node0.properties` |
| `effects.executors.webhook.url` | **node-local** | generated `node0.properties` |

*"Reaching approval emits an effect"* is consensus — every member must agree,
or they would disagree about what the block did. *"And I am the one who
performs it"* is node-local — if it were consensus, all three members would
call the ERP.

The `./cluster` script generates the per-node overlays, so the split is
reproducible rather than something you have to set up by hand:

```bash
./cluster start 3     # node0 gets the executor settings; node1, node2 do not
```

Point it somewhere else with `RECEIVER_URL=... ./cluster start 3`.

## Run it

```bash
./cluster start 3     # ~40s
npm run receiver      # in another terminal — the ERP
./demo.sh             # ~30s
```

`demo.sh` starts and stops its own receiver, so a second terminal is optional.

## Use it directly

```bash
E="node src/cli.js"

$E members                          # which member runs the executor
$E release ORD-5512 --required 2    # propose; nothing is called yet
$E approve ORD-5512 --as 0          # one approval — still nothing
$E approve ORD-5512 --as 1          # threshold reached → the ERP is called
$E show    ORD-5512                 # decision AND effect, separately
$E effects                          # every effect this chain emitted
```

Receiver modes for exploring failure:

```bash
node receiver.js                 # answers 200
node receiver.js --fail-4xx      # answers 400 — permanent, not retried
node receiver.js --fail-5xx 2    # fails twice with 503, then succeeds
```

## Two records, deliberately separate

```
i/<orderId>      the decision   APPROVED
ae/s/<orderId>   the effect     CONFIRMED | FAILED | PENDING
```

An approval does not become un-approved because a webhook failed. `APPROVED but
the effect FAILED` is precisely the state an operator needs to see — collapsing
them into one status would hide it.

Both are committed state with their own proofs.

## What the receiver gets

```
POST /erp/release
  Idempotency-Key  70776604d8644f7912944065156a874ebc8f6cf931a940046cf415736326f617
  X-App-Chain-Id   release-chain
  X-Effect-Id      release-chain/3/0
  X-Effect-Type    webhook.post
  Content-Type     application/json

  {"action":"release-order","orderId":"ORD-5512"}
```

- **`Idempotency-Key` is deterministic**, not random — it is the effect's
  identity hash. The same effect always carries the same key. That is what
  makes at-least-once delivery safe to build on.
- **`X-Effect-Id` is `chain/height/ordinal`** — where in the ledger it came from.
- **The body is exactly what the approval carried.** The `approvals` machine
  never interpreted it; `on-approved-effect.type` only routes it. Change the
  type and the same approval drives a different executor, with no change to
  approval semantics.

Status codes decide the committed outcome:

| Response | Outcome | Retried? |
|---|---|---|
| 2xx | `CONFIRMED` | — |
| 4xx | `FAILED` | **No** — the request was wrong; repeating will not help |
| 5xx or timeout | stays pending | Yes, with bounded backoff |

## Deduplicate on what you ACTED on

`receiver.js` keeps two sets, and the distinction matters:

- `seen` — every delivery, for reporting
- `handled` — the ones it actually acted on

A retry after a transient failure is a fresh attempt at work that *never
happened*. Treating it as a duplicate because the key was seen before would
silently drop the release. The check for "already handled" runs **after** the
failure modes, not before.

This is easy to get wrong, and the 5xx demo is what exposes it.

## Files

```
chain/application-appchain.yml   consensus settings — the emission rule
cluster                          generates the node-local executor overlays
receiver.js                      the ERP endpoint, with failure modes
demo.sh                          the guided walkthrough
src/
  cli.js                         the command line
  client.js                      REST calls — plain fetch()
  approvals.js                   the approvals wire format and state decoding
  cbor.js                        canonical CBOR, including maps
```

## Limits

- **It does not make the external system transactional.** The chain records
  what the ERP *said*. It cannot undo what the ERP *did*.
- **The receiver must deduplicate.** At-least-once is by design; no amount of
  chain-side care removes the obligation.
- **One executor is a single point of execution.** Here member 0 runs it. A
  deployment decides who executes and what happens when they are down —
  effects park and retry, but they do not migrate by themselves.
- **`effects:runtime`, `effects:on-approved` and `executor:webhook` are
  `preview` maturity.**
- **The decoding here is positional**, matching the committed record layouts. A
  future record version would need updating — the JS has no schema
  negotiation, unlike the Java client.

## Related

- [`../03-batch-release-java/`](../03-batch-release-java/) — approvals with
  business actors and roles instead of member votes
- [`../USE_CASES.md`](../USE_CASES.md) — the full catalog

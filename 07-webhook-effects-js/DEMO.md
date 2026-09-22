# Demo script — Webhook effects

**Run time:** about 30 seconds · **Audience:** anyone · **Language:** JavaScript

```bash
./cluster start 3
./demo.sh          # starts its own ERP receiver
```

---

## The problem

Every approval system eventually has to call something — release an order,
queue a payment, close a ticket. That call is where systems come apart:

- the chain says APPROVED, and the ERP was **never called**
- the ERP was called **twice**, and the order shipped twice
- the call failed, and **nobody can tell** whether it ever succeeded

The usual fix is a job queue beside the ledger. Now there are two sources of
truth that have to be reconciled, and reconciliation is where the bugs live.

## What Yano does

It treats the outside call as part of the ledger. A finalized approval emits an
**effect**; one member performs it; the outcome is written **back into
consensus**.

> **Delivery is at-least-once. Incorporating the outcome is exactly-once.**

Nothing can guarantee an HTTP call happens precisely once across a network. So
the chain guarantees what it can: every member agrees on what the ERP *said*,
and the receiver gets a stable key to deduplicate on.

---

## The walkthrough

### Step 1 — Only one member calls the ERP

```
  member 0   executor ENABLED — this one calls the ERP
  member 1   executor disabled
  member 2   executor disabled
```

Two scopes, and this is the crux:

| | |
|---|---|
| *"reaching approval emits an effect"* | **consensus** — every member, in the chain YAML |
| *"and I am the one who performs it"* | **node-local** — one member, in its own overlay |

If performing it were consensus config, three members would each call the ERP.

### Steps 2–4 — Propose, and approve once

```
$ erp release ORD-5512 --required 2
  decision   PENDING

  Nothing has been called yet.

$ erp approve ORD-5512 --as 0
  decision   PENDING   (1 of 2 approvals: 8a88e3dd7409)

  Still short of the threshold — no effect emitted, nothing called.
```

The ERP log is unchanged. The chain does not call anything on a *proposal*,
only on a finalized decision.

### Step 5 — The second approval emits the effect

```
$ erp approve ORD-5512 --as 1
  decision   APPROVED   (2 of 2 approvals: 8a88e3dd7409, 8139770ea87d)

  APPROVED. An effect was emitted as part of this block.
  waiting for the executor to call the ERP and report back...

  effect     CONFIRMED   (committed at height 3)
  effect id  release-chain/3/0
  result     HTTP 200
```

### Step 6 — What the ERP actually received

```
POST /erp/release
  Idempotency-Key  70776604d8644f7912944065156a874ebc8f6cf931a940046cf415736326f617
  X-App-Chain-Id   release-chain
  X-Effect-Id      release-chain/3/0
  X-Effect-Type    webhook.post
  body             {"action":"release-order","orderId":"ORD-5512"}
  → 200, released on attempt #1
```

Three things worth pointing at:

- **`Idempotency-Key` is deterministic** — it is the effect's identity hash,
  not a random value. The same effect always carries the same key. That is what
  makes at-least-once delivery safe to build on.
- **`X-Effect-Id` is `chain/height/ordinal`** — exactly where in the ledger this
  came from.
- **The body is what the approval carried**, verbatim. The `approvals` machine
  never interpreted it; `on-approved-effect.type` only routed it.

### Step 7 — The outcome went back into consensus

```
$ erp show ORD-5512
  decision   APPROVED   (2 of 2 approvals)
  effect     CONFIRMED   (HTTP 200)
```

Two records, deliberately separate. Every member agrees the ERP answered 2xx —
**even though only one of them made the call.**

### Steps 8–9 — When the ERP rejects (4xx)

```
  effect     FAILED   (HTTP 400)

$ erp show ORD-9001
  decision   APPROVED   (2 of 2 approvals)
  effect     FAILED   (HTTP 400)
```

**This is the separation earning its keep.**

A 4xx means the request was wrong — retrying will not help, so it is not
retried. But the members *did* approve the release, and that fact does not
evaporate because a downstream system said no.

Operationally, `APPROVED but the effect FAILED` is exactly the state a human
needs to see. Collapsing the two into one status would hide it.

### Steps 10–11 — When the ERP is merely unavailable (5xx)

```
  → 503, transient: not handled, so it will be retried (1 more failure(s) queued)
  → 503, transient: not handled, so it will be retried (0 more failure(s) queued)
  → 200, released on attempt #3

  effect     CONFIRMED   (HTTP 200)
```

Retried with bounded backoff, because a 5xx says *"not now"* rather than *"no"*.

Note what the receiver deduplicates on: what it has **acted on**, not what it
has **seen**. A retry after a transient failure is a fresh attempt at work that
never happened — treating it as a duplicate would silently drop the release.

---

## What this demonstrates

| | |
|---|---|
| **Effects are consensus** | Emission is agreed by every member, in-block |
| **Execution is node-local** | One member performs it; all three agree it happened |
| **Deterministic idempotency key** | At-least-once delivery becomes safe to build on |
| **Exactly-once incorporation** | The outcome is committed once, agreed by all |
| **4xx vs 5xx** | Permanent failure vs retryable, with different handling |
| **Separate records** | An approval survives a failed effect |

## What it does not do

- **It does not make the external system transactional.** The chain records
  what the ERP *said*; it cannot undo what the ERP *did*.
- **The receiver must deduplicate.** At-least-once is by design.
- **One executor is a single point of execution.** Effects park and retry when
  it is down; they do not migrate by themselves.
- **These capabilities are `preview` maturity.**

---

## Try it yourself

```bash
E="node src/cli.js"

$E effects                      # every effect this chain emitted
$E show <orderId>

# Watch a permanent failure
node receiver.js --fail-4xx &
$E release ORD-1 --required 2 && $E approve ORD-1 --as 0 && $E approve ORD-1 --as 1
$E show ORD-1                   # APPROVED, effect FAILED

# Watch a retry
node receiver.js --fail-5xx 3 &

./cluster stop     # keep data
./cluster clean    # wipe
```

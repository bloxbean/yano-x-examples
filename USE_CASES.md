# Yano X Examples — Use Case Catalog

A catalog of small, runnable examples that demonstrate what
[Yano X](https://yano-x.io) app chains can do. Each entry names the capability
it exercises, the language it is written in, and — most importantly — **what it
proves that a plain database or a plain blockchain would not**.

Status legend:

| Mark | Meaning |
|---|---|
| ✅ | Built and runnable in this repo |
| 🔜 | Planned next |
| 💡 | Candidate, not scheduled |

Runtime used by all examples: `yano-x-jvm-0.1.0-pre2` (Yano `0.1.0-pre15`),
Java 25, local devnet — no public-network funds and no external Cardano node
unless an example explicitly says so.

---

## The backbone every example inherits

Before the individual use cases, this is what an app chain gives you in all of
them. The examples exist to make these properties visible rather than
theoretical.

| Property | Mechanism |
|---|---|
| Total order of records | Sequencer + hash-linked app blocks |
| Multi-party agreement | n-of-m Ed25519 finality certificates, verified by every member |
| Tamper evidence | Content-derived message ids, merkle message roots, MPF state root |
| Independent verifiability | MPF inclusion proofs against a state root anchored to Cardano L1 |
| Neutral custody | Every member holds the full ledger; no single broker |
| L1 without extra infra | The node is its own Cardano gateway (submit + observe anchors) |

---

## Tier 1 — Foundations

Configuration only. No plugin jar, no custom Java on the node side. The
application is an ordinary client that talks REST.

### ✅ 1. Shared access-change audit log
**Folder:** `01-audit-log-java` · **Language:** Java · **Capability:** `state:ordered-log`, `sequencer:fixed`

Two organizations and an auditor keep a shared append-only record of access
grants and revocations. Entries are co-signed by a threshold of members, so
neither org can later reorder, delete, or deny one.

*Demonstrates:* threshold finality; the `finalized-message-v1` typed proof
subject; verifying a proof served by one node against a state root obtained
from a **different** node; and a tamper attempt failing verification.

*Why an app chain:* a database owned by one party proves nothing to the other;
a public L1 is too costly, too slow and too public for per-event writes.

### ✅ 2. Consortium service registry
**Folder:** `02-service-registry-js` · **Language:** JavaScript · **Capability:** `state:kv-registry`

A consortium maintains one authoritative registry — service endpoints, allow
lists, schema versions — where the first writer owns a key and no other member
can overwrite it unilaterally.

*Demonstrates:* owner-guarded state transitions; an unauthorized overwrite
finalizing as a message while changing nothing; and an application **verifying
answers for itself in JavaScript** — re-hashing the block header and checking
the finality certificate's Ed25519 signatures against pinned member keys, with
no Yano library and no dependencies.

*Why an app chain:* this is the closest thing to smart-contract state the
framework offers with zero custom code.

### 🔜 3. Digital Product Passport trail
**Folder:** `03-doc-trail-js` · **Language:** JavaScript · **Capability:** `state:doc-trail`

Manufacturer, logistics and certifier attach a growing, non-repudiable event
trail to each product. Documents stay off-chain; the chain records
`{productId, entryHash, reference}`.

*Demonstrates:* per-entity chained head
(`head[n] = Blake2b-256(head[n-1] || entryHash[n] || senderPublicKey[n])`)
**recomputed independently in JavaScript** and checked against the proven state
value; integrity separated from availability.

*Why an app chain:* a downstream buyer verifies one entry with one proof,
without being shown the rest of the trail and without trusting the manufacturer.

### 🔜 4. Loyalty / prepaid credits ledger
**Folder:** `04-balances-java` · **Language:** Java · **Capability:** `state:balances`

A stock non-negative account ledger: a configured minter issues units, members
transfer from their own account, and every current balance is individually
provable.

*Demonstrates:* `StdlibAppChainClient` typed mint/transfer; insufficient funds
as a deterministic no-op; balance proofs at state key `b/<account>`.

*Note:* application credits, not ada and not a native asset — no custody, no
fees, no token policy.

### 🔜 5. Release approval gate
**Folder:** `05-approvals-java` · **Language:** Java · **Capability:** `state:approval-workflow`

A cross-org release gate needs 2-of-3 sign-off. `propose` / `approve` /
`reject` commands drive a per-item workflow to a terminal decision with a
provable trail of who decided what, in which order.

*Demonstrates:* each member public key counting at most once; one rejection
being terminal; deadline expiry; the decision-trail proof at `i/<itemId>`.

---

## Tier 2 — Eventing and integration

### 🔜 6. Live order feed → read model
**Folder:** `06-sse-projection-js` · **Language:** JavaScript · **Capability:** SSE stream, `sink:webhook`

Subscribe to `GET /stream`, build a read model, serve a small page showing the
chain's current view. Replays from a height on restart.

*Demonstrates:* the chain as a multi-party event-sourcing backbone; ordered,
cursor-tracked, at-least-once delivery and consumer-side deduplication by
chain/block/message identity.

*Why an app chain:* the analytics stack stays exactly as it is; only the system
of record becomes neutral.

### 🔜 7. ERP callback after a finalized approval
**Folder:** `07-webhook-effects-js` · **Language:** JavaScript · **Capability:** `effects:on-approved`, `executor:webhook`, `effects:runtime`

An approval reaching its threshold triggers an acknowledged outbound HTTP call.
A small Express receiver shows the deterministic `Idempotency-Key`, the
2xx/4xx/5xx retry semantics, and the outcome being committed **back into
consensus state** with its own effect proof.

*Demonstrates:* the effect lifecycle — at-least-once external execution with
exactly-once outcome incorporation. This is the capability that is hardest to
reproduce with any other stack.

### 💡 8. Cross-organization SLA evidence
**Language:** Java · **Capability:** `state:ordered-log`

Two systems integrating over APIs both log request/response digests as they
happen. "We called you at 12:01" becomes a proof check instead of an argument.

*Overlaps heavily with #1* — worth building only if the dispute-resolution
angle deserves its own example.

---

## Tier 3 — Cardano L1

### 🔜 9. Anchor and verify without trusting the node
**Folder:** `09-anchoring-verify` · **Language:** Java (+ JS verifier) · **Capability:** `anchor:metadata`, `anchor:script`

Anchor a chain's state root to Cardano on devnet, then run a standalone
verifier that reads the anchor transaction from L1, extracts the `state_root`,
and validates an MPF proof against it offline.

*Demonstrates:* the whole trust proposition end to end — the verifier never
asks a Yano node to vouch for anything. Also contrasts metadata anchoring
(fund a wallet, done) with Plutus V3 script anchoring (threshold-co-signed,
validator-enforced datum chain).

*This is arguably the single most important example in the repo.*

### 💡 10. React to a Cardano payment
**Capability:** `observer:address-deposit`, `l1:slot-feed`

A stable deposit to a watched L1 address becomes a reserved app-chain message;
the application credits an account. Every member verifies the block's `l1-ref`
against its own canonical L1 view before co-signing.

*Demonstrates:* deterministic L1 → app-chain observation with `stability-depth`
and rollback safety. Note the framework's own caveat: trusted-member
integration infrastructure, not an adversarial bridge.

### 💡 11. Net balances and settle on L1
**Capability:** `state:balances` + `executor:cardano-payment` *(optional bundle)*

A settlement job nets high-frequency micro-receipts every anchor interval and
pays out on devnet, citing the anchored root the balances came from.

*Demonstrates:* the micropayment / x402-style shape — off-chain throughput,
periodic credible on-chain settlement.

---

## Tier 4 — Business actors vs node members

### ✅ 12. Pharmaceutical batch release — roles, and replacing them
**Folder:** `03-batch-release-java` · **Language:** Java · **Capability:** `state:role-approvals`, `anchor:metadata`, `membership:governed`

A medicine batch passes Quality Control (2 analysts), Quality Assurance, then
certification by a Qualified Person plus two auditors from **distinct
organizations**. Midway, the Qualified Person leaves and is replaced.

*Demonstrates:* the distinction most designs get wrong — **a node transports a
command; an actor signature authorizes its business meaning.** Both distinctness
modes (`ACTOR` vs `ORGANIZATION`) with domain reasons for each; stages chained
by payload; replacing a role holder on a running chain with proof-of-possession;
and revocation blocking future decisions while past ones stay provably valid.

*Also shows* the boundary: stage ordering is enforced by the application, not by
consensus — `ApprovalPolicyV1` is an unordered AND of clauses. Consensus-enforced
ordering needs a custom state machine.

---

## Tier 5 — Custom code (the extension ladder)

### 💡 13. Inventory ledger with admission rules
**Language:** Java plugin jar · **Capability:** `state:custom-plugin`

`validate()` rejects malformed commands at admission; `apply()` enforces
no-negative-stock and legal state transitions deterministically. Every SKU is a
provable state key.

*Demonstrates:* Part B of the extension ladder — new business rules without
forking Yano. Because every member re-executes `apply()`, a member cannot be
fed a different ledger than its peers; state roots would diverge and blocks
would be rejected.

### 💡 14. Spring Boot service that *is* a chain member
**Language:** Java · **Capability:** library mode / Spring starter

An existing service embeds the runtime, keeps its own database and REST
surface, and updates a read model on `AppBlockFinalizedEvent` — one JVM, one
deployment unit, no separate node process.

*Demonstrates:* Part C — chain-backed enterprise service. Fits core banking
adapters, ERP connectors, marketplace backends.

---

## Tier 6 — Advanced and optional

Pick these opportunistically; several need Docker or an optional plugin bundle.

| # | Use case | Capability | Note |
|---|---|---|---|
| 💡 15 | Evidence publication to S3 + IPFS with Kafka notification | `executor:objectstore-s3`, `executor:ipfs`, `sink:kafka` | Needs Docker and the optional bundles |
| 💡 16 | Multi-collection registry with declarative schema validation | `state:authenticated-map` | Six collection policies: owner, member, governed-role, approval |
| 💡 17 | Historical Cardano parameters, stake and governance with proofs | `yano-x-cardano-history` | Per-epoch authenticated snapshots |
| 💡 18 | Cardano-shaped EUTxO mini-ledger with Plutus V3 | `profile:eutxo-plutus-v3` | Experimental; virtual genesis, no real funds |
| 💡 19 | Operations: add a member, change threshold, restart and catch up | `membership:governed` | Proves state-root parity survives a membership epoch |
| 💡 20 | Private policy compliance — prove "amount ≤ limit" across orgs | `state:zk-gate` | Experimental |
| 💡 21 | Anonymous-but-authorized submissions (voting, sealed bids) | `state:zk-membership` | Experimental |
| 💡 22 | Verifiable credentials with selective disclosure | `state:credential-registry` | Experimental, BBS |

---

## What these examples are deliberately *not*

Worth stating plainly, because it shapes what each example claims:

- **Not a trustless validator set.** Membership is a configured key list. There
  is no stake, no slashing, no open participation.
- **Not a domain-enforced bridge.** Metadata and threshold-co-signed script
  anchors are implemented; the stock anchor validator does not validate a
  domain withdrawal or payment policy.
- **Not for large payloads.** 64 KB default body cap. Store blobs elsewhere,
  chain the hashes.
- **Not public data distribution.** The chain replicates to members only.
  Publish proofs and roots to outsiders, not the ledger.
- **Not sub-second global finality.** Finality needs a network round trip to a
  threshold of members.

Every example uses demo keys, disposable data directories and a local devnet.
None of them is a production deployment posture.

---

## Reference

- AI-ready docs: <https://yano-x.io/ai/>
- Capability catalog: `yano-x-jvm-<version>/docs/appchain/CAPABILITIES.md`
- Upstream use-case catalogue: `yano-x-jvm-<version>/docs/APP_CHAIN_USE_CASES.md`
- Tutorial hub: `yano-x-jvm-<version>/docs/appchain/README.md`
- Full showcase (13 chains at once): `yano-x-jvm-<version>/examples/showcase/`

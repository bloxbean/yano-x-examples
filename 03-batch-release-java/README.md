# 03 — Pharmaceutical batch release (Java)

A medicine batch passes three sign-offs before it can be released. The people
who sign are named individuals in three different organizations — **not** the
nodes that run the chain. Partway through, the Qualified Person leaves and is
replaced, and the batches she already certified stay certified.

**Start here:** [`DEMO.md`](DEMO.md) — the narrated walkthrough.

| | |
|---|---|
| Capability | `state:role-approvals` (preview), `anchor:metadata`, governed membership |
| Members | 3 nodes, threshold 2 |
| Actors | 10 people, 3 organizations, 3 policies |
| Needs | Java 25, Maven, `curl`, `jq`, `python3` |
| Network | Local devnet, anchored to its Cardano L1 — no funds, no external node |

## The terms

Spelled out, because the abbreviations are industry shorthand:

| | Full form | What they do here |
|---|---|---|
| **QC** | **Quality Control** | Runs release testing on the batch. Two analysts must sign. |
| **QA** | **Quality Assurance** | Reviews deviations and the completeness of the batch record. |
| **QP** | **Qualified Person** | The named individual who certifies the batch for release and is **personally liable** for it. Required by EU GMP Annex 16. |
| Auditor | — | Independent review, from an organization other than the manufacturer. |

The Qualified Person is the reason this example exists: a QP is a *person*, not
a company. People resign, go on leave, and are replaced — and a batch certified
in March must still be verifiably certified after they leave in June.

## The flow

```
                     ┌──────────────────────────────────────────┐
  Mira (coordinator) │ opens each stage — approves nothing      │
                     └──────────────────────────────────────────┘
                                      │
   STAGE 1   qc-results       payload = batch + test summary
   ─────────────────────────────────────────────────────────────
   needs     2 × QC analyst,  DISTINCT ACTOR
             Anna + Ben       (two different people; same employer is fine)
                                      │
                                      │  stage 2's payload commits to
                                      │  stage 1's proposal id + hash
                                      ▼
   STAGE 2   qa-review        payload = batch + stage-1 proposal + hash
   ─────────────────────────────────────────────────────────────
   needs     1 × QA reviewer
             Dev
                                      │
                                      ▼
   STAGE 3   qp-release       payload = batch + stage-2 proposal + hash
   ─────────────────────────────────────────────────────────────
   needs     1 × Qualified Person          (Elena, later Farid)
           + 2 × auditor, DISTINCT ORGANIZATION
                                            (Gita @ Helix + Hugo @ Certus —
                                             Iris @ Helix would not count twice)
                                      │
                                      ▼
                        state root anchored to Cardano L1
```

Two distinctness modes, each for a reason that comes from the domain:

- **`DistinctBy.ACTOR`** — two different *people*. Both QC analysts work for
  the manufacturer; that is expected. This is the four-eyes check.
- **`DistinctBy.ORGANIZATION`** — two different *firms*. Two signatures from the
  same company satisfy the clause once, not twice. This is what "independent
  review" has to mean to mean anything.

## Run it

```bash
./cluster start 3   # ~40s, anchoring bootstrapped automatically
mvn -B package
./demo.sh           # the walkthrough (~30s)
```

`demo.sh` registers the cast itself on a fresh chain — the ceremony is
idempotent, so it is skipped when already done. Run it on its own with
`java -jar target/batch-release.jar bootstrap`.

```bash
./cluster stop        # stop, keep data
./cluster clean       # stop and wipe
```

## Use it directly

```bash
B="java -jar target/batch-release.jar"

$B cast                                           # who exists, what each stage needs
$B open  BATCH-2026-0042 --stage qc-results
$B sign  BATCH-2026-0042 --stage qc-results --actor qc-anna
$B sign  BATCH-2026-0042 --stage qc-results --actor qc-ben --via 1
$B show  BATCH-2026-0042
$B anchor
```

`--actor` is **who signs**. `--via` is **which member node relays it**. Changing
`--via` changes nothing about the decision — that is the entire point.

## The identity boundary

This is the idea the example exists to demonstrate:

| Credential | Means | Decides anything? |
|---|---|---|
| App-chain member key | a node relayed, voted, finalized | **No** |
| **Domain actor key** | a named person authorized exact bytes | **Yes** |
| REST API key | permission to call an endpoint | **No** |

A signed statement binds the chain, proposal, policy revision, payload domain
and hash, deadline, **actor revision**, key and clause. So a signature cannot be
replayed onto another batch, another stage, a later policy revision, or a
different clause — and an old actor revision cannot be reused after rotation.

## Replacing a role holder on a running chain

This is normal operation, not a migration. `batch replace` does it in one
command; here is what it actually submits.

```bash
java -jar target/batch-release.jar replace --leaving qp-elena --joining qp-farid
```

**Step 1 — revoke the departing person.** A new actor revision, `current + 1`,
with status `REVOKED`:

```java
new ActorRecordV1("qp-elena", "nordia-pharma", currentRevision + 1,
                  RecordStatus.REVOKED, roles, List.of(existingKeyEpoch), metadata)
```

Two rules the registry enforces, both easy to get wrong:

- The revision must be **exactly `current + 1`**, and it may **not drop a key
  epoch** the previous revision held. A revoked actor keeps its keys on record —
  the *status* is what stops future decisions, so history stays verifiable.
- **No proof-of-possession is attached.** The registry checks
  `keyProofs().size() == newKeys`, and this revision introduces no new key.
  Attaching one makes the whole mutation a silent no-op.

**Step 2 — register the successor.** A fresh actor at revision 1, **with**
proof-of-possession — a signature by Farid's own key over
`(chain, actor, revision, key)`. Without it the registry refuses the key,
so an administrator cannot register a key its holder does not control.

**Step 3 — the members approve both.** Each change goes through
propose → approve → activate (below). Applying them together means there is no
window with no Qualified Person.

Afterwards:

```
qp-elena   revision 2, REVOKED    → new signatures rejected
qp-farid   revision 1, ACTIVE     → can certify
BATCH-2026-0042   still APPROVED, still naming qp-elena at rev=1
```

To onboard or revoke individually: `batch onboard <actor>`,
`batch offboard <actor>`.

> **Key rotation** — keeping the same person with a new key — is the same shape,
> but appends a *new* key epoch with proof-of-possession and bounds the old
> one's `validUntilHeight`. V1 retains at most 16 key epochs per actor. This
> example does replacement rather than rotation; the code path is
> `Registry.registerActor` vs `Registry.changeActorStatus`.

## Who governs the registry

Not the actors — the **member nodes**. The `role-approvals` profile derives its
administrators from the genesis membership epoch
(`RoleWorkflowGovernanceConfig.from(context)`), so every registry change is:

```
PROPOSE    member 0 submits the mutation   → PENDING, approvals = [member0]
APPROVE    member 1 submits its approval   → approvals = [member0, member1]
ACTIVATE   any member                       → applied, since 2 ≥ threshold
```

The proposer counts as the first approval, so a 2-of-3 threshold needs exactly
one more. `Registry.apply` pipelines these by phase, so the 15-change bootstrap
is three rounds rather than 45 sequential waits.

## Files

```
chain/application-appchain.yml   the chain definition
cluster                          start / stop / status
demo.sh                          the guided walkthrough
src/main/java/.../
  Cast.java                      organizations, people, roles, demo keys
  Policies.java                  the three stages as policies
  BatchRecord.java               canonical payload bytes and stage chaining
  Registry.java                  governed registry changes
  Stages.java                    opening stages and casting decisions
  Chain.java                     member clients and the domain API
  BatchReleaseApp.java           the command line
```

## Future enhancements

**Consensus-enforced stage ordering.** Today the *application* refuses to open
stage 3 before stage 2 is APPROVED, and the payload chaining makes a
mis-ordered certification detectable after the fact. But `ApprovalPolicyV1` is a
**bounded AND of clauses** — `(clauseId, role, minimumCount, distinctBy)` and
nothing else. There is no ordering field and no dependency between policies, so
a policy cannot say "stage 2 before stage 3".

Making the ordering consensus-enforced needs a **custom or composite state
machine** — a versioned contract that atomically consumes stage N's approval to
open stage N+1. That is the documented third option for acting on an approval
("install a reviewed composite profile that atomically consumes the approval"),
and it **requires writing and deploying code**, not configuration. It is also a
consensus upgrade: every member must run the same reviewed plugin.

Until then, be precise about the claim. The chain proves, per stage: *these
roles, from these organizations, signed exactly this hash, under this policy
revision, at this height*. It does not prove the stages happened in order.

**Other things this example does not do:**

- **No effect is emitted.** An approved hash is not executable bytes. Acting on
  a release — printing a certificate, notifying a distributor, moving stock —
  is the application's job, bound to the approved payload hash.
- **Actor keys are demo keys**, derived from the actor id so the example is
  reproducible. That makes every private key here public. In a deployment each
  person generates their own seed on their own machine and publishes only the
  public half; the node never sees a private key.
- **`role-approvals` is `preview` maturity**, not `stable` like `ordered-log` or
  `kv-registry`.
- **Anchoring is script mode** on a local devnet — a Plutus V3 thread NFT per
  chain with a validator-enforced datum chain, faucet-funded by the launcher. A
  real deployment funds and guards that key itself.

## Where to go next

- [`../USE_CASES.md`](../USE_CASES.md) — the full catalog
- `role-approvals` reference: `yano-x-jvm-*/docs/appchain/state-machines/role-approvals.md`
- Domain actors: `yano-x-jvm-*/docs/APP_CHAIN_DOMAIN_ROLES.md`

# 01 — Shared access-change audit log (Java)

Two companies and an auditor keep one shared, append-only record of who was
granted access to what. No single party can reorder, edit, or deny an entry,
and any entry can be proved to an outsider on its own.

**Start here:** [`DEMO.md`](DEMO.md) — the narrated walkthrough.

| | |
|---|---|
| Capability | `state:ordered-log`, `sequencer:fixed`, static membership |
| Members | 3 nodes, threshold 2 |
| Needs | Java 25, Maven, `curl`, `jq`, `python3` |
| Network | Local devnet — no funds, no external Cardano node |

## Run it

```bash
./cluster start 3     # three members on a private devnet (~40s first time)
mvn -B package        # build the client app
./demo.sh             # the guided walkthrough
```

When you're done:

```bash
./cluster stop        # stop the nodes, keep the data
./cluster clean       # stop and wipe .yano/
```

## Use it directly

```bash
APP="java -jar target/audit-log.jar"

$APP record grant  --subject bob --resource prod-db --by alice --reason "oncall"
$APP record revoke --subject bob --resource prod-db --by carol --node 1
$APP list --limit 20
$APP prove <messageId> --from 2 --against 0
$APP tips
```

`--node i` picks which member receives the submission. `--from` / `--against`
pick which member serves a proof and which one supplies the state root it is
checked against.

## How it works

An **app chain** is a small replicated ledger shared by a fixed set of members.
Here, three nodes run `ordered-log`: an append-only log of opaque records.

```
  your app  ──submit──>  any member
                             │
                             ├─ the proposer orders it into a block
                             ├─ 2 of 3 members sign that block and its state root
                             └─ every member stores the same history
                                        │
                              ask any member for a proof
                                        │
                              check it against a root
                              you got somewhere else
```

Three things make the log trustworthy:

1. **Threshold finality.** An entry only counts once 2 of 3 members co-sign the
   block containing it. One party cannot insert or drop a record.
2. **A state root.** Every block commits to a single hash covering everything
   the chain has recorded. If two members disagree, their roots differ
   immediately and visibly.
3. **Per-entry proofs.** A member can produce a compact proof that one specific
   entry is included under that root — without handing over the rest of the log.

The proof is only worth as much as the root you compare it against. `prove`
takes the root from a **different member** than the one that served the proof,
which is the weakest of the three sensible options and the easiest to run on a
laptop. Stronger ones, in order:

| Root source | Trust required | Where |
|---|---|---|
| A peer member's block | that peer | this example |
| Threshold certificate under member keys you pinned | nobody, if you pinned the keys | `ProofVerifier.verifyCertified` |
| A Cardano L1 anchor transaction | Cardano | example 09 |

## Tests

```bash
mvn test        # 10 tests, no cluster needed, ~16s
```

The chain tests use the **app-chain testkit**, which starts three real members
inside the test JVM — no devnet, no ports, no `./cluster start`. Each test
asserts a claim this example's `DEMO.md` makes:

| Test | Claim it pins |
|---|---|
| `membersAgree` | all three members report the same tip and state root |
| `eventIsFinalized` | `ordered-log` writes every finalized message into state |
| `proofVerifiesAndTamperFails` | a proof from one member verifies; a flipped bit does not; a forged root does not |
| `unknownEntryHasNoProof` | the chain will not vouch for a record nobody submitted |
| `sendersAreDistinguished` | each entry records the member that relayed it |

`AccessEventTest` covers the encoding without a chain: fixed field order, stable
bytes, escaping. Message ids come from the body bytes, so if the encoding
drifted, old entries would stop being reproducible — the kind of bug that
surfaces years later, during a dispute.

These test the chain's behaviour through the in-process gateway. The REST path
the application itself uses is exercised by `./demo.sh`.

> If you add the testkit to another project: it pulls in `junit-jupiter-api`
> 5.8.1 at *compile* scope, which beats a newer engine and fails with
> `TestEngine with ID 'junit-jupiter' failed to discover tests`. Import
> `junit-bom` as this `pom.xml` does.

## Files

```
chain/application-appchain.yml    the chain definition (commented)
cluster                           start / stop / status wrapper
demo.sh                           the guided walkthrough
pom.xml                           one real dependency: org.yanoproject.x:yano-x-client
src/main/java/.../
  AccessEvent.java                the event record and its canonical bytes
  AuditLog.java                   all chain operations — submit, read, prove
  AuditLogApp.java                the command line
src/test/java/.../
  AuditLogChainTest.java          a real 3-member chain, in-process
  AccessEventTest.java            the encoding, no chain needed
```

The example's chain runs in its own private Yano home under `.yano/`, built
from the extracted distribution without modifying it. See
[`../00-shared/README.md`](../00-shared/README.md).

## Notes worth knowing

- **Submission is not finality.** `POST /messages` returns `202` and a message
  id — that is admission to the pending pool. `record` then waits for the entry
  to appear in a finalized block. Always treat the two as separate.
- **Keep bodies small.** There is a 64 KB cap per message, and every member
  stores every record. Log hashes and references, not documents.
- **The sender is a node, not a person.** The log proves which *member* relayed
  an entry. Proving that Alice personally approved something needs a
  business-actor signature — a different capability (example 03).
- **Canonical bytes matter.** `AccessEvent` writes its fields in a fixed order
  so the same logical event always produces the same bytes, and therefore the
  same message id.

## Where to go next

- [`../USE_CASES.md`](../USE_CASES.md) — the full catalog of examples
- Yano X docs: <https://yano-x.io>
- `ordered-log` reference: `yano-x-jvm-*/docs/core-host.md`

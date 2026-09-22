# Demo script — Pharmaceutical batch release

**Run time:** about 1 minute · **Audience:** anyone · **Language:** Java

```bash
./cluster start 3 --anchor-mode metadata
mvn -B package
java -jar target/batch-release.jar bootstrap
./demo.sh
```

---

## The problem

Before a medicine reaches a patient, a batch passes three sign-offs:

| | Full form | Who signs |
|---|---|---|
| **QC** | **Quality Control** | Two analysts confirm release testing |
| **QA** | **Quality Assurance** | One reviewer checks deviations and the batch record |
| **QP** | **Qualified Person** | One named individual certifies the batch for release |

The **Qualified Person** is the crux. Under EU GMP Annex 16 a QP is a *named
human being*, personally liable for every batch they certify. Not a company,
not a department, not a service account.

Two things follow, and normal systems handle neither well:

1. **A signature must mean a person, not a machine.** If the sign-off is "the
   server that had the credentials", it proves nothing about who decided.
2. **People leave.** A QP resigns in June. Batches she certified in March must
   remain verifiably certified — and she must not be able to certify anything
   from July.

Add that "independent review" must mean *different firms*, not two colleagues,
and you have the whole problem.

## What an app chain does

Three member nodes run the chain — one per organization. They transport and
finalize commands. **They decide nothing.**

Ten people hold their own keys. Their signatures authorize exact bytes. The
registry that says who holds which role is itself governed by the members, and
every change to it is proposed, approved to threshold, and activated.

---

## The walkthrough

### Step 1 — The cast

Three organizations: **Nordia Pharma** (manufacturer), **Helix Labs** and
**Certus Assurance** (independent). Ten people. Note that `auditor-gita` and
`auditor-iris` both work at Helix Labs — that matters later.

### Steps 2–4 — Quality Control needs two analysts

```
$ batch open BATCH-2026-0042 --stage qc-results
  status      PENDING — needs 2 QC analysts, two different people

$ batch sign BATCH-2026-0042 --stage qc-results --actor qc-anna
  status      PENDING
  accepted    1 decision(s)
```

Then Anna signs **again**, relayed through a different member node:

```
$ batch sign BATCH-2026-0042 --stage qc-results --actor qc-anna --via 2
  status      PENDING
  accepted    1 decision(s)          ← still one
```

Two things at once. A person cannot be their own second pair of eyes — the
clause counts `DistinctBy.ACTOR`. And routing through another node changed
nothing, because **the node is not who is signing**.

A second, different analyst completes it:

```
$ batch sign BATCH-2026-0042 --stage qc-results --actor qc-ben --via 1
  status      APPROVED
```

### Step 5 — Stage 3 cannot start before stage 2

```
$ batch open BATCH-2026-0042 --stage qp-release
error: Qualified Person — certification for release cannot start:
       Quality Assurance — batch record review has not been opened
```

Each stage's signed payload commits to the previous stage's proposal id and
payload hash, so there is nothing valid to chain to yet.

> **Be precise about this one.** That refusal is the *application's*. A policy
> is an unordered AND of clauses and cannot express "stage 2 before stage 3".
> The chaining makes a mis-ordered certification *detectable*; it does not make
> it *impossible*. See Future enhancements in the README.

### Steps 6–7 — QA, then the Qualified Person certifies

```
$ batch open BATCH-2026-0042 --stage qa-review
  chained to  batch-2026-0042-qc-results
  prior hash  324f8cb22562fcf9…
```

Stage 3 opens the same way, chained to stage 2. Elena (QP) certifies, Gita
(Helix Labs) reviews. Still pending — the policy wants **two** independent
auditors.

### Step 8 — Two auditors from the same firm are not two opinions

```
$ batch sign BATCH-2026-0042 --stage qp-release --actor auditor-iris
  status      PENDING
  accepted    2 decision(s)
                qp-elena       nordia-pharma    qualified-person
                auditor-gita   helix-labs       auditor
```

Iris signed. Her decision **was not accepted at all** — the count is unchanged.
She works at Helix Labs, and so does Gita. The clause counts
`DistinctBy.ORGANIZATION`.

This is the difference between "two signatures" and "two independent opinions",
and every member enforces it identically. Nobody operating the registry can
quietly waive it.

### Step 9 — A different firm completes the release

```
$ batch sign BATCH-2026-0042 --stage qp-release --actor auditor-hugo --via 2
  status      APPROVED
```

### Step 10 — The trail

```
  3. qp-release   Qualified Person — certification for release
     status   APPROVED
       APPROVE  qp-elena       nordia-pharma      rev=1 key=qp-elena-key-v1     height=12
       APPROVE  auditor-gita   helix-labs         rev=1 key=auditor-gita-key-v1 height=13
       APPROVE  auditor-hugo   certus-assurance   rev=1 key=auditor-hugo-key-v1 height=15
```

Who signed, for which organization, under which role, at which **actor
revision**, with which key, at what height.

### Step 11 — Elena leaves; Farid takes over

```
$ batch replace --leaving qp-elena --joining qp-farid

  qp-elena   revision 2, REVOKED
  qp-farid   revision 1, ACTIVE
```

Two governed registry changes applied together, so there is never a window with
no Qualified Person. Elena's revision keeps her key on record — the *status* is
what stops her, not deletion. Farid's registration carries
proof-of-possession, so the registry knows he controls the key being registered.

### Step 12 — The departed QP can no longer certify

A new batch, through QC and QA, then Elena tries:

```
$ batch sign BATCH-2026-0043 --stage qp-release --actor qp-elena
  status      PENDING
  accepted    0 decision(s)
```

Her signature was cryptographically valid and relayed normally. It was not
accepted, because her **current** registry revision is REVOKED — and a
statement must name the actor's current revision, so an old one cannot be
replayed.

### Step 13 — Her successor can

```
$ batch sign BATCH-2026-0043 --stage qp-release --actor qp-farid
  accepted    1 decision(s)
                qp-farid   nordia-pharma   qualified-person
...
  status      APPROVED
```

### Step 14 — And the batch Elena certified is still certified

```
$ batch show BATCH-2026-0042 --stage qp-release
     status   APPROVED
       APPROVE  qp-elena  nordia-pharma  rev=1 key=qp-elena-key-v1 height=12
```

**This is the point of the whole example.**

Revocation blocks *future* decisions. It cannot rewrite a finalized
authorization. A regulator asking "who released this batch, and were they
authorized at the time?" gets an answer that does not depend on who works there
now.

### Step 15 — Anchored to Cardano

```
  anchored count    1
  last height       28
  last L1 slot      8454
  last anchor tx    6f44f0e9199c804017e71a641644496a5655cf077e57444b167ada44e6b355b3
```

The state root covering every decision above is committed in a Cardano
transaction. An auditor who trusts Cardano — and nothing else — can bound when
these certifications existed.

---

## What this demonstrates

| | |
|---|---|
| **Actors ≠ members** | A node transports; a person's key authorizes |
| **Multi-stage release** | QC (2 analysts) → QA → QP + 2 independent auditors |
| **Distinct actor** | One person cannot be their own second signature |
| **Distinct organization** | Two colleagues are not two independent opinions |
| **Chained stages** | Each stage's signed payload names the previous one |
| **Role replacement** | Revoke and onboard on a running chain, with proof-of-possession |
| **Immutable history** | Revocation stops new decisions, never rewrites old ones |
| **Cardano anchoring** | The whole trail committed to L1 |

## What it does not do

- **Stage ordering is not consensus-enforced.** The application checks it.
  Making the chain enforce it needs a custom/composite state machine — real
  code, reviewed and deployed to every member. README has the detail.
- **No effect is emitted.** An approved hash is not executable bytes. Printing
  a certificate or releasing stock is the application's job.
- **Demo keys.** Actor seeds are derived from actor ids so the example is
  reproducible, which makes every private key here public.
- **`role-approvals` is `preview`**, not `stable`.
- **Devnet anchoring**, funded from the faucet.

---

## Try it yourself

```bash
java -jar target/batch-release.jar cast
java -jar target/batch-release.jar show BATCH-2026-0042

# Who else could have signed the independent review?
java -jar target/batch-release.jar sign BATCH-2026-0043 --stage qp-release --actor auditor-iris

# Revoke someone and watch the registry
java -jar target/batch-release.jar offboard qc-cleo
java -jar target/batch-release.jar cast

./cluster status
./cluster stop      # keep data
./cluster clean     # wipe
```

# Demo script — Consortium service registry

**Run time:** about 4 minutes · **Audience:** anyone · **Language:** JavaScript

```bash
./cluster start 3     # once, takes ~40s
./demo.sh             # the walkthrough
```

---

## The problem

Three banks settle payments with each other. Each publishes the API endpoint
the others should send to. Everyone needs the current list.

The danger is not a typo. It is one bank repointing another bank's settlement
endpoint at an address it controls. Whoever hosts the registry can do that, and
nobody else can tell it happened.

So: a list every member can read, where **only the owner of an entry can change
it**, and where a consumer can check an answer before wiring money to it.

## What this example adds over example 01

Example 01 showed a shared log and proved one entry. This one shows two things
that example could not:

1. **Rules the chain enforces.** Not "everyone can append", but "only the owner
   of this key may write it" — applied identically by every member.
2. **An application verifying an answer for itself**, in JavaScript, with no
   Yano library and no trust in the node that answered.

---

## The walkthrough

### Step 1 — What the application trusts

```
  chain      service-registry-chain
  threshold  2 of 3

  node 0  acme-bank        8a88e3dd7409…
  node 1  borealis-bank    8139770ea87d…
  node 2  clearing-house   ed4928c628d1…
```

Three public keys and a threshold, pinned in `trust.json`. That is the entire
trust input.

The application never asks a node who the members are. If it did, a dishonest
node could nominate its own key and sign whatever it liked.

### Step 2 — Acme publishes its endpoint

```
$ registry publish clearing.acme-bank https://api.acme-bank.example/v1 --as acme-bank

  Registry now reads: clearing.acme-bank = https://api.acme-bank.example/v1
  Owned by acme-bank (node 0)
```

Acme submitted through its own node, so Acme's member key owns that entry.
Ownership is decided by **which member relayed the first write**.

### Step 3 — Borealis tries to hijack it

```
$ registry update clearing.acme-bank https://evil.borealis.example/steal --as borealis-bank

  Submitting via borealis-bank ... finalized
  position   height 2, index 0

  Registry still reads: clearing.acme-bank = https://api.acme-bank.example/v1
  Owned by acme-bank (node 0) — the command was finalized but changed nothing.
```

**This is the step worth slowing down on.**

The command was *finalized*. It is in the chain forever, co-signed by a
threshold of members. And it changed nothing.

`kv-registry`'s rule is "first writer owns the key". A write by anyone else is a
**deterministic no-op** — not an error, not a rejection, just no effect. Every
member applies that rule identically, so there is no node to compromise and no
race to win.

There is no error message because nothing went wrong. The chain did exactly
what all three members agreed it should do.

> The practical lesson: **"accepted" never means "applied".** HTTP 202 means
> the message entered the pool. Even finality only means the command was
> recorded. If you need the outcome, read the state back.

### Step 4 — Every attempt is on record

```
HEIGHT  OP      KEY                   VALUE                              SUBMITTED BY
3       put     clearing.borealis     https://api.borealis.example/v2    borealis-bank (node 1)
2       put     clearing.acme-bank    https://evil.borealis.example/ste  borealis-bank (node 1)
1       put     clearing.acme-bank    https://api.acme-bank.example/v1   acme-bank (node 0)
```

The failed hijack sits at height 2, attributed to the member that tried it. A
registry that silently dropped rejected writes would have destroyed that
evidence.

Note the two views: the **log** holds every finalized command, the **state**
holds only what was applied.

### Step 5 — Retrieve and verify (the point of the example)

A payment service is about to send money to whatever endpoint the registry
names. "Some node told me" is not good enough.

```
$ registry get clearing.acme-bank --from clearing-house

  value      https://api.acme-bank.example/v1
  owner      acme-bank (node 0)
  height     3
  state root f49e61116bc8c146…

Verifying against the member keys this application pinned:

  [ok  ] chain id matches the one you pinned
  [ok  ] header matches the proof it came with
  [ok  ] block hash recomputed from the header
  [ok  ] 2 of 3 pinned members signed this root

VERIFIED — 2 of 3 members signed state root f49e6111… at height 3.
  Signed by:
    - clearing-house (node 2)
    - borealis-bank (node 1)
```

What actually happened, in the application's own code:

1. It re-hashed the block header from its own fields with BLAKE2b-256 and
   checked it matches the claimed block hash. Change any committed field —
   the state root, the timestamp, the messages root — and this fails.
2. It rebuilt the domain-separated commit digest the members sign.
3. It verified each Ed25519 signature against the **pinned** member keys, and
   counted distinct valid signers against the threshold.

A node serving a made-up value would have to forge signatures from members
whose private keys it does not have.

Note that the answer came from `clearing-house` but was signed by
`clearing-house` **and** `borealis-bank`. One member serving, a threshold
vouching.

### Step 6 — Releasing a key

```
$ registry remove clearing.acme-bank --as acme-bank
  clearing.acme-bank is gone. The next member to publish it becomes its new owner.

$ registry publish clearing.acme-bank https://api.borealis.example/took-it --as borealis-bank
  Owned by borealis-bank (node 1)
```

Deleting releases the key, and the next writer owns it — including a rival.

---

## What this demonstrates

| | |
|---|---|
| **Enforced ownership** | First writer owns a key; nobody else can change it |
| **Deterministic no-op** | An unauthorized write finalizes and changes nothing |
| **Accepted ≠ applied** | The log records attempts; the state records outcomes |
| **Independent verification** | An app checks the answer against keys it pinned |
| **No SDK required** | Plain REST plus ~200 lines of verification, zero dependencies |
| **Exclusion proofs** | "This key is not in the registry" is also provable |

## Limits worth stating

- **Delete-then-recreate is not an ownership transfer.** Step 6 is a real
  limitation, not a feature. There is no atomic transfer, no expiry, no admin
  override. If ownership must move under control, that rule belongs in a
  state machine, not an off-chain convention.
- **Ownership is per member key, not per organization.** One organization
  running two nodes has two owners. Tying entries to a business identity needs
  role-aware authorization (example 03).
- **This verifies the root, not the lookup.** The application proves that a
  threshold of members committed to state root R at height H. Binding *this
  key's value* to R is the MPF inclusion proof, which the shipped Java verifier
  does (`ProofVerifier.verify`) and this JavaScript does not implement. In
  practice, combine it with reading from more than one member — but be clear
  about which half you have checked.
- **The trusted keys have to come from somewhere real.** Here they are the
  launcher's published demo keys. In a deployment `trust.json` is the output of
  a genesis ceremony where each organization generated its own key.
- **Values are application data.** `value-format: utf8` validates structure,
  not meaning. Version your values if consumers must decode them reliably.

---

## Try it yourself

```bash
node src/cli.js get clearing.borealis --from acme-bank
node src/cli.js get clearing.nothing-here      # exclusion proof, still verified
node src/cli.js tips
npm test                                        # the verifier's self-test
```

### Things worth trying

**Ask a different member the same question.** The value, the root and the
verification should be identical no matter who answers:

```bash
for m in 0 1 2; do node src/cli.js get clearing.borealis --from $m | grep -E 'value|VERIFIED'; done
```

**Break the verifier and watch it refuse to run.** Change a byte in
`src/blake2b.js` — the self-test fails and the CLI will not verify anything
rather than verifying it wrongly.

**Try to hijack from the third member too:**

```bash
node src/cli.js update clearing.borealis https://nope.example --as clearing-house
node src/cli.js log      # the attempt is recorded
node src/cli.js get clearing.borealis   # the value is not
```

## Cleaning up

```bash
./cluster stop     # stop the members, keep the data
./cluster clean    # stop and wipe .yano/
```

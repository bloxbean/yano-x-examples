# Demo script — Catalyst-style milestone disbursement

**Run time:** about 15 seconds · **Audience:** anyone · **Language:** Java

```bash
./cluster start 3 --anchor-mode metadata
mvn -B package
java -jar target/disbursement.jar bootstrap
./demo.sh
```

---

## The problem

A fund pays a project when a milestone is accepted. Afterwards, two questions
have to be answerable:

1. **Who approved this payment, and were they entitled to?**
2. **Is this the payment they approved?**

The second is where approval workflows usually go vague. The approval system
records *"milestone 1 accepted"*. A separate system builds and sends a
transaction. Nothing binds them — so nothing stops the amount or the recipient
changing in between, and nobody can prove afterwards which payment was meant.

## The idea

One property of Cardano closes the gap:

> **A transaction id *is* the Blake2b-256 hash of its transaction body.**

So the thing reviewers sign is the transaction id. The approval record then
names exactly one payment, and checking it requires trusting nobody: look up
the transaction on chain, look up the approval, compare.

---

## The walkthrough

### Step 1 — The reviewers

Four people, three organizations. Note **Omar and Quinn are both Guild North** —
that matters in step 7.

A payout needs **2 reviewers from different organizations**.

### Step 2 — The fund's treasury

```
  address   addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer...
  balance   2000.000000 ada
```

The node running the app chain is also a Cardano node, and its REST API is
Blockfrost-shaped — so an ordinary Cardano library builds and submits against
it with no extra service. On devnet the faucet tops it up.

### Step 3 — Build the payout, unsigned

```
$ disburse prepare M1-alpha --to addr_test1qqagkw45... --ada 500

  amount           500.000000 ada
  transaction id   093c3f562fe5e36e5d88d2942eaa111bdbbf6dce135d542ad76dd0e232a25a11
```

Note what has **not** happened: the treasury key has not signed anything. The
transaction exists, it has an id, and that id is what gets authorized.

### Step 4 — Nothing can be paid before it is reviewed

```
$ disburse execute M1-alpha
error: no review has been opened for M1-alpha — nothing authorizes this payout
```

### Step 5 — Open it for review

```
$ disburse propose M1-alpha
  payload domain   org.cardano.transaction.id.v1
  payload hash     093c3f562fe5e36e5d88d2942eaa111bdbbf6dce135d542ad76dd0e232a25a11
  status           PENDING — needs 2 reviewers from different organizations
```

The payload hash is the transaction id from step 3. The payload domain says
what that hash means.

### Step 6 — One reviewer is not enough

```
$ disburse review M1-alpha --actor reviewer-omar
  status       PENDING
  accepted     1 decision(s)
                 reviewer-omar    reviewer-guild-north   reviewer
```

### Step 7 — Nor is a second reviewer from the same guild

```
$ disburse review M1-alpha --actor reviewer-quinn --via 1
  status       PENDING
  accepted     1 decision(s)          ← unchanged
```

Quinn's decision **was not accepted at all**. Omar and Quinn are both Guild
North, and the clause counts `DistinctBy.ORGANIZATION`.

Money moves on this decision, so the control is not "two signatures" — it is
"two independent organizations". Every member enforces that identically; nobody
operating the fund can waive it.

### Step 8 — A reviewer from a different guild completes it

```
$ disburse review M1-alpha --actor reviewer-pia --via 2
  status       APPROVED
  accepted     2 decision(s)
                 reviewer-omar    reviewer-guild-north   reviewer
                 reviewer-pia     reviewer-guild-south   reviewer
```

### Step 9 — Someone quietly raises the amount

```
$ disburse tamper M1-alpha --ada 900
  was   500.000000 ada   transaction 093c3f56...
  now   900.000000 ada   transaction 087d6a9e...
```

The payout has been swapped for a larger one, **after** approval. This is the
attack the design is aimed at.

### Step 10 — The payment is refused

```
$ disburse execute M1-alpha
error: the approved transaction is not the one about to be submitted.
       approved : 093c3f562fe5e36e5d88d2942eaa111bdbbf6dce135d542ad76dd0e232a25a11
       prepared : 087d6a9e8cec5abb8c69effcbb9721bc479dc3d91894aa6baf2fcf04fbaa7866
       Reviewers authorized a different payment. Refusing.
```

**Nothing in the code mentions amounts.** Changing the amount changed the
transaction body, which changed its id. Any change at all — recipient, amount,
inputs — produces a different id and is caught by the same single comparison.

### Step 11 — Restore and pay

Rebuilding the same payment reproduces the **same** id, so a reviewer could
independently reconstruct the transaction and confirm what they signed.

```
$ disburse execute M1-alpha

  [ok  ] a terminal APPROVED review exists
  [ok  ] the approved hash is exactly this transaction id
  [ok  ] signing did not change the transaction id
  [ok  ] Cardano accepted it

  on-chain transaction   093c3f562fe5e36e5d88d2942eaa111bdbbf6dce135d542ad76dd0e232a25a11
  approved hash          093c3f562fe5e36e5d88d2942eaa111bdbbf6dce135d542ad76dd0e232a25a11
  IDENTICAL              yes
```

The third check is worth pausing on. The treasury key signs only *after*
approval, and signing cannot change the id because witnesses sit outside the
hashed body — so the bytes submitted are the bytes approved.

### Step 12 — Check it from the outside

```
$ disburse show M1-alpha
  transaction id   093c3f56...
  on chain         yes
  review status    APPROVED
  approved hash    093c3f56...
```

An auditor needs no access to the fund's systems: look up the transaction on
Cardano, look up the approval record on the app chain, compare two hex strings.

---

## What this demonstrates

| | |
|---|---|
| **Approval names one payment** | The approved hash *is* the Cardano transaction id |
| **Independent reviewers** | Two organizations required, not two signatures |
| **Actors ≠ members** | Reviewers sign; member nodes only relay |
| **Sign after approval** | Witnesses are outside the body, so the id is stable |
| **Tamper detection** | Any change to the payment changes its id |
| **Externally checkable** | Compare the on-chain txid with the approval record |

## What it does not do

- **It is not on-chain enforcement.** Nothing stops whoever holds the treasury
  key from paying with no approval. You get a provable authorization record and
  detection of a mismatch — not prevention.

  Real enforcement means a Plutus validator guarding the treasury that requires
  an MPF inclusion proof against an anchored app-chain root. `mpf-blake2b256-v1`
  is the only profile whose proofs a Cardano script can verify. That is a much
  larger example.

- **A prepared payout pins specific UTXOs.** If they are spent elsewhere it
  becomes unsubmittable and must be rebuilt and re-approved.

- **Demo keys throughout** — the treasury mnemonic is published in the source
  so the address is stable, and actor seeds derive from actor ids. Everything
  is faucet ada on a local devnet.

---

## Try it yourself

```bash
D="java -jar target/disbursement.jar"

# A second milestone, end to end
$D prepare M2-beta --to addr_test1... --ada 250
$D propose M2-beta
$D review  M2-beta --actor reviewer-pia
$D review  M2-beta --actor reviewer-omar
$D execute M2-beta

# Try to pay one reviewer's approval alone
$D prepare M3-gamma --to addr_test1... --ada 100
$D propose M3-gamma
$D review  M3-gamma --actor reviewer-omar
$D review  M3-gamma --actor reviewer-quinn   # same guild — no effect
$D execute M3-gamma                          # refused

./cluster stop     # keep data
./cluster clean    # wipe
```

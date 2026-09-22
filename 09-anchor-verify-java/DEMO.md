# Demo script — Anchor and verify

**Run time:** about 15 seconds · **Audience:** anyone · **Language:** Java

```bash
./cluster start 3
mvn -B package
./demo.sh
```

---

## The question this answers

Every other example in this repo ends with *"verified"* — against a root that
came from somewhere:

- **Example 01** compares a proof against a **peer member's** root.
- **Example 02** checks signatures against **member keys pinned in a file**.

Both are useful. Both leave the same question open: where did that root, or
that key list, come from? Ask a node, and a dishonest node can answer. Pin it
by hand, and someone has to keep the pin correct.

Here the verifier reads **Cardano and nothing else** — and Cardano carries not
just the state root, but the member set and threshold too.

---

## The walkthrough

### Step 1 — Write something worth proving later

```
$ anchor record "inspection certificate C-8841 issued 2026-09-22"
  messageId  623ec5c8f8672c42…
  finalized  height 1
```

### Step 2 — Wait for it to be anchored

```
  mode             script
  bootstrapped     true
  anchored         1 time(s)
  last height      1
  script address   addr_test1wr66hmkdhqkwrlnxlcryyh0e258q6yej45cz8e2tvxh48nc2efza6
```

Anchoring is on by default and was bootstrapped when the cluster started — a
Plutus V3 thread NFT was minted for this chain and parked at a validator
address.

### Step 3 — Pin the chain identity (the one out-of-band step)

```json
{
  "chainId": "evidence-chain",
  "chainGenesisId": "6a9ed0e5b01e2cc7c2f3e626a24ad734abcef3fd102004283a4db4beab7695b0",
  "scriptAddress": "addr_test1wr66hmkdhqkwrlnxlcryyh0e258q6yej45cz8e2tvxh48nc2efza6",
  "threadPolicyId": "5d75309807902eec519007c1557222405c161272922e0279aad466b4"
}
```

This is the **only** step that asks the node about identity, and it stands in
for the consortium publishing its chain identity out of band — a website, a
registry entry, a signed announcement.

The point is that it happens **once, publicly**, instead of per answer. A lie
has to be told once, in the open, permanently — rather than freshly each time
someone asks.

### Step 4 — What Cardano actually says

```
  found at         tx 7d3f2e84fcfc6a44… output 0
  thread token     5d75309807902eec…65766964656e63652d636861696e

  chain            evidence-chain
  application      ordered-log
  genesis          6a9ed0e5b01e2cc7…
  profile          mpf-blake2b256-v1
  height           1
  state root       9d357b52e39ed136cc002ab58d8ab3138e3094b308059237f0b4bddcf0754150
  threshold        2 of 3
    member         8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394
    member         8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c
    member         ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1
```

Every one of those came out of a Cardano UTxO.

Note especially the last four lines. **The member set and threshold are in the
datum**, so a verifier does not have to be told separately who was allowed to
sign. That is what `trust.json` in example 02 had to supply by hand.

### Step 5 — Export a claim

```
$ anchor export 623ec5c8… --note "inspection certificate C-8841"

  height       1   (the anchored height, not the tip)
  record       topic evidence.record.v1, finalized at height 1 index 0
  state root   9d357b52e39ed136…
```

The proof is taken **at the anchored height**, not at the tip. A proof at the
tip commits to a root Cardano has not seen yet and would be refused — correctly.

### Step 6 — Verify, Cardano only

```
  [ok  ] found this chain's anchor on Cardano
  [ok  ] the anchor is the chain and generation you pinned
  [ok  ] the bundle is about that chain
  [ok  ] the bundle's height is the height Cardano anchored
  [ok  ] the bundle's state root is the anchored root
  [ok  ] the record is proved under the anchored root
  [ok  ] Cardano names the member set and threshold

VERIFIED — this record was in the state a threshold of members
           committed at height 1, and Cardano carries it.
```

The order is the argument:

> Cardano holds a UTxO carrying this chain's thread token, and its datum says
> that at height 1 the state root was `9d357b52…`, under these three members
> with a threshold of two. The bundle's proof reconciles this record against
> that exact root.

**No Yano node was asked anything.** If every member disappeared tomorrow, this
still verifies.

### Steps 7–8 — Change one bit

```
$ anchor tamper bundle.json
$ anchor verify bundle.json

  [FAIL] the record is proved under the anchored root
REJECTED — do not rely on this bundle.
```

Same height, same root, same proof bytes — only the recorded value moved.

### Step 9 — Other things a forgery might try

```
claim a height Cardano never anchored  → [FAIL] the bundle's height is the height Cardano anchored
claim a different state root           → [FAIL] the bundle's state root is the anchored root
claim to be from another chain         → [FAIL] the bundle is about that chain
```

Each caught by a different check, each naming which one failed.

And note what a bundle **cannot** do: say where its own anchor lives. If it
could, a forged bundle would simply point at a forged anchor.

---

## What this demonstrates

| | |
|---|---|
| **Anchored state root** | Committed to Cardano by a Plutus thread-NFT anchor |
| **Self-contained trust** | The datum carries the member set and threshold |
| **No node involved** | `Verifier` and `L1Anchor` have no `AppChainClient` at all |
| **Height discipline** | An anchor commits one height; a tip proof is not covered |
| **Forgery resistance** | Tampered record, wrong height, wrong root, wrong chain — all refused |

## The three trust levels, side by side

| Root source | You trust | Where |
|---|---|---|
| a peer member's block | that peer | example 01 |
| a threshold certificate | member keys you pinned | example 02 |
| **a Cardano anchor** | **Cardano** | **this example** |

## Limits

- **An anchor is periodic.** Records between anchors are finalized but not yet
  on Cardano. Every anchor is a fee-paying L1 transaction.
- **This proves inclusion at the anchored height**, not the current state. A key
  deleted later still verifies as present *at that height* — correct, but worth
  saying precisely.
- **Trusting Cardano means trusting your Cardano source.** Here it is the local
  devnet node; a real verifier uses one it trusts and checks stability depth.
- **The datum says who the members were**, not that they were entitled to be.
  Membership is a configured key list — made public and tamper-evident, not
  permissionless.

---

## Try it yourself

```bash
A="java -jar target/anchor-verify.jar"

$A record "another certificate"
$A status
$A inspect
cat anchor-trust.json bundle.json

# Prove a record that was never anchored yet — export refuses
$A record "too recent"
$A export <that message id>

./cluster stop     # keep data
./cluster clean    # wipe
```

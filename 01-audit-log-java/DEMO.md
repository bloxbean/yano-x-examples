# Demo script — Shared access-change audit log

**Run time:** about 3 minutes · **Audience:** anyone · **Language:** Java

```bash
./cluster start 3     # once, takes ~40s
./demo.sh             # the walkthrough
```

---

## The problem

Two companies work together. Both need a record of who was given access to
which system, and when.

Whoever hosts the database controls that record. They can edit a row, change a
timestamp, or delete an entry, and nobody else can tell. So neither company
wants the other to host it, and paying a third party just moves the problem.

The usual answers do not fit either:

- **A shared database** — one party still holds the keys.
- **A public blockchain** — too slow and too expensive per event, and the data
  is public.
- **Signed log files** — no shared order, and both sides keep their own copy.

## What an app chain does instead

Three members run the chain: one node per company, plus an auditor. An entry
counts only after **2 of the 3** have signed it. Everyone holds the full log.

Later, an auditor can take a single entry and check it — without trusting the
node that handed it over.

---

## The walkthrough

### Step 1 — Three members, one history

```
NODE     HEIGHT     STATE ROOT
0        0          0000000000000000000000000000000000000000000000000000000000000000
1        0          000000000000...
2        0          000000000000...

AGREED — every member finalized the same history.
```

The **state root** is a single fingerprint of everything the chain has
recorded. All three match, so nobody is holding a different version of the log.

### Step 2 — Company A records a grant

```
$ audit-log record grant --subject bob --resource prod-db --by alice --node 0

Submitting via node 0 ... finalized
  messageId  8af1e337...
  position   height 1, index 0
```

Two things happened, and the difference matters:

1. The HTTP call returned a **message id** right away. That only means the
   entry was accepted into the pending pool.
2. The command then waited for 2 of 3 members to sign it. The **height and
   index** are what prove it actually landed.

### Step 3 — Company B and the auditor record their own changes

```
$ audit-log record revoke --subject bob --resource prod-db --by carol --node 1
$ audit-log record grant  --subject dave --resource billing-api --by alice --node 2
```

Each entry went in through a different member, and each one carries the key of
the member that relayed it.

### Step 4 — The shared log

```
HEIGHT   ACTION   CHANGE                         SUBMITTED BY   MESSAGE ID
3        grant    alice -> dave @ billing-api    ed4928c628d1   251715b6...
2        revoke   carol -> bob @ prod-db         8139770ea87d   b0cfb781...
1        grant    alice -> bob @ prod-db         8a88e3dd7409   8af1e337...

3 entries from 3 distinct member key(s).
```

One ordered list, identical on every member. Three different member keys, so
"we never sent that" is answerable.

### Step 5 — Prove one entry (the point of the whole thing)

```
$ audit-log prove 251715b6... --from 2 --against 0

  proof served by node 2
  root (node 2)   5f248d71...
  root (node 0)   5f248d71...

  [ok  ] proof is internally consistent
  [ok  ] verified against node 0's independently finalized root
  [ok  ] honest record accepted by raw MPF inclusion check
  [ok  ] tampered record REJECTED (one bit flipped)

PASS — this entry is provable without trusting any single member.
```

Read that carefully:

- The **proof came from node 2.**
- The **state root it was checked against came from node 0** — a different
  company's node, its own copy of that block.
- The last check flips a single bit of the recorded event and re-runs the same
  proof. It fails, as it must.

So node 2 cannot invent an entry. Any record it makes up would have to
reconcile with a root that node 0 arrived at on its own, and it cannot.

---

## What this demonstrates

| | |
|---|---|
| **Shared order** | One list of entries, same on every member, nobody can reorder it |
| **Threshold finality** | An entry counts once 2 of 3 members co-sign it |
| **Per-entry proofs** | Prove one entry without revealing or sending the rest of the log |
| **Independent verification** | The proof is checked against a root from a *different* member |
| **Tamper evidence** | Changing a recorded event breaks its proof |

## What it deliberately does not do

Worth saying out loud so nobody oversells it:

- **The proof is only as good as the root you check it against.** This demo
  uses a peer member, which is the weakest of the three options and the easiest
  to run on a laptop. Stronger: a threshold certificate under member keys you
  pinned yourself, or a Cardano anchor transaction. Example 09 does the anchor.
- **Membership is a fixed list of keys.** No staking, no slashing, no open
  participation. These are three parties who agreed to run this together.
- **"Submitted by" is the node, not the person.** The chain proves which
  *member* relayed an entry. It does not prove that Alice personally approved
  it. That needs business-actor signatures — example 12.
- **Demo keys, local devnet, disposable data.** Not a deployment posture.

---

## Try it yourself

```bash
# Record your own entry
java -jar target/audit-log.jar record grant \
  --subject erin --resource wiki --by alice --reason "new hire"

# Prove it from any member, against any other member
java -jar target/audit-log.jar prove <messageId> --from 1 --against 2

# All three should always agree
java -jar target/audit-log.jar tips
./cluster status
```

### Things worth trying

**Stop a member and keep going.** The chain needs 2 of 3, so it survives one
node being down:

```bash
kill "$(cat .yano/data/node2.pid)"        # node 2 goes away
java -jar target/audit-log.jar record grant --subject frank --resource vpn --by alice
java -jar target/audit-log.jar tips       # node 2 unreachable, 0 and 1 still agree
./cluster stop && ./cluster start 3       # bring it back; it catches up
```

**Restart and check nothing moved.** State survives a restart:

```bash
./cluster stop          # keeps the data
./cluster start 3
java -jar target/audit-log.jar list       # same entries, same message ids
```

**Watch a member work:**

```bash
./cluster logs 0 -f
```

## Cleaning up

```bash
./cluster stop     # stop the nodes, keep the data
./cluster clean    # stop and wipe .yano/data
```

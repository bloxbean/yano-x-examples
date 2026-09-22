# Yano X Examples

Small, runnable examples of what you can build on
[Yano X](https://yano-x.io) app chains — application-specific replicated
ledgers that settle on Cardano.

Each example is a real, if small, use case: a few parties who need a shared
record that none of them controls. Each one runs locally, needs no funds and no
external Cardano node, and comes with a demo script you can follow or present.

Examples are written in different languages on purpose — Java, JavaScript — to
show that an app chain is ordinary infrastructure you talk to over HTTP.

## Examples

| # | Example | Language | What it shows |
|---|---|---|---|
| [01](01-audit-log-java/) | Shared access-change audit log | Java | A log two companies share and neither controls, with per-entry proofs |
| [02](02-service-registry-js/) | Consortium service registry | JavaScript | Only the owner can change an entry — and an app verifies answers for itself, with no SDK |
| [03](03-batch-release-java/) | Pharmaceutical batch release | Java | Named people sign, not nodes — multi-stage QC/QA/QP approval, role replacement, Cardano anchoring |
| [04](04-catalyst-disbursement-java/) | Catalyst milestone disbursement | Java | The approved hash **is** the Cardano transaction id — approve off-chain, then pay exactly what was approved |

The full catalog of planned examples, grouped from foundations through Cardano
anchoring to custom plugins, is in **[USE_CASES.md](USE_CASES.md)**.

## Before you start

You need:

- **Java 25** — `java -version`
- **Maven** — for the Java examples
- **Node.js 20+** — for the JavaScript examples
- `bash`, `curl`, `jq`, `python3` — standard on macOS and Linux
- An extracted **Yano X JVM distribution** in this directory
  (`yano-x-jvm-<version>/`), downloaded from the
  [releases page](https://github.com/bloxbean/yano-x/releases)

If the distribution lives somewhere else, point at it:

```bash
export YANO_X_DIST=/path/to/yano-x-jvm-0.1.0-pre2
```

## Running an example

Every example works the same way:

```bash
cd 01-audit-log-java
./cluster start 3     # start its chain — three members on a local devnet
./demo.sh             # the walkthrough
./cluster clean       # stop and wipe when you're done
```

`./cluster` also takes `status`, `stop`, `logs <node>` and anything else the
bundled launcher accepts.

**Anchoring is on by default.** Every example anchors its state root to the
local Cardano devnet in script mode — a Plutus V3 thread NFT per chain, with a
validator-enforced datum chain. The launcher funds the anchor wallet from the
faucet and bootstraps each chain on first start, so there is nothing to set up.
Opt out with `./cluster start 3 --no-anchor`.

Each example gets its own chain, its own data directory and its own ports, so
you can leave one running while you try another. Nothing is written back to the
extracted distribution.

## Layout

```
README.md            this file
USE_CASES.md         the full catalog of examples and what each one proves
pom.xml              aggregator — lets an IDE see every Java example at once
00-shared/           tooling every example reuses
01-audit-log-java/   one folder per example
02-service-registry-js/
03-batch-release-java/
04-catalyst-disbursement-java/
yano-x-jvm-*/        the extracted distribution (not committed)
```

Inside an example:

```
README.md                        what it is and how it works
DEMO.md                          the demo script — read this first
cluster                          start / stop / status
demo.sh                          guided walkthrough
chain/application-appchain.yml   the chain definition
src/ or index.js                 the application
```

## Opening this repo in an IDE

Open the **top-level folder**. The root `pom.xml` is an aggregator, so IntelliJ
IDEA imports every Java example as a module in one go, and picks up JavaScript
examples from their `package.json` automatically.

The aggregator is not a parent — no example inherits from it, and no example
declares it. Each one keeps a complete build file and can be copied out of this
repository and built on its own:

```bash
mvn package                        # build every Java example, from the root
mvn -pl 01-audit-log-java package  # build just one
cd 01-audit-log-java && mvn package   # or build it standalone
```

When you add a Java example, add one `<module>` line to the root `pom.xml`.
JavaScript examples need nothing.

If IDEA still shows an example as plain folders, the import was cached from
before the aggregator existed: right-click the root `pom.xml` → **Add as Maven
Project**, or use **Maven** tool window → **Reload All Maven Projects**.

## What an app chain is, briefly

A small ledger shared by a fixed group of parties. Each party runs a node. A
record counts only after a threshold of them has signed the block containing
it, and every party keeps the full history.

That gives you four things a normal database cannot:

- **A shared order** nobody can rewrite afterwards
- **A single state root** — one hash covering everything recorded, so
  disagreement is immediately visible
- **Per-record proofs** you can hand to an outsider, without giving them the
  rest of the log
- **Cardano anchoring** — publish that root on L1 periodically, so the
  timestamp is verifiable by anyone, for pennies

And it stays honest about what it is not: membership is a configured list of
keys, not an open validator set. These examples say so where it matters.

## Reference — the `state:` block in a chain config

Every chain config in this repo carries three fields that look alike but behave
completely differently. They must be configured together, and the runtime
refuses to start if they disagree.

```yaml
state:
  commitment-profile: mpf-blake2b256-v1
  format-fingerprint: 91ee14091200f1e24659112d640e877e9177779dcc81dd06117f013e9190082b
  genesis-id: e208e2576c58bc217342a51191ad5b1568afd316fcd90971dab4b350b6d26ebb
```

| Field | Same on every member? | Across different chains | Where it comes from |
|---|---|---|---|
| `commitment-profile` | must be identical | same, if they use the same profile | you pick one of three |
| `format-fingerprint` | must be identical | same, if they use the same profile | **derived** — a constant of the profile |
| `genesis-id` | must be identical | **must differ** | **chosen** — fresh random bytes per chain |

### The three commitment profiles

This is a closed catalog — `StateCommitmentProfiles` in `yano-core-api` defines
exactly three, and only two can be run today. The fingerprint is
`blake2b256("yano-state-commitment-format-v1\0" || canonical profile descriptor)`,
so it is fixed per profile. Copy it as-is:

| `commitment-profile` | `format-fingerprint` | Verification |
|---|---|---|
| `mpf-blake2b256-v1` | `91ee14091200f1e24659112d640e877e9177779dcc81dd06117f013e9190082b` | off-chain **and on-chain** |
| `jmt-blake2b256-v1` | `10c06baa78234478a3ea94d2c61e23cea8b145c9416ece35688da9be8106e97a` | off-chain only |
| `jmt-poseidon-bls12381-v1` | `879153d220352224204b1e289af2ad234489f52870857a5ed99e500dad4d49b2` | none yet — runtime gated |

> Only `mpf-blake2b256-v1` appears in any shipped configuration, and it is the
> only one the examples here run on. The two JMT rows are correct values for
> profiles nothing in this repo has booted.

### Getting these from the Java API instead of a table

The table above is transcribed from the library, so it can go stale. If you are
on the JVM, ask the library directly — the catalog is public API, and this needs
**no running node**:

```xml
<dependency>
  <groupId>org.yanoproject</groupId>
  <artifactId>yano-core-api</artifactId>
  <version>0.1.0-pre15</version>
</dependency>
```

Already depending on `org.yanoproject.x:yano-x-client`? You have it — the client
pulls `yano-core-api` in at compile scope.

```java
import org.yanoproject.api.appchain.state.StateCommitmentProfile;
import org.yanoproject.api.appchain.state.StateCommitmentProfiles;
import org.yanoproject.x.client.ProofVerifier;

import java.util.HexFormat;

for (StateCommitmentProfile profile : StateCommitmentProfiles.all()) {
    boolean verifiable = ProofVerifier.profileMetadata(profile.id())
            .map(ProofVerifier.ProfileMetadata::verifierAvailable)
            .orElse(false);

    System.out.printf("%-26s %s  verifier=%s%n",
            profile.id(),
            HexFormat.of().formatHex(profile.formatFingerprint()),
            verifiable ? "available" : "gated");
}
```

```text
mpf-blake2b256-v1          91ee14091200f1e24659112d640e877e9177779dcc81dd06117f013e9190082b  verifier=available
jmt-blake2b256-v1          10c06baa78234478a3ea94d2c61e23cea8b145c9416ece35688da9be8106e97a  verifier=available
jmt-poseidon-bls12381-v1   879153d220352224204b1e289af2ad234489f52870857a5ed99e500dad4d49b2  verifier=gated
```

The rest of that surface:

| Call | Gives you |
|---|---|
| `StateCommitmentProfiles.all()` | every profile in the closed catalog |
| `StateCommitmentProfiles.find(id)` | `Optional` — for validating a config value |
| `StateCommitmentProfiles.require(id)` | same, but throws on an unknown id |
| `StateCommitmentProfiles.MPF_BLAKE2B256_V1` | the id constants, instead of string literals |
| `profile.formatFingerprint()` | the 32 bytes to put in `format-fingerprint` |
| `profile.nativeVersioning()` / `.physicalDelete()` | how deletes and versions behave |
| `ProofVerifier.profileMetadata(id)` | `verifierAvailable` — whether this release can verify its proofs |

`yano-core-api` is also where `StateCommitmentIdentity` lives, which is what
validates the three fields together at startup — worth reading if you want the
exact rule rather than this summary.

### Reading it off a running chain

A non-JVM client can get the same values for **one** chain from
`GET /api/v1/app-chain/chains/{chainId}/state/identity`:

```json
{ "profile": "mpf-blake2b256-v1",
  "formatFingerprint": "91ee1409…",
  "genesisId": "…", "stateRoot": "…" }
```

Two caveats: it reports the chain's own profile, not the catalog, and the route
is not in the shipped REST reference — it works, but it is undocumented.

Choosing between them:

- **`mpf-blake2b256-v1`** is the default and what every example here uses. It is
  the only profile that may set `l1-proof-consumption-required` — the others
  fail with *"L1 state-proof consumption is supported only by MPF"*. If a
  Cardano script must ever verify your proofs, this is the only option.
- **`jmt-blake2b256-v1`** is an off-chain-only comparison backend. It uses
  native versioning and tombstones where MPF uses physical delete, so a removed
  key behaves differently.
- **`jmt-poseidon-bls12381-v1`** exists so its consensus identity is fixed now.
  The shipped verifier reports it as unavailable; you cannot run on it.

You do not choose the fingerprint. The runtime recomputes it from the named
profile and refuses to start if yours disagrees — it is a tripwire that catches
a config naming one profile while expecting another format.

### `genesis-id`

A fresh 32 random bytes, unique to each chain. Not a key, not a secret — it is
what stops two chains with otherwise identical settings from being mistaken for
each other, and what binds a proof to *your* chain. It is also what a Cardano
anchor datum carries as `chainGenesisId`.

```bash
openssl rand -hex 32
```

Every member of a chain must configure the **same** value; it is shared
consensus identity and cannot be changed later without starting a new chain.

Two notes that surprise people:

- `GET /state/identity` reports a **different** genesis id than the one you
  configured. That is expected: the runtime derives the effective value from
  yours plus the committed application profile.
- `./yano.sh appchain init` fills this in for you, but **deterministically** —
  it is derived from the project name and chain id, so re-running it with the
  same inputs produces the same value. Hand-written configs like the ones in
  this repo should generate their own.

There is currently no CLI or doc page listing the profiles and their
fingerprints; `appchain config explain state.commitment-profile` reports
`BOUNDS <none>` and no allowed values. Hence this table.

## Troubleshooting

**A node won't start.** Read its log — `./cluster logs 0` — and look for the
first `ERROR`. Do not `clean` to fix a startup problem; you will lose the
evidence.

**Ports already in use.** Each example picks its own range. Override it:

```bash
EXAMPLE_HTTP_BASE=7200 EXAMPLE_SERVER_BASE=13500 ./cluster start 3
```

**"Roots differ" in `tips`.** A fresh cluster needs a second or two for every
member to catch up. Run it again.

## License

MIT, matching Yano and Yano X.

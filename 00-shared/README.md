# Shared tooling

Things every example reuses. You do not need to read this to run an example;
it exists so the examples themselves stay short.

## `lib/example-cluster.sh`

Gives each example its own isolated application without touching the
extracted distribution. It needs Yano X **0.1.0-pre6** or later.

Each example describes its application as an app-chain template,
`chain/<app>.template.yaml`: the chains, their recipes and settings, and how
each one anchors. When you run `./cluster start 3` inside an example, this
script sets that template up the way three real operators would, with the
release's ordinary setup commands:

1. Finds the Yano X distribution (`YANO_X_DIST`, or the newest `yano-x-jvm-*`
   in the repo root that has the `yano.sh appchain` tool).
2. Builds `<example>/.yano/release`: `yano.sh` copied, everything else
   symlinked back to the distribution, and a real `plugins/` directory with the
   release's bundles plus any JARs the example adds.
3. `yano.sh appchain new <app> --from chain/<app>.template.yaml` writes the
   draft for operators `node0`, `node1`, `node2` (threshold: a majority).
4. `request`, once per member: each makes its own key and member card.
5. `seal` writes `<app>.chain`, fixing the members, the threshold, every
   chain's consensus settings and genesis identity, and the plugin digests.
6. `join`, once per member, checked against the sealed fingerprint.
7. `start`, lead first. On a devnet the lead (node0) also produces the
   application's private Cardano devnet.
8. `anchor`: every chain starts anchoring to Cardano (below).

The result:

- the extracted distribution is never modified
- two examples can run side by side on different ports
- `./cluster clean` wipes one example without affecting anything else

```bash
./cluster start 3 [--no-anchor]   # seal and start (skipped steps are already done)
./cluster status                  # the application's stage, and every member's tip and root
./cluster stop [n]                # stop the members, or just member n; keep the data
./cluster logs <n> [-f]           # member n's log
./cluster clean                   # stop and delete .yano/ (chains, member keys, devnet)
```

Running `./cluster start 3` again after a `stop` starts whichever members are
down and leaves the running ones alone, so `./cluster stop 2` followed by
`./cluster start 3` takes one member out and brings it back.

### Anchoring, on by default

`./cluster start` turns on **script-mode anchoring** for every chain in the
template (`anchor: {mode: script, every-blocks: N}`), led by node0. Script mode
mints a Plutus V3 thread NFT per chain and parks it at a validator address, so
each chain gets its own on-chain identity and the anchor datum chain is
validator-enforced, co-signed by a threshold of members. That is stronger than
metadata mode, where the anchor is just a transaction with a payload.

On devnet the lead funds the anchor wallet itself, so there is nothing to do
manually. Repeat starts leave chains that already anchor alone.

```bash
./cluster start 3               # anchoring on
./cluster start 3 --no-anchor   # opt out
```

The first anchor appears once the chain has blocks to anchor and the thread
NFT is minted on L1, a few seconds on devnet. Check it with:

```bash
./cluster status
curl -s localhost:7100/api/v1/app-chain/chains/<chain>/status | jq .anchor
```

### Used by an example

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"

export EXAMPLE_HTTP_BASE=7100        # this example's port range
export EXAMPLE_SERVER_BASE=13400

. "$HERE/../00-shared/lib/example-cluster.sh"
example_cluster "$HERE" "$@"
```

An example can set these before `example_cluster`:

| Hook | Meaning |
|---|---|
| `EXAMPLE_PLUGIN_JARS` | Plugin JARs (space-separated) to add to the members' `plugins/`; `seal` pins their digests. |
| `example_local_config <n> <node-dir>` | A shell function called after `join`; it may write `<node-dir>/config/local.yaml`, the member's own node-local settings (an effect executor, a connector endpoint). Sealed consensus settings cannot be changed there. |
| `example_after_start` | A shell function called once the members are live and anchoring. |

### Port assignments

Keep these distinct so examples can run at the same time.

| Example | HTTP | n2n |
|---|---|---|
| 01 — audit log | 7100–7102 | 13400–13402 |
| 02 — service registry | 7110–7112 | 13410–13412 |
| 03 — batch release | 7130–7132 | 13430–13432 |
| 04 — catalyst disbursement | 7140–7142 | 13440–13442 |
| 07 — webhook effects | 7160–7162 | 13460–13462 |
| 09 — anchor and verify | 7150–7152 | 13450–13452 |
| 20 — anchor canvas | 7200–7202 | 13500–13502 |
| 21 — game center (own `cluster`) | 7210–7212 | 13510–13512 |

### Environment

| Variable | Meaning |
|---|---|
| `YANO_X_DIST` | Path to the extracted distribution. Defaults to the newest `yano-x-jvm-*` (0.1.0-pre6 or later) in the repo root. |
| `EXAMPLE_HTTP_BASE` | First HTTP port; node *i* listens on base + *i*. |
| `EXAMPLE_SERVER_BASE` | First node-to-node port. |

## A note on the member keys

Each member's signing key is made by `yano.sh appchain request` on first start
and kept in `.yano/node<i>/secrets/`. They are real keys, but they belong to a
throwaway devnet application: `./cluster clean` deletes them, and they must
never be used for anything real.
